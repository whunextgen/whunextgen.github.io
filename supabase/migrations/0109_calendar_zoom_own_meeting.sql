-- 一、日历上的 Zoom 会议：讲座的 Zoom 链接固定，写在 CLAIN日历的日程上。开会时从同一时段日程的地点、描述、会议链接里找 Zoom 会议号挂上。
-- 二、自建会议：成员可以自己在正则上开会（题目自拟），同样有签到码、可挂飞书或 Zoom 会议自动签到、散会出纪要。
--     自建会议只作记录，不计入日常任务；由开会的人办理。

create function calendar_link_zoom(p_event uuid, p_zoom text) returns void language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if p_zoom !~ '^[0-9]{9,12}$' then return; end if;
  update attend_event set zoom_id = p_zoom, sync_note = '已从中心日历找到 Zoom 会议' where id = p_event and zoom_id is null and feishu_no is null;
end $$;
select expose('calendar_link_zoom(uuid, text)');

alter table attend_event drop constraint attend_event_kind_check;
alter table attend_event add constraint attend_event_kind_check check (kind in ('lecture','seminar','council','training','other'));

-- 能否办理某一场会：原来按会议类别；自建会议由开会的人办理
create function can_run_event(p_kind text, p_seminar text, p_host uuid) returns boolean language sql stable security definer set search_path = public as $$
  select can_run_meeting(p_kind, p_seminar) or (p_kind = 'other' and p_host = app_uid())
$$;

create or replace function open_meeting(p_kind text, p_seminar text default null, p_title text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; c text; t text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if p_kind not in ('lecture','seminar','council','other') then raise exception '会议类别不对'; end if;
  if p_kind = 'other' and t is null then raise exception '自建会议请写明题目'; end if;
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if p_kind = 'seminar' and not exists (select 1 from seminar where code = p_seminar) then raise exception '研讨会不存在'; end if;
  if p_kind <> 'other' and not can_run_meeting(p_kind, p_seminar) then raise exception '讲座由人事岗、研讨会由组织者、联席会议由中心助理开会' using errcode = '42501'; end if;
  if t is not null and length(t) > 120 then raise exception '题目不得超过 120 个字'; end if;
  if exists (select 1 from attend_event where kind = p_kind and seminar is not distinct from (case when p_kind = 'seminar' then p_seminar end) and ended_at is null
             and (p_kind <> 'other' or recorded_by = app_uid())) then
    raise exception '这一类会还有一场没有散会，请先散会'; end if;
  loop
    c := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from attend_event where code = c and ended_at is null);
  end loop;
  insert into attend_event (kind, seminar, held_on, title, recorded_by, started_at, code, code_until)
  values (p_kind, case when p_kind = 'seminar' then p_seminar end, app_today(), t, app_uid(), now(), c, now() + interval '3 hours') returning attend_event.id into v_id;
  return v_id;
end $$;

-- 把各处「按类别判断能否办理」换成「按这场会判断」
do $$
declare f text; d text; n text;
begin
  foreach f in array array['public.set_minutes(uuid, text)', 'public.end_meeting(uuid)', 'public.set_feishu_meeting(uuid, text)', 'public.set_zoom_meeting(uuid, text)', 'public.claim_name(uuid, text, uuid)'] loop
    d := pg_get_functiondef(f::regprocedure);
    n := replace(d, 'can_run_meeting(e.kind, e.seminar)', 'can_run_event(e.kind, e.seminar, e.recorded_by)');
    if n = d then raise exception '%：没有找到要替换的判断', f; end if;
    execute n;
  end loop;

end $$;

create or replace view api.meeting as
  select e.id, e.kind, e.seminar, (select name from seminar where code = e.seminar) as seminar_name, e.held_on, e.title,
         (select name from app_user where id = e.recorded_by) as host_name, e.started_at, e.ended_at, (e.ended_at is null) as open,
         case when can_run_event(e.kind, e.seminar, e.recorded_by) and e.ended_at is null then e.code end as code, e.code_until, e.minutes_link,
         can_run_event(e.kind, e.seminar, e.recorded_by) as can_run,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'present') as present,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'leave') as leave,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'absent') as absent,
         (select status from attend a where a.event_id = e.id and a.user_id = app_uid()) as my_status,
         (select made_up from attend a where a.event_id = e.id and a.user_id = app_uid()) as my_made_up,
         case when can_run_event(e.kind, e.seminar, e.recorded_by) then (select coalesce(jsonb_agg(jsonb_build_object('name', u.name, 'status', a.status, 'made_up', a.made_up) order by a.status, u.name), '[]')
           from attend a join app_user u on u.id = a.user_id where a.event_id = e.id) end as roll
  from attend_event e where app_role() is not null;
create or replace view api.meeting_sync as
  select e.id, e.feishu_no, e.zoom_id, e.sync_note, e.synced_at, e.sync_unmatched from attend_event e where app_role() is not null and can_run_event(e.kind, e.seminar, e.recorded_by);
