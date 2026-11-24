-- 双周表接飞书任务：每期给还没登记的研究单元负责人建一条飞书任务，截止日为本期最后一天；
-- 登记后任务自动完成；补登期过了仍没登记的，把任务撤掉（已经登记不了，留着也办不成）。
-- 任务由发送端在飞书里建，这里只记每个研究单元每期对应哪条任务、办到哪一步。
create table biweekly_task (
  project_id uuid not null references project(id),
  period_start date not null check (period_start = token_period(period_start)),
  user_id uuid not null references app_user(id),
  state text not null default 'new' check (state in ('new', 'open', 'done', 'dropped', 'failed')),
  task_guid text,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, period_start)
);
select seal('biweekly_task');

-- 由定时任务调用，返回这一轮要在飞书里做的事：
--   create 建任务（本期未登记、负责人在用且绑了飞书、还没建过）；done 标为完成（已登记）；drop 撤掉（补登期已过仍未登记）
-- p_create 为假时不建新任务（夜里不打扰人），完成和撤掉照常
create function biweekly_task_plan(p_create boolean default true)
returns table (act text, project_id uuid, period_start date, target_id text, summary text, due date, task_guid text)
language plpgsql security definer set search_path = public as $$
declare cur date := token_period(app_today());
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if p_create then
    insert into biweekly_task (project_id, period_start, user_id)
    select p.id, cur, p.owner_id from project p join app_user u on u.id = p.owner_id
    where p.layer = 'paper' and p.active and not p.proposed and biweekly_from(p.id) <= cur
      and u.active and coalesce(u.feishu_union_id, u.feishu_open_id) is not null
      and not exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = cur)
    on conflict do nothing;
  end if;
  return query
    select case when t.state = 'new' then 'create'
                when exists (select 1 from biweekly_report r where r.project_id = t.project_id and r.period_start = t.period_start) then 'done'
                else 'drop' end,
           t.project_id, t.period_start, coalesce(u.feishu_union_id, u.feishu_open_id),
           '登记双周表：' || p.name || '（' || to_char(t.period_start, 'MM-DD') || ' 至 ' || to_char(t.period_start + 13, 'MM-DD') || '）',
           t.period_start + 13, t.task_guid
    from biweekly_task t join project p on p.id = t.project_id join app_user u on u.id = t.user_id
    where t.attempts < 5 and (
      (t.state = 'new' and p_create and t.period_start = cur
        and not exists (select 1 from biweekly_report r where r.project_id = t.project_id and r.period_start = t.period_start))
      or (t.state = 'open' and exists (select 1 from biweekly_report r where r.project_id = t.project_id and r.period_start = t.period_start))
      or (t.state = 'open' and app_today() > t.period_start + 16))
    order by t.period_start, p.code limit 30;
end $$;

-- 发送端回报每一条办得怎样
create function biweekly_task_mark(p_project uuid, p_period date, p_act text, p_ok boolean, p_guid text default null, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update biweekly_task set updated_at = now(), attempts = case when p_ok then 0 else attempts + 1 end,
    last_error = case when p_ok then null else left(p_error, 300) end,
    task_guid = case when p_ok and p_act = 'create' then p_guid else task_guid end,
    state = case when not p_ok then (case when attempts + 1 >= 5 then 'failed' else state end)
                 when p_act = 'create' then 'open' when p_act = 'done' then 'done' when p_act = 'drop' then 'dropped' else state end
  where project_id = p_project and period_start = p_period;
end $$;
select expose('biweekly_task_plan(boolean)', 'biweekly_task_mark(uuid, date, text, boolean, text, text)');
