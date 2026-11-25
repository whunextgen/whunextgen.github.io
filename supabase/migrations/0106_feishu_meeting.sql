-- 飞书会议自动签到：开会时把飞书会议号（会议链接末尾 9 位）挂到这场会上；定时任务按会议号查到飞书会议，
-- 读参会人名单，按飞书账号对上中台账号，自动签到；会后读录制，挂上妙记链接。
-- 用正则应用的身份调飞书接口，需要在飞书开放平台给正则开通视频会议（vc:meeting:readonly）和录制（vc:record:readonly）的读取权限。
-- 每次同步的结果（签到几人、出错原因）记在会上，现场页看得到。

alter table attend_event add column feishu_no text check (feishu_no is null or feishu_no ~ '^[0-9]{9}$'),
  add column sync_note text check (sync_note is null or length(sync_note) <= 300), add column synced_at timestamptz;

create function set_feishu_meeting(p_event uuid, p_link text) returns text language plpgsql security definer set search_path = public as $$
declare e attend_event; d text := regexp_replace(coalesce(p_link, ''), '[^0-9]', '', 'g'); no text;
begin
  select * into e from attend_event where id = p_event;
  if not found then raise exception '会议不存在'; end if;
  if not can_run_meeting(e.kind, e.seminar) then raise exception '由开会的人填写' using errcode = '42501'; end if;
  if d = '' then update attend_event set feishu_no = null where id = p_event; return null; end if;
  if length(d) < 9 then raise exception '飞书会议号是 9 位数字，可以直接粘贴会议链接'; end if;
  no := right(d, 9);
  update attend_event set feishu_no = no, sync_note = null, synced_at = null where id = p_event;
  return no;
end $$;
select expose('set_feishu_meeting(uuid, text)');

-- 定时任务：要同步的会。开着的每 5 分钟一次；散会后两天内继续同步（等录制生成）
create function meeting_sync_todo() returns table (event_id uuid, feishu_no text, from_ts bigint, to_ts bigint, has_minutes boolean)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select e.id, e.feishu_no,
    extract(epoch from coalesce(e.started_at, e.held_on::timestamptz) - interval '2 hours')::bigint,
    extract(epoch from coalesce(e.ended_at + interval '2 hours', now()))::bigint,
    e.minutes_link is not null
  from attend_event e
  where e.feishu_no is not null and (e.ended_at is null or e.ended_at > now() - interval '2 days')
    and (e.synced_at is null or e.synced_at < now() - interval '4 minutes')
  order by e.started_at desc limit 10;
end $$;

-- 定时任务：存同步结果。p_union_ids 是飞书会议里参会的飞书用户；对上中台账号的自动签到（请假的改为出席）
create function meeting_sync_save(p_event uuid, p_union_ids text[], p_minutes text, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; e attend_event;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select * into e from attend_event where id = p_event;
  if not found then return 0; end if;
  if p_union_ids is not null and array_length(p_union_ids, 1) > 0 then
    insert into attend (event_id, user_id, status)
    select p_event, u.id, 'present' from app_user u where u.active and (u.feishu_union_id = any(p_union_ids) or u.feishu_open_id = any(p_union_ids))
    on conflict (event_id, user_id) do update set status = 'present', made_up = false where attend.status <> 'present';
    get diagnostics n = row_count;
  end if;
  update attend_event set synced_at = now(), sync_note = left(p_note, 300),
    minutes_link = coalesce(minutes_link, case when p_minutes ~ '^https?://' then p_minutes end)
  where id = p_event;
  return n;
end $$;
select expose('meeting_sync_todo()', 'meeting_sync_save(uuid, text[], text, text)');

create or replace view api.meeting_sync as
  select e.id, e.feishu_no, e.sync_note, e.synced_at from attend_event e where app_role() is not null and can_run_meeting(e.kind, e.seminar);
grant select on api.meeting_sync to app_api;
