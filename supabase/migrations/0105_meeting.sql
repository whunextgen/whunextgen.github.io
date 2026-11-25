-- 会议现场与签到：周日讲座、主题研讨会、联席会议都在正则上开会、签到、记录，不再用飞书表格。
--   开会：讲座由人事岗、研讨会由组织者、联席会议由中心助理在正则上开一场会，中台给出四位签到码，三小时内有效。
--   签到：到会的人（线上线下同等）在正则上输入签到码签到。
--   请假：不能参加的事先在正则上请假（写明哪天哪一类会）；散会时请假的记为请假，之后一周内看完回放的，本人登记补看。
--   散会：组织者散会，签到码作废；周日讲座没有签到也没有请假的，记为缺席。会议可以挂上飞书妙记或录屏的链接。
--   研讨会现场：组织者共享「研讨会现场」页，逐份过快照、记入质疑、结束讨论并结算；讨论结束时挂到当场这次会上，散会出纪要。

alter table attend_event add column started_at timestamptz, add column ended_at timestamptz,
  add column code text check (code is null or code ~ '^[0-9]{4}$'), add column code_until timestamptz,
  add column minutes_link text check (minutes_link is null or (minutes_link ~ '^https?://' and length(minutes_link) <= 500));
-- 原来会后一次登记的，视为已散会
update attend_event set ended_at = recorded_at where ended_at is null;

-- 会后一次登记的（record_attendance、record_training）不经开会，插入时即视为已散会
create function trg_event_closed() returns trigger language plpgsql as $$
begin
  if new.started_at is null and new.ended_at is null then new.ended_at := now(); end if;
  return new;
end $$;
create trigger event_closed before insert on attend_event for each row execute function trg_event_closed();

create table leave_request (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references app_user(id),
  kind     text not null check (kind in ('lecture','seminar','council','training')),
  seminar  text references seminar(code),
  held_on  date not null,
  note     text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (user_id, kind, held_on)
);
select seal('leave_request');
create trigger audit after insert or update or delete on leave_request for each row execute function trg_audit();

alter table snapshot_pitch add column meeting_id uuid references attend_event(id);

create function can_run_meeting(p_kind text, p_seminar text) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() = 'director'
      or (p_kind in ('lecture','training') and has_perm('people.manage'))
      or (p_kind = 'seminar' and is_organizer(p_seminar))
      or (p_kind = 'council' and has_perm('budget.evaluate'))
$$;

create function open_meeting(p_kind text, p_seminar text default null, p_title text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; c text; t text := nullif(btrim(coalesce(p_title, '')), '');
begin
  if p_kind not in ('lecture','seminar','council') then raise exception '会议类别不对'; end if;
  if p_kind = 'seminar' and not exists (select 1 from seminar where code = p_seminar) then raise exception '研讨会不存在'; end if;
  if not can_run_meeting(p_kind, p_seminar) then raise exception '讲座由人事岗、研讨会由组织者、联席会议由中心助理开会' using errcode = '42501'; end if;
  if t is not null and length(t) > 120 then raise exception '题目不得超过 120 个字'; end if;
  if exists (select 1 from attend_event where kind = p_kind and seminar is not distinct from (case when p_kind = 'seminar' then p_seminar end) and ended_at is null) then
    raise exception '这一类会还有一场没有散会，请先散会'; end if;
  loop
    c := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from attend_event where code = c and ended_at is null);
  end loop;
  insert into attend_event (kind, seminar, held_on, title, recorded_by, started_at, code, code_until)
  values (p_kind, case when p_kind = 'seminar' then p_seminar end, app_today(), t, app_uid(), now(), c, now() + interval '3 hours') returning attend_event.id into v_id;
  return v_id;
end $$;

-- 签到：输入签到码；线上线下同等
create function check_in(p_code text) returns text language plpgsql security definer set search_path = public as $$
declare e attend_event;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into e from attend_event where code = btrim(coalesce(p_code, '')) and ended_at is null and code_until > now() order by started_at desc limit 1;
  if not found then raise exception '签到码不对，或这场会已经散会'; end if;
  insert into attend (event_id, user_id, status) values (e.id, app_uid(), 'present')
  on conflict (event_id, user_id) do update set status = 'present', made_up = false;
  return coalesce(e.title, case e.kind when 'lecture' then '周日讲座' when 'seminar' then (select name from seminar where code = e.seminar) || '主题研讨会' else '联席会议' end);
end $$;

create function ask_leave(p_kind text, p_on date, p_seminar text default null, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if p_kind not in ('lecture','seminar','council','training') then raise exception '会议类别不对'; end if;
  if p_on is null or p_on < app_today() then raise exception '须事先请假：日期不能早于今天'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  insert into leave_request (user_id, kind, seminar, held_on, note) values (app_uid(), p_kind, case when p_kind = 'seminar' then p_seminar end, p_on, nt)
  on conflict (user_id, kind, held_on) do update set note = excluded.note, seminar = excluded.seminar;
end $$;

-- 补看回放：请假的在会后一周内本人登记
create function report_makeup(p_event uuid) returns void language plpgsql security definer set search_path = public as $$
declare e attend_event;
begin
  select * into e from attend_event where id = p_event;
  if not found then raise exception '会议不存在'; end if;
  if app_today() > e.held_on + 7 then raise exception '补看回放须在会后一周内登记'; end if;
  update attend set made_up = true where event_id = p_event and user_id = app_uid() and status = 'leave';
  if not found then raise exception '本人这场会不是请假'; end if;
end $$;

create function set_minutes(p_event uuid, p_link text) returns void language plpgsql security definer set search_path = public as $$
declare e attend_event; lk text := nullif(btrim(coalesce(p_link, '')), '');
begin
  select * into e from attend_event where id = p_event;
  if not found then raise exception '会议不存在'; end if;
  if not can_run_meeting(e.kind, e.seminar) then raise exception '由开会的人挂纪要' using errcode = '42501'; end if;
  if lk is not null and lk !~ '^https?://' then raise exception '链接须以 http 开头'; end if;
  update attend_event set minutes_link = lk where id = p_event;
end $$;

-- 散会：签到码作废；事先请假的记为请假；周日讲座未签到也未请假的在岗人员记为缺席
create function end_meeting(p_event uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare e attend_event;
begin
  select * into e from attend_event where id = p_event for update;
  if not found then raise exception '会议不存在'; end if;
  if not can_run_meeting(e.kind, e.seminar) then raise exception '由开会的人散会' using errcode = '42501'; end if;
  if e.ended_at is not null then raise exception '已经散会'; end if;
  update attend_event set ended_at = now(), code_until = now() where id = p_event;
  insert into attend (event_id, user_id, status)
  select p_event, l.user_id, 'leave' from leave_request l where l.kind = e.kind and l.held_on = e.held_on and (e.kind <> 'seminar' or l.seminar is null or l.seminar = e.seminar)
  on conflict do nothing;
  if e.kind = 'lecture' then
    insert into attend (event_id, user_id, status)
    select p_event, pr.user_id, 'absent' from person pr join app_user u on u.id = pr.user_id where pr.status = 'active' and u.active
    on conflict do nothing;
  end if;
  return jsonb_build_object(
    'present', (select count(*) from attend where event_id = p_event and status = 'present'),
    'leave', (select count(*) from attend where event_id = p_event and status = 'leave'),
    'absent', (select count(*) from attend where event_id = p_event and status = 'absent'),
    'closed', (select count(*) from snapshot_pitch where meeting_id = p_event));
end $$;

-- 研讨会上结束一份快照的讨论时，挂到当场这次会上
create function trg_pitch_meeting() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' and new.meeting_id is null then
    new.meeting_id := (select id from attend_event where kind = 'seminar' and seminar = new.seminar and ended_at is null order by started_at desc limit 1);
  end if;
  return new;
end $$;
create trigger pitch_meeting before update of status on snapshot_pitch for each row execute function trg_pitch_meeting();

select expose('open_meeting(text, text, text)', 'check_in(text)', 'ask_leave(text, date, text, text)', 'report_makeup(uuid)', 'set_minutes(uuid, text)', 'end_meeting(uuid)');

-- 会议：所有人看得到；签到码只给开会的人（共享屏幕时与会者在屏幕上看到）
create view api.meeting as
  select e.id, e.kind, e.seminar, (select name from seminar where code = e.seminar) as seminar_name, e.held_on, e.title,
         (select name from app_user where id = e.recorded_by) as host_name, e.started_at, e.ended_at, (e.ended_at is null) as open,
         case when can_run_meeting(e.kind, e.seminar) and e.ended_at is null then e.code end as code, e.code_until, e.minutes_link,
         can_run_meeting(e.kind, e.seminar) as can_run,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'present') as present,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'leave') as leave,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'absent') as absent,
         (select status from attend a where a.event_id = e.id and a.user_id = app_uid()) as my_status,
         (select made_up from attend a where a.event_id = e.id and a.user_id = app_uid()) as my_made_up,
         case when can_run_meeting(e.kind, e.seminar) then (select coalesce(jsonb_agg(jsonb_build_object('name', u.name, 'status', a.status, 'made_up', a.made_up) order by a.status, u.name), '[]')
           from attend a join app_user u on u.id = a.user_id where a.event_id = e.id) end as roll
  from attend_event e where app_role() is not null;
create view api.leave_mine as
  select l.id, l.kind, l.seminar, l.held_on, l.note from leave_request l where l.user_id = app_uid();
grant select on api.meeting, api.leave_mine to app_api;
