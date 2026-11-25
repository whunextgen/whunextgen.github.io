-- Zoom 会议签到和中心日历：
--   Zoom：周日讲座用 Zoom。会上可以挂 Zoom 会议号（链接里 /j/ 之后的数字）；定时任务用 Zoom 的服务端应用凭证读参会报告，
--         按邮箱、再按姓名（含认领过的别名）对上中台账号自动签到；对不上的姓名记下来，开会的人认领后以后同名自动对上。会后读云录制挂上链接。
--   中心日历：飞书会议都加到中心日历。中台读中心日历里同一时段、标题对得上的日程，把其中的飞书会议号自动挂到开着的会上。
--         中心日历的编号由中心负责人在中台填写。

alter table attend_event add column zoom_id text check (zoom_id is null or zoom_id ~ '^[0-9]{9,12}$'),
  add column sync_unmatched text[];

create table name_alias (
  name    text primary key check (length(btrim(name)) between 1 and 80),
  user_id uuid not null references app_user(id),
  set_by  uuid references app_user(id),
  set_at  timestamptz not null default now()
);
select seal('name_alias');
create trigger audit after insert or update or delete on name_alias for each row execute function trg_audit();

create function set_zoom_meeting(p_event uuid, p_link text) returns text language plpgsql security definer set search_path = public as $$
declare e attend_event; l text := btrim(coalesce(p_link, '')); v_id text;
begin
  select * into e from attend_event where id = p_event;
  if not found then raise exception '会议不存在'; end if;
  if not can_run_meeting(e.kind, e.seminar) then raise exception '由开会的人填写' using errcode = '42501'; end if;
  if l = '' then update attend_event set zoom_id = null where id = p_event; return null; end if;
  v_id := coalesce(substring(l from '/j/([0-9]{9,12})'), regexp_replace(l, '[^0-9]', '', 'g'));
  if v_id !~ '^[0-9]{9,12}$' then raise exception 'Zoom 会议号是 9 到 12 位数字，可以直接粘贴会议链接'; end if;
  update attend_event set zoom_id = v_id, sync_note = null, synced_at = null where id = p_event;
  return v_id;
end $$;

-- 认领对不上的姓名：记为别名，签到，以后同名自动对上
create function claim_name(p_event uuid, p_name text, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare e attend_event; n text := btrim(coalesce(p_name, ''));
begin
  select * into e from attend_event where id = p_event for update;
  if not found then raise exception '会议不存在'; end if;
  if not can_run_meeting(e.kind, e.seminar) then raise exception '由开会的人认领' using errcode = '42501'; end if;
  if n = '' or not exists (select 1 from app_user where id = p_user and active) then raise exception '请选择对应的成员'; end if;
  insert into name_alias (name, user_id, set_by) values (n, p_user, app_uid()) on conflict (name) do update set user_id = excluded.user_id, set_by = excluded.set_by, set_at = now();
  insert into attend (event_id, user_id, status) values (p_event, p_user, 'present') on conflict (event_id, user_id) do update set status = 'present', made_up = false;
  update attend_event set sync_unmatched = array_remove(sync_unmatched, n) where id = p_event;
end $$;

-- 中心日历
insert into path_param (key, value) values ('calendar_id', 'null') on conflict (key) do nothing;
create function set_center_calendar(p_id text) returns void language plpgsql security definer set search_path = public as $$
declare v text := nullif(btrim(coalesce(p_id, '')), '');
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人填写' using errcode = '42501'; end if;
  if v is not null and (length(v) > 200 or v !~ '^[A-Za-z0-9_.@-]+$') then raise exception '日历编号格式不对'; end if;
  update path_param set value = to_jsonb(v) where key = 'calendar_id';
end $$;

select expose('set_zoom_meeting(uuid, text)', 'claim_name(uuid, text, uuid)', 'set_center_calendar(text)');

-- 定时任务：要同步的会（飞书或 Zoom）
drop function meeting_sync_todo();
create function meeting_sync_todo() returns table (event_id uuid, feishu_no text, zoom_id text, from_ts bigint, to_ts bigint, has_minutes boolean, ended boolean)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select e.id, e.feishu_no, e.zoom_id,
    extract(epoch from coalesce(e.started_at, e.held_on::timestamptz) - interval '2 hours')::bigint,
    extract(epoch from coalesce(e.ended_at + interval '2 hours', now()))::bigint,
    e.minutes_link is not null, e.ended_at is not null
  from attend_event e
  where (e.feishu_no is not null or e.zoom_id is not null) and (e.ended_at is null or e.ended_at > now() - interval '2 days')
    and (e.synced_at is null or e.synced_at < now() - interval '4 minutes')
  order by e.started_at desc limit 10;
end $$;

-- 定时任务：开着、还没挂会议号的会，以及中心日历编号；用来到日历里找同一时段的飞书会议
create function calendar_todo() returns table (event_id uuid, kind text, seminar_name text, title text, from_ts bigint, to_ts bigint, calendar_id text)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select e.id, e.kind, (select name from seminar where code = e.seminar), e.title,
    extract(epoch from e.started_at - interval '3 hours')::bigint, extract(epoch from e.started_at + interval '3 hours')::bigint,
    (select value #>> '{}' from path_param where key = 'calendar_id')
  from attend_event e
  where e.ended_at is null and e.started_at is not null and e.feishu_no is null and e.zoom_id is null
    and (select value #>> '{}' from path_param where key = 'calendar_id') is not null;
end $$;
create function calendar_link(p_event uuid, p_feishu_no text) returns void language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if p_feishu_no !~ '^[0-9]{9}$' then return; end if;
  update attend_event set feishu_no = p_feishu_no, sync_note = '已从中心日历找到飞书会议' where id = p_event and feishu_no is null;
end $$;

-- 定时任务：存同步结果。飞书按账号对上；Zoom 按邮箱、姓名、认领过的别名对上，对不上的姓名记下
drop function meeting_sync_save(uuid, text[], text, text);
create function meeting_sync_save(p_event uuid, p_union_ids text[], p_minutes text, p_note text, p_emails text[] default null, p_names text[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; k int; e attend_event; nm text; u uuid; miss text[] := '{}';
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select * into e from attend_event where id = p_event;
  if not found then return 0; end if;
  if coalesce(array_length(p_union_ids, 1), 0) > 0 then
    insert into attend (event_id, user_id, status)
    select p_event, x.id, 'present' from app_user x where x.active and (x.feishu_union_id = any(p_union_ids) or x.feishu_open_id = any(p_union_ids))
    on conflict (event_id, user_id) do update set status = 'present', made_up = false where attend.status <> 'present';
    get diagnostics k = row_count; n := n + k;
  end if;
  for i in 1 .. coalesce(array_length(p_names, 1), 0) loop
    nm := btrim(p_names[i]);
    u := (select id from app_user where active and p_emails is not null and p_emails[i] <> '' and lower(email) = lower(p_emails[i]) limit 1);
    if u is null then u := (select user_id from name_alias where name = nm); end if;
    if u is null then u := (select id from app_user where active and name = nm and (select count(*) from app_user where active and name = nm) = 1); end if;
    if u is null then
      if nm <> '' and not (nm = any(miss)) then miss := miss || nm; end if;
      continue;
    end if;
    insert into attend (event_id, user_id, status) values (p_event, u, 'present')
    on conflict (event_id, user_id) do update set status = 'present', made_up = false where attend.status <> 'present';
    get diagnostics k = row_count; n := n + k;
  end loop;
  update attend_event set synced_at = now(), sync_note = left(p_note, 300),
    minutes_link = coalesce(minutes_link, case when p_minutes ~ '^https?://' then p_minutes end),
    sync_unmatched = case when p_names is null then sync_unmatched else
      (select array_agg(x) from unnest(miss) x where not exists (select 1 from name_alias a where a.name = x)) end
  where id = p_event;
  return n;
end $$;
select expose('meeting_sync_todo()', 'meeting_sync_save(uuid, text[], text, text, text[], text[])', 'calendar_todo()', 'calendar_link(uuid, text)');

drop view api.meeting_sync;
create view api.meeting_sync as
  select e.id, e.feishu_no, e.zoom_id, e.sync_note, e.synced_at, e.sync_unmatched from attend_event e where app_role() is not null and can_run_meeting(e.kind, e.seminar);
create view api.center_calendar as
  select (select value #>> '{}' from path_param where key = 'calendar_id') as calendar_id, (app_role() = 'director') as can_set where app_role() is not null;
grant select on api.meeting_sync, api.center_calendar to app_api;
