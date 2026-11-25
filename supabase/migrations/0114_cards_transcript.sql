-- 质疑卡与录音补漏（黄济民 2026-11-26）
-- 一、质疑卡：接收讨论的快照，与会者会前就可以写卡；会上组织者可以开一轮「写卡」，到场的每人当场写一张，组织者看谁还没交
-- 二、录音补漏：散会后中台取飞书妙记或 Zoom 云录制的逐字稿，找出会上提的质疑，作为草稿交组织者记入；讨论结束后 7 天内仍可记入

-- ---------- 一、质疑卡 ----------
alter table snapshot_pitch add column card_round boolean not null default false;

create function set_card_round(p_pitch uuid, p_open boolean) returns void language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch;
begin
  select * into x from snapshot_pitch where id = p_pitch for update;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者开始或结束写卡' using errcode = '42501'; end if;
  if p_open and x.status <> 'accepted' then raise exception '只有接收讨论、尚未结束的快照可以写卡'; end if;
  if p_open then update snapshot_pitch set card_round = false where seminar = x.seminar and card_round and id <> p_pitch; end if;
  update snapshot_pitch set card_round = coalesce(p_open, false) where id = p_pitch;
end $$;

-- 结束讨论时一并收卡
create function trg_pitch_card_round() returns trigger language plpgsql as $$
begin
  if new.status <> 'accepted' then new.card_round := false; end if;
  return new;
end $$;
create trigger pitch_card_round before update of status on snapshot_pitch for each row execute function trg_pitch_card_round();

-- ---------- 草稿：卡片或录音 ----------
alter table query_draft alter column author_id drop not null;
alter table query_draft add column source text not null default 'card' check (source in ('card','transcript')),
  add column speaker text check (speaker is null or length(speaker) <= 80),
  add column quote text check (quote is null or length(quote) <= 400),
  add column event_id uuid references attend_event(id) on delete set null,
  add constraint query_draft_author check (source = 'transcript' or author_id is not null);

-- 记入：录音里的草稿可以指定提出的人；讨论已结束的，录音补漏在 7 天内仍可记入（只记新的质疑，记为本期未回应）
drop function accept_query_draft(uuid, boolean);
create function accept_query_draft(p_id uuid, p_accept boolean, p_raised_by uuid default null) returns void language plpgsql security definer set search_path = public as $$
declare d query_draft; x snapshot_pitch; s snapshot; qid uuid; who uuid;
begin
  select * into d from query_draft where id = p_id for update;
  if not found then raise exception '质疑不存在'; end if;
  select * into x from snapshot_pitch where id = d.pitch_id;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者记入' using errcode = '42501'; end if;
  if d.status <> 'pending' then raise exception '这一条已处理'; end if;
  if not p_accept then update query_draft set status = 'dropped' where id = p_id; return; end if;
  who := coalesce(p_raised_by, d.author_id);
  if x.status = 'accepted' then
    qid := add_query(d.pitch_id, case when d.parent_id is null then d.axis end, d.body, who, d.parent_id);
  elsif x.status = 'closed' and d.source = 'transcript' and d.parent_id is null and x.closed_at > now() - interval '7 days' then
    select * into s from snapshot where id = x.snapshot_id;
    insert into query (project_id, person_id, pitch_id, period_start, axis, body, raised_by, status, recorded_by)
    values (s.project_id, s.person_id, d.pitch_id, s.period_start, d.axis, d.body, who, 'open', app_uid()) returning query.id into qid;
  else
    raise exception '这份快照的讨论已结束；录音补漏须在结束后 7 天内记入';
  end if;
  update query_draft set status = 'accepted', query_id = qid where id = p_id;
end $$;
select expose('set_card_round(uuid, boolean)', 'accept_query_draft(uuid, boolean, uuid)');

drop view api.query_draft;
create view api.query_draft as
  select d.id, d.pitch_id, d.axis, axis_label(d.axis) as axis_label, d.body, d.parent_id, d.author_id,
         coalesce((select name from app_user where id = d.author_id), d.speaker) as author_name,
         d.status, d.created_at, (d.author_id = app_uid()) as mine, is_organizer(x.seminar) as can_accept,
         d.source, d.speaker, d.quote, d.event_id
  from query_draft d join snapshot_pitch x on x.id = d.pitch_id
  where app_role() is not null and (d.author_id = app_uid() or is_organizer(x.seminar));
grant select on api.query_draft to app_api;

create or replace view api.snapshot_pitch as
  select x.id, x.snapshot_id, s.project_id, p.code as project_code, p.name as project_name, s.seq, s.period_start, s.link,
         x.seminar, sm.name as seminar_name, x.status, x.note, (select name from app_user where id = x.decided_by) as decided_by_name, x.decided_at, x.closed_at,
         is_organizer(x.seminar) as can_run,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status <> 'again') as new_queries,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status = 'again') as again_queries,
         (select count(*)::int from query q where q.resolved_pitch = x.id) as resolved,
         s.person_id, (select name from app_user where id = s.person_id) as person_name, s.title, x.format, x.minutes,
         x.card_round,
         (select count(*)::int from query_draft d where d.pitch_id = x.id and d.status = 'pending' and is_organizer(x.seminar)) as pending_drafts,
         (select count(distinct d.author_id)::int from query_draft d where d.pitch_id = x.id and d.source = 'card') as card_authors
  from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id join seminar sm on sm.code = x.seminar
  where app_role() is not null;

-- ---------- 二、录音补漏 ----------
create table meeting_transcript (
  event_id     uuid primary key references attend_event(id) on delete cascade,
  source       text check (source in ('feishu','zoom')),
  body         text,
  fetched_at   timestamptz,
  tries        int not null default 0,
  tried_at     timestamptz,
  note         text,
  extracted_at timestamptz,
  extract_note text,
  drafts       int
);
select seal('meeting_transcript');

-- 这场会讨论的快照：会上结束讨论的，或同一研讨会本期接收的
create function meeting_pitches(p_event uuid) returns setof snapshot_pitch language sql stable security definer set search_path = public as $$
  select x.* from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join attend_event e on e.id = p_event
  where e.kind = 'seminar' and x.seminar = e.seminar and x.status in ('accepted','closed')
    and (x.meeting_id = p_event or (x.meeting_id is null and s.period_start = token_period(e.held_on)))
$$;
revoke execute on function meeting_pitches(uuid) from public;

-- 定时任务：散会后三天内、挂了妙记或 Zoom 的研讨会，取逐字稿；取不到的 15 分钟后再试，最多 40 次
create function transcript_todo() returns table (event_id uuid, zoom_id text, minutes_link text)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select e.id, e.zoom_id, e.minutes_link from attend_event e left join meeting_transcript t on t.event_id = e.id
  where e.kind = 'seminar' and e.ended_at is not null and e.ended_at > now() - interval '3 days' and e.ended_at < now() - interval '5 minutes'
    and (e.zoom_id is not null or e.minutes_link ~ '/minutes/')
    and (t.event_id is null or (t.body is null and t.tries < 40 and t.tried_at < now() - interval '15 minutes'))
  order by e.ended_at desc limit 3;
end $$;

create function transcript_save(p_event uuid, p_source text, p_body text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare b text := nullif(btrim(coalesce(p_body, '')), '');
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  insert into meeting_transcript (event_id, source, body, fetched_at, tries, tried_at, note)
  values (p_event, p_source, b, case when b is not null then now() end, 1, now(), left(p_note, 300))
  on conflict (event_id) do update set source = coalesce(excluded.source, meeting_transcript.source), body = coalesce(excluded.body, meeting_transcript.body),
    fetched_at = coalesce(excluded.fetched_at, meeting_transcript.fetched_at), tries = meeting_transcript.tries + 1, tried_at = now(), note = excluded.note;
end $$;

-- 待提取：取到了逐字稿、还没提取过的。连同这场会的快照和到场的人一起交出去
create function transcript_extract_todo() returns table (event_id uuid, seminar_name text, held_on date, body text, pitches jsonb, attendees jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select t.event_id, sm.name, e.held_on, t.body,
    (select coalesce(jsonb_agg(jsonb_build_object('id', x.id,
        'label', coalesce((select name from app_user where id = s.person_id) || ' · ' || coalesce(s.title, '主线草稿'), p.name),
        'format', x.format, 'authors', (select coalesce(jsonb_agg(u.name order by u.name), '[]') from snapshot_author a join app_user u on u.id = a.user_id where a.snapshot_id = s.id))
        order by x.format nulls last, x.decided_at), '[]')
     from meeting_pitches(t.event_id) x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id),
    (select coalesce(jsonb_agg(u.name order by u.name), '[]') from attend a join app_user u on u.id = a.user_id where a.event_id = t.event_id and a.status = 'present')
  from meeting_transcript t join attend_event e on e.id = t.event_id join seminar sm on sm.code = e.seminar
  where t.body is not null and t.extracted_at is null
  order by t.fetched_at limit 1;
end $$;

-- 存提取结果：每条须对上这场会的一份快照；发言人按姓名或 Zoom 认领过的名字对上账号；汇报人自己的话、和已有草稿或已记入的同一句不再收
create function transcript_drafts_save(p_event uuid, p_items jsonb, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare it jsonb; pid uuid; ax text; b text; sp text; qt text; who uuid; n int := 0; e attend_event; u uuid;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select * into e from attend_event where id = p_event;
  if not found then raise exception '会议不存在'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    pid := nullif(it->>'pitch', '')::uuid;
    if pid is null or not exists (select 1 from meeting_pitches(p_event) x where x.id = pid) then continue; end if;
    ax := it->>'axis'; if axis_label(ax) is null then continue; end if;
    b := left(btrim(coalesce(it->>'body', '')), 500); if b = '' then continue; end if;
    sp := nullif(left(btrim(coalesce(it->>'speaker', '')), 80), '');
    qt := nullif(left(btrim(coalesce(it->>'quote', '')), 400), '');
    who := null;
    if sp is not null then
      select a.user_id into who from name_alias a where a.name = sp;
      if who is null and (select count(*) from app_user where active and name = sp) = 1 then select id into who from app_user where active and name = sp; end if;
    end if;
    if who is not null and exists (select 1 from snapshot_pitch x join snapshot_author a on a.snapshot_id = x.snapshot_id where x.id = pid and a.user_id = who) then continue; end if;
    if exists (select 1 from query_draft d where d.pitch_id = pid and d.body = b) or exists (select 1 from query q where q.pitch_id = pid and q.body = b) then continue; end if;
    insert into query_draft (pitch_id, axis, body, author_id, source, speaker, quote, event_id) values (pid, ax, b, who, 'transcript', sp, qt, p_event);
    n := n + 1;
  end loop;
  update meeting_transcript set extracted_at = now(), extract_note = left(p_note, 300), drafts = n where event_id = p_event;
  if n > 0 then
    for u in select user_id from seminar_organizer where seminar = e.seminar loop
      perform notify_sys(u, format('录音补漏：%s 的「%s」主题研讨会，从录音里找到 %s 条质疑，请到会议现场页核对并记入；讨论结束后 7 天内都可以记入',
        to_char(e.held_on, 'MM-DD'), (select name from seminar where code = e.seminar), n));
    end loop;
  end if;
  return n;
end $$;

-- 组织者看逐字稿和提取情况
create view api.meeting_transcript as
  select t.event_id as id, t.source, t.fetched_at, t.tries, t.note, t.extracted_at, t.extract_note, t.drafts, length(t.body) as chars, t.body
  from meeting_transcript t join attend_event e on e.id = t.event_id
  where app_role() is not null and can_run_event(e.kind, e.seminar, e.recorded_by);
grant select on api.meeting_transcript to app_api;
