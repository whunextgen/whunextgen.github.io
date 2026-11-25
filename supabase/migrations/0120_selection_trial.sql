-- 项目双选与试做期（黄济民 2026-11-26，依据陈秀栋的需求设计，按章程第五章调整）：
--   招募信息：课题和研究单元公开研究什么、加入后做什么、需要什么基础、接收对象、是否接收、联系谁
--   意向：成员表达意向、附上研究兴趣和作品链接，负责人和联系人看得到
--   试做期：负责人为新加入的 Intern、Assistant 开试做期（一个月，可延长一次）；指导人为 Researcher 及以上、申报没有私人关系
--     第二周阶段检查，期满结论（继续、延长、调整、结束）；结论报联席会议备案；结束参与的本人七日内可申诉，列入联席会议议程
--   考察标准由联席会议确定（《项目双选与试做期规则（草案）》作为议题交联席会议表决）

-- ---------- 招募信息 ----------
create table project_recruit (
  project_id uuid primary key references project(id),
  intro      text check (intro is null or length(intro) <= 500),
  tasks      text check (tasks is null or length(tasks) <= 800),
  needs      text check (needs is null or length(needs) <= 300),
  audience   text check (audience is null or length(audience) <= 100),
  status     text not null default 'open' check (status in ('open','paused','full')),
  contact_id uuid references app_user(id),
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now()
);
select seal('project_recruit');

create function save_project_recruit(p_project uuid, p_intro text, p_tasks text, p_needs text, p_audience text, p_status text, p_contact uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p project;
begin
  select * into p from project where id = p_project;
  if not found or not p.active or p.proposed or p.kind = 'public' then raise exception '只有在用的课题和研究单元可以招募'; end if;
  if not has_perm('budget.project', p_project) then raise exception '由负责人或副手维护招募信息' using errcode = '42501'; end if;
  if p_status not in ('open','paused','full') then raise exception '状态只有正在接收、暂停、已满'; end if;
  if p_contact is not null and not exists (select 1 from app_user where id = p_contact and active) then raise exception '联系人不在中台'; end if;
  insert into project_recruit (project_id, intro, tasks, needs, audience, status, contact_id, updated_by)
  values (p_project, nullif(btrim(coalesce(p_intro, '')), ''), nullif(btrim(coalesce(p_tasks, '')), ''), nullif(btrim(coalesce(p_needs, '')), ''),
          nullif(btrim(coalesce(p_audience, '')), ''), p_status, coalesce(p_contact, p.owner_id), app_uid())
  on conflict (project_id) do update set intro = excluded.intro, tasks = excluded.tasks, needs = excluded.needs, audience = excluded.audience,
    status = excluded.status, contact_id = excluded.contact_id, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------- 意向 ----------
create table recruit_interest (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id),
  user_id    uuid not null references app_user(id),
  note       text not null check (length(btrim(note)) between 1 and 800),
  link       text check (link is null or (link ~ '^https?://' and length(link) <= 500)),
  status     text not null default 'open' check (status in ('open','joined','withdrawn')),
  created_at timestamptz not null default now()
);
create unique index recruit_interest_open on recruit_interest (project_id, user_id) where status = 'open';
select seal('recruit_interest');

create function express_interest(p_project uuid, p_note text, p_link text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare p project; r project_recruit; v_id uuid; lk text := nullif(btrim(coalesce(p_link, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or not p.active or p.proposed or p.kind = 'public' then raise exception '课题或研究单元不存在'; end if;
  select * into r from project_recruit where project_id = p_project;
  if found and r.status <> 'open' then raise exception '这里现在%，暂不接收', case r.status when 'paused' then '暂停接收' else '已满' end; end if;
  if exists (select 1 from project_member where project_id = p_project and user_id = app_uid() and left_on is null) then raise exception '已在成员名单里'; end if;
  if lk is not null and lk !~ '^https?://' then raise exception '链接须以 http 开头'; end if;
  insert into recruit_interest (project_id, user_id, note, link) values (p_project, app_uid(), btrim(p_note), lk) returning recruit_interest.id into v_id;
  perform notify_user(coalesce(r.contact_id, p.owner_id), format('双选意向：%s 想参与「%s」：%s', (select name from app_user where id = app_uid()), p.name, left(btrim(p_note), 120)));
  return v_id;
exception when unique_violation then raise exception '已表达过意向，等负责人联系';
end $$;

create function withdraw_interest(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update recruit_interest set status = 'withdrawn' where id = p_id and user_id = app_uid() and status = 'open';
  if not found then raise exception '没有可以撤回的意向'; end if;
end $$;

-- 加入成员名单时，意向记为已加入
create function trg_interest_joined() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update recruit_interest set status = 'joined' where project_id = new.project_id and user_id = new.user_id and status = 'open';
  return new;
end $$;
create trigger interest_joined after insert on project_member for each row execute function trg_interest_joined();

-- ---------- 试做期 ----------
create table trial (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references project(id),
  user_id       uuid not null references app_user(id),
  mentor_id     uuid not null references app_user(id),
  start_on      date not null,
  end_on        date not null,
  extended      boolean not null default false,
  task_title    text not null check (length(btrim(task_title)) between 1 and 80),
  task_detail   text not null check (length(btrim(task_detail)) between 1 and 1000),
  task_due      date not null,
  status        text not null default 'running' check (status in ('running','done')),
  mid_note      text, mid_link text, mid_at timestamptz,
  mid_feedback  text, mid_feedback_at timestamptz,
  final_note    text, final_link text, final_at timestamptz,
  conclusion    text check (conclusion in ('continue','extend','adjust','end')),
  conclusion_note text,
  concluded_at  timestamptz,
  started_by    uuid references app_user(id),
  created_at    timestamptz not null default now()
);
create unique index trial_running on trial (project_id, user_id) where status = 'running';
create table trial_log (
  trial_id   uuid not null references trial(id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null,
  conclusion text, note text, end_on date
);
create table trial_notice (trial_id uuid not null references trial(id) on delete cascade, kind text not null, primary key (trial_id, kind));
select seal('trial', 'trial_log', 'trial_notice');
create trigger audit after insert or update or delete on trial for each row execute function trg_audit();

create function trial_label(c text) returns text language sql immutable as $$
  select case c when 'continue' then '继续参与' when 'extend' then '延长试做' when 'adjust' then '调整课题或指导安排' when 'end' then '结束本课题参与' end
$$;

-- 开试做期：负责人或副手；成员不在名单里的一并加入
create function start_trial(p_project uuid, p_user uuid, p_mentor uuid, p_end date, p_task_title text, p_task_detail text, p_task_due date, p_no_conflict boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; v_id uuid;
begin
  select * into p from project where id = p_project;
  if not found or not p.active or p.proposed or p.kind = 'public' then raise exception '课题或研究单元不存在'; end if;
  if not has_perm('budget.project', p_project) then raise exception '由负责人或副手开试做期' using errcode = '42501'; end if;
  if user_rank(p_user) not in ('intern','assistant') then raise exception '试做期适用于 Intern 和 Assistant'; end if;
  if not user_rank_at_least(p_mentor, 'researcher') then raise exception '指导人由 Researcher 及以上担任'; end if;
  if p_mentor = p_user then raise exception '指导人不能是本人'; end if;
  if not coalesce(p_no_conflict, false) then raise exception '指导人须与成员没有私人关系；有的，请另选指导人'; end if;
  if p_end is null or p_end <= app_today() or p_end > app_today() + 31 then raise exception '试做期为一个月，截止日期须在今天之后、一个月以内'; end if;
  if p_task_due is null or p_task_due < app_today() or p_task_due > p_end then raise exception '小任务的提交日期须在试做期内'; end if;
  if exists (select 1 from trial where project_id = p_project and user_id = p_user and status = 'running') then raise exception '这名成员在这里已有试做期'; end if;
  if not exists (select 1 from project_member where project_id = p_project and user_id = p_user and left_on is null) then perform add_project_member(p_project, p_user); end if;
  insert into trial (project_id, user_id, mentor_id, start_on, end_on, task_title, task_detail, task_due, started_by)
  values (p_project, p_user, p_mentor, app_today(), p_end, btrim(p_task_title), btrim(p_task_detail), p_task_due, app_uid()) returning trial.id into v_id;
  insert into trial_log (trial_id, kind, note, end_on) values (v_id, 'start', btrim(p_task_title), p_end);
  perform notify_user(p_user, format('试做期开始：「%s」，指导人 %s，至 %s。首个小任务：%s，%s 前提交', p.name, (select name from app_user where id = p_mentor), p_end, btrim(p_task_title), p_task_due));
  if p_mentor <> app_uid() then perform notify_user(p_mentor, format('试做期指导：你是 %s 在「%s」的试做期指导人，至 %s', (select name from app_user where id = p_user), p.name, p_end)); end if;
  return v_id;
end $$;

-- 成员提交阶段进展或期满交付
create function submit_trial(p_id uuid, p_stage text, p_note text, p_link text default null) returns void language plpgsql security definer set search_path = public as $$
declare t trial; n text := btrim(coalesce(p_note, '')); lk text := nullif(btrim(coalesce(p_link, '')), '');
begin
  select * into t from trial where id = p_id for update;
  if not found or t.user_id <> app_uid() then raise exception '只能提交本人的试做' using errcode = '42501'; end if;
  if t.status <> 'running' then raise exception '试做期已办结'; end if;
  if p_stage not in ('mid','final') then raise exception '阶段不对'; end if;
  if n = '' or length(n) > 1500 then raise exception '请写明进展，不超过 1500 字'; end if;
  if lk is not null and lk !~ '^https?://' then raise exception '链接须以 http 开头'; end if;
  if p_stage = 'mid' then update trial set mid_note = n, mid_link = lk, mid_at = now() where id = p_id;
  else update trial set final_note = n, final_link = lk, final_at = now() where id = p_id; end if;
  insert into trial_log (trial_id, kind, note) values (p_id, p_stage, left(n, 300));
  perform notify_user(t.mentor_id, format('试做%s：%s 提交了%s，请查看并%s', case p_stage when 'mid' then '阶段进展' else '期满交付' end,
    (select name from app_user where id = t.user_id), case p_stage when 'mid' then '阶段进展' else '交付物和自述' end, case p_stage when 'mid' then '反馈' else '给出期满结论' end));
end $$;

create function trial_feedback(p_id uuid, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare t trial; n text := btrim(coalesce(p_note, ''));
begin
  select * into t from trial where id = p_id for update;
  if not found or t.mentor_id <> app_uid() then raise exception '由指导人反馈' using errcode = '42501'; end if;
  if t.status <> 'running' then raise exception '试做期已办结'; end if;
  if n = '' or length(n) > 1500 then raise exception '请写明反馈：已完成什么、遇到什么困难、下一阶段继续或调整什么'; end if;
  update trial set mid_feedback = n, mid_feedback_at = now() where id = p_id;
  insert into trial_log (trial_id, kind, note) values (p_id, 'feedback', left(n, 300));
  perform notify_user(t.user_id, format('试做反馈：指导人 %s 对你的阶段进展作了反馈', (select name from app_user where id = app_uid())));
end $$;

-- 期满结论：由指导人给出；延长只能一次；结束参与的移出名单；结论报联席会议备案
create function conclude_trial(p_id uuid, p_conclusion text, p_note text, p_new_end date default null, p_new_task text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t trial; p project; n text := btrim(coalesce(p_note, '')); k int; who uuid;
begin
  select * into t from trial where id = p_id for update;
  if not found or t.mentor_id <> app_uid() then raise exception '由指导人给出期满结论' using errcode = '42501'; end if;
  if t.status <> 'running' then raise exception '试做期已办结'; end if;
  if trial_label(p_conclusion) is null then raise exception '结论只有继续参与、延长试做、调整课题或指导安排、结束本课题参与'; end if;
  if n = '' or length(n) > 1500 then raise exception '请对照考察标准写明结论的理由'; end if;
  select * into p from project where id = t.project_id;
  if p_conclusion = 'extend' then
    if t.extended then raise exception '试做期只能延长一次'; end if;
    if p_new_end is null or p_new_end <= app_today() or p_new_end > greatest(t.end_on, app_today()) + 31 then raise exception '延长不超过一个月，写明新的截止日期'; end if;
    if nullif(btrim(coalesce(p_new_task, '')), '') is null then raise exception '写明延长期间要完成的任务'; end if;
    update trial set extended = true, end_on = p_new_end, task_title = left(btrim(p_new_task), 80), task_detail = btrim(p_new_task), task_due = p_new_end,
      final_note = null, final_link = null, final_at = null where id = p_id;
    insert into trial_log (trial_id, kind, conclusion, note, end_on) values (p_id, 'conclude', 'extend', n, p_new_end);
    perform notify_user(t.user_id, format('试做期延长：「%s」延长至 %s，任务：%s', p.name, p_new_end, left(btrim(p_new_task), 120)));
    return;
  end if;
  if p_conclusion = 'end' then
    k := member_holding(t.project_id, t.user_id);
    if k > 0 then raise exception '该成员在这里尚有 % 项接口额度未收回，收回后才能结束参与', k; end if;
    update project_member set left_on = app_today(), removed_by = app_uid() where project_id = t.project_id and user_id = t.user_id and left_on is null;
  end if;
  update trial set status = 'done', conclusion = p_conclusion, conclusion_note = n, concluded_at = now() where id = p_id;
  insert into trial_log (trial_id, kind, conclusion, note) values (p_id, 'conclude', p_conclusion, n);
  perform notify_user(t.user_id, format('试做期结论：「%s」%s。%s%s', p.name, trial_label(p_conclusion), left(n, 200),
    case when p_conclusion = 'end' then '。结论只影响这里的成员资格，不影响身份；不同意的，可以在七日内向联席会议申诉' else '' end));
  if p_conclusion = 'adjust' then
    for who in select id from app_user where active and user_perm(id, 'budget.evaluate') loop
      perform notify_user(who, format('试做期待协调：%s 在「%s」的试做结论为调整课题或指导安排，请协调', (select name from app_user where id = t.user_id), p.name));
    end loop;
  end if;
end $$;

-- 申诉：结束参与的，七日内；列入联席会议议程，免附议，本人可到会陈述；通过的恢复成员资格
create function appeal_trial(p_id uuid, p_reason text) returns uuid language plpgsql security definer set search_path = public as $$
declare t trial; p project; r text := btrim(coalesce(p_reason, ''));
begin
  select * into t from trial where id = p_id;
  if not found or t.user_id <> app_uid() then raise exception '由本人申诉' using errcode = '42501'; end if;
  if t.conclusion is distinct from 'end' then raise exception '只有结束本课题参与的结论可以申诉'; end if;
  if t.concluded_at < now() - interval '7 days' then raise exception '申诉须在结论作出后七日内提出'; end if;
  if r = '' or length(r) > 2000 then raise exception '请写明申诉理由，不超过 2000 字'; end if;
  select * into p from project where id = t.project_id;
  return motion_auto('trial_appeal', p_id, null, 'personnel', format('%s 申诉：恢复在「%s」的成员资格', (select name from app_user where id = t.user_id), p.name),
    format(E'%s 对试做期结论的申诉\n课题或研究单元：%s\n指导人：%s\n试做期：%s 至 %s\n指导人的结论：结束本课题参与。%s\n\n申诉理由：\n%s\n\n表决通过、否决期满后，恢复其成员资格。',
      (select name from app_user where id = t.user_id), p.name, (select name from app_user where id = t.mentor_id), t.start_on, t.end_on, coalesce(t.conclusion_note, ''), r),
    app_uid(), array[t.user_id, t.mentor_id]);
end $$;

alter table motion drop constraint motion_ref_kind_check;
alter table motion add constraint motion_ref_kind_check check (ref_kind in ('assessment','unit','tier','path','fixed_change','period_report','unit_stall','project_end','removal','trial_appeal'));

do $$
declare d text := pg_get_functiondef('public.motion_apply(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, E'  elsif m.ref_kind = ''removal'' then',
E'  elsif m.ref_kind = ''trial_appeal'' then
    if p_result = ''effective'' then
      insert into project_member (project_id, user_id, joined_on, added_by)
      select tr.project_id, tr.user_id, on_, null from trial tr where tr.id = m.ref_id
        and not exists (select 1 from project_member x where x.project_id = tr.project_id and x.user_id = tr.user_id and x.left_on is null);
      insert into trial_log (trial_id, kind, note) values (m.ref_id, ''appeal'', format(''联席会议第 %s 号决议：恢复成员资格'', m.seq));
    end if;
    perform council_notify((select user_id from trial where id = m.ref_id), format(''申诉结果：%s %s'', motion_label(m),
      case when p_result = ''effective'' then ''决议生效，已恢复成员资格'' when p_result = ''vetoed'' then ''被中心主任否决'' else ''联席会议表决未通过'' end));
  elsif m.ref_kind = ''removal'' then');
  if n = d then raise exception '落回函数没有改上'; end if;
  execute n;
end $$;

-- 提醒：首周提醒小任务截止；第二周阶段检查；第三周提醒；到期请指导人给结论
create function trial_tick() returns int language plpgsql security definer set search_path = public as $$
declare t record; k int := 0; d int;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for t in select x.*, p.name as pname from trial x join project p on p.id = x.project_id where x.status = 'running' loop
    d := app_today() - t.start_on;
    if d >= 5 and app_today() <= t.task_due then
      insert into trial_notice values (t.id, 'due') on conflict do nothing;
      if found then perform notify_sys(t.user_id, format('试做提醒：「%s」的首个小任务「%s」%s 截止', t.pname, t.task_title, t.task_due)); k := k + 1; end if;
    end if;
    if d >= 14 and t.mid_at is null then
      insert into trial_notice values (t.id, 'mid') on conflict do nothing;
      if found then perform notify_sys(t.user_id, format('试做阶段检查：「%s」已满两周，请在「双选」页提交简短进展并附上链接', t.pname)); k := k + 1; end if;
    end if;
    if d >= 21 then
      insert into trial_notice values (t.id, 'w3') on conflict do nothing;
      if found then perform notify_sys(t.user_id, format('试做提醒：「%s」的试做期 %s 到期，请准备交付物和简短自述', t.pname, t.end_on)); k := k + 1; end if;
    end if;
    if app_today() >= t.end_on then
      insert into trial_notice values (t.id, 'end:' || t.end_on) on conflict do nothing;
      if found then perform notify_sys(t.mentor_id, format('试做期到期：%s 在「%s」的试做期今天到期，请在「双选」页给出期满结论', (select name from app_user where id = t.user_id), t.pname)); k := k + 1; end if;
    end if;
  end loop;
  return k;
end $$;

select expose('save_project_recruit(uuid, text, text, text, text, text, uuid)', 'express_interest(uuid, text, text)', 'withdraw_interest(uuid)',
  'start_trial(uuid, uuid, uuid, date, text, text, date, boolean)', 'submit_trial(uuid, text, text, text)', 'trial_feedback(uuid, text)',
  'conclude_trial(uuid, text, text, date, text)', 'appeal_trial(uuid, text)');

-- ---------- 视图 ----------
create view api.recruit as
  select p.id, p.code, p.name, p.layer, p.parent_id, (select name from project q where q.id = p.parent_id) as parent_name,
         (select name from app_user where id = p.owner_id) as owner_name,
         r.intro, r.tasks, r.needs, r.audience, coalesce(r.status, 'unset') as status, coalesce(r.contact_id, p.owner_id) as contact_id,
         (select name from app_user where id = coalesce(r.contact_id, p.owner_id)) as contact_name, r.updated_at,
         (select count(*)::int from project_member m where m.project_id = p.id and m.left_on is null) as members,
         has_perm('budget.project', p.id) as can_manage,
         exists (select 1 from project_member m where m.project_id = p.id and m.user_id = app_uid() and m.left_on is null) as am_member,
         exists (select 1 from recruit_interest i where i.project_id = p.id and i.user_id = app_uid() and i.status = 'open') as my_interest
  from project p left join project_recruit r on r.project_id = p.id
  where app_role() is not null and p.active and not p.proposed and p.kind <> 'public' and p.layer in ('big','paper');

create view api.recruit_interest as
  select i.id, i.project_id, p.name as project_name, i.user_id, u.name as user_name, rank_label(user_rank(i.user_id)) as rank_label, i.note, i.link, i.status, i.created_at,
         (i.user_id = app_uid()) as mine
  from recruit_interest i join project p on p.id = i.project_id join app_user u on u.id = i.user_id
  left join project_recruit r on r.project_id = i.project_id
  where app_role() is not null and (i.user_id = app_uid() or has_perm('budget.project', i.project_id) or r.contact_id = app_uid());

create view api.trial as
  select t.id, t.project_id, p.name as project_name, p.layer, t.user_id, u.name as user_name, rank_label(user_rank(t.user_id)) as rank_label,
         t.mentor_id, (select name from app_user where id = t.mentor_id) as mentor_name, t.start_on, t.end_on, t.extended, t.task_title, t.task_detail, t.task_due, t.status,
         t.mid_note, t.mid_link, t.mid_at, t.mid_feedback, t.mid_feedback_at, t.final_note, t.final_link, t.final_at,
         t.conclusion, trial_label(t.conclusion) as conclusion_label, t.conclusion_note, t.concluded_at,
         case when t.status <> 'running' then 'done' when app_today() >= t.end_on then 'final' when t.mid_at is not null and t.mid_feedback_at is null then 'feedback'
              when app_today() - t.start_on >= 14 and t.mid_at is null then 'mid' else 'running' end as stage,
         (t.user_id = app_uid()) as mine, (t.mentor_id = app_uid()) as am_mentor, has_perm('budget.project', t.project_id) as can_manage,
         (t.user_id = app_uid() and t.conclusion = 'end' and t.concluded_at > now() - interval '7 days'
           and not exists (select 1 from motion m where m.ref_kind = 'trial_appeal' and m.ref_id = t.id)) as can_appeal,
         (select id from motion m where m.ref_kind = 'trial_appeal' and m.ref_id = t.id order by created_at desc limit 1) as appeal_motion_id
  from trial t join project p on p.id = t.project_id join app_user u on u.id = t.user_id
  where app_role() is not null and (t.user_id = app_uid() or t.mentor_id = app_uid() or has_perm('budget.project', t.project_id));

-- 报联席会议备案：办结的试做期结论
create view api.trial_filing as
  select t.id, p.name as project_name, u.name as user_name, rank_label(user_rank(t.user_id)) as rank_label, (select name from app_user where id = t.mentor_id) as mentor_name,
         t.start_on, t.end_on, trial_label(t.conclusion) as conclusion_label, t.conclusion, t.conclusion_note, t.concluded_at
  from trial t join project p on p.id = t.project_id join app_user u on u.id = t.user_id
  where app_role() is not null and t.status = 'done' and (council_voter(app_uid()) or council_chair() or t.user_id = app_uid() or t.mentor_id = app_uid());

grant select on api.recruit, api.recruit_interest, api.trial, api.trial_filing to app_api;
