-- 轮流发言：保证到场的每个人都被问到。研讨会讨论一份快照时，按签到名单排出顺序（汇报人除外）：
-- 本场还没轮到的在前，近 60 天轮到次数少的在前。组织者逐个点名：提了质疑即记在此人名下，没有就跳过。
create table speak_turn (
  id       uuid primary key default gen_random_uuid(),
  pitch_id uuid not null references snapshot_pitch(id),
  user_id  uuid not null references app_user(id),
  result   text not null check (result in ('query','pass')),
  at       timestamptz not null default now(),
  unique (pitch_id, user_id)
);
select seal('speak_turn');

create function record_turn(p_pitch uuid, p_user uuid, p_result text) returns void language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch;
begin
  select * into x from snapshot_pitch where id = p_pitch;
  if not found then raise exception '投稿不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者点名' using errcode = '42501'; end if;
  if p_result not in ('query','pass') then raise exception '结果只有提了质疑、跳过两种'; end if;
  insert into speak_turn (pitch_id, user_id, result) values (p_pitch, p_user, p_result)
  on conflict (pitch_id, user_id) do update set result = case when speak_turn.result = 'query' then 'query' else excluded.result end, at = now();
end $$;
select expose('record_turn(uuid, uuid, text)');

-- 记入的质疑写明了提出人的，算此人这一轮提了质疑
create function trg_query_turn() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.raised_by is not null then
    insert into speak_turn (pitch_id, user_id, result) values (new.pitch_id, new.raised_by, 'query')
    on conflict (pitch_id, user_id) do update set result = 'query', at = now();
  end if;
  return null;
end $$;
create trigger query_turn after insert on query for each row execute function trg_query_turn();

-- 发言顺序：这份快照所在研讨会正开着的会上签到出席的人，去掉这份快照的作者
create view api.speak_order as
  select x.id as pitch_id, a.user_id, u.name as user_name,
         t.result as this_turn,
         (select count(*)::int from speak_turn s where s.user_id = a.user_id and s.at > now() - interval '60 days') as recent_turns,
         row_number() over (partition by x.id order by (t.result is not null), (select count(*) from speak_turn s where s.user_id = a.user_id and s.at > now() - interval '60 days'), u.name)::int as seq
  from snapshot_pitch x
  join attend_event e on e.kind = 'seminar' and e.seminar = x.seminar and e.ended_at is null
  join attend a on a.event_id = e.id and a.status = 'present'
  join app_user u on u.id = a.user_id
  left join speak_turn t on t.pitch_id = x.id and t.user_id = a.user_id
  where x.status = 'accepted' and app_role() is not null and is_organizer(x.seminar)
    and not exists (select 1 from snapshot_author sa where sa.snapshot_id = x.snapshot_id and sa.user_id = a.user_id);
grant select on api.speak_order to app_api;
