-- 中心负责人特批（黄济民 2026-11-26「也发通知，就是负责人才有权限的特殊批准，包括双周表」）
--   特批只有中心负责人能办，不经联席会议，也不受登记日限制；每一次都要写明理由，记录全中心可见，并由正则在全员群通报。
--   两类：
--     档次：给课题直接定当年档次，占该档次的名额；年度已下达的，同时写入课题当年额度。
--     双周表：准许某个研究单元在本期登记日之外登记本期双周表，并从本期起计登记。
--   今天陈焱凯的课题 P-16 已按特批定了 2027 年度「探索课题」（迁移之外办理），这里补记一条。

create table special_approval (
  id          uuid primary key default gen_random_uuid(),
  seq         serial unique,
  kind        text not null check (kind in ('tier','biweekly')),
  project_id  uuid not null references project(id),
  year        int,
  period      date,
  tier_id     uuid references budget_tier(id),
  reason      text not null check (length(btrim(reason)) between 1 and 500),
  approved_by uuid references app_user(id),
  approved_at timestamptz not null default now(),
  check ((kind = 'tier') = (tier_id is not null and year is not null)),
  check ((kind = 'biweekly') = (period is not null))
);
create unique index special_biweekly_once on special_approval (project_id, period) where kind = 'biweekly';
select seal('special_approval');
create trigger audit after insert or update or delete on special_approval for each row execute function trg_audit();

create function special_biweekly_ok(p_project uuid, p_period date) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from special_approval where kind = 'biweekly' and project_id = p_project and period = p_period) and p_period = token_period(app_today())
$$;

-- 全员群通报，并通知负责人
create function special_notice(s special_approval, p_what text) returns void language plpgsql security definer set search_path = public as $$
declare p project;
begin
  select * into p from project where id = s.project_id;
  insert into feishu_outbox (target, payload) values ('group', jsonb_build_object('text',
    format('中心负责人特批（第 %s 号）：%s。理由：%s。特批是中心负责人的权限，不经联席会议、不受登记日限制，记录在正则「联席会议」页可查。', s.seq, p_what, s.reason),
    'by', '正则', 'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI')));
  if p.owner_id is not null then perform notify_user(p.owner_id, format('中心负责人特批：%s。理由：%s', p_what, s.reason)); end if;
end $$;
revoke execute on function special_notice(special_approval, text) from public;

create function special_tier(p_project uuid, p_year int, p_tier uuid, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare p project; t budget_tier; y budget_year; n int; s special_approval; r text := btrim(coalesce(p_reason, ''));
begin
  if app_role() is distinct from 'director' then raise exception '特批由中心负责人办理' using errcode = '42501'; end if;
  if r = '' or length(r) > 500 then raise exception '请写明特批的理由，不超过 500 字'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'big' or not p.active or p.kind = 'public' then raise exception '档次按在用的课题特批'; end if;
  select * into y from budget_year where year = p_year;
  if not found then raise exception '% 年度预算不存在', p_year; end if;
  select * into t from budget_tier where id = p_tier and year = p_year;
  if not found then raise exception '档次不存在'; end if;
  if exists (select 1 from tier_pick where year = p_year and project_id = p_project and (decided_tier_id is not null or rejected)) then raise exception '该课题本年度已评定档次'; end if;
  select count(*) into n from tier_pick where year = p_year and decided_tier_id = p_tier and project_id <> p_project;
  if n >= t.slots then raise exception '「%」的名额 % 个已用满，请先在档次表里增加名额', t.name, t.slots; end if;
  -- 不触发列入联席会议议程和「评定」通知
  perform set_config('app.special', 'on', true);
  insert into tier_pick (year, project_id, tier_id, reason, picked_by, kind, decided_tier_id, decided_by, decided_at, decide_note)
  values (p_year, p_project, p_tier, '中心负责人特批', app_uid(), case when p.proposed then 'new' else 'renew' end, p_tier, app_uid(), now(), '中心负责人特批，不经联席会议评定：' || r)
  on conflict (year, project_id) do update set tier_id = excluded.tier_id, decided_tier_id = excluded.decided_tier_id, decided_by = excluded.decided_by,
    decided_at = excluded.decided_at, decide_note = excluded.decide_note;
  perform set_config('app.special', '', true);
  update motion set status = 'withdrawn', decided_at = now(), note = '中心负责人特批'
  where ref_kind = 'tier' and ref_id = p_project and ref_year = p_year and status in ('proposed','seconded');
  if y.stage <> 'declare' then
    insert into project_cap (year, project_id, amount, set_by) values (p_year, p_project, t.amount, app_uid())
    on conflict (year, project_id) do update set amount = excluded.amount, set_by = excluded.set_by, set_at = now();
    update project set proposed = false where (id = p_project or parent_id = p_project) and proposed;
  end if;
  insert into special_approval (kind, project_id, year, tier_id, reason, approved_by) values ('tier', p_project, p_year, p_tier, r, app_uid()) returning * into s;
  perform special_notice(s, format('课题「%s」%s 年度档次定为「%s」，%s 元%s', p.name, p_year, t.name, to_char(t.amount, 'FM999,999,990'),
    case when y.stage <> 'declare' then '，额度已下达' else '' end));
  return s.seq;
end $$;

create function special_biweekly(p_unit uuid, p_reason text) returns int language plpgsql security definer set search_path = public as $$
declare p project; s special_approval; r text := btrim(coalesce(p_reason, '')); cur date := token_period(app_today());
begin
  if app_role() is distinct from 'director' then raise exception '特批由中心负责人办理' using errcode = '42501'; end if;
  if r = '' or length(r) > 500 then raise exception '请写明特批的理由，不超过 500 字'; end if;
  select * into p from project where id = p_unit;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '双周表按已成立的研究单元特批'; end if;
  if biweekly_open(cur) then raise exception '今天就是登记日，直接登记即可'; end if;
  if exists (select 1 from biweekly_report where project_id = p_unit and period_start = cur) then raise exception '本期已登记'; end if;
  insert into special_approval (kind, project_id, period, reason, approved_by) values ('biweekly', p_unit, cur, r, app_uid())
  on conflict (project_id, period) where kind = 'biweekly' do nothing returning * into s;
  if s.id is null then raise exception '本期已特批过'; end if;
  perform special_notice(s, format('研究单元「%s」（%s）可在本期登记日之外登记 %s 一期的双周表，本期起计登记', p.name, p.code, to_char(cur, 'MM-DD')));
  return s.seq;
end $$;

-- 档次申请的两个触发器在特批时不动作
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.trg_tier_motion()'::regprocedure);
  n := replace(d, E'begin\n', E'begin\n  if current_setting(''app.special'', true) = ''on'' then return coalesce(new, old); end if;\n');
  if n = d then raise exception 'trg_tier_motion 没有改上'; end if;
  execute n;
  d := pg_get_functiondef('public.trg_notify_pick_new()'::regprocedure);
  n := replace(d, E'begin\n', E'begin\n  if current_setting(''app.special'', true) = ''on'' then return new; end if;\n');
  if n = d then raise exception 'trg_notify_pick_new 没有改上'; end if;
  execute n;
  d := pg_get_functiondef('public.trg_notify_pick_decide()'::regprocedure);
  n := replace(d, E'begin\n', E'begin\n  if current_setting(''app.special'', true) = ''on'' then return new; end if;\n');
  if n = d then raise exception 'trg_notify_pick_decide 没有改上'; end if;
  execute n;
  -- 双周表：特批的本期可以登记
  d := pg_get_functiondef('public.save_biweekly_report(uuid, date, text, text, text, text, text, text, text)'::regprocedure);
  n := replace(d, 'if not biweekly_open(p_period) then', 'if not biweekly_open(p_period) and not special_biweekly_ok(p_project, p_period) then');
  if n = d then raise exception 'save_biweekly_report 没有改上'; end if;
  execute n;
end $$;

-- 特批的那一期起计登记
create or replace function biweekly_from(p_project uuid) returns date language sql stable security definer set search_path = public as $$
  select least(
    (select greatest(date '2026-11-23', token_period(d) + case when register_window(d) then 0 else 14 end)
       from (select (coalesce(checked_at, created_at) at time zone 'Asia/Shanghai')::date as d from project where id = p_project) x),
    coalesce((select min(period) from special_approval where kind = 'biweekly' and project_id = p_project), 'infinity'::date))
$$;

do $$
declare d text := pg_get_viewdef('api.biweekly_status'::regclass); n text;
begin
  n := replace(d, 'biweekly_open(s.cur) AS open', '(biweekly_open(s.cur) OR special_biweekly_ok(p.id, s.cur)) AS open');
  if n = d then raise exception 'biweekly_status 没有改上'; end if;
  n := replace(n, 'NOT biweekly_open(s.cur) AND', 'NOT (biweekly_open(s.cur) OR special_biweekly_ok(p.id, s.cur)) AND');
  execute 'create or replace view api.biweekly_status as ' || n;
end $$;

select expose('special_tier(uuid, int, uuid, text)', 'special_biweekly(uuid, text)');

create view api.special_approval as
  select s.id, s.seq, s.kind, s.project_id, p.code as project_code, p.name as project_name, (select name from app_user where id = p.owner_id) as owner_name,
         s.year, s.period, (select name from budget_tier where id = s.tier_id) as tier_name, (select amount from budget_tier where id = s.tier_id) as tier_amount,
         s.reason, (select name from app_user where id = s.approved_by) as approved_by_name, s.approved_at
  from special_approval s join project p on p.id = s.project_id where app_role() is not null;
create view api.special_targets as
  select p.id, p.code, p.name, p.layer from project p where app_role() = 'director' and p.active and p.kind <> 'public' and p.layer in ('big','paper');
grant select on api.special_approval, api.special_targets to app_api;

-- 补记今天已办的那一次（陈焱凯的课题 P-16，2027 年度探索课题），不再通报
insert into special_approval (kind, project_id, year, tier_id, reason, approved_by, approved_at)
select 'tier', k.project_id, k.year, k.decided_tier_id, '本人有个人原因，已向中心负责人说明', k.decided_by, k.decided_at
from tier_pick k join project p on p.id = k.project_id
where p.code = 'P-16' and k.year = 2027 and k.decide_note like '中心负责人%特批%';
select set_config('app.special', 'on', false);
update tier_pick k set decide_note = '中心负责人特批，不经联席会议评定：本人有个人原因，已向中心负责人说明'
from project p where p.id = k.project_id and p.code = 'P-16' and k.year = 2027 and k.decide_note like '中心负责人%特批%';
select set_config('app.special', '', false);
