-- 登记日：研究单元的申请和双周表登记，只在每两周一期的第一天办（黄济民 2026-11-25 定）。
--   双周表：只有登记日当天可以登记和修改，交上一期的结果和这一期的计划；不再有期末截止和三日补登。
--   研究单元申请：平时可以提交，所挂课题负责人的同意、退回和助理的核对都在登记日办。
--   第一期（2026-11-23 起）切换时放到了 11-24 24:00，不再放宽。
create function is_register_day() returns boolean language sql stable security definer set search_path = public as $$
  select app_today() = token_period(app_today())
$$;
create function biweekly_open(p_period date) returns boolean language sql stable security definer set search_path = public as $$
  select p_period = token_period(app_today())
     and (app_today() = p_period or (p_period = date '2026-11-23' and app_today() <= date '2026-11-24'))
$$;
create function next_register_day() returns date language sql stable security definer set search_path = public as $$
  select case when app_today() = token_period(app_today()) then app_today() else token_period(app_today()) + 14 end
$$;
select expose('is_register_day()', 'next_register_day()');

do $$
declare d text; n text; f text; gate text := 'if not is_register_day() then raise exception ''研究单元申请只在每期第一天办理，下一个办理日为 %'', to_char(next_register_day(), ''MM-DD''); end if;';
begin
  -- 双周表：只在登记日
  d := pg_get_functiondef('public.save_biweekly_report(uuid, date, text, text, text, text, text, text, text)'::regprocedure);
  n := replace(d, 'if not (p_period = cur or (p_period = cur - 14 and app_today() <= cur + 2)) then
    raise exception ''仅可登记本期；上一期在结束后三日内可以补登'';
  end if;',
    'if p_period <> cur then raise exception ''仅可登记本期''; end if;
  if not biweekly_open(p_period) then raise exception ''双周表只在每期第一天登记，本期的登记日已过，下一个登记日为 %'', to_char(cur + 14, ''MM-DD''); end if;');
  if n = d then raise exception 'save_biweekly_report：没有找到登记时段的判断'; end if;
  execute n;
  -- 研究单元申请：同意、核对、退回只在登记日
  foreach f in array array['public.approve_unit(uuid)', 'public.confirm_unit(uuid)', 'public.return_unit(uuid, text)'] loop
    d := pg_get_functiondef(f::regprocedure);
    n := regexp_replace(d, '(if app_role\(\) is null then raise exception ''请先登录'' using errcode = ''42501''; end if;)', E'\\1\n  ' || replace(gate, '\', '\\'));
    if n = d then n := regexp_replace(d, '(\nbegin\n)', E'\\1  ' || replace(gate, '\', '\\') || E'\n'); end if;
    if n = d or n not like '%is_register_day()%' then raise exception '%：没有找到插入位置', f; end if;
    execute n;
  end loop;
end $$;

-- 登记情况：登记日过了还没登记的，当期就算未登记一期；不再有补登
create or replace view api.biweekly_status as
  select p.id as project_id, p.code as unit_code, p.name as unit_name, p.parent_id as topic_id, t.code as topic_code, t.name as topic_name,
         p.owner_id as leader_id, (select name from app_user where id = p.owner_id) as leader_name,
         s.cur as period_start, s.cur + 13 as period_end,
         exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = s.cur) as filled,
         exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = s.cur - 14) as prev_filled,
         false as prev_open,
         l.period_start as last_period, l.stage as last_stage,
         greatest(0, ((s.cur - 14) - greatest(s.since, coalesce((select max(r.period_start) from biweekly_report r where r.project_id = p.id and r.period_start < s.cur) + 14, s.since))) / 14 + 1)
           + case when s.cur >= s.since and not biweekly_open(s.cur) and not exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = s.cur) then 1 else 0 end as missed,
         is_on_project(p.id) as can_fill,
         biweekly_open(s.cur) as open, next_register_day() as register_day
  from project p left join project t on t.id = p.parent_id
  cross join lateral (select token_period(app_today()) as cur, biweekly_from(p.id) as since) s
  left join lateral (select r.period_start, r.stage from biweekly_report r where r.project_id = p.id order by r.period_start desc limit 1) l on true
  where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;

-- 群通报改为围着登记日：前一日提醒（@所有人）、登记日当天、次日出结果
alter table group_digest drop constraint group_digest_kind_check;
alter table group_digest add constraint group_digest_kind_check check (kind in ('mid', 'last', 'final', 'eve', 'open'));
create or replace function group_digest_tick() returns text
language plpgsql security definer set search_path = public as $$
declare cur date := token_period(app_today()); d int := app_today() - token_period(app_today());
        k text; ps date; span text; total int; n_ok int; n_no int; l_no text; l_long text; msg text;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if d = 13 then k := 'eve'; ps := cur + 14;
  elsif d = 0 and cur > date '2026-11-23' then k := 'open'; ps := cur;
  elsif d = 1 and cur > date '2026-11-23' then k := 'final'; ps := cur;
  else return null; end if;
  insert into group_digest (kind, period_start) values (k, ps) on conflict do nothing;
  if not found then return null; end if;
  span := to_char(ps, 'MM-DD') || ' 至 ' || to_char(ps + 13, 'MM-DD');
  if k = 'eve' then
    perform notify_group(format('登记日提醒：明天（%s）是 %s 一期的登记日。双周表只在当天登记，交上一期的结果和这一期的计划；研究单元申请的同意和核对也只在当天办理。当天 24:00 截止，不补登。', to_char(ps, 'MM-DD'), span), null, null, true);
    return k;
  elsif k = 'open' then
    perform notify_group(format('登记日：今天（%s）是 %s 一期的登记日。请各研究单元在今天 24:00 前登记双周表；课题负责人和助理请在今天办完研究单元申请。', to_char(ps, 'MM-DD'), span));
    return k;
  end if;
  with due as (
    select p.code, p.name || '（' || coalesce((select name from app_user where id = p.owner_id), '—') || '）' as label,
           exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = ps) as filled,
           biweekly_from(p.id) as since,
           (select max(r.period_start) from biweekly_report r where r.project_id = p.id and r.period_start < ps) as last
    from project p where p.layer = 'paper' and p.active and not p.proposed and biweekly_from(p.id) <= ps
  ), s as (
    select *, case when filled then 0 else (ps - greatest(since, coalesce(last + 14, since))) / 14 + 1 end as streak from due
  )
  select count(*), count(*) filter (where filled), count(*) filter (where not filled),
         string_agg('· ' || label, E'\n' order by code) filter (where not filled),
         string_agg('· ' || label || ' ' || streak || ' 期', E'\n' order by code) filter (where streak >= 2)
    into total, n_ok, n_no, l_no, l_long from s;
  if total = 0 then return null; end if;
  msg := format('双周表本期结果：%s 一期的登记已于 %s 24:00 截止，应登记 %s 个研究单元，已登记 %s 个，未登记 %s 个。', span, to_char(ps, 'MM-DD'), total, n_ok, n_no)
    || coalesce(E'\n未登记\n' || l_no, '') || coalesce(E'\n连续两期及以上未登记\n' || l_long, '')
    || case when l_long is not null then E'\n说明\n连续两期未登记的研究单元转为停滞，负责人须到联席会议说明。' else '' end;
  perform notify_group(msg);
  return k;
end $$;

-- 飞书任务：登记日当天建，截止日就是当天；登记日过了还没登记的，把任务撤掉
create or replace function biweekly_task_plan(p_create boolean default true)
returns table (act text, project_id uuid, period_start date, target_id text, summary text, due date, task_guid text)
language plpgsql security definer set search_path = public as $$
declare cur date := token_period(app_today());
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if p_create and biweekly_open(cur) then
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
           '登记双周表：' || p.name || '（' || to_char(t.period_start, 'MM-DD') || ' 登记日，当天 24:00 截止）',
           t.period_start, t.task_guid
    from biweekly_task t join project p on p.id = t.project_id join app_user u on u.id = t.user_id
    where t.attempts < 5 and (
      (t.state = 'new' and p_create and biweekly_open(t.period_start)
        and not exists (select 1 from biweekly_report r where r.project_id = t.project_id and r.period_start = t.period_start))
      or (t.state = 'open' and exists (select 1 from biweekly_report r where r.project_id = t.project_id and r.period_start = t.period_start))
      or (t.state = 'open' and not biweekly_open(t.period_start)))
    order by t.period_start, p.code limit 30;
end $$;
