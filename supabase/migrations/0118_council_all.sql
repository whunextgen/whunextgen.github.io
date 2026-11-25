-- 联席会议事项全部接入（黄济民 2026-11-26「都接进去」）：
--   一、考核申请（RA 考核除外）提交即生成议题，不记名表决；已在办理中的补上议题
--   二、成长主线里须经联席会议审核的任务：本人提交审核，生成议题，决议生效即认定完成
--   三、追加或调减预算：课题负责人对某一行核定数提出申请，生成议题；决议生效后由中心负责人按决议执行
--   四、预算期预算与复盘：课题负责人每个预算期提交，生成议题；决议生效后记为该期的复盘结论

alter table motion drop constraint motion_category_check;
alter table motion add constraint motion_category_check check (category in ('research','unit','topic','budget','assessment','path','personnel','removal','rules','other','procedure'));
alter table motion drop constraint motion_ref_kind_check;
alter table motion add constraint motion_ref_kind_check check (ref_kind in ('assessment','unit','tier','path','fixed_change','period_report'));
alter table motion add column ref_code text;

-- 申请流程生成议题：加上任务编号作为区分；涉及人员的类别不记名
drop function motion_auto(text, uuid, int, text, text, text, uuid, uuid[]);
create function motion_auto(p_kind text, p_ref uuid, p_year int, p_category text, p_title text, p_body text, p_proposer uuid, p_subjects uuid[], p_code text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare m motion; v_id uuid;
begin
  select * into m from motion where ref_kind = p_kind and ref_id = p_ref and ref_year is not distinct from p_year and ref_code is not distinct from p_code
    and status not in ('failed','vetoed','withdrawn','effective') order by created_at desc limit 1;
  if found then
    if m.status = 'voting' then raise exception '这份申请正在联席会议表决，表决结束前不能修改'; end if;
    if m.status in ('proposed','seconded') then update motion set title = left(p_title, 80), body = left(p_body, 12000), subjects = p_subjects where id = m.id; end if;
    return m.id;
  end if;
  insert into motion (mtype, category, title, body, proposer_id, subjects, threshold, ballot, ref_kind, ref_id, ref_year, ref_code, auto, status, seconded_at, note)
  values ('main', p_category, left(p_title, 80), left(p_body, 12000), p_proposer, p_subjects, 'majority',
          case when p_category in ('assessment','path','personnel','removal') then 'secret' else 'open' end,
          p_kind, p_ref, p_year, p_code, true, 'seconded', now(), '由申请流程自动列入议程，免附议')
  returning motion.id into v_id;
  return v_id;
end $$;
revoke execute on function motion_auto(text, uuid, int, text, text, text, uuid, uuid[], text) from public;

-- ---------- 一、考核 ----------
create function assessment_motion_sync(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; pr person;
begin
  select * into a from assessment where id = p_id;
  if not found or a.kind = 'ra' or a.status <> 'applied' then return; end if;
  if exists (select 1 from motion where ref_kind = 'assessment' and ref_id = p_id and status not in ('withdrawn','failed','vetoed')) then return; end if;
  select * into pr from person where id = a.person_id;
  perform motion_auto('assessment', p_id, null, 'assessment', format('%s%s推荐', pr.name, assess_label(a.kind)),
    format(E'%s申请%s\n当前身份：%s\n申请时本级主线任务已全部完成，申请当期的本期任务已完成。\n材料：%s\n说明：%s\n\n表决通过、否决期满后，转中心负责人决定。',
      pr.name, assess_label(a.kind), rank_label(pr.rank), coalesce(a.link, '—'), coalesce(a.note, '—')),
    coalesce(pr.user_id, (select id from app_user where role = 'director' and active order by created_at limit 1)), case when pr.user_id is null then '{}'::uuid[] else array[pr.user_id] end);
end $$;
revoke execute on function assessment_motion_sync(uuid) from public;
create function trg_assessment_motion() returns trigger language plpgsql security definer set search_path = public as $$
begin perform assessment_motion_sync(new.id); return new; end $$;
create trigger assessment_motion after insert on assessment for each row execute function trg_assessment_motion();
do $$ declare r record; begin for r in select id from assessment where kind <> 'ra' and status = 'applied' loop perform assessment_motion_sync(r.id); end loop; end $$;

-- 原来的录入表决：有议题在办的，改到议题上表决
do $$
declare d text := pg_get_functiondef('public.record_council_vote(uuid, boolean, date, text)'::regprocedure); n text;
begin
  n := replace(d, E'  if a.status <> ''applied'' then raise exception ''已录入表决结果''; end if;',
    E'  if a.status <> ''applied'' then raise exception ''已录入表决结果''; end if;\n  if exists (select 1 from motion where ref_kind = ''assessment'' and ref_id = p_id and status in (''voting'',''passed'')) then raise exception ''这项考核正在联席会议议题上表决''; end if;\n  update motion set status = ''withdrawn'', decided_at = now(), note = ''已按录入的联席会议表决结果办理'' where ref_kind = ''assessment'' and ref_id = p_id and status in (''proposed'',''seconded'');');
  if n = d then raise exception '录入表决的函数没有改上'; end if;
  execute n;
end $$;

-- ---------- 二、成长主线任务 ----------
create function request_path_council(p_code text, p_link text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t path_task; pr person; lk text := nullif(btrim(coalesce(p_link, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from path_task where code = p_code;
  if not found then raise exception '任务不存在'; end if;
  if t.verify <> 'council' then raise exception '这一条不经联席会议审核'; end if;
  select * into pr from person where user_id = app_uid() and status in ('active','offroll') order by updated_at desc nulls last limit 1;
  if not found then raise exception '本人的人员档案尚未对应中台账号'; end if;
  if exists (select 1 from path_done where person_id = pr.id and task_code = p_code) then raise exception '这一条已认定完成'; end if;
  if lk is not null and lk !~ '^https?://' then raise exception '链接须以 http 开头'; end if;
  if lk is null and nt is null then raise exception '请附上材料链接或写明情况'; end if;
  if nt is not null and length(nt) > 1000 then raise exception '说明不得超过 1000 个字'; end if;
  return motion_auto('path', pr.id, null, 'path', format('%s：%s', pr.name, t.title),
    format(E'成长主线任务审核\n申请人：%s（%s）\n任务：%s\n要求：%s\n材料：%s\n说明：%s\n\n表决通过、否决期满后，这一条认定完成。',
      pr.name, rank_label(pr.rank), t.title, coalesce(t.detail, '—'), coalesce(lk, '—'), coalesce(nt, '—')),
    app_uid(), array[app_uid()], p_code);
end $$;

-- ---------- 三、追加或调减预算 ----------
create table fixed_change (
  id           uuid primary key default gen_random_uuid(),
  line_id      uuid not null references project_budget_line(id),
  year         int not null,
  project_id   uuid not null references project(id),
  amount_from  numeric(14,2) not null,
  amount_to    numeric(14,2) not null check (amount_to >= 0),
  reason       text not null check (length(btrim(reason)) between 1 and 1000),
  requested_by uuid not null references app_user(id),
  requested_at timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending','approved','rejected','done','withdrawn')),
  done_by      uuid references app_user(id),
  done_at      timestamptz,
  note         text
);
select seal('fixed_change');
create trigger audit after insert or update or delete on fixed_change for each row execute function trg_audit();

create function council_subjects_for(p_project uuid) returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct x), '{}') from (
    select owner_id x from project where id = p_project or parent_id = p_project
    union select m.user_id from project_member m join project q on q.id = m.project_id where (q.id = p_project or q.parent_id = p_project) and m.left_on is null) s where x is not null
$$;

create function submit_fixed_change(p_line uuid, p_amount numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare l v_line; y budget_year; p project; r text := btrim(coalesce(p_reason, '')); v_id uuid;
begin
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在'; end if;
  select * into p from project where id = l.project_id;
  if not has_perm('budget.project', l.project_id) then raise exception '由课题负责人或副手提出' using errcode = '42501'; end if;
  select * into y from budget_year where year = l.year;
  if y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前才能申请调整'; end if;
  if p_amount is null or p_amount < 0 then raise exception '金额不能为空，也不能是负数'; end if;
  if p_amount = l.fixed then raise exception '金额没有变'; end if;
  if p_amount < l.used then raise exception '这一行已经用了 %，核定数不能低于它', l.used; end if;
  if r = '' then raise exception '请写明调整原因'; end if;
  if exists (select 1 from fixed_change where line_id = p_line and status in ('pending','approved')) then raise exception '这一行已有一份调整申请在办理中'; end if;
  insert into fixed_change (line_id, year, project_id, amount_from, amount_to, reason, requested_by) values (p_line, l.year, l.project_id, l.fixed, p_amount, r, app_uid())
  returning fixed_change.id into v_id;
  perform motion_auto('fixed_change', v_id, l.year, 'budget', format('%s %s：%s', p.name, case when p_amount > l.fixed then '追加预算' else '调减预算' end, left(l.purpose, 30)),
    format(E'%s 年度预算调整申请\n课题：%s（%s）\n预算行：%s\n核定数：%s 元 → %s 元（%s %s 元）\n已用（含在途）：%s 元\n\n原因：\n%s\n\n表决通过、否决期满后，由中心负责人按决议调整核定数；调增部分另行下达，调减部分超额下达的自动收回。',
      l.year, p.name, p.code, l.purpose, to_char(l.fixed, 'FM999,999,990.00'), to_char(p_amount, 'FM999,999,990.00'), case when p_amount > l.fixed then '增加' else '减少' end,
      to_char(abs(p_amount - l.fixed), 'FM999,999,990.00'), to_char(l.used, 'FM999,999,990.00'), r),
    app_uid(), council_subjects_for(coalesce(p.parent_id, p.id)));
  return v_id;
end $$;

create function withdraw_fixed_change(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare c fixed_change;
begin
  select * into c from fixed_change where id = p_id for update;
  if not found or c.status <> 'pending' then raise exception '只能撤回办理中的申请'; end if;
  if c.requested_by <> app_uid() and not has_perm('budget.project', c.project_id) then raise exception '由申请人撤回' using errcode = '42501'; end if;
  perform motion_auto_withdraw('fixed_change', p_id, c.year);
  update fixed_change set status = 'withdrawn' where id = p_id;
end $$;

-- 按决议执行：中心负责人调用原来的调整核定数，记下执行
create function execute_fixed_change(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare c fixed_change; m motion;
begin
  perform need_role('director');
  select * into c from fixed_change where id = p_id for update;
  if not found or c.status <> 'approved' then raise exception '只有联席会议决议已生效的申请可以执行'; end if;
  select * into m from motion where ref_kind = 'fixed_change' and ref_id = p_id and status = 'effective' order by effective_at desc limit 1;
  perform revise_fixed(c.line_id, c.amount_to, format('联席会议第 %s 号决议：%s', m.seq, left(c.reason, 200)));
  update fixed_change set status = 'done', done_by = app_uid(), done_at = now() where id = p_id;
  perform notify_user(c.requested_by, format('预算已按联席会议决议调整：核定数 %s 元 → %s 元', c.amount_from, c.amount_to));
end $$;

-- ---------- 四、预算期预算与复盘 ----------
create table period_report (
  id           uuid primary key default gen_random_uuid(),
  year         int not null,
  quarter      int not null check (quarter between 1 and 4),
  project_id   uuid not null references project(id),
  review       text not null check (length(btrim(review)) between 1 and 2000),
  plan         text not null check (length(btrim(plan)) between 1 and 2000),
  submitted_by uuid not null references app_user(id),
  submitted_at timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  unique (year, quarter, project_id)
);
select seal('period_report');
create trigger audit after insert or update or delete on period_report for each row execute function trg_audit();

-- 提交本预算期的预算并附上一期复盘；同一期可以改，改了议题正文跟着更新（表决中不能改）
create function submit_period_report(p_year int, p_quarter int, p_project uuid, p_review text, p_plan text) returns uuid
language plpgsql security definer set search_path = public as $$
declare y budget_year; p project; rv text := btrim(coalesce(p_review, '')); pl text := btrim(coalesce(p_plan, '')); v_id uuid; old period_report;
begin
  select * into p from project where id = p_project;
  if not found or p.layer <> 'big' or p.kind = 'public' then raise exception '预算期预算按课题提交'; end if;
  if not has_perm('budget.project', p_project) then raise exception '由课题负责人或副手提交' using errcode = '42501'; end if;
  select * into y from budget_year where year = p_year;
  if not found or y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前提交预算期预算'; end if;
  if p_quarter is null or p_quarter not between 1 and 4 then raise exception '请选择是第几个预算期'; end if;
  if rv = '' then raise exception '请写上一期复盘：计划和实际的偏差、原因和措施'; end if;
  if pl = '' then raise exception '请写本期预算：本期要做的事和要用的钱'; end if;
  select * into old from period_report where year = p_year and quarter = p_quarter and project_id = p_project for update;
  if found and old.status <> 'pending' then raise exception '这一期已经联席会议表决'; end if;
  insert into period_report (year, quarter, project_id, review, plan, submitted_by) values (p_year, p_quarter, p_project, rv, pl, app_uid())
  on conflict (year, quarter, project_id) do update set review = excluded.review, plan = excluded.plan, submitted_by = excluded.submitted_by, submitted_at = now()
  returning period_report.id into v_id;
  perform motion_auto('period_report', v_id, p_year, 'budget', format('%s 第 %s 预算期预算：%s', p_year, p_quarter, p.name),
    format(E'%s 年第 %s 预算期预算\n课题：%s（%s）\n\n上一期复盘：\n%s\n\n本期预算：\n%s\n\n表决通过、否决期满后，记为这一期的复盘结论。',
      p_year, p_quarter, p.name, p.code, rv, pl),
    app_uid(), council_subjects_for(p_project));
  return v_id;
end $$;

-- ---------- 表决结果落回：补上这三类 ----------
do $$
declare d text := pg_get_functiondef('public.motion_apply(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, E'  elsif m.ref_kind = ''tier'' then',
E'  elsif m.ref_kind = ''path'' then
    if p_result = ''effective'' and not exists (select 1 from path_done where person_id = m.ref_id and task_code = m.ref_code) then
      insert into path_done (person_id, task_code, done_on, note) values (m.ref_id, m.ref_code, on_, format(''联席会议第 %s 号决议'', m.seq));
    end if;
    perform council_notify((select user_id from person where id = m.ref_id), format(''主线任务审核：%s %s'', motion_label(m),
      case when p_result = ''effective'' then ''决议生效，这一条认定完成'' when p_result = ''vetoed'' then ''被中心主任否决'' else ''联席会议表决未通过'' end));
  elsif m.ref_kind = ''fixed_change'' then
    update fixed_change set status = case when p_result = ''effective'' then ''approved'' else ''rejected'' end,
      note = case when p_result = ''vetoed'' then ''中心主任否决：'' || m.veto_reason when p_result = ''failed'' then ''联席会议表决未通过'' end where id = m.ref_id and status = ''pending'';
    if p_result = ''effective'' then perform council_notify_directors(format(''预算调整待执行：%s 决议已生效，请在议题页按决议调整核定数'', motion_label(m))); end if;
    perform council_notify((select requested_by from fixed_change where id = m.ref_id), format(''预算调整申请：%s %s'', motion_label(m),
      case when p_result = ''effective'' then ''决议生效，待中心负责人执行'' when p_result = ''vetoed'' then ''被中心主任否决'' else ''联席会议表决未通过'' end));
  elsif m.ref_kind = ''period_report'' then
    update period_report set status = case when p_result = ''effective'' then ''approved'' else ''rejected'' end where id = m.ref_id;
    if p_result = ''effective'' then
      insert into budget_review (year, quarter, project_id, note, reviewed_by)
      select r.year, r.quarter, r.project_id, format(E''联席会议第 %s 号决议通过。\n复盘：%s\n本期预算：%s'', m.seq, r.review, r.plan), null from period_report r where r.id = m.ref_id
      on conflict (year, quarter, project_id) do update set note = excluded.note, reviewed_by = null, reviewed_at = now();
    end if;
    perform council_notify((select submitted_by from period_report where id = m.ref_id), format(''预算期预算：%s %s'', motion_label(m),
      case when p_result = ''effective'' then ''决议生效，记为这一期的复盘结论'' when p_result = ''vetoed'' then ''被中心主任否决，请修改后重新提交'' else ''联席会议表决未通过，请修改后重新提交'' end));
    if p_result <> ''effective'' then update period_report set status = ''pending'' where id = m.ref_id; end if;
  elsif m.ref_kind = ''tier'' then');
  if n = d then raise exception '落回函数没有改上'; end if;
  execute n;
end $$;

select expose('request_path_council(text, text, text)', 'submit_fixed_change(uuid, numeric, text)', 'withdraw_fixed_change(uuid)', 'execute_fixed_change(uuid)',
  'submit_period_report(int, int, uuid, text, text)');

create view api.fixed_change as
  select c.id, c.line_id, c.year, c.project_id, p.name as project_name, c.amount_from, c.amount_to, c.reason, (select name from app_user where id = c.requested_by) as requested_by_name,
         c.requested_at, c.status, c.done_at, c.note,
         (select id from motion m where m.ref_kind = 'fixed_change' and m.ref_id = c.id order by created_at desc limit 1) as motion_id,
         (app_role() = 'director' and c.status = 'approved') as can_execute
  from fixed_change c join project p on p.id = c.project_id where app_role() is not null;
create view api.period_report as
  select r.id, r.year, r.quarter, r.project_id, p.name as project_name, r.review, r.plan, (select name from app_user where id = r.submitted_by) as submitted_by_name, r.submitted_at, r.status,
         (select id from motion m where m.ref_kind = 'period_report' and m.ref_id = r.id order by created_at desc limit 1) as motion_id
  from period_report r join project p on p.id = r.project_id where app_role() is not null;
create view api.path_council as
  select m.ref_code as task_code, m.id as motion_id, m.status from motion m join person pr on pr.id = m.ref_id
  where app_role() is not null and m.ref_kind = 'path' and pr.user_id = app_uid();
grant select on api.fixed_change, api.period_report, api.path_council to app_api;

create or replace view api.council_motion as
  select m.id, m.seq, m.mtype, m.category, m.title, m.body, m.link, m.parent_id, (select seq from motion p where p.id = m.parent_id) as parent_seq,
         (select title from motion p where p.id = m.parent_id) as parent_title,
         m.proposer_id, (select name from app_user where id = m.proposer_id) as proposer_name, (select name from app_user where id = m.seconder_id) as seconder_name,
         (select coalesce(jsonb_agg(u.name order by u.name), '[]') from app_user u where u.id = any(m.subjects)) as subject_names,
         m.threshold, m.ballot, m.urgent, m.ref_kind, m.ref_id, m.status, m.round, m.meeting_id, m.online, m.vote_open_at, m.vote_until,
         case when m.status <> 'voting' then m.yes end as yes, case when m.status <> 'voting' then m.no end as no, case when m.status <> 'voting' then m.abstain end as abstain,
         m.eligible, m.note, m.decided_at, m.veto_until, m.veto_reason, m.effective_at, m.body_prev, m.created_at, m.seconded_at,
         (select count(*)::int from motion_vote v where v.motion_id = m.id and v.round = m.round) as cast_count,
         (select choice from motion_vote v where v.motion_id = m.id and v.round = m.round and v.user_id = app_uid()) as my_vote,
         motion_can_vote(m.id, app_uid()) as can_vote,
         (council_voter(app_uid()) and m.status = 'proposed' and m.proposer_id <> app_uid()) as can_second,
         (m.proposer_id = app_uid() and m.status in ('proposed','seconded') and not m.auto) as can_withdraw,
         council_chair() as can_chair,
         (app_role() = 'director' and m.status = 'passed' and m.mtype = 'main' and m.veto_until > now()) as can_veto,
         exists (select 1 from motion_recusal r where r.motion_id = m.id and r.user_id = app_uid()) as recused,
         (select coalesce(jsonb_agg(u.name order by u.name), '[]') from motion_recusal r join app_user u on u.id = r.user_id where r.motion_id = m.id) as recused_names,
         (select count(*)::int from motion_meeting_request r where r.motion_id = m.id and r.round = m.round) as meeting_requests,
         exists (select 1 from motion_meeting_request r where r.motion_id = m.id and r.round = m.round and r.user_id = app_uid()) as my_request,
         (select count(*)::int from motion c where c.parent_id = m.id and c.mtype = 'amend' and c.status in ('proposed','seconded','voting')) as open_amendments,
         m.auto, m.ref_year, m.ref_code,
         (m.ref_kind = 'fixed_change' and m.status = 'effective' and app_role() = 'director' and exists (select 1 from fixed_change c where c.id = m.ref_id and c.status = 'approved')) as can_execute
  from motion m where app_role() is not null;
