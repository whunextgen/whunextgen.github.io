-- 研讨会按 symposium 办：
--   一、每个研讨会设两位以上组织者（Researcher 及以上），任何一位都能接收投稿、开会、记入质疑。原来的单一组织者并入名单。
--   二、快照提交给研讨会即投稿。组织者决定不接收，或接收为口头报告、海报；两种的时长按研讨会分别设，默认口头报告 20 分钟、海报 5 分钟。

create table seminar_organizer (
  seminar text not null references seminar(code),
  user_id uuid not null references app_user(id),
  set_by  uuid references app_user(id),
  set_at  timestamptz not null default now(),
  primary key (seminar, user_id)
);
select seal('seminar_organizer');
create trigger audit after insert or update or delete on seminar_organizer for each row execute function trg_audit();
insert into seminar_organizer (seminar, user_id) select code, organizer_id from seminar where organizer_id is not null;

alter table seminar add column oral_minutes int not null default 20 check (oral_minutes between 5 and 90),
  add column poster_minutes int not null default 5 check (poster_minutes between 1 and 30);
alter table snapshot_pitch add column format text check (format in ('oral','poster')), add column minutes int;

create or replace function is_organizer(p_seminar text) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() = 'director' or exists (select 1 from seminar_organizer where seminar = p_seminar and user_id = app_uid())
$$;

-- 指定组织者：一次给出全部名单，至少两位
create function set_seminar_organizers(p_seminar text, p_users uuid[]) returns void language plpgsql security definer set search_path = public as $$
declare s seminar; u uuid;
begin
  if app_role() is distinct from 'director' then raise exception '组织者由中心负责人指定' using errcode = '42501'; end if;
  select * into s from seminar where code = p_seminar for update;
  if not found then raise exception '研讨会不存在'; end if;
  if coalesce(array_length(p_users, 1), 0) < 2 then raise exception '每个研讨会至少两位组织者'; end if;
  foreach u in array p_users loop
    if not (user_rank_at_least(u, 'researcher') or exists (select 1 from app_user where id = u and role = 'director')) then raise exception '组织者由 Researcher 及以上担任：%', (select name from app_user where id = u); end if;
  end loop;
  for u in select user_id from seminar_organizer where seminar = p_seminar and not (user_id = any(p_users)) loop
    delete from seminar_organizer where seminar = p_seminar and user_id = u;
  end loop;
  foreach u in array p_users loop
    insert into seminar_organizer (seminar, user_id, set_by) values (p_seminar, u, app_uid()) on conflict do nothing;
    if found then perform notify_user(u, format('研讨会组织者：你已被指定为「%s」主题研讨会的组织者之一，与其他组织者一起接收投稿、决定口头报告或海报、开会并记入质疑', s.name)); end if;
  end loop;
  update seminar set updated_at = now() where code = p_seminar;
end $$;

-- 原来的单人指定改为加入名单（不减少已有的组织者）
create or replace function set_seminar_organizer(p_seminar text, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare s seminar;
begin
  if app_role() is distinct from 'director' then raise exception '组织者由中心负责人指定' using errcode = '42501'; end if;
  select * into s from seminar where code = p_seminar;
  if not found then raise exception '研讨会不存在'; end if;
  if p_user is null then return; end if;
  if not user_rank_at_least(p_user, 'researcher') then raise exception '组织者由 Researcher 担任'; end if;
  insert into seminar_organizer (seminar, user_id, set_by) values (p_seminar, p_user, app_uid()) on conflict do nothing;
  if found then perform notify_user(p_user, format('研讨会组织者：你已被指定为「%s」主题研讨会的组织者之一', s.name)); end if;
end $$;

-- 两种形式的时长：组织者可以改
create function set_seminar_minutes(p_seminar text, p_oral int, p_poster int) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_organizer(p_seminar) then raise exception '由该研讨会的组织者设置' using errcode = '42501'; end if;
  update seminar set oral_minutes = p_oral, poster_minutes = p_poster, updated_at = now() where code = p_seminar;
  if not found then raise exception '研讨会不存在'; end if;
end $$;

-- 投稿通知全体组织者
create function notify_seminar(p_seminar text, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  for u in select user_id from seminar_organizer where seminar = p_seminar loop perform notify_user(u, p_text); end loop;
end $$;
revoke execute on function notify_seminar(text, text) from public;
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.pitch_snapshot(uuid, text[])'::regprocedure);
  n := replace(replace(d, 'if sm.organizer_id is not null then', 'if true then'), 'perform notify_user(sm.organizer_id, format(''快照待接收：', 'perform notify_seminar(c, format(''快照待接收：');
  n := replace(n, '请决定是否接收讨论', '请决定不接收，或接收为口头报告、海报');
  if n = d or position('notify_seminar' in n) = 0 then raise exception 'pitch_snapshot：没有找到通知组织者的地方'; end if;
  execute n;
end $$;

drop function decide_pitch(uuid, boolean, text);
create function decide_pitch(p_pitch uuid, p_accept boolean, p_note text default null, p_format text default 'oral') returns void language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; s snapshot; p project; sm seminar; nt text := nullif(btrim(coalesce(p_note, '')), ''); fm text := coalesce(p_format, 'oral'); fl text;
begin
  select * into x from snapshot_pitch where id = p_pitch for update;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者决定' using errcode = '42501'; end if;
  if x.status <> 'pending' then raise exception '这份提交已处理'; end if;
  select * into s from snapshot where id = x.snapshot_id;
  if s.period_start <> token_period(app_today()) then raise exception '往期的提交不再处理'; end if;
  if p_accept and fm not in ('oral','poster') then raise exception '接收的形式只有口头报告和海报两种'; end if;
  select * into p from project where id = s.project_id; select * into sm from seminar where code = x.seminar;
  update snapshot_pitch set status = case when p_accept then 'accepted' else 'declined' end, note = nt, decided_by = app_uid(), decided_at = now(),
    format = case when p_accept then fm end, minutes = case when p_accept then case fm when 'oral' then sm.oral_minutes else sm.poster_minutes end end where id = p_pitch;
  fl := case when p_accept then case fm when 'oral' then format('（口头报告，%s 分钟）', sm.oral_minutes) else format('（海报，%s 分钟）', sm.poster_minutes) end else '' end;
  perform notify_user(s.submitted_by, format('快照%s：研究单元「%s」的第 %s 次快照%s「%s」主题研讨会讨论%s', case when p_accept then '已接收' else '未接收' end,
    p.name, s.seq, case when p_accept then '已由' else '未被' end, sm.name, fl || case when nt is null then '' else '。说明：' || nt end));
  if p.owner_id is distinct from s.submitted_by then
    perform notify_user(p.owner_id, format('快照%s：研究单元「%s」的第 %s 次快照，「%s」主题研讨会%s', case when p_accept then '已接收' else '未接收' end, p.name, s.seq, sm.name, case when p_accept then '接收讨论' else '本期未接收，可在下一期重新提交' end));
  end if;
end $$;

select expose('set_seminar_organizers(text, uuid[])', 'set_seminar_minutes(text, int, int)', 'decide_pitch(uuid, boolean, text, text)');

create or replace view api.seminar as
  select s.code, s.name, s.seq, s.organizer_id, (select string_agg(u.name, '、' order by u.name) from seminar_organizer o join app_user u on u.id = o.user_id where o.seminar = s.code) as organizer_name,
         is_organizer(s.code) as mine, (app_role() = 'director') as can_set,
         (select coalesce(jsonb_agg(jsonb_build_object('id', o.user_id, 'name', u.name) order by u.name), '[]') from seminar_organizer o join app_user u on u.id = o.user_id where o.seminar = s.code) as organizers,
         s.oral_minutes, s.poster_minutes
  from seminar s where app_role() is not null;

create or replace view api.snapshot_pitch as
  select x.id, x.snapshot_id, s.project_id, p.code as project_code, p.name as project_name, s.seq, s.period_start, s.link,
         x.seminar, sm.name as seminar_name, x.status, x.note, (select name from app_user where id = x.decided_by) as decided_by_name, x.decided_at, x.closed_at,
         is_organizer(x.seminar) as can_run,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status <> 'again') as new_queries,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status = 'again') as again_queries,
         (select count(*)::int from query q where q.resolved_pitch = x.id) as resolved,
         s.person_id, (select name from app_user where id = s.person_id) as person_name, s.title, x.format, x.minutes
  from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id join seminar sm on sm.code = x.seminar
  where app_role() is not null;

-- 三、口头报告缩短为 10 分钟；每种形式设质疑目标（口头报告 3 条、海报 1 条），现场页显示已收获几条
alter table seminar alter column oral_minutes set default 10;
update seminar set oral_minutes = 10 where oral_minutes = 20;
alter table seminar add column oral_target int not null default 3 check (oral_target between 0 and 20),
  add column poster_target int not null default 1 check (poster_target between 0 and 20);
create or replace function set_seminar_minutes(p_seminar text, p_oral int, p_poster int) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_organizer(p_seminar) then raise exception '由该研讨会的组织者设置' using errcode = '42501'; end if;
  update seminar set oral_minutes = p_oral, poster_minutes = p_poster, updated_at = now() where code = p_seminar;
  if not found then raise exception '研讨会不存在'; end if;
end $$;
create function set_seminar_targets(p_seminar text, p_oral int, p_poster int) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_organizer(p_seminar) then raise exception '由该研讨会的组织者设置' using errcode = '42501'; end if;
  update seminar set oral_target = p_oral, poster_target = p_poster, updated_at = now() where code = p_seminar;
  if not found then raise exception '研讨会不存在'; end if;
end $$;

-- 四、与会者当场提质疑：对正在讨论的那份快照提交，组织者点一下记入（记在提出人名下）或不记入
create table query_draft (
  id         uuid primary key default gen_random_uuid(),
  pitch_id   uuid not null references snapshot_pitch(id),
  axis       text not null check (axis in ('li','ju','ti','yong')),
  body       text not null check (length(btrim(body)) between 1 and 500),
  parent_id  uuid references query(id),
  author_id  uuid not null references app_user(id),
  status     text not null default 'pending' check (status in ('pending','accepted','dropped')),
  query_id   uuid references query(id) on delete set null,
  created_at timestamptz not null default now()
);
create index query_draft_pitch on query_draft (pitch_id);
select seal('query_draft');
create trigger audit after insert or update or delete on query_draft for each row execute function trg_audit();

create function submit_query_draft(p_pitch uuid, p_axis text, p_body text, p_parent uuid default null) returns uuid language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; b text := btrim(coalesce(p_body, '')); v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into x from snapshot_pitch where id = p_pitch;
  if not found or x.status <> 'accepted' then raise exception '只能对正在讨论的快照提质疑'; end if;
  if axis_label(p_axis) is null then raise exception '请指明针对理、据、体、用中的哪一问'; end if;
  if b = '' or length(b) > 500 then raise exception '请写明质疑，不超过 500 个字'; end if;
  insert into query_draft (pitch_id, axis, body, parent_id, author_id) values (p_pitch, p_axis, b, p_parent, app_uid()) returning query_draft.id into v_id;
  return v_id;
end $$;

create function accept_query_draft(p_id uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare d query_draft; x snapshot_pitch; qid uuid;
begin
  select * into d from query_draft where id = p_id for update;
  if not found then raise exception '质疑不存在'; end if;
  select * into x from snapshot_pitch where id = d.pitch_id;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者记入' using errcode = '42501'; end if;
  if d.status <> 'pending' then raise exception '这一条已处理'; end if;
  if p_accept then
    qid := add_query(d.pitch_id, case when d.parent_id is null then d.axis end, d.body, d.author_id, d.parent_id);
    update query_draft set status = 'accepted', query_id = qid where id = p_id;
  else
    update query_draft set status = 'dropped' where id = p_id;
  end if;
end $$;
select expose('set_seminar_targets(text, int, int)', 'submit_query_draft(uuid, text, text, uuid)', 'accept_query_draft(uuid, boolean)');

create view api.query_draft as
  select d.id, d.pitch_id, d.axis, axis_label(d.axis) as axis_label, d.body, d.parent_id, d.author_id, (select name from app_user where id = d.author_id) as author_name,
         d.status, d.created_at, (d.author_id = app_uid()) as mine, is_organizer(x.seminar) as can_accept
  from query_draft d join snapshot_pitch x on x.id = d.pitch_id
  where app_role() is not null and (d.author_id = app_uid() or is_organizer(x.seminar));

create or replace view api.seminar as
  select s.code, s.name, s.seq, s.organizer_id, (select string_agg(u.name, '、' order by u.name) from seminar_organizer o join app_user u on u.id = o.user_id where o.seminar = s.code) as organizer_name,
         is_organizer(s.code) as mine, (app_role() = 'director') as can_set,
         (select coalesce(jsonb_agg(jsonb_build_object('id', o.user_id, 'name', u.name) order by u.name), '[]') from seminar_organizer o join app_user u on u.id = o.user_id where o.seminar = s.code) as organizers,
         s.oral_minutes, s.poster_minutes, s.oral_target, s.poster_target
  from seminar s where app_role() is not null;
grant select on api.query_draft to app_api;
