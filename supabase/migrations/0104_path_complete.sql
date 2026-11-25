-- 把草案第五十三版剩下的几条落到中台：
--   一、身份的权限：研究单元由 Assistant 及以上提出和负责，Assistant 同时负责的不超过两个；课题由 Researcher 及以上申请。
--       人员档案尚未对应账号的不卡（身份未知），中心负责人不卡。
--   二、训练课程：第八节的课程逐门登记；入门训练（T101、T102、T103）按出勤由中台自动认定。出勤由人事岗登记，请假补看回放的计入。
--   三、本人主线上的草稿（第八条）：开题稿、综述、方案报告、立场论文等，挂在一个课题之下，每期取快照、提交研讨会、接受质疑，
--       回应质疑同样记名义币（记在该课题名下，不进研究单元的池子）。研究单元的快照照旧。
--   四、研究单元的停滞（第二十二条）：连续两期未登记双周表的为停滞，满四期仍未恢复的应予终止；中台标出状态并通知负责人和人事岗，不自动终止。

-- ---------- 一、身份的权限 ----------
do $$
declare d text; n text; gate text;
begin
  gate := '  if app_role() is distinct from ''director'' and exists (select 1 from person where user_id = app_uid() and status in (''active'',''offroll'')) then
    if p_id is null and not user_rank_at_least(app_uid(), ''assistant'') then raise exception ''研究单元由 Assistant 及以上身份提出和负责；Intern 先完成本级主线任务并通过 RA 考核''; end if;
    if p_id is null and user_rank(app_uid()) = ''assistant'' and (select count(*) from project where owner_id = app_uid() and layer = ''paper'' and active) >= 2 then raise exception ''Assistant 同时负责的研究单元不超过两个''; end if;
  end if;';
  d := pg_get_functiondef('public.propose_unit(uuid, uuid, text, date, date, text, text)'::regprocedure);
  n := regexp_replace(d, E'\nbegin\n', E'\nbegin\n' || replace(gate, '\', '\\') || E'\n');
  if n = d then raise exception 'propose_unit：没有找到插入点'; end if;
  execute n;
  gate := '  if app_role() is distinct from ''director'' and exists (select 1 from person where user_id = app_uid() and status in (''active'',''offroll''))
     and not user_rank_at_least(app_uid(), ''researcher'') then raise exception ''课题由 Researcher 及以上身份申请；Assistant 先完成本级主线任务并通过 Researcher 考核''; end if;';
  d := pg_get_functiondef('public.propose_project(int, text, uuid, text, text)'::regprocedure);
  n := regexp_replace(d, E'\nbegin\n', E'\nbegin\n' || replace(gate, '\', '\\') || E'\n');
  if n = d then raise exception 'propose_project：没有找到插入点'; end if;
  execute n;
end $$;

-- ---------- 二、训练课程 ----------
create table course (
  code     text primary key,
  name     text not null,
  audience text not null check (audience in ('intern','assistant','researcher')),
  seq      int not null,
  intro    boolean not null default false,          -- Intern 的三项入门训练
  is_new   boolean not null default false           -- 草案标为新设
);
insert into course values
  ('T101', 'GPU 集群使用技术', 'intern', 1, true, false),
  ('T102', '中台使用：研究单元、双周表、写作草稿、支出申请与资源申领', 'intern', 2, true, true),
  ('T103', '科研规范、标准标注流程与数据保密', 'intern', 3, true, true),
  ('R102', '如何撰写 Introduction', 'intern', 4, false, false),
  ('R104', '三分钟 Thesis 展示', 'intern', 5, false, false),
  ('R103', '学术讲座', 'intern', 6, false, false),
  ('R101', '如何开展卓越研究', 'assistant', 7, false, false),
  ('R105', '如何撰写领域 Survey', 'assistant', 8, false, false),
  ('R106', '如何写一页提案并设计最小实验', 'assistant', 9, false, true),
  ('M101', '如何组织会议', 'assistant', 10, false, false),
  ('M102', '如何布置和评价小任务', 'researcher', 11, false, false),
  ('M103', '课题预算的编制与执行', 'researcher', 12, false, true),
  ('R201', '如何撰写立场论文', 'researcher', 13, false, true),
  ('M201', '基金申请与对外合作', 'researcher', 14, false, true);
select seal('course');

alter table attend_event drop constraint attend_event_kind_check;
alter table attend_event add constraint attend_event_kind_check check (kind in ('lecture','seminar','council','training'));
alter table attend_event add column course text references course(code);
alter table attend_event add constraint attend_event_course_check check ((kind = 'training') = (course is not null));

create function record_training(p_course text, p_on date, p_present uuid[], p_leave uuid[] default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not (has_perm('people.manage') or app_role() = 'director') then raise exception '课程出勤由人事岗登记' using errcode = '42501'; end if;
  if not exists (select 1 from course where code = p_course) then raise exception '课程不存在'; end if;
  if p_on is null or p_on > app_today() then raise exception '日期不能晚于今天'; end if;
  insert into attend_event (kind, course, held_on, title, recorded_by) values ('training', p_course, p_on, (select name from course where code = p_course), app_uid()) returning attend_event.id into v_id;
  insert into attend (event_id, user_id, status) select v_id, x, 'present' from unnest(coalesce(p_present, '{}')) x on conflict do nothing;
  insert into attend (event_id, user_id, status) select v_id, x, 'leave' from unnest(coalesce(p_leave, '{}')) x on conflict do nothing;
  return v_id;
end $$;
select expose('record_training(text, date, uuid[], uuid[])');

create function course_done(p_user uuid, p_course text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from attend_event e join attend a on a.event_id = e.id where e.kind = 'training' and e.course = p_course and a.user_id = p_user
                 and (a.status = 'present' or (a.status = 'leave' and a.made_up)))
$$;

create view api.course as
  select c.code, c.name, c.audience, rank_label(c.audience) as audience_label, c.seq, c.intro, c.is_new,
         (select count(*)::int from attend_event e where e.kind = 'training' and e.course = c.code) as sessions,
         (select max(held_on) from attend_event e where e.kind = 'training' and e.course = c.code) as last_on,
         course_done(app_uid(), c.code) as mine_done
  from course c where app_role() is not null;
grant select on api.course to app_api;

-- 入门训练改为中台按出勤自动认定；已由人事岗确认的照旧算完成
update path_task set verify = 'auto', ready = true, detail = '集群使用（T101）、中台使用（T102）、科研规范与数据保密（T103），出勤由人事岗登记' where code = 'ri-train';

create or replace function path_auto(p_person uuid, p_code text) returns table (done boolean, progress text)
language plpgsql stable security definer set search_path = public as $$
declare u uuid := (select user_id from person where id = p_person); n int;
begin
  if u is null then return query select false, '尚未对应中台账号'; return; end if;
  if p_code = 'ri-unit' then
    return query select exists (select 1 from project_member m join project p on p.id = m.project_id where m.user_id = u and p.layer = 'paper' and not p.proposed)
                     or exists (select 1 from project p where p.owner_id = u and p.layer = 'paper' and not p.proposed), null::text;
  elsif p_code = 'ri-train' then
    return query select course_done(u, 'T101') and course_done(u, 'T102') and course_done(u, 'T103'),
      format('已完成 %s / 3 项', (course_done(u, 'T101'))::int + (course_done(u, 'T102'))::int + (course_done(u, 'T103'))::int);
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

-- ---------- 三、本人主线上的草稿 ----------
alter table snapshot add column person_id uuid references app_user(id), add column title text check (title is null or length(btrim(title)) between 1 and 60);
alter table snapshot drop constraint snapshot_project_id_period_start_key, drop constraint snapshot_project_id_seq_key;
create unique index snapshot_period_once on snapshot (project_id, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start);
create unique index snapshot_seq_once on snapshot (project_id, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid), seq);
alter table query add column person_id uuid references app_user(id);

-- 本人交主线草稿的快照：挂在一个已立项的课题之下，由该课题的负责人指导；一人一课题每期一份，再交即更新
create function save_personal_snapshot(p_topic uuid, p_title text, p_link text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; per date := token_period(app_today()); s snapshot; t text := btrim(coalesce(p_title, '')); lk text := btrim(coalesce(p_link, '')); nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_topic;
  if not found or p.layer = 'paper' or p.kind = 'public' or not p.active or p.proposed then raise exception '本人主线上的草稿挂在一个已立项的课题之下'; end if;
  if t = '' or length(t) > 60 then raise exception '请写明是哪一项成果，如开题稿、综述、方案报告、立场论文，不超过 60 个字'; end if;
  if lk !~ '^https?://' then raise exception '请填写写作草稿的链接'; end if;
  if nt is not null and length(nt) > 500 then raise exception '说明不得超过 500 个字'; end if;
  select * into s from snapshot where project_id = p_topic and person_id = app_uid() and period_start = per for update;
  if found then
    if exists (select 1 from snapshot_pitch where snapshot_id = s.id and status = 'closed') then raise exception '本期快照已在研讨会上讨论完毕，不能再改'; end if;
    update snapshot set title = t, link = lk, note = nt, submitted_at = now() where id = s.id;
  else
    insert into snapshot (project_id, person_id, title, period_start, seq, link, note, submitted_by)
    values (p_topic, app_uid(), t, per, coalesce((select max(seq) from snapshot where project_id = p_topic and person_id = app_uid()), 0) + 1, lk, nt, app_uid()) returning * into s;
    insert into snapshot_author (snapshot_id, user_id) values (s.id, app_uid());
    perform notify_user(p.owner_id, format('主线草稿：%s 在课题「%s」之下交了本人主线草稿「%s」的第 %s 次快照，由课题负责人指导', (select name from app_user where id = app_uid()), p.name, t, s.seq));
  end if;
  return s.id;
end $$;
select expose('save_personal_snapshot(uuid, text, text, text)');

-- ---------- 四、研究单元的停滞 ----------
-- 只看自开始记录日常任务（path_param.daily_from）以来已结束的各期
create function unit_stall(p_project uuid) returns text language plpgsql stable security definer set search_path = public as $$
declare cur date := token_period(app_today()); from_d date := (select (value #>> '{}')::date from path_param where key = 'daily_from'); k int := 0; d date;
begin
  d := cur - 14;
  while d >= from_d and k < 4 loop
    if exists (select 1 from biweekly_report where project_id = p_project and period_start = d) then exit; end if;
    k := k + 1; d := d - 14;
  end loop;
  return case when k >= 4 then 'terminate' when k >= 2 then 'stalled' else 'active' end;
end $$;

create table stall_notice (project_id uuid not null references project(id), period_start date not null, status text not null, primary key (project_id, period_start));
select seal('stall_notice');

-- 不经登录身份的通知：定时任务用
create function notify_sys(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if p_user is null then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null then return; end if;
  insert into feishu_outbox (target, payload, user_id)
  values (oid, jsonb_build_object('text', p_text, 'by', '正则', 'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI')), p_user);
end $$;
revoke execute on function notify_sys(uuid, text) from public;

-- 每期一次：新转为停滞或应终止的，通知负责人和人事岗
create function unit_stall_tick() returns int language plpgsql security definer set search_path = public as $$
declare r record; st text; n int := 0; h uuid; per date := token_period(app_today());
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for r in select id, name, owner_id from project where layer = 'paper' and active and not proposed loop
    st := unit_stall(r.id);
    if st = 'active' then continue; end if;
    insert into stall_notice (project_id, period_start, status) values (r.id, per, st) on conflict do nothing;
    if not found then continue; end if;
    perform notify_sys(r.owner_id, format('研究单元%s：「%s」%s', case st when 'stalled' then '停滞' else '应予终止' end, r.name,
      case st when 'stalled' then '连续两期未登记双周表，已转为停滞，负责人须到联席会议说明' else '停滞满两期仍未恢复，按规定应予终止，由联席会议办理' end));
    for h in select distinct g.user_id from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
             where rp.perm = 'people.manage' and g.revoked_at is null and (g.to_date is null or g.to_date >= app_today()) loop
      perform notify_sys(h, format('研究单元%s：「%s」%s', case st when 'stalled' then '停滞' else '应予终止' end, r.name, case st when 'stalled' then '连续两期未登记双周表' else '停滞满两期仍未恢复' end));
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;
select expose('unit_stall_tick()');

create view api.unit_status as
  select p.id as project_id, unit_stall(p.id) as status from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;
grant select on api.unit_status to app_api;

-- 快照、质疑按稿子区分：研究单元的稿子，或本人主线上的稿子
create or replace function add_query(p_pitch uuid, p_axis text, p_body text, p_raised_by uuid default null, p_parent uuid default null) returns uuid
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
    if not found or q.project_id <> s.project_id or q.person_id is distinct from s.person_id or q.parent_id is not null then raise exception '原来那一条不属于这份稿子'; end if;
    if q.status <> 'open' then raise exception '原来那一条已回应，请作为新的质疑记入'; end if;
    if q.period_start >= s.period_start then raise exception '本期提出的质疑不必再次提出'; end if;
    ax := coalesce(ax, q.axis);
  end if;
  if ax is null or axis_label(ax) is null then raise exception '请指明针对理、据、体、用中的哪一问'; end if;
  insert into query (project_id, person_id, pitch_id, period_start, axis, body, raised_by, parent_id, status, recorded_by)
  values (s.project_id, s.person_id, p_pitch, s.period_start, ax, b, p_raised_by, p_parent, case when p_parent is null then 'open' else 'again' end, app_uid()) returning query.id into v_id;
  return v_id;
end $$;

create or replace function close_pitch(p_pitch uuid) returns int language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; s snapshot; p project; q record; n int := 0; k int; share numeric; m record;
begin
  select * into x from snapshot_pitch where id = p_pitch for update;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者结束讨论' using errcode = '42501'; end if;
  if x.status <> 'accepted' then raise exception '只有接收讨论的快照可以结束讨论'; end if;
  select * into s from snapshot where id = x.snapshot_id;
  select * into p from project where id = s.project_id;
  update snapshot_pitch set status = 'closed', closed_by = app_uid(), closed_at = now() where id = p_pitch;
  for q in select * from query where project_id = s.project_id and person_id is not distinct from s.person_id and status = 'open' and parent_id is null and period_start < s.period_start order by recorded_at loop
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
  perform notify_user(coalesce(s.person_id, p.owner_id), format('研讨会讨论结束：%s「%s」第 %s 次快照的讨论已结束，本期新记质疑 %s 条、再次提出 %s 条，已回应 %s 条', case when s.person_id is null then '研究单元' else '本人主线草稿 · 课题' end, p.name, s.seq,
    (select count(*) from query where pitch_id = p_pitch and status <> 'again'), (select count(*) from query where pitch_id = p_pitch and status = 'again'), n));
  return n;
end $$;

create or replace function pitch_snapshot(p_snapshot uuid, p_seminars text[]) returns int language plpgsql security definer set search_path = public as $$
declare s snapshot; p project; c text; n int := 0; sm seminar;
begin
  select * into s from snapshot where id = p_snapshot;
  if not found then raise exception '快照不存在'; end if;
  select * into p from project where id = s.project_id;
  if not (case when s.person_id is not null then s.person_id = app_uid() else p.owner_id = app_uid() or is_on_project(p.id) end) then raise exception '只有研究单元的负责人和名单里的人、或本人主线草稿的本人可以提交' using errcode = '42501'; end if;
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

create or replace function add_query_member(p_query uuid, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare q query; p project;
begin
  select * into q from query where id = p_query;
  if not found or q.parent_id is not null then raise exception '质疑不存在'; end if;
  select * into p from project where id = q.project_id;
  if not (case when q.person_id is not null then q.person_id = app_uid() else p.owner_id = app_uid() end or app_role() = 'director') then raise exception '入队由研究单元的负责人加人；本人主线草稿的质疑由本人加人' using errcode = '42501'; end if;
  if q.status <> 'open' then raise exception '这条质疑已回应'; end if;
  if not exists (select 1 from app_user where id = p_user and active) then raise exception '人员不存在'; end if;
  insert into query_member (query_id, user_id, from_period, added_by) values (p_query, p_user, token_period(app_today()) + 14, app_uid());
  if not found then raise exception '已在队里'; end if;
  perform notify_user(p_user, format('质疑小队：你已加入研究单元「%s」的质疑小队（%s：%s），自下一期起参与分配', p.name, axis_label(q.axis), left(q.body, 60)));
exception when unique_violation then raise exception '已在队里';
end $$;

create or replace view api.snapshot as
  select s.id, s.project_id, p.code as project_code, p.name as project_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         s.period_start, s.seq, s.link, s.note, (select name from app_user where id = s.submitted_by) as submitted_by_name, s.submitted_at,
         (select coalesce(jsonb_agg(jsonb_build_object('id', a.user_id, 'name', u.name) order by u.name), '[]') from snapshot_author a join app_user u on u.id = a.user_id where a.snapshot_id = s.id) as authors,
         (s.period_start = token_period(app_today()) and (case when s.person_id is not null then s.person_id = app_uid() else p.owner_id = app_uid() or is_on_project(p.id) end)) as can_edit,
         s.person_id, (select name from app_user where id = s.person_id) as person_name, s.title
  from snapshot s join project p on p.id = s.project_id where app_role() is not null;


create or replace view api.snapshot_pitch as
  select x.id, x.snapshot_id, s.project_id, p.code as project_code, p.name as project_name, s.seq, s.period_start, s.link,
         x.seminar, sm.name as seminar_name, x.status, x.note, (select name from app_user where id = x.decided_by) as decided_by_name, x.decided_at, x.closed_at,
         is_organizer(x.seminar) as can_run,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status <> 'again') as new_queries,
         (select count(*)::int from query q where q.pitch_id = x.id and q.status = 'again') as again_queries,
         (select count(*)::int from query q where q.resolved_pitch = x.id) as resolved,
         s.person_id, (select name from app_user where id = s.person_id) as person_name, s.title
  from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id join seminar sm on sm.code = x.seminar
  where app_role() is not null;


create or replace view api.query as
  select q.id, q.project_id, p.code as project_code, p.name as project_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         q.pitch_id, x.seminar, (select name from seminar where code = x.seminar) as seminar_name, s.seq as snapshot_seq, q.period_start, q.axis, axis_label(q.axis) as axis_label, q.body,
         (select name from app_user where id = q.raised_by) as raised_by_name, q.parent_id, q.status, q.resolved_period, q.recorded_at,
         (select count(*)::int from query a where a.parent_id = q.id) as again,
         (select coalesce(jsonb_agg(jsonb_build_object('id', m.user_id, 'name', u.name, 'from', m.from_period) order by m.added_at), '[]') from query_member m join app_user u on u.id = m.user_id where m.query_id = q.id) as team,
         exists (select 1 from query_member m where m.query_id = q.id and m.user_id = app_uid()) as in_team,
         (case when q.person_id is not null then q.person_id = app_uid() else p.owner_id = app_uid() end or app_role() = 'director') as can_team,
         (is_organizer(x.seminar) and x.status = 'accepted') as can_remove,
         q.person_id, (select name from app_user where id = q.person_id) as person_name
  from query q join project p on p.id = q.project_id join snapshot_pitch x on x.id = q.pitch_id join snapshot s on s.id = x.snapshot_id
  where app_role() is not null;

