-- 双周表并入中台：每个研究单元每两周登记一次（章程第二十七条；研究项目按两周一轮推进，每轮只回答一个问题，第二十六条）。
--   登记内容：写作进度（想法、摘要、首图、核心结果表、完整初稿、投稿稿）、本轮回答的问题、已完成的工作与阶段结果、
--   本轮改变的判断、遇到的问题、成员分工、下一轮安排与预期。
--   期次与名义币的两周一期相同（token_period，自 2026-11-16 起算）；本期随时可改，上一期在结束后三日内可以补登。
--   研究单元负责人和成员登记；课题本身不登记。所有登录的人都看得到各研究单元的登记和未登记情况：
--   超过两周未登记的由联席会议优先过问；未登记双周表的研究单元不参加方向会汇报（2026-11-19 联席会议）。

create table biweekly_report (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id),
  period_start date not null check (period_start = token_period(period_start)),
  stage text not null check (stage in ('idea', 'abstract', 'first_figure', 'results_table', 'full_draft', 'submitted')),
  question text not null,          -- 本轮回答的问题
  done text not null,              -- 已完成的工作与阶段结果
  changed_judgment text not null,  -- 本轮改变的判断
  issues text,                     -- 遇到的问题
  division text not null,          -- 成员分工
  next_plan text not null,         -- 下一轮安排与预期
  submitted_by uuid not null references app_user(id),
  submitted_at timestamptz not null default now(),
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  unique (project_id, period_start)
);
alter table biweekly_report enable row level security;
create trigger audit after insert or update or delete on biweekly_report for each row execute function trg_audit();

-- 研究单元从哪一期起须登记：成立（核对确认，或直接建立）所在的那一期，最早 2026-11-16
create function biweekly_from(p_project uuid) returns date language sql stable security definer set search_path = public as $$
  select greatest(date '2026-11-16', token_period((coalesce(checked_at, created_at) at time zone 'Asia/Shanghai')::date)) from project where id = p_project
$$;

-- 登记或修改本单元这一期的双周表：同一研究单元同一期只有一份，后登记的覆盖先登记的
create function save_biweekly_report(p_project uuid, p_period date, p_stage text, p_question text, p_done text, p_changed text, p_issues text, p_division text, p_next text) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; cur date := token_period(app_today()); rid uuid;
  q text := nullif(btrim(coalesce(p_question, '')), ''); d text := nullif(btrim(coalesce(p_done, '')), ''); c text := nullif(btrim(coalesce(p_changed, '')), '');
  i text := nullif(btrim(coalesce(p_issues, '')), ''); v text := nullif(btrim(coalesce(p_division, '')), ''); n text := nullif(btrim(coalesce(p_next, '')), '');
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' then raise exception '双周表按研究单元登记，请选择研究单元'; end if;
  if not p.active or p.proposed then raise exception '研究单元「%」尚未成立或已停用', p.name; end if;
  if not is_on_project(p_project) then raise exception '仅研究单元负责人和成员可登记双周表' using errcode = '42501'; end if;
  if p_period is null or p_period <> token_period(p_period) then raise exception '登记的期次有误'; end if;
  if not (p_period = cur or (p_period = cur - 14 and app_today() <= cur + 2)) then
    raise exception '仅可登记本期；上一期在结束后三日内可以补登';
  end if;
  if p_stage is null then raise exception '请选择写作进度'; end if;
  if p_stage not in ('idea', 'abstract', 'first_figure', 'results_table', 'full_draft', 'submitted') then
    raise exception '写作进度仅限想法、摘要、首图、核心结果表、完整初稿、投稿稿';
  end if;
  if q is null then raise exception '请填写本轮回答的问题'; end if;
  if length(q) > 300 then raise exception '本轮回答的问题不得超过 300 个字'; end if;
  if d is null then raise exception '请填写已完成的工作与阶段结果'; end if;
  if length(d) > 2000 then raise exception '已完成的工作与阶段结果不得超过 2000 个字'; end if;
  if c is null then raise exception '请填写本轮改变的判断'; end if;
  if length(c) > 1000 then raise exception '本轮改变的判断不得超过 1000 个字'; end if;
  if length(i) > 1000 then raise exception '遇到的问题不得超过 1000 个字'; end if;
  if v is null then raise exception '请填写成员分工'; end if;
  if length(v) > 500 then raise exception '成员分工不得超过 500 个字'; end if;
  if n is null then raise exception '请填写下一轮安排与预期'; end if;
  if length(n) > 1000 then raise exception '下一轮安排与预期不得超过 1000 个字'; end if;
  insert into biweekly_report (project_id, period_start, stage, question, done, changed_judgment, issues, division, next_plan, submitted_by)
  values (p_project, p_period, p_stage, q, d, c, i, v, n, app_uid())
  on conflict (project_id, period_start) do update set stage = excluded.stage, question = excluded.question, done = excluded.done,
     changed_judgment = excluded.changed_judgment, issues = excluded.issues, division = excluded.division, next_plan = excluded.next_plan,
     updated_by = app_uid(), updated_at = now()
  returning id into rid;
  return rid;
end $$;

select expose('save_biweekly_report(uuid, date, text, text, text, text, text, text, text)');

-- ---------- 视图：课题和研究单元全公开，双周表同样所有登录的人都能看 ----------
create view api.biweekly_report as
  select r.id, r.project_id, p.code as unit_code, p.name as unit_name, p.parent_id as topic_id, t.code as topic_code, t.name as topic_name,
         (select name from app_user where id = p.owner_id) as leader_name,
         r.period_start, r.period_start + 13 as period_end, r.stage, r.question, r.done, r.changed_judgment, r.issues, r.division, r.next_plan,
         (select name from app_user where id = r.submitted_by) as submitted_by_name, r.submitted_at,
         (select name from app_user where id = r.updated_by) as updated_by_name, r.updated_at
  from biweekly_report r join project p on p.id = r.project_id left join project t on t.id = p.parent_id
  where app_role() is not null and can_see_project(r.project_id);

-- 各研究单元的登记情况：本期是否已登记、最近一次登记、从上一期往前连续未登记的期数（大于 0 即超过两周未登记）
create view api.biweekly_status as
  select p.id as project_id, p.code as unit_code, p.name as unit_name, p.parent_id as topic_id, t.code as topic_code, t.name as topic_name,
         p.owner_id as leader_id, (select name from app_user where id = p.owner_id) as leader_name,
         s.cur as period_start, s.cur + 13 as period_end,
         exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = s.cur) as filled,
         exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = s.cur - 14) as prev_filled,
         (app_today() <= s.cur + 2 and s.cur - 14 >= s.since) as prev_open,
         l.period_start as last_period, l.stage as last_stage,
         greatest(0, ((s.cur - 14) - greatest(s.since, coalesce((select max(r.period_start) from biweekly_report r where r.project_id = p.id and r.period_start < s.cur) + 14, s.since))) / 14 + 1) as missed,
         is_on_project(p.id) as can_fill
  from project p left join project t on t.id = p.parent_id
  cross join lateral (select token_period(app_today()) as cur, biweekly_from(p.id) as since) s
  left join lateral (select r.period_start, r.stage from biweekly_report r where r.project_id = p.id order by r.period_start desc limit 1) l on true
  where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;

grant select on api.biweekly_report, api.biweekly_status to app_api;
