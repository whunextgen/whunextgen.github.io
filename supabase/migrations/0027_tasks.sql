-- 任务列表：把一件要办的事派给一个人，拆成几步，办一步勾一步，全部办完后办结。
-- 每个人都能给自己建任务；有「派任务」权限的人（默认中心负责人）能派给别人，也看得到全部任务。
-- 任务可以挂一张经费卡（比如某张卡的结算），卡名只给看得到这张卡的人显示。

create table task (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(btrim(title)) between 1 and 80),
  detail      text check (detail is null or length(detail) <= 2000),
  assignee    uuid not null references app_user,
  due_date    date,
  card_id     uuid references fund_card,
  status      text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_by  uuid not null references app_user,
  created_at  timestamptz not null default now(),
  closed_by   uuid references app_user,
  closed_at   timestamptz,
  close_note  text
);
create index on task (assignee) where status = 'open';

create table task_step (
  id       uuid primary key default gen_random_uuid(),
  task_id  uuid not null references task on delete cascade,
  sort     int not null,
  text     text not null check (length(btrim(text)) between 1 and 200),
  done     boolean not null default false,
  done_by  uuid references app_user,
  done_at  timestamptz,
  note     text check (note is null or length(note) <= 300),
  unique (task_id, sort)
);

select seal('task', 'task_step');
do $$ declare t text; begin
  foreach t in array array['task', 'task_step'] loop
    execute format('create trigger audit after insert or update or delete on %I for each row execute function trg_audit()', t);
  end loop;
end $$;

insert into rbac_perm (code, name, grp, scope, sort) values
  ('task.assign', '给别人派任务，看全部任务', '任务', 'global', 90);
insert into rbac_role_perm (role_id, perm) select r.id, 'task.assign' from rbac_role r where r.code = 'director';

-- 派任务的人、有派任务权限的人能改、能撤、能退回重办
create function can_manage_task(t task) returns boolean language sql stable security definer set search_path = public as $$
  select t.created_by = app_uid() or has_perm('task.assign')
$$;

create function _task_steps(p_task uuid, p_steps text) returns void language plpgsql as $$
declare s text; n int;
begin
  select coalesce(max(sort), 0) into n from task_step where task_id = p_task;
  foreach s in array regexp_split_to_array(coalesce(p_steps, ''), E'\r?\n') loop
    s := btrim(s);
    continue when s = '';
    if length(s) > 200 then raise exception '一步不超过 200 个字：%…', left(s, 20); end if;
    n := n + 1;
    insert into task_step (task_id, sort, text) values (p_task, n, s);
  end loop;
  if n > 40 then raise exception '一个任务最多 40 步，太长的拆成几个任务'; end if;
end $$;

create function create_task(p_title text, p_assignee uuid, p_due date, p_card uuid, p_detail text, p_steps text) returns uuid
language plpgsql security definer set search_path = public as $$
declare tid uuid; who uuid := coalesce(p_assignee, app_uid()); ti text := btrim(coalesce(p_title, ''));
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if ti = '' then raise exception '请写任务的名称'; end if;
  if length(ti) > 80 then raise exception '名称不超过 80 个字，细节写在说明里'; end if;
  if who <> app_uid() and not has_perm('task.assign') then raise exception '你只能给自己建任务，派给别人要有派任务的权限' using errcode = '42501'; end if;
  if not exists (select 1 from app_user where id = who and active) then raise exception '办理人不存在或已停用'; end if;
  if p_card is not null and not can_see_card(p_card) then raise exception '你看不到这张经费卡，不能挂在任务上' using errcode = '42501'; end if;
  insert into task (title, detail, assignee, due_date, card_id, created_by)
  values (ti, nullif(btrim(coalesce(p_detail, '')), ''), who, p_due, p_card, app_uid()) returning id into tid;
  perform _task_steps(tid, p_steps);
  perform notify_user(who, format('%s 给你派了任务「%s」%s', (select name from app_user where id = app_uid()), ti,
    case when p_due is null then '' else '，' || to_char(p_due, 'YYYY-MM-DD') || ' 前办完' end));
  return tid;
end $$;

create function edit_task(p_id uuid, p_title text, p_assignee uuid, p_due date, p_detail text) returns void
language plpgsql security definer set search_path = public as $$
declare t task; ti text := btrim(coalesce(p_title, ''));
begin
  select * into t from task where id = p_id for update;
  if t.id is null then raise exception '任务不存在'; end if;
  if not can_manage_task(t) then raise exception '只有派任务的人能改' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception '已经办结或撤销的任务不能改'; end if;
  if ti = '' then raise exception '请写任务的名称'; end if;
  if length(ti) > 80 then raise exception '名称不超过 80 个字，细节写在说明里'; end if;
  if p_assignee is null or not exists (select 1 from app_user where id = p_assignee and active) then raise exception '办理人不存在或已停用'; end if;
  if p_assignee <> app_uid() and p_assignee <> t.assignee and not has_perm('task.assign') then raise exception '派给别人要有派任务的权限' using errcode = '42501'; end if;
  update task set title = ti, assignee = p_assignee, due_date = p_due, detail = nullif(btrim(coalesce(p_detail, '')), '') where id = p_id;
  if p_assignee <> t.assignee then
    perform notify_user(p_assignee, format('任务「%s」转给你办%s', ti, case when p_due is null then '' else '，' || to_char(p_due, 'YYYY-MM-DD') || ' 前办完' end));
    perform notify_user(t.assignee, format('任务「%s」已转给别人办，不用你办了', ti));
  elsif p_due is distinct from t.due_date then
    perform notify_user(t.assignee, format('任务「%s」的期限改为 %s', ti, coalesce(to_char(p_due, 'YYYY-MM-DD'), '不限期')));
  end if;
end $$;

-- 加步骤：派任务的人和办理人都能加（办的过程中发现还有一步）
create function add_task_steps(p_id uuid, p_steps text) returns void
language plpgsql security definer set search_path = public as $$
declare t task;
begin
  select * into t from task where id = p_id for update;
  if t.id is null then raise exception '任务不存在'; end if;
  if not (can_manage_task(t) or t.assignee = app_uid()) then raise exception '只有派任务的人和办理人能加步骤' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception '已经办结或撤销的任务不能加步骤'; end if;
  if btrim(coalesce(p_steps, '')) = '' then raise exception '请写要加的步骤，一行一步'; end if;
  perform _task_steps(p_id, p_steps);
end $$;

-- 勾一步、取消勾选、写备注：办理人办；派任务的人也能代勾
create function tick_task_step(p_step uuid, p_done boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare s task_step; t task; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into s from task_step where id = p_step;
  if s.id is null then raise exception '这一步不存在'; end if;
  select * into t from task where id = s.task_id for update;
  if not (t.assignee = app_uid() or can_manage_task(t)) then raise exception '只有办理人和派任务的人能勾' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception '已经办结或撤销的任务不能再改步骤'; end if;
  if length(n) > 300 then raise exception '备注不超过 300 个字'; end if;
  update task_step set done = coalesce(p_done, done),
    done_by = case when coalesce(p_done, done) then coalesce(case when p_done is not null and p_done <> s.done then app_uid() end, done_by, app_uid()) end,
    done_at = case when coalesce(p_done, done) then coalesce(case when p_done is not null and p_done <> s.done then now() end, done_at, now()) end,
    note = case when p_note is null then note else n end
  where id = p_step;
end $$;

-- 办结：每一步都勾了才能办结
create function finish_task(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare t task; left_n int; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from task where id = p_id for update;
  if t.id is null then raise exception '任务不存在'; end if;
  if not (t.assignee = app_uid() or can_manage_task(t)) then raise exception '只有办理人和派任务的人能办结' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception '这个任务已经办结或撤销'; end if;
  select count(*) into left_n from task_step where task_id = p_id and not done;
  if left_n > 0 then raise exception '还有 % 步没勾，全部办完再办结', left_n; end if;
  if length(n) > 300 then raise exception '说明不超过 300 个字'; end if;
  update task set status = 'done', closed_by = app_uid(), closed_at = now(), close_note = n where id = p_id;
  perform notify_user(t.created_by, format('%s 办结了任务「%s」%s', (select name from app_user where id = app_uid()), t.title, case when n is null then '' else '：' || n end));
end $$;

-- 撤销：不用办了
create function cancel_task(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare t task; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from task where id = p_id for update;
  if t.id is null then raise exception '任务不存在'; end if;
  if not can_manage_task(t) then raise exception '只有派任务的人能撤销' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception '这个任务已经办结或撤销'; end if;
  if n is null then raise exception '请写为什么撤销'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  update task set status = 'cancelled', closed_by = app_uid(), closed_at = now(), close_note = n where id = p_id;
  perform notify_user(t.assignee, format('任务「%s」撤销了，不用办了：%s', t.title, n));
end $$;

-- 退回重办：办结或撤销的任务重新打开
create function reopen_task(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare t task; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into t from task where id = p_id for update;
  if t.id is null then raise exception '任务不存在'; end if;
  if not can_manage_task(t) then raise exception '只有派任务的人能退回重办' using errcode = '42501'; end if;
  if t.status = 'open' then raise exception '这个任务还在办'; end if;
  if n is null then raise exception '请写哪里还要再办'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  update task set status = 'open', closed_by = null, closed_at = null, close_note = null where id = p_id;
  perform notify_user(t.assignee, format('任务「%s」退回重办：%s', t.title, n));
end $$;

create view api.task as
  select t.id, t.title, t.detail, t.assignee as assignee_id, (select name from app_user where id = t.assignee) as assignee_name,
         t.due_date, case when can_see_card(t.card_id) then t.card_id end as card_id,
         case when can_see_card(t.card_id) then (select name from fund_card where id = t.card_id) end as card_name,
         t.status, t.created_by, (select name from app_user where id = t.created_by) as creator_name, t.created_at,
         (select name from app_user where id = t.closed_by) as closed_by_name, t.closed_at, t.close_note,
         (select count(*) from task_step s where s.task_id = t.id)::int as steps,
         (select count(*) from task_step s where s.task_id = t.id and s.done)::int as steps_done,
         t.assignee = app_uid() as mine, can_manage_task(t) as can_manage
  from task t
  where app_role() is not null and (t.assignee = app_uid() or t.created_by = app_uid() or has_perm('task.assign'));

create view api.task_step as
  select s.id, s.task_id, s.sort, s.text, s.done, (select name from app_user where id = s.done_by) as done_by_name, s.done_at, s.note
  from task_step s join task t on t.id = s.task_id
  where app_role() is not null and (t.assignee = app_uid() or t.created_by = app_uid() or has_perm('task.assign'));

grant select on api.task, api.task_step to app_api;

select expose('create_task(text, uuid, date, uuid, text, text)', 'edit_task(uuid, text, uuid, date, text)', 'add_task_steps(uuid, text)',
  'tick_task_step(uuid, boolean, text)', 'finish_task(uuid, text)', 'cancel_task(uuid, text)', 'reopen_task(uuid, text)');
