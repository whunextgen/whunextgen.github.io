-- 迭代、质疑与积累（《The Path of an Independent Researcher》草案第五十三版第五、六、七节，第三节的考核）。
--   一、主题研讨会：认知基础、医疗、金融、人文社会四个，各设组织者（由 Researcher 担任，中心负责人指定）。
--   二、快照：研究单元每期提交一次写作草稿的快照（链接），写明本期有改动的成员，依次编号；可提交给一个或几个研讨会，
--       由组织者决定是否接收讨论。
--   三、质疑：接收讨论的快照，由组织者在会上逐条记入，每条指明理、据、体、用中的哪一问；再次提出的挂在原来那一条下面。
--       未回应的质疑全中心公开。几个人组队回应，入队由研究单元负责人加人；新入队的自下一期起参与分配。
--   四、结算：一期的会开完，组织者结束这次讨论。该研究单元此前提出、本次没有人再提、且有可参与分配的队员的质疑，
--       即为已回应，当期结算：每条 16 名义币，由当期有分配资格的队员平分，直接进入研究单元的名义池子，记为各人的份额。
--       研究单元取得第一个经核对的外部成果时池子解锁；铸造率挂牌后按份额铸造实际币。
--   五、属性：文章四项（理、据、体、用）按回应所得名义币的数额累加；德行四项（元、亨、利、贞）按次数累加，贞随连续期数加计。
--   六、日常任务：每期几项，周日讲座和主题研讨会的出勤由对应岗位登记，快照改动、双周表由中台按记录判定。
--   七、考核：RA 考核（小任务，两名 Researcher 布置和认定）、Researcher 考核（课题提案）、Rising Star 考核、PI 认定。
--   八、保持与收回：中台按记录列出须过问的情形，由人事岗通知本人，不自动下调身份。
-- 原来按身份发名义币、登记时间的试行办法停止：名义币只来自回应质疑。登记时间的接口保留但不再接受登记。

-- ---------- 身份的先后 ----------
create function rank_ord(p_rank text) returns int language sql immutable as $$
  select array_position(array['intern','assistant','researcher','rising_star','pi','director'], p_rank)
$$;
create function user_rank(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select coalesce((select rank from person where user_id = p_user and status in ('active','offroll') order by updated_at desc nulls last limit 1), 'intern')
$$;
create function user_rank_at_least(p_user uuid, p_rank text) returns boolean language sql stable security definer set search_path = public as $$
  select rank_ord(user_rank(p_user)) >= rank_ord(p_rank)
$$;

create table path_param (key text primary key, value jsonb not null);
insert into path_param values ('daily_from', to_jsonb(token_period(app_today())));
select seal('path_param');

-- ---------- 一、主题研讨会 ----------
create table seminar (
  code         text primary key check (code in ('cog','med','fin','hum')),
  name         text not null,
  seq          int not null,
  organizer_id uuid references app_user(id),
  updated_at   timestamptz not null default now()
);
insert into seminar (code, name, seq) values ('cog', '认知基础', 1), ('med', '医疗', 2), ('fin', '金融', 3), ('hum', '人文社会', 4);
select seal('seminar');
create trigger audit after insert or update or delete on seminar for each row execute function trg_audit();

create function is_organizer(p_seminar text) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() = 'director' or exists (select 1 from seminar where code = p_seminar and organizer_id = app_uid())
$$;

create function set_seminar_organizer(p_seminar text, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare s seminar;
begin
  if app_role() is distinct from 'director' then raise exception '组织者由中心负责人指定' using errcode = '42501'; end if;
  select * into s from seminar where code = p_seminar for update;
  if not found then raise exception '研讨会不存在'; end if;
  if p_user is not null and not user_rank_at_least(p_user, 'researcher') then raise exception '组织者由 Researcher 担任'; end if;
  update seminar set organizer_id = p_user, updated_at = now() where code = p_seminar;
  if p_user is not null then perform notify_user(p_user, format('研讨会组织者：你已被指定为「%s」主题研讨会的组织者，负责接收快照、安排讨论、主持会议并记入质疑', s.name)); end if;
end $$;

-- ---------- 二、快照 ----------
create table snapshot (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  period_start date not null check (period_start = token_period(period_start)),
  seq          int not null,
  link         text not null check (link ~ '^https?://' and length(link) <= 500),
  note         text check (note is null or length(note) <= 500),
  submitted_by uuid not null references app_user(id),
  submitted_at timestamptz not null default now(),
  unique (project_id, period_start),
  unique (project_id, seq)
);
create table snapshot_author (
  snapshot_id uuid not null references snapshot(id) on delete cascade,
  user_id     uuid not null references app_user(id),
  primary key (snapshot_id, user_id)
);
create table snapshot_pitch (
  id          uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references snapshot(id),
  seminar     text not null references seminar(code),
  status      text not null default 'pending' check (status in ('pending','accepted','declined','closed')),
  note        text check (note is null or length(note) <= 300),
  decided_by  uuid references app_user(id),
  decided_at  timestamptz,
  closed_by   uuid references app_user(id),
  closed_at   timestamptz,
  unique (snapshot_id, seminar)
);
select seal('snapshot', 'snapshot_author', 'snapshot_pitch');
create trigger audit after insert or update or delete on snapshot for each row execute function trg_audit();
create trigger audit after insert or update or delete on snapshot_pitch for each row execute function trg_audit();

-- 研究单元的负责人或名单里的人提交本期快照；同一期再交即更新，已有讨论结束的不能再改
create function save_snapshot(p_project uuid, p_link text, p_note text default null, p_authors uuid[] default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; per date := token_period(app_today()); s snapshot; a uuid; lk text := btrim(coalesce(p_link, '')); nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '快照只由已成立的研究单元提交'; end if;
  if not (p.owner_id = app_uid() or is_on_project(p_project)) then raise exception '只有研究单元的负责人和名单里的人可以提交快照' using errcode = '42501'; end if;
  if lk !~ '^https?://' then raise exception '请填写写作草稿的链接'; end if;
  if nt is not null and length(nt) > 500 then raise exception '说明不得超过 500 个字'; end if;
  foreach a in array coalesce(p_authors, array[app_uid()]) loop
    if not (is_on_project(p_project, a) or p.owner_id = a) then raise exception '有改动的人须在研究单元的名单里'; end if;
  end loop;
  select * into s from snapshot where project_id = p_project and period_start = per for update;
  if found then
    if exists (select 1 from snapshot_pitch where snapshot_id = s.id and status = 'closed') then raise exception '本期快照已在研讨会上讨论完毕，不能再改'; end if;
    update snapshot set link = lk, note = nt, submitted_by = app_uid(), submitted_at = now() where id = s.id;
    delete from snapshot_author where snapshot_id = s.id;
  else
    insert into snapshot (project_id, period_start, seq, link, note, submitted_by)
    values (p_project, per, coalesce((select max(seq) from snapshot where project_id = p_project), 0) + 1, lk, nt, app_uid()) returning * into s;
  end if;
  insert into snapshot_author (snapshot_id, user_id) select s.id, x from unnest(coalesce(p_authors, array[app_uid()])) x on conflict do nothing;
  return s.id;
end $$;

-- 提交给研讨会：可以同时交给几个；组织者收到通知
create function pitch_snapshot(p_snapshot uuid, p_seminars text[]) returns int language plpgsql security definer set search_path = public as $$
declare s snapshot; p project; c text; n int := 0; sm seminar;
begin
  select * into s from snapshot where id = p_snapshot;
  if not found then raise exception '快照不存在'; end if;
  select * into p from project where id = s.project_id;
  if not (p.owner_id = app_uid() or is_on_project(p.id)) then raise exception '只有研究单元的负责人和名单里的人可以提交' using errcode = '42501'; end if;
  if s.period_start <> token_period(app_today()) then raise exception '只能提交本期的快照'; end if;
  if coalesce(array_length(p_seminars, 1), 0) = 0 then raise exception '请选择研讨会'; end if;
  foreach c in array p_seminars loop
    select * into sm from seminar where code = c;
    if not found then raise exception '研讨会不存在'; end if;
    insert into snapshot_pitch (snapshot_id, seminar) values (s.id, c) on conflict do nothing;
    if found then
      n := n + 1;
      if sm.organizer_id is not null then
        perform notify_user(sm.organizer_id, format('快照待接收：研究单元「%s」把第 %s 次快照提交给「%s」主题研讨会，请决定是否接收讨论', p.name, s.seq, sm.name));
      end if;
    end if;
  end loop;
  return n;
end $$;

create function decide_pitch(p_pitch uuid, p_accept boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; s snapshot; p project; sm seminar; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into x from snapshot_pitch where id = p_pitch for update;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者决定' using errcode = '42501'; end if;
  if x.status <> 'pending' then raise exception '这份提交已处理'; end if;
  select * into s from snapshot where id = x.snapshot_id;
  if s.period_start <> token_period(app_today()) then raise exception '往期的提交不再处理'; end if;
  update snapshot_pitch set status = case when p_accept then 'accepted' else 'declined' end, note = nt, decided_by = app_uid(), decided_at = now() where id = p_pitch;
  select * into p from project where id = s.project_id; select * into sm from seminar where code = x.seminar;
  perform notify_user(s.submitted_by, format('快照%s：研究单元「%s」的第 %s 次快照%s「%s」主题研讨会讨论%s', case when p_accept then '已接收' else '未接收' end,
    p.name, s.seq, case when p_accept then '已由' else '未被' end, sm.name, case when nt is null then '' else '。说明：' || nt end));
  if p.owner_id is distinct from s.submitted_by then
    perform notify_user(p.owner_id, format('快照%s：研究单元「%s」的第 %s 次快照，「%s」主题研讨会%s', case when p_accept then '已接收' else '未接收' end, p.name, s.seq, sm.name, case when p_accept then '接收讨论' else '本期未接收，可在下一期重新提交' end));
  end if;
end $$;

-- ---------- 三、质疑与小队 ----------
create table query (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  pitch_id     uuid not null references snapshot_pitch(id),
  period_start date not null,
  axis         text not null check (axis in ('li','ju','ti','yong')),
  body         text not null check (length(btrim(body)) between 1 and 500),
  raised_by    uuid references app_user(id),            -- 提出的人；不在中台的与会者留空
  parent_id    uuid references query(id),               -- 再次提出的，挂在原来那一条下面
  status       text not null default 'open' check (status in ('open','resolved','again')),
  resolved_period date,
  resolved_pitch  uuid references snapshot_pitch(id),
  recorded_by  uuid not null references app_user(id),
  recorded_at  timestamptz not null default now(),
  check ((parent_id is null) = (status <> 'again'))
);
create index query_project on query (project_id, status);
create table query_member (
  query_id    uuid not null references query(id) on delete cascade,
  user_id     uuid not null references app_user(id),
  from_period date not null,                            -- 自这一期起参与分配：入队的下一期
  added_by    uuid references app_user(id),
  added_at    timestamptz not null default now(),
  primary key (query_id, user_id)
);
create table nominal_entry (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  user_id      uuid not null references app_user(id),
  query_id     uuid not null references query(id),
  period_start date not null,
  axis         text not null check (axis in ('li','ju','ti','yong')),
  coins        numeric not null check (coins > 0),
  created_at   timestamptz not null default now(),
  unique (query_id, user_id)
);
select seal('query', 'query_member', 'nominal_entry');
create trigger audit after insert or update or delete on query for each row execute function trg_audit();
create trigger audit after insert or update or delete on query_member for each row execute function trg_audit();
create trigger audit after insert or update or delete on nominal_entry for each row execute function trg_audit();

create function axis_label(p_axis text) returns text language sql immutable as $$
  select case p_axis when 'li' then '理' when 'ju' then '据' when 'ti' then '体' when 'yong' then '用' end
$$;

-- 组织者在会上记入质疑。再次提出的，指明原来那一条
create function add_query(p_pitch uuid, p_axis text, p_body text, p_raised_by uuid default null, p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; s snapshot; q query; b text := btrim(coalesce(p_body, '')); ax text := p_axis; v_id uuid;
begin
  select * into x from snapshot_pitch where id = p_pitch;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '质疑由该研讨会的组织者记入' using errcode = '42501'; end if;
  if x.status <> 'accepted' then raise exception '只有接收讨论、尚未结束的快照可以记入质疑'; end if;
  select * into s from snapshot where id = x.snapshot_id;
  if b = '' then raise exception '请写明质疑'; end if;
  if length(b) > 500 then raise exception '质疑不得超过 500 个字'; end if;
  if p_parent is not null then
    select * into q from query where id = p_parent;
    if not found or q.project_id <> s.project_id or q.parent_id is not null then raise exception '原来那一条不属于这个研究单元'; end if;
    if q.status <> 'open' then raise exception '原来那一条已回应，请作为新的质疑记入'; end if;
    if q.period_start >= s.period_start then raise exception '本期提出的质疑不必再次提出'; end if;
    ax := coalesce(ax, q.axis);
  end if;
  if ax is null or axis_label(ax) is null then raise exception '请指明针对理、据、体、用中的哪一问'; end if;
  insert into query (project_id, pitch_id, period_start, axis, body, raised_by, parent_id, status, recorded_by)
  values (s.project_id, p_pitch, s.period_start, ax, b, p_raised_by, p_parent, case when p_parent is null then 'open' else 'again' end, app_uid()) returning query.id into v_id;
  return v_id;
end $$;

create function remove_query(p_query uuid) returns void language plpgsql security definer set search_path = public as $$
declare q query; x snapshot_pitch;
begin
  select * into q from query where id = p_query for update;
  if not found then raise exception '质疑不存在'; end if;
  select * into x from snapshot_pitch where id = q.pitch_id;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者删除' using errcode = '42501'; end if;
  if x.status <> 'accepted' then raise exception '讨论已结束，不能再删'; end if;
  if exists (select 1 from query where parent_id = p_query) or exists (select 1 from query_member where query_id = p_query) then raise exception '这一条已有人再次提出或已组队，不能删除'; end if;
  delete from query where id = p_query;
end $$;

-- 入队：由研究单元的负责人加人；本人提出入队，通知负责人
create function add_query_member(p_query uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare q query; p project;
begin
  select * into q from query where id = p_query;
  if not found or q.parent_id is not null then raise exception '质疑不存在'; end if;
  select * into p from project where id = q.project_id;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '入队由研究单元的负责人加人' using errcode = '42501'; end if;
  if q.status <> 'open' then raise exception '这条质疑已回应'; end if;
  if not exists (select 1 from app_user where id = p_user and active) then raise exception '人员不存在'; end if;
  insert into query_member (query_id, user_id, from_period, added_by) values (p_query, p_user, token_period(app_today()) + 14, app_uid());
  if not found then raise exception '已在队里'; end if;
  perform notify_user(p_user, format('质疑小队：你已加入研究单元「%s」的质疑小队（%s：%s），自下一期起参与分配', p.name, axis_label(q.axis), left(q.body, 60)));
exception when unique_violation then raise exception '已在队里';
end $$;

create function remove_query_member(p_query uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare q query; p project;
begin
  select * into q from query where id = p_query;
  if not found then raise exception '质疑不存在'; end if;
  select * into p from project where id = q.project_id;
  if not (p.owner_id = app_uid() or app_role() = 'director' or p_user = app_uid()) then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  if q.status <> 'open' then raise exception '这条质疑已回应，队伍不再变动'; end if;
  delete from query_member where query_id = p_query and user_id = p_user;
  if not found then raise exception '不在队里'; end if;
end $$;

create function ask_join_query(p_query uuid, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare q query; p project; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into q from query where id = p_query;
  if not found or q.parent_id is not null then raise exception '质疑不存在'; end if;
  if q.status <> 'open' then raise exception '这条质疑已回应'; end if;
  if exists (select 1 from query_member where query_id = p_query and user_id = app_uid()) then raise exception '已在队里'; end if;
  select * into p from project where id = q.project_id;
  if nt is not null and length(nt) > 300 then raise exception '说明不得超过 300 个字'; end if;
  perform notify_user(p.owner_id, format('入队申请：%s 申请加入研究单元「%s」的质疑小队（%s：%s）%s', (select name from app_user where id = app_uid()), p.name, axis_label(q.axis), left(q.body, 60),
    case when nt is null then '' else '。说明：' || nt end));
end $$;

-- ---------- 四、结束讨论并结算 ----------
create function close_pitch(p_pitch uuid) returns int language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; s snapshot; p project; q record; n int := 0; k int; share numeric; m record;
begin
  select * into x from snapshot_pitch where id = p_pitch for update;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者结束讨论' using errcode = '42501'; end if;
  if x.status <> 'accepted' then raise exception '只有接收讨论的快照可以结束讨论'; end if;
  select * into s from snapshot where id = x.snapshot_id;
  select * into p from project where id = s.project_id;
  update snapshot_pitch set status = 'closed', closed_by = app_uid(), closed_at = now() where id = p_pitch;
  for q in select * from query where project_id = s.project_id and status = 'open' and parent_id is null and period_start < s.period_start order by recorded_at loop
    if exists (select 1 from query a where a.parent_id = q.id and a.period_start = s.period_start) then continue; end if;   -- 本期有人再次提出
    select count(*) into k from query_member where query_id = q.id and from_period <= s.period_start;
    if k = 0 then continue; end if;                                                                                         -- 还没有可参与分配的队员
    share := round(16.0 / k, 2);
    update query set status = 'resolved', resolved_period = s.period_start, resolved_pitch = p_pitch where id = q.id;
    for m in select user_id from query_member where query_id = q.id and from_period <= s.period_start loop
      insert into nominal_entry (project_id, user_id, query_id, period_start, axis, coins) values (s.project_id, m.user_id, q.id, s.period_start, q.axis, share);
      perform notify_user(m.user_id, format('质疑已回应：研究单元「%s」的质疑（%s：%s）本期无人再提，记 %s 名义币，进入研究单元的池子', p.name, axis_label(q.axis), left(q.body, 60), share));
    end loop;
    n := n + 1;
  end loop;
  perform notify_user(p.owner_id, format('研讨会讨论结束：研究单元「%s」第 %s 次快照的讨论已结束，本期新记质疑 %s 条、再次提出 %s 条，已回应 %s 条', p.name, s.seq,
    (select count(*) from query where pitch_id = p_pitch and status <> 'again'), (select count(*) from query where pitch_id = p_pitch and status = 'again'), n));
  return n;
end $$;

-- 原来按时间登记名义币的办法停止
create or replace function save_time_log(p_period date, p_items jsonb) returns int language plpgsql security definer set search_path = public as $$
begin raise exception '名义币改为回应质疑记入，不再登记时间'; end $$;
create or replace function confirm_time_logs(p_project uuid, p_period date) returns int language plpgsql security definer set search_path = public as $$
begin raise exception '名义币改为回应质疑记入，不再登记时间'; end $$;

-- ---------- 五、日常任务与出勤 ----------
create table attend_event (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('lecture','seminar','council')),
  seminar     text references seminar(code),
  held_on     date not null,
  title       text check (title is null or length(title) <= 120),
  recorded_by uuid not null references app_user(id),
  recorded_at timestamptz not null default now(),
  check ((kind = 'seminar') = (seminar is not null))
);
create table attend (
  event_id uuid not null references attend_event(id) on delete cascade,
  user_id  uuid not null references app_user(id),
  status   text not null check (status in ('present','leave','absent')),
  made_up  boolean not null default false,              -- 请假的，一周内看完回放
  primary key (event_id, user_id)
);
select seal('attend_event', 'attend');
create trigger audit after insert or update or delete on attend_event for each row execute function trg_audit();
create trigger audit after insert or update or delete on attend for each row execute function trg_audit();

-- 周日讲座由人事岗登记；主题研讨会由组织者；联席会议由录入评定的中心助理。名单里没有的记为缺席
create function record_attendance(p_kind text, p_seminar text, p_on date, p_title text, p_present uuid[], p_leave uuid[] default null, p_absent uuid[] default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_kind = 'lecture' and not (has_perm('people.manage') or app_role() = 'director') then raise exception '周日讲座的出勤由人事岗登记' using errcode = '42501'; end if;
  if p_kind = 'seminar' and not is_organizer(p_seminar) then raise exception '研讨会的出勤由组织者登记' using errcode = '42501'; end if;
  if p_kind = 'council' and not (has_perm('budget.evaluate') or app_role() = 'director') then raise exception '联席会议的出勤由中心助理登记' using errcode = '42501'; end if;
  if p_kind not in ('lecture','seminar','council') then raise exception '会议类别不对'; end if;
  if p_on is null or p_on > app_today() then raise exception '日期不能晚于今天'; end if;
  if p_title is not null and length(p_title) > 120 then raise exception '题目不得超过 120 个字'; end if;
  insert into attend_event (kind, seminar, held_on, title, recorded_by) values (p_kind, case when p_kind = 'seminar' then p_seminar end, p_on, nullif(btrim(coalesce(p_title, '')), ''), app_uid()) returning attend_event.id into v_id;
  insert into attend (event_id, user_id, status) select v_id, x, 'present' from unnest(coalesce(p_present, '{}')) x on conflict do nothing;
  insert into attend (event_id, user_id, status) select v_id, x, 'leave' from unnest(coalesce(p_leave, '{}')) x on conflict do nothing;
  insert into attend (event_id, user_id, status) select v_id, x, 'absent' from unnest(coalesce(p_absent, '{}')) x on conflict do nothing;
  return v_id;
end $$;

create function mark_made_up(p_event uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare e attend_event;
begin
  select * into e from attend_event where id = p_event;
  if not found then raise exception '会议不存在'; end if;
  if not ((e.kind = 'lecture' and has_perm('people.manage')) or (e.kind = 'seminar' and is_organizer(e.seminar)) or (e.kind = 'council' and has_perm('budget.evaluate')) or app_role() = 'director') then
    raise exception '由登记出勤的岗位办理' using errcode = '42501'; end if;
  update attend set made_up = true where event_id = p_event and user_id = p_user and status = 'leave';
  if not found then raise exception '此人不是请假'; end if;
end $$;

-- 一期的日常任务。null 表示这一项对此人不适用，或本期没有登记这类会议
create function daily_check(p_user uuid, p_period date) returns table (
  lecture_ok boolean, seminar_ok boolean, change_ok boolean, biweekly_ok boolean, council_ok boolean, done boolean)
language sql stable security definer set search_path = public as $$
  with r as (select user_rank(p_user) as rk),
  ev as (select e.kind, a.status, a.made_up from attend_event e left join attend a on a.event_id = e.id and a.user_id = p_user
         where e.held_on between p_period and p_period + 13),
  c as (select
    case when not exists (select 1 from ev where kind = 'lecture') then null
         else not exists (select 1 from ev where kind = 'lecture' and not (status = 'present' or (status = 'leave' and made_up))) end as lecture_ok,
    case when not exists (select 1 from ev where kind = 'seminar') then null
         else exists (select 1 from ev where kind = 'seminar' and (status = 'present' or (status = 'leave' and made_up))) end as seminar_ok,
    exists (select 1 from snapshot s join snapshot_author a on a.snapshot_id = s.id where a.user_id = p_user and s.period_start = p_period) as change_ok,
    case when (select rk from r) not in ('assistant','researcher','pi','director')
           or not exists (select 1 from project p where p.owner_id = p_user and p.layer = 'paper' and p.active and not p.proposed) then null
         else not exists (select 1 from project p where p.owner_id = p_user and p.layer = 'paper' and p.active and not p.proposed
                            and not (exists (select 1 from biweekly_report b where b.project_id = p.id and b.period_start = p_period)
                                     and exists (select 1 from snapshot s join snapshot_pitch x on x.snapshot_id = s.id where s.project_id = p.id and s.period_start = p_period and x.status in ('accepted','closed')))) end as biweekly_ok,
    case when (select rk from r) not in ('researcher','pi','director') or not exists (select 1 from ev where kind = 'council') then null
         else exists (select 1 from ev where kind = 'council' and (status = 'present' or (status = 'leave' and made_up))) end as council_ok
  )
  select lecture_ok, seminar_ok, change_ok, biweekly_ok, council_ok,
         coalesce(lecture_ok, true) and coalesce(seminar_ok, true) and change_ok and coalesce(biweekly_ok, true) and coalesce(council_ok, true)
  from c
$$;

-- 已结束的各期：是否完成、连续期数、当期记入贞的数额（每多连续一期多计一成）
create function daily_streak(p_user uuid) returns table (period_start date, done boolean, streak int, zhen numeric)
language plpgsql stable security definer set search_path = public as $$
declare d date := (select (value #>> '{}')::date from path_param where key = 'daily_from'); st int := 0; ok boolean;
begin
  while d + 13 < app_today() loop
    select c.done into ok from daily_check(p_user, d) c;
    if ok then st := st + 1; else st := 0; end if;
    period_start := d; done := ok; streak := st; zhen := case when ok then round(1 + 0.1 * (st - 1), 1) else 0 end;
    return next;
    d := d + 14;
  end loop;
end $$;

-- ---------- 六、考核 ----------
create table assessment (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  kind          text not null check (kind in ('ra','researcher','rising_star','pi')),
  period_start  date not null,
  status        text not null default 'applied' check (status in ('applied','examining','recommended','passed','failed','withdrawn')),
  link          text check (link is null or (link ~ '^https?://' and length(link) <= 500)),   -- 课题提案、报告或证明材料
  note          text check (note is null or length(note) <= 500),
  task_title    text check (task_title is null or length(task_title) <= 120),               -- RA 考核的小任务
  task_detail   text check (task_detail is null or length(task_detail) <= 2000),
  task_due      date,
  council_on    date,
  council_note  text check (council_note is null or length(council_note) <= 500),
  mentor_id     uuid references app_user(id),                                               -- 带出此人的人：计入元和带人类任务
  decided_by    uuid references app_user(id),
  decided_at    timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  applied_at    timestamptz not null default now()
);
create unique index assessment_open on assessment (person_id) where status in ('applied','examining','recommended');
create table assessment_examiner (
  assessment_id uuid not null references assessment(id) on delete cascade,
  user_id       uuid not null references app_user(id),
  verdict       text check (verdict in ('pass','fail')),
  note          text check (note is null or length(note) <= 500),
  joined_at     timestamptz not null default now(),
  decided_at    timestamptz,
  primary key (assessment_id, user_id)
);
select seal('assessment', 'assessment_examiner');
create trigger audit after insert or update or delete on assessment for each row execute function trg_audit();
create trigger audit after insert or update or delete on assessment_examiner for each row execute function trg_audit();

create function assess_label(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'ra' then 'RA 考核' when 'researcher' then 'Researcher 考核' when 'rising_star' then 'Rising Star 考核' when 'pi' then 'PI 认定' end
$$;
create function assess_from(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'ra' then 'intern' when 'researcher' then 'assistant' when 'rising_star' then 'researcher' when 'pi' then 'rising_star' end
$$;
create function assess_to(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'ra' then 'assistant' when 'researcher' then 'researcher' when 'rising_star' then 'rising_star' when 'pi' then 'pi' end
$$;

-- 此人最早进入的研究单元的负责人：接收 RI 的人
create function first_mentor(p_user uuid) returns uuid language sql stable security definer set search_path = public as $$
  select p.owner_id from project_member m join project p on p.id = m.project_id
  where m.user_id = p_user and p.layer = 'paper' and not p.proposed and p.owner_id is distinct from p_user
  order by m.joined_on, m.created_at limit 1
$$;
-- 此人负责的研究单元所挂课题的负责人
create function topic_mentor(p_user uuid) returns uuid language sql stable security definer set search_path = public as $$
  select t.owner_id from project p join project t on t.id = p.parent_id
  where p.owner_id = p_user and p.layer = 'paper' and not p.proposed and t.owner_id is distinct from p_user
  order by p.code limit 1
$$;

-- 向中心负责人发通知
create function notify_directors(p_text text) returns void language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  for d in select id from app_user where active and role = 'director' loop perform notify_user(d, p_text); end loop;
end $$;

-- 申请考核：本级任务全部完成，申请当期的本期任务已完成（本期尚在进行，按已有的记录判定）
create function apply_assessment(p_kind text, p_link text default null, p_note text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare pr person; a uuid; lk text := nullif(btrim(coalesce(p_link, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), ''); c record; left_n int;
begin
  select * into pr from person where user_id = app_uid() and status in ('active','offroll') order by updated_at desc nulls last limit 1;
  if not found then raise exception '本人的人员档案尚未对应中台账号'; end if;
  if assess_label(p_kind) is null then raise exception '考核类别不对'; end if;
  if pr.rank <> assess_from(p_kind) then raise exception '%由 % 申请', assess_label(p_kind), rank_label(assess_from(p_kind)); end if;
  select count(*) into left_n from path_task t left join path_done d on d.person_id = pr.id and d.task_code = t.code
    left join lateral path_auto(pr.id, t.code) x on t.verify = 'auto'
    where t.rank = pr.rank and d.task_code is null and not (t.verify = 'auto' and coalesce(x.done, false));
  if left_n > 0 then raise exception '本级主线任务还有 % 条未完成，任务没有做完的不能申请考核', left_n; end if;
  select * into c from daily_check(app_uid(), token_period(app_today()));
  if not c.change_ok then raise exception '申请当期的本期任务须已完成：本期快照里还没有本人的改动'; end if;
  if c.biweekly_ok is false then raise exception '申请当期的本期任务须已完成：负责的研究单元本期还没有登记双周表并在会上展示快照'; end if;
  if exists (select 1 from assessment where person_id = pr.id and kind = p_kind and status = 'failed' and period_start = token_period(app_today())) then
    raise exception '未通过的，可在下一期重新申请'; end if;
  if p_kind <> 'ra' and lk is null then raise exception '请附上%的材料链接', case p_kind when 'researcher' then '课题提案' when 'rising_star' then '研究报告' else '聘任或立项文件' end; end if;
  if lk is not null and lk !~ '^https?://' then raise exception '链接须以 http 开头'; end if;
  if nt is not null and length(nt) > 500 then raise exception '说明不得超过 500 个字'; end if;
  insert into assessment (person_id, kind, period_start, link, note) values (pr.id, p_kind, token_period(app_today()), lk, nt) returning id into a;
  if p_kind = 'ra' then
    perform notify_user(first_mentor(app_uid()), format('考核申请：%s 申请 RA 考核，待两名 Researcher 认领并布置小任务', pr.name));
  else
    perform notify_directors(format('考核申请：%s 申请%s，待联席会议表决', pr.name, assess_label(p_kind)));
  end if;
  return a;
exception when unique_violation then raise exception '已有一项考核在办理中';
end $$;

create function withdraw_assessment(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare a assessment;
begin
  select * into a from assessment where id = p_id for update;
  if not found then raise exception '考核不存在'; end if;
  if not exists (select 1 from person where id = a.person_id and user_id = app_uid()) and app_role() is distinct from 'director' then raise exception '由申请人撤回' using errcode = '42501'; end if;
  if a.status not in ('applied','examining','recommended') then raise exception '这项考核已办结'; end if;
  update assessment set status = 'withdrawn', decided_at = now() where id = p_id;
end $$;

-- 晋升身份并留记录；认定人为空的是中台按考核结论办理
create function promote(p_person uuid, p_rank text, p_basis text) returns void language plpgsql security definer set search_path = public as $$
declare pr person;
begin
  select * into pr from person where id = p_person for update;
  if pr.rank = p_rank then return; end if;
  insert into rank_change (person_id, from_rank, to_rank, basis, decided_by) values (p_person, pr.rank, p_rank, left(p_basis, 300), app_uid());
  update person set rank = p_rank, updated_at = now() where id = p_person;
  if pr.user_id is not null then
    perform notify_user(pr.user_id, format('身份认定：你的身份已认定为 %s（原为 %s）。依据：%s', rank_label(p_rank), rank_label(pr.rank), p_basis));
  end if;
end $$;

-- RA 考核：Researcher 认领考核人。与申请人有私人关系的、申请人所在研究单元的负责人，不担任考核人
create function join_examiner(p_id uuid, p_no_conflict boolean) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; u uuid; n int;
begin
  select * into a from assessment where id = p_id for update;
  if not found or a.kind <> 'ra' then raise exception '只有 RA 考核由 Researcher 担任考核人'; end if;
  if a.status <> 'applied' then raise exception '考核人已齐'; end if;
  if not user_rank_at_least(app_uid(), 'researcher') then raise exception '考核人由 Researcher 担任' using errcode = '42501'; end if;
  select user_id into u from person where id = a.person_id;
  if u = app_uid() then raise exception '不能考核本人'; end if;
  if not coalesce(p_no_conflict, false) then raise exception '与申请人有私人关系的，不担任考核人；请确认没有私人关系'; end if;
  if exists (select 1 from project_member m join project p on p.id = m.project_id where m.user_id = u and m.left_on is null and p.layer = 'paper' and p.owner_id = app_uid()) then
    raise exception '申请人所在研究单元的负责人不担任考核人'; end if;
  select count(*) into n from assessment_examiner where assessment_id = p_id;
  if n >= 2 then raise exception '考核人已齐'; end if;
  insert into assessment_examiner (assessment_id, user_id) values (p_id, app_uid());
exception when unique_violation then raise exception '已是考核人';
end $$;

-- 两名考核人齐了，由其中一人布置小任务，为期两周
create function set_small_task(p_id uuid, p_title text, p_detail text) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; t text := btrim(coalesce(p_title, '')); d text := btrim(coalesce(p_detail, ''));
begin
  select * into a from assessment where id = p_id for update;
  if not found or a.kind <> 'ra' then raise exception '考核不存在'; end if;
  if not exists (select 1 from assessment_examiner where assessment_id = p_id and user_id = app_uid()) then raise exception '由考核人布置' using errcode = '42501'; end if;
  if a.status <> 'applied' or (select count(*) from assessment_examiner where assessment_id = p_id) < 2 then raise exception '两名考核人齐了再布置'; end if;
  if t = '' or d = '' then raise exception '请写明小任务的题目和内容'; end if;
  if length(t) > 120 or length(d) > 2000 then raise exception '题目不超过 120 字，内容不超过 2000 字'; end if;
  update assessment set status = 'examining', task_title = t, task_detail = d, task_due = app_today() + 14 where id = p_id;
  perform notify_user((select user_id from person where id = a.person_id), format('RA 考核：小任务已布置「%s」，为期两周，%s 前向两名考核人汇报', t, to_char(app_today() + 14, 'YYYY-MM-DD')));
end $$;

-- 考核人认定。两人一致通过即为 RA；有一人不通过即为未通过
create function judge_small_task(p_id uuid, p_pass boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; pr person; nt text := nullif(btrim(coalesce(p_note, '')), ''); names text;
begin
  select * into a from assessment where id = p_id for update;
  if not found or a.kind <> 'ra' then raise exception '考核不存在'; end if;
  if a.status <> 'examining' then raise exception '小任务尚未布置或考核已办结'; end if;
  update assessment_examiner set verdict = case when p_pass then 'pass' else 'fail' end, note = nt, decided_at = now() where assessment_id = p_id and user_id = app_uid() and verdict is null;
  if not found then raise exception '只有尚未认定的考核人可以认定' using errcode = '42501'; end if;
  select * into pr from person where id = a.person_id;
  if not p_pass then
    update assessment set status = 'failed', decided_at = now(), decision_note = nt where id = p_id;
    perform notify_user(pr.user_id, format('RA 考核未通过：%s。可在下一期重新申请', coalesce(nt, '考核人认定未通过')));
  elsif not exists (select 1 from assessment_examiner where assessment_id = p_id and verdict is distinct from 'pass') then
    select string_agg(u.name, '、' order by u.name) into names from assessment_examiner e join app_user u on u.id = e.user_id where e.assessment_id = p_id;
    update assessment set status = 'passed', decided_at = now(), mentor_id = first_mentor(pr.user_id) where id = p_id;
    perform promote(pr.id, 'assistant', format('RA 考核通过：小任务「%s」，考核人 %s', a.task_title, names));
  end if;
end $$;

-- Researcher、Rising Star 考核和 PI 认定：联席会议表决（由中心助理录入），再由中心负责人决定
create function record_council_vote(p_id uuid, p_pass boolean, p_on date, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; pr person; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (has_perm('budget.evaluate') or app_role() = 'director') then raise exception '联席会议的表决由中心助理录入' using errcode = '42501'; end if;
  select * into a from assessment where id = p_id for update;
  if not found or a.kind = 'ra' then raise exception '这项考核不经联席会议表决'; end if;
  if a.status <> 'applied' then raise exception '已录入表决结果'; end if;
  if p_on is null or p_on > app_today() then raise exception '会议日期不能晚于今天'; end if;
  select * into pr from person where id = a.person_id;
  update assessment set status = case when p_pass then 'recommended' else 'failed' end, council_on = p_on, council_note = nt,
    decided_at = case when p_pass then null else now() end where id = p_id;
  if p_pass then perform notify_directors(format('考核待决定：联席会议表决同意推荐 %s 通过%s，请中心负责人决定', pr.name, assess_label(a.kind)));
  else perform notify_user(pr.user_id, format('%s未通过：联席会议表决未通过%s', assess_label(a.kind), case when nt is null then '' else '。说明：' || nt end)); end if;
end $$;

create function decide_assessment(p_id uuid, p_pass boolean, p_note text default null, p_mentor uuid default null) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; pr person; nt text := nullif(btrim(coalesce(p_note, '')), ''); m uuid;
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人决定' using errcode = '42501'; end if;
  select * into a from assessment where id = p_id for update;
  if not found or a.kind = 'ra' then raise exception '考核不存在'; end if;
  if a.status <> 'recommended' then raise exception '须先经联席会议表决推荐'; end if;
  select * into pr from person where id = a.person_id;
  m := coalesce(p_mentor, case a.kind when 'researcher' then topic_mentor(pr.user_id) end);
  update assessment set status = case when p_pass then 'passed' else 'failed' end, decided_by = app_uid(), decided_at = now(), decision_note = nt,
    mentor_id = case when p_pass then m end where id = p_id;
  if p_pass then perform promote(pr.id, assess_to(a.kind), format('%s通过：联席会议 %s 表决推荐，中心负责人认可%s', assess_label(a.kind), to_char(a.council_on, 'YYYY-MM-DD'),
    case when nt is null then '' else '。' || nt end));
  else perform notify_user(pr.user_id, format('%s未通过：中心负责人未认可%s', assess_label(a.kind), case when nt is null then '' else '。说明：' || nt end)); end if;
end $$;

-- ---------- 七、中台自动认定的其余任务 ----------
create or replace function path_auto(p_person uuid, p_code text) returns table (done boolean, progress text)
language plpgsql stable security definer set search_path = public as $$
declare u uuid := (select user_id from person where id = p_person); n int;
begin
  if u is null then return query select false, '尚未对应中台账号'; return; end if;
  if p_code = 'ri-unit' then
    return query select exists (select 1 from project_member m join project p on p.id = m.project_id where m.user_id = u and p.layer = 'paper' and not p.proposed)
                     or exists (select 1 from project p where p.owner_id = u and p.layer = 'paper' and not p.proposed), null::text;
  elsif p_code = 'ri-three' then
    select count(distinct e.period_start)::int into n from nominal_entry e where e.user_id = u;
    return query select n >= 3, format('已有 %s 期，共需 3 期', least(n, 3));
  elsif p_code = 'ra-unit' then
    return query select exists (select 1 from project p where p.owner_id = u and p.layer = 'paper' and not p.proposed), null::text;
  elsif p_code = 'ra-biweekly' then
    -- 按登记人计，只计研究单元的双周表：研究单元换了负责人，已登记的期数不转给新负责人
    select count(distinct r.period_start)::int into n from biweekly_report r join project p on p.id = r.project_id
      where p.layer = 'paper' and r.submitted_by = u;
    return query select n >= 6, format('已登记 %s 期，共需 6 期', least(n, 6));
  elsif p_code = 'ra-mentor' then
    return query select exists (select 1 from assessment where kind = 'ra' and status = 'passed' and mentor_id = u), null::text;
  elsif p_code = 'rs-mentor' then
    return query select exists (select 1 from assessment where kind = 'researcher' and status = 'passed' and mentor_id = u), null::text;
  elsif p_code = 'pi-star' then
    return query select exists (select 1 from assessment where kind = 'rising_star' and status = 'passed' and mentor_id = u), null::text;
  else
    return query select false, null::text;
  end if;
end $$;
update path_task set ready = true where code in ('ri-three', 'ra-mentor', 'rs-mentor', 'pi-star');
-- 结算、考核通过后补记
create function trg_path_latch_entry() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'nominal_entry' then perform path_latch(new.user_id);
  elsif new.status = 'passed' and new.mentor_id is not null then perform path_latch(new.mentor_id); end if;
  return null;
end $$;
create trigger path_latch_after after insert on nominal_entry for each row execute function trg_path_latch_entry();
create trigger path_latch_after after update of status on assessment for each row execute function trg_path_latch_entry();

-- 德行里由中心负责人确认的：组织和主持中心活动（亨）、承担中心的公共事务（利）
create table merit (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user(id),
  virtue     text not null check (virtue in ('heng','li')),
  what       text not null check (length(btrim(what)) between 1 and 200),
  done_on    date not null,
  confirmed_by uuid not null references app_user(id),
  confirmed_at timestamptz not null default now()
);
select seal('merit');
create trigger audit after insert or update or delete on merit for each row execute function trg_audit();
create function add_merit(p_user uuid, p_virtue text, p_what text, p_on date) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; w text := btrim(coalesce(p_what, ''));
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人确认' using errcode = '42501'; end if;
  if p_virtue not in ('heng','li') then raise exception '只记亨、利两项'; end if;
  if w = '' or length(w) > 200 then raise exception '请写明事项，不超过 200 个字'; end if;
  if p_on is null or p_on > app_today() then raise exception '日期不能晚于今天'; end if;
  insert into merit (user_id, virtue, what, done_on, confirmed_by) values (p_user, p_virtue, w, p_on, app_uid()) returning merit.id into v_id;
  perform notify_user(p_user, format('德行记入：「%s」已由中心负责人确认，记入%s', w, case p_virtue when 'heng' then '亨' else '利' end));
  return v_id;
end $$;

select expose('set_seminar_organizer(text, uuid)', 'save_snapshot(uuid, text, text, uuid[])', 'pitch_snapshot(uuid, text[])', 'decide_pitch(uuid, boolean, text)',
  'add_query(uuid, text, text, uuid, uuid)', 'remove_query(uuid)', 'add_query_member(uuid, uuid)', 'remove_query_member(uuid, uuid)', 'ask_join_query(uuid, text)',
  'close_pitch(uuid)', 'record_attendance(text, text, date, text, uuid[], uuid[], uuid[])', 'mark_made_up(uuid, uuid)',
  'apply_assessment(text, text, text)', 'withdraw_assessment(uuid)', 'join_examiner(uuid, boolean)', 'set_small_task(uuid, text, text)',
  'judge_small_task(uuid, boolean, text)', 'record_council_vote(uuid, boolean, date, text)', 'decide_assessment(uuid, boolean, text, uuid)', 'add_merit(uuid, text, text, date)');
revoke execute on function promote(uuid, text, text) from public;
revoke execute on function notify_directors(text) from public;

-- ---------- 视图 ----------
create view api.seminar as
  select s.code, s.name, s.seq, s.organizer_id, u.name as organizer_name, is_organizer(s.code) as mine, (app_role() = 'director') as can_set
  from seminar s left join app_user u on u.id = s.organizer_id where app_role() is not null;

-- 快照：全中心公开
create view api.snapshot as
  select s.id, s.project_id, p.code as project_code, p.name as project_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         s.period_start, s.seq, s.link, s.note, (select name from app_user where id = s.submitted_by) as submitted_by_name, s.submitted_at,
         (select coalesce(jsonb_agg(jsonb_build_object('id', a.user_id, 'name', u.name) order by u.name), '[]') from snapshot_author a join app_user u on u.id = a.user_id where a.snapshot_id = s.id) as authors,
         (s.period_start = token_period(app_today()) and (p.owner_id = app_uid() or is_on_project(p.id))) as can_edit
  from snapshot s join project p on p.id = s.project_id where app_role() is not null;

create view api.snapshot_pitch as
  select x.id, x.snapshot_id, s.project_id, p.code as project_code, p.name as project_name, s.seq, s.period_start, s.link,
         x.seminar, sm.name as seminar_name, x.status, x.note, (select name from app_user where id = x.decided_by) as decided_by_name, x.decided_at, x.closed_at,
         is_organizer(x.seminar) as can_run,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status <> 'again') as new_queries,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status = 'again') as again_queries,
         (select count(*)::int from query q where q.resolved_pitch = x.id) as resolved
  from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id join seminar sm on sm.code = x.seminar
  where app_role() is not null;

-- 质疑：全中心公开
create view api.query as
  select q.id, q.project_id, p.code as project_code, p.name as project_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         q.pitch_id, x.seminar, (select name from seminar where code = x.seminar) as seminar_name, s.seq as snapshot_seq, q.period_start, q.axis, axis_label(q.axis) as axis_label, q.body,
         (select name from app_user where id = q.raised_by) as raised_by_name, q.parent_id, q.status, q.resolved_period, q.recorded_at,
         (select count(*)::int from query a where a.parent_id = q.id) as again,
         (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', u.name, 'from', m.from_period) order by m.added_at), '[]') from query_member m join app_user u on u.id = m.user_id where m.query_id = q.id) as team,
         exists (select 1 from query_member m where m.query_id = q.id and m.user_id = app_uid()) as in_team,
         (p.owner_id = app_uid() or app_role() = 'director') as can_team,
         (is_organizer(x.seminar) and x.status = 'accepted') as can_remove
  from query q join project p on p.id = q.project_id join snapshot_pitch x on x.id = q.pitch_id join snapshot s on s.id = x.snapshot_id
  where app_role() is not null;

-- 研究单元的名义池子：全中心看得到总数；解锁看是否有经核对的外部成果
drop view api.unit_share;
drop view api.unit_pool;
create view api.unit_pool as
  select p.id as project_id, p.parent_id, p.pool_cap,
         coalesce((select sum(e.coins) from nominal_entry e where e.project_id = p.id), 0) as coins,
         (select count(distinct e.user_id)::int from nominal_entry e where e.project_id = p.id) as people,
         (select count(*)::int from query q where q.project_id = p.id and q.status = 'open' and q.parent_id is null) as pending,
         coalesce((select max(o.level) from outcome o where o.project_id = p.id and o.checked_at is not null and not o.rejected), 0) as level
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;
create view api.unit_share as
  select e.project_id, e.user_id, u.name as user_name, u.kind as user_kind, sum(e.coins) as coins,
         sum(e.coins) / nullif((select sum(x.coins) from nominal_entry x where x.project_id = e.project_id), 0) as share
  from nominal_entry e join app_user u on u.id = e.user_id
  where app_role() is not null and (e.user_id = app_uid() or is_on_project(e.project_id) or can_manage_project(e.project_id) or has_perm('budget.setup') or has_perm('budget.evaluate'))
  group by e.project_id, e.user_id, u.name, u.kind;

-- 各人的八项属性：全中心看得到（属性即声望）
create view api.person_attr as
  select u.id as user_id, u.name as user_name,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'li'), 0) as a_li,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'ju'), 0) as a_ju,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'ti'), 0) as a_ti,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'yong'), 0) as a_yong,
         -- 元：所带的人（最早接收其进入研究单元的负责人）回应了质疑、通过了考核
         ((select count(*) from nominal_entry e where first_mentor(e.user_id) = u.id) + (select count(*) from assessment a where a.mentor_id = u.id and a.status = 'passed'))::int as d_yuan,
         -- 亨：本人负责的研究单元在会上展示快照，组织者主持讨论，中心负责人确认的组织主持
         ((select count(*) from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id where x.status = 'closed' and p.owner_id = u.id)
          + (select count(*) from snapshot_pitch x where x.status = 'closed' and x.closed_by = u.id)
          + (select count(*) from merit m where m.user_id = u.id and m.virtue = 'heng'))::int as d_heng,
         -- 利：给别人的快照提出质疑，回应别的研究单元的质疑，中心负责人确认的公共事务
         ((select count(*) from query q join project p on p.id = q.project_id where q.raised_by = u.id and p.owner_id is distinct from u.id and not is_on_project(p.id, u.id))
          + (select count(*) from nominal_entry e join project p on p.id = e.project_id where e.user_id = u.id and p.owner_id is distinct from u.id and not is_on_project(p.id, u.id))
          + (select count(*) from merit m where m.user_id = u.id and m.virtue = 'li'))::int as d_li,
         coalesce((select sum(zhen) from daily_streak(u.id)), 0) as d_zhen,
         coalesce((select streak from daily_streak(u.id) order by period_start desc limit 1), 0) as streak
  from app_user u where u.active and app_role() is not null and exists (select 1 from person pr where pr.user_id = u.id and pr.status in ('active','offroll'));

-- 本人各期的日常任务：已结束的各期加上本期
create view api.daily_mine as
  select d.period_start, d.period_start + 13 as period_end, (d.period_start = token_period(app_today())) as current, c.lecture_ok, c.seminar_ok, c.change_ok, c.biweekly_ok, c.council_ok, c.done,
         s.streak, s.zhen
  from generate_series((select (value #>> '{}')::date from path_param where key = 'daily_from'), token_period(app_today()), interval '14 days') g(d0)
  cross join lateral (select g.d0::date as period_start) d
  cross join lateral daily_check(app_uid(), d.period_start) c
  left join lateral (select x.streak, x.zhen from daily_streak(app_uid()) x where x.period_start = d.period_start) s on true
  where app_uid() is not null;

create view api.attend_event as
  select e.id, e.kind, e.seminar, (select name from seminar where code = e.seminar) as seminar_name, e.held_on, e.title, (select name from app_user where id = e.recorded_by) as recorded_by_name,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'present') as present,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'leave') as leave,
         (select count(*)::int from attend a where a.event_id = e.id and a.status = 'absent') as absent,
         (select status from attend a where a.event_id = e.id and a.user_id = app_uid()) as my_status
  from attend_event e where app_role() is not null;

create view api.assessment as
  select a.id, a.person_id, pr.name as person_name, pr.user_id, coalesce(pr.user_id = app_uid(), false) as mine, a.kind, assess_label(a.kind) as kind_label, a.period_start, a.status,
         a.link, a.note, a.task_title, a.task_detail, a.task_due, a.council_on, a.council_note, (select name from app_user where id = a.mentor_id) as mentor_name,
         (select name from app_user where id = a.decided_by) as decided_by_name, a.decided_at, a.decision_note, a.applied_at,
         (select coalesce(jsonb_agg(jsonb_build_object('id', e.user_id, 'name', u.name, 'verdict', e.verdict, 'note', e.note) order by e.joined_at), '[]') from assessment_examiner e join app_user u on u.id = e.user_id where e.assessment_id = a.id) as examiners,
         exists (select 1 from assessment_examiner e where e.assessment_id = a.id and e.user_id = app_uid()) as examiner,
         (a.kind = 'ra' and a.status = 'applied' and user_rank_at_least(app_uid(), 'researcher') and pr.user_id is distinct from app_uid()
            and (select count(*) from assessment_examiner e where e.assessment_id = a.id) < 2
            and not exists (select 1 from assessment_examiner e where e.assessment_id = a.id and e.user_id = app_uid())) as can_join,
         (a.kind <> 'ra' and a.status = 'applied' and (has_perm('budget.evaluate') or app_role() = 'director')) as can_vote,
         (a.kind <> 'ra' and a.status = 'recommended' and app_role() = 'director') as can_decide
  from assessment a join person pr on pr.id = a.person_id
  where app_role() is not null and (pr.user_id = app_uid() or path_can_see(pr.id) or user_rank_at_least(app_uid(), 'researcher') or has_perm('budget.evaluate'));

create view api.merit as
  select m.id, m.user_id, u.name as user_name, m.virtue, m.what, m.done_on, (select name from app_user where id = m.confirmed_by) as confirmed_by_name
  from merit m join app_user u on u.id = m.user_id where app_role() is not null;

-- 须过问的情形（第二十一至二十三条）：人事岗和中心负责人看得到，由人事岗通知本人，不自动下调
create view api.path_alert as
  with per as (select token_period(app_today()) - 14 as p1, token_period(app_today()) - 28 as p2),
  started as (select (select (value #>> '{}')::date from path_param where key = 'daily_from') <= (select p2 from per) as ok)
  select 'person' as kind, pr.id as person_id, pr.name as subject, null::uuid as project_id,
         '连续两期快照里没有本人的改动' as what
  from person pr, per, started
  where started.ok and pr.status = 'active' and pr.user_id is not null and pr.rank in ('intern','assistant','researcher')
    and not exists (select 1 from snapshot s join snapshot_author a on a.snapshot_id = s.id where a.user_id = pr.user_id and s.period_start in (per.p1, per.p2))
    and (has_perm('people.manage') or app_role() = 'director')
  union all
  select 'person', pr.id, pr.name, null,
         '周日讲座连续三次缺席，未请假'
  from person pr
  where pr.status = 'active' and pr.user_id is not null and (has_perm('people.manage') or app_role() = 'director')
    and (select count(*) from (select a.status from attend_event e join attend a on a.event_id = e.id and a.user_id = pr.user_id where e.kind = 'lecture' order by e.held_on desc limit 3) z where z.status = 'absent') = 3
  union all
  select 'unit', null, p.name, p.id, '连续两期未登记双周表，转为停滞，负责人须到联席会议说明'
  from project p, per, started
  where started.ok and p.layer = 'paper' and p.active and not p.proposed and (has_perm('people.manage') or has_perm('budget.evaluate') or app_role() = 'director')
    and not exists (select 1 from biweekly_report b where b.project_id = p.id and b.period_start in (per.p1, per.p2))
  union all
  select 'unit', null, p.name, p.id, '连续两期没有向主题研讨会提交快照，或提交了未被接收，由联席会议过问'
  from project p, per, started
  where started.ok and p.layer = 'paper' and p.active and not p.proposed and (has_perm('people.manage') or has_perm('budget.evaluate') or app_role() = 'director')
    and not exists (select 1 from snapshot s join snapshot_pitch x on x.snapshot_id = s.id where s.project_id = p.id and s.period_start in (per.p1, per.p2) and x.status in ('accepted','closed'));

grant select on api.seminar, api.snapshot, api.snapshot_pitch, api.query, api.unit_pool, api.unit_share, api.person_attr, api.daily_mine,
  api.attend_event, api.assessment, api.merit, api.path_alert to app_api;
