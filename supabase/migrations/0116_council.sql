-- 联席会议进中台（黄济民 2026-11-26）：议题、附议、修正案、讨论发言、会上表决与会外表决、回避、复议、否决期、生效后转办；
-- Assistant 和 Intern 每学期推选一名代表列席。议事规则见《联席会议议事规则（草案）》，作为第一份议题交联席会议表决
--   有表决权：身份为 Researcher、Rising Star、PI 的在用账号；Director 不参加，保留否决权
--   主持：有 budget.evaluate 权限的（科研助理）或中心负责人账号

-- ---------- 有表决权的成员与代表 ----------
create function council_voter(p_user uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_user u where u.id = p_user and u.active) and user_rank(p_user) in ('researcher','rising_star','pi')
$$;
create function council_electorate() returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from app_user u where u.active and user_rank(u.id) in ('researcher','rising_star','pi')
$$;
create function council_chair() returns boolean language sql stable security definer set search_path = public as $$
  select has_perm('budget.evaluate') or app_role() = 'director'
$$;
-- 学期：9 月至次年 1 月为秋季学期，2 月至 8 月为春季学期
create function council_term(p_on date) returns text language sql immutable as $$
  select case when extract(month from p_on) >= 9 then extract(year from p_on)::int || '秋'
              when extract(month from p_on) = 1 then (extract(year from p_on)::int - 1) || '秋'
              else extract(year from p_on)::int || '春' end
$$;
create function council_rep_eligible(p_user uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from person p join app_user u on u.id = p.user_id where p.user_id = p_user and u.active and p.status in ('active','offroll') and p.rank in ('intern','assistant'))
$$;

create table council_rep_vote (
  term         text not null,
  voter_id     uuid not null references app_user(id),
  candidate_id uuid not null references app_user(id),
  at           timestamptz not null default now(),
  primary key (term, voter_id)
);
select seal('council_rep_vote');

-- 本学期的代表：得票最多的，同票的先得票者当选
create function council_rep(p_term text default null) returns uuid language sql stable security definer set search_path = public as $$
  select candidate_id from council_rep_vote where term = coalesce(p_term, council_term(app_today())) and council_rep_eligible(candidate_id)
  group by candidate_id order by count(*) desc, min(at) limit 1
$$;

create function vote_council_rep(p_candidate uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not council_rep_eligible(app_uid()) then raise exception '代表由 Assistant 和 Intern 推选' using errcode = '42501'; end if;
  if not council_rep_eligible(p_candidate) then raise exception '代表须是 Assistant 或 Intern'; end if;
  insert into council_rep_vote (term, voter_id, candidate_id) values (council_term(app_today()), app_uid(), p_candidate)
  on conflict (term, voter_id) do update set candidate_id = excluded.candidate_id, at = now();
end $$;

-- ---------- 议题 ----------
create table motion (
  id           uuid primary key default gen_random_uuid(),
  seq          int generated always as identity,
  mtype        text not null default 'main' check (mtype in ('main','amend','reconsider','procedural')),
  category     text not null check (category in ('research','unit','budget','assessment','personnel','removal','rules','other','procedure')),
  title        text not null check (length(btrim(title)) between 1 and 80),
  body         text not null check (length(btrim(body)) between 1 and 12000),
  link         text check (link is null or (link ~ '^https?://' and length(link) <= 500)),
  parent_id    uuid references motion(id),
  proposer_id  uuid not null references app_user(id),
  seconder_id  uuid references app_user(id),
  subjects     uuid[] not null default '{}',
  threshold    text not null check (threshold in ('majority','two_thirds')),
  ballot       text not null check (ballot in ('open','secret')),
  urgent       boolean not null default false,
  ref_kind     text check (ref_kind in ('assessment')),
  ref_id       uuid,
  status       text not null default 'proposed' check (status in ('proposed','seconded','voting','passed','failed','vetoed','effective','withdrawn')),
  round        int not null default 1,
  meeting_id   uuid references attend_event(id),
  online       boolean not null default false,
  vote_open_at timestamptz,
  vote_until   timestamptz,
  yes int, no int, abstain int, eligible int,
  note         text,
  decided_at   timestamptz,
  veto_until   timestamptz,
  veto_reason  text,
  vetoed_by    uuid references app_user(id),
  effective_at timestamptz,
  body_prev    text,
  created_at   timestamptz not null default now(),
  seconded_at  timestamptz
);
create table motion_vote (
  motion_id uuid not null references motion(id) on delete cascade,
  round     int not null,
  user_id   uuid not null references app_user(id),
  choice    text not null check (choice in ('yes','no','abstain')),
  at        timestamptz not null default now(),
  primary key (motion_id, round, user_id)
);
create table motion_recusal (
  motion_id uuid not null references motion(id) on delete cascade,
  user_id   uuid not null references app_user(id),
  note      text check (note is null or length(note) <= 200),
  at        timestamptz not null default now(),
  primary key (motion_id, user_id)
);
create table motion_meeting_request (
  motion_id uuid not null references motion(id) on delete cascade,
  round     int not null,
  user_id   uuid not null references app_user(id),
  at        timestamptz not null default now(),
  primary key (motion_id, round, user_id)
);
create table motion_speech (
  id           uuid primary key default gen_random_uuid(),
  motion_id    uuid not null references motion(id) on delete cascade,
  round        int not null,
  user_id      uuid not null references app_user(id),
  side         text not null check (side in ('pro','con','neutral')),
  requested_at timestamptz not null default now(),
  spoke_at     timestamptz
);
create unique index motion_speech_pending on motion_speech (motion_id, user_id) where spoke_at is null;
select seal('motion', 'motion_vote', 'motion_recusal', 'motion_meeting_request', 'motion_speech');
create trigger audit after insert or update or delete on motion for each row execute function trg_audit();
create trigger audit after insert or update or delete on motion_recusal for each row execute function trg_audit();

create function council_notify(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  if app_uid() is null then perform notify_sys(p_user, p_text); else perform notify_user(p_user, p_text); end if;
end $$;
revoke execute on function council_notify(uuid, text) from public;
create function council_notify_directors(p_text text) returns void language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  for d in select id from app_user where active and role = 'director' loop perform council_notify(d, p_text); end loop;
end $$;
revoke execute on function council_notify_directors(text) from public;

create function motion_can_vote(p_motion uuid, p_user uuid) returns boolean language sql stable security definer set search_path = public as $$
  select council_voter(p_user) and not exists (select 1 from motion m where m.id = p_motion and p_user = any(m.subjects))
     and not exists (select 1 from motion_recusal r where r.motion_id = p_motion and r.user_id = p_user)
$$;

-- 工作日用 0063 的 add_workdays（跳过周六周日）

create function motion_label(m motion) returns text language sql stable as $$
  select format('第 %s 号%s「%s」', m.seq, case m.mtype when 'amend' then '修正案' when 'reconsider' then '复议' when 'procedural' then '程序动议' else '议题' end, m.title)
$$;

-- 提案：有表决权的成员、中心负责人账号、本学期代表都可以提
create function submit_motion(p_title text, p_category text, p_body text, p_link text default null, p_subjects uuid[] default '{}',
  p_urgent boolean default false, p_mtype text default 'main', p_parent uuid default null, p_ref_kind text default null, p_ref_id uuid default null, p_two_thirds boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare mt text := coalesce(p_mtype, 'main'); pa motion; cat text := p_category; thr text; bal text; subj uuid[] := coalesce(p_subjects, '{}'); v_id uuid; a assessment; pu uuid; mv text;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if not (council_voter(app_uid()) or app_role() = 'director' or council_rep() = app_uid()) then
    raise exception '有表决权的成员、中心负责人和代表可以提案' using errcode = '42501'; end if;
  if mt not in ('main','amend','reconsider','procedural') then raise exception '动议类别不对'; end if;
  if mt = 'main' then
    if p_parent is not null then raise exception '议题不挂在别的议题下面'; end if;
    if cat is null or cat not in ('research','unit','budget','assessment','personnel','removal','rules','other') then raise exception '请选择议题类别'; end if;
  else
    select * into pa from motion where id = p_parent;
    if not found and mt <> 'procedural' then raise exception '请指明针对哪一份议题'; end if;
    if mt = 'amend' and (pa.mtype <> 'main' or pa.status not in ('proposed','seconded')) then raise exception '修正案须在议题表决之前提出'; end if;
    if mt = 'reconsider' then
      if pa.mtype <> 'main' or pa.status not in ('passed','failed') or pa.decided_at < now() - interval '21 days' then raise exception '只能在本次或下一次会议复议已表决、尚未生效的议题'; end if;
      if exists (select 1 from motion where parent_id = pa.id and mtype = 'reconsider' and status <> 'withdrawn') then raise exception '同一议题只能复议一次'; end if;
      if pa.ballot = 'open' then
        select choice into mv from motion_vote where motion_id = pa.id and round = pa.round and user_id = app_uid();
        if mv is distinct from (case when pa.status = 'passed' then 'yes' else 'no' end) then raise exception '复议由投了多数一方票的成员提出'; end if;
      end if;
    end if;
    cat := 'procedure';
  end if;
  if p_ref_kind is not null then
    if p_ref_kind <> 'assessment' then raise exception '不认识的关联对象'; end if;
    select * into a from assessment where id = p_ref_id;
    if not found or a.kind = 'ra' or a.status <> 'applied' then raise exception '这项考核不在待联席会议表决的状态'; end if;
    if exists (select 1 from motion where ref_kind = 'assessment' and ref_id = p_ref_id and status not in ('withdrawn','failed','vetoed')) then raise exception '这项考核已提交联席会议'; end if;
    select user_id into pu from person where id = a.person_id;
    if pu is not null and not pu = any(subj) then subj := subj || pu; end if;
    cat := 'assessment';
  end if;
  if exists (select 1 from unnest(subj) s where not exists (select 1 from app_user where id = s)) then raise exception '涉及的人不在中台'; end if;
  thr := case when cat in ('removal','rules') or (mt = 'procedural' and p_two_thirds) then 'two_thirds' else 'majority' end;
  bal := case when cat in ('assessment','personnel','removal') or (pa.id is not null and pa.ballot = 'secret') then 'secret' else 'open' end;
  insert into motion (mtype, category, title, body, link, parent_id, proposer_id, subjects, threshold, ballot, urgent, ref_kind, ref_id)
  values (mt, cat, btrim(p_title), btrim(p_body), nullif(btrim(coalesce(p_link, '')), ''), p_parent, app_uid(), subj, thr, bal, coalesce(p_urgent, false), p_ref_kind, p_ref_id)
  returning motion.id into v_id;
  return v_id;
end $$;

create function second_motion(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare m motion;
begin
  select * into m from motion where id = p_id for update;
  if not found then raise exception '议题不存在'; end if;
  if not council_voter(app_uid()) then raise exception '由有表决权的成员附议' using errcode = '42501'; end if;
  if m.proposer_id = app_uid() then raise exception '提案人不能附议自己的提案'; end if;
  if m.status <> 'proposed' then raise exception '这份已有人附议或已处理'; end if;
  update motion set status = 'seconded', seconder_id = app_uid(), seconded_at = now() where id = p_id;
  perform council_notify(m.proposer_id, format('联席会议：%s 已由 %s 附议，列入议程', motion_label(m), (select name from app_user where id = app_uid())));
end $$;

create function withdraw_motion(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare m motion;
begin
  select * into m from motion where id = p_id for update;
  if not found then raise exception '议题不存在'; end if;
  if m.proposer_id is distinct from app_uid() then raise exception '由提案人撤回' using errcode = '42501'; end if;
  if m.status not in ('proposed','seconded') then raise exception '表决开始后不能撤回'; end if;
  update motion set status = 'withdrawn', decided_at = now() where id = p_id;
end $$;

create function recuse_motion(p_id uuid, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare m motion;
begin
  select * into m from motion where id = p_id;
  if not found then raise exception '议题不存在'; end if;
  if not council_voter(app_uid()) then raise exception '只有有表决权的成员需要申报回避' using errcode = '42501'; end if;
  if m.status not in ('proposed','seconded','voting') then raise exception '已表决的议题不再申报回避'; end if;
  insert into motion_recusal (motion_id, user_id, note) values (p_id, app_uid(), nullif(btrim(coalesce(p_note, '')), '')) on conflict do nothing;
  delete from motion_vote where motion_id = p_id and round = m.round and user_id = app_uid();
end $$;

-- 会上开放表决：须在开着的联席会议上，有表决权的成员过半数签到出席
create function council_present(p_event uuid) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from attend a where a.event_id = p_event and a.status = 'present' and council_voter(a.user_id)
$$;
create function open_vote(p_id uuid, p_meeting uuid) returns void language plpgsql security definer set search_path = public as $$
declare m motion; e attend_event; pres int; tot int := council_electorate();
begin
  if not council_chair() then raise exception '由联席会议主持人开放表决' using errcode = '42501'; end if;
  select * into m from motion where id = p_id for update;
  if not found then raise exception '议题不存在'; end if;
  select * into e from attend_event where id = p_meeting;
  if not found or e.kind <> 'council' or e.started_at is null or e.ended_at is not null then raise exception '须在开着的联席会议上表决'; end if;
  if m.status <> 'seconded' then raise exception '只有已附议、尚未表决的可以开放表决'; end if;
  if m.mtype = 'main' and m.created_at > now() - interval '3 days' then raise exception '提案须在表决前三天提交（本议题 % 提交）', to_char(m.created_at at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'); end if;
  if exists (select 1 from motion c where c.parent_id = m.id and c.mtype = 'amend' and c.status in ('proposed','seconded','voting')) then raise exception '先表决或撤回修正案'; end if;
  pres := council_present(p_meeting);
  if pres * 2 <= tot then raise exception '出席的有表决权成员不足半数，不能表决（出席 % 人，共 % 人）', pres, tot; end if;
  update motion set status = 'voting', meeting_id = p_meeting, online = false, vote_open_at = now(), vote_until = null where id = p_id;
end $$;

-- 会外表决：只限紧急议题；修正案、复议、程序动议不在会外表决
create function open_online_vote(p_id uuid, p_hours int default 48) returns void language plpgsql security definer set search_path = public as $$
declare m motion; u uuid;
begin
  if not council_chair() then raise exception '会外表决由科研助理召集' using errcode = '42501'; end if;
  select * into m from motion where id = p_id for update;
  if not found then raise exception '议题不存在'; end if;
  if m.status <> 'seconded' then raise exception '只有已附议、尚未表决的可以表决'; end if;
  if m.mtype <> 'main' or not m.urgent then raise exception '会外表决限于紧急议题'; end if;
  if exists (select 1 from motion c where c.parent_id = m.id and c.mtype = 'amend' and c.status in ('proposed','seconded','voting')) then raise exception '先处理修正案'; end if;
  if p_hours is null or p_hours < 24 or p_hours > 168 then raise exception '会外表决开放 24 至 168 小时'; end if;
  update motion set status = 'voting', online = true, meeting_id = null, vote_open_at = now(), vote_until = now() + make_interval(hours => p_hours) where id = p_id;
  for u in select id from app_user where active and user_rank(id) in ('researcher','rising_star','pi') loop
    if motion_can_vote(p_id, u) then perform council_notify(u, format('联席会议会外表决：%s，%s 前在正则上投票；需要当面讨论的，可以要求转到下次会议', motion_label(m),
      to_char((now() + make_interval(hours => p_hours)) at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))); end if;
  end loop;
end $$;

create function cast_vote(p_id uuid, p_choice text) returns void language plpgsql security definer set search_path = public as $$
declare m motion;
begin
  select * into m from motion where id = p_id;
  if not found then raise exception '议题不存在'; end if;
  if m.status <> 'voting' then raise exception '这份不在表决中'; end if;
  if p_choice not in ('yes','no','abstain') then raise exception '选项只有同意、反对、弃权'; end if;
  if not council_voter(app_uid()) then raise exception '由有表决权的成员投票' using errcode = '42501'; end if;
  if not motion_can_vote(p_id, app_uid()) then raise exception '表决事项涉及本人或已申报回避，不参加投票'; end if;
  if not m.online and not exists (select 1 from attend where event_id = m.meeting_id and user_id = app_uid() and status = 'present') then
    raise exception '会上表决由出席的成员投票，请先签到'; end if;
  if m.online and m.vote_until < now() then raise exception '表决已截止'; end if;
  insert into motion_vote (motion_id, round, user_id, choice) values (p_id, m.round, app_uid(), p_choice)
  on conflict (motion_id, round, user_id) do update set choice = excluded.choice, at = now();
end $$;

-- 会外表决中，两名有表决权的成员要求当面讨论的，转到下次会议
create function request_meeting(p_id uuid) returns int language plpgsql security definer set search_path = public as $$
declare m motion; n int;
begin
  select * into m from motion where id = p_id for update;
  if not found then raise exception '议题不存在'; end if;
  if m.status <> 'voting' or not m.online then raise exception '只有会外表决可以要求转到会上'; end if;
  if not council_voter(app_uid()) then raise exception '由有表决权的成员提出' using errcode = '42501'; end if;
  insert into motion_meeting_request (motion_id, round, user_id) values (p_id, m.round, app_uid()) on conflict do nothing;
  select count(*) into n from motion_meeting_request where motion_id = p_id and round = m.round;
  if n >= 2 then
    update motion set status = 'seconded', online = false, vote_open_at = null, vote_until = null, round = round + 1 where id = p_id;
    perform council_notify(m.proposer_id, format('联席会议：%s 有两名成员要求当面讨论，会外表决中止，转到下次会议', motion_label(m)));
  end if;
  return n;
end $$;

-- 考核：表决结果落到考核上（与原来的录入表决一致）
create function assessment_council_apply(p_id uuid, p_pass boolean, p_on date, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare a assessment; pr person;
begin
  select * into a from assessment where id = p_id for update;
  if not found or a.status <> 'applied' then return; end if;
  select * into pr from person where id = a.person_id;
  update assessment set status = case when p_pass then 'recommended' else 'failed' end, council_on = p_on, council_note = p_note,
    decided_at = case when p_pass then null else now() end where id = p_id;
  if p_pass then perform council_notify_directors(format('考核待决定：联席会议表决同意推荐 %s 通过%s，请中心负责人决定', pr.name, assess_label(a.kind)));
  else perform council_notify(pr.user_id, format('%s未通过：联席会议表决未通过', assess_label(a.kind))); end if;
end $$;
revoke execute on function assessment_council_apply(uuid, boolean, date, text) from public;

-- 结束表决并计票
create function motion_close(p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare m motion; y int; n int; ab int; elig int := 0; tot int := council_electorate(); ok boolean; nt text; u uuid; res text;
begin
  select * into m from motion where id = p_id for update;
  if m.status <> 'voting' then raise exception '这份不在表决中'; end if;
  select count(*) filter (where choice = 'yes'), count(*) filter (where choice = 'no'), count(*) filter (where choice = 'abstain') into y, n, ab
  from motion_vote where motion_id = p_id and round = m.round;
  for u in select id from app_user where active and user_rank(id) in ('researcher','rising_star','pi') loop
    if motion_can_vote(p_id, u) then elig := elig + 1; end if;
  end loop;
  if m.online and (y + n + ab) * 2 <= tot then ok := false; nt := format('投票 %s 人，不足有表决权成员（%s 人）的半数，表决无效', y + n + ab, tot);
  elsif m.threshold = 'majority' then ok := y > n;
  else ok := y > 0 and y * 3 >= (y + n) * 2; end if;
  update motion set yes = y, no = n, abstain = ab, eligible = elig, decided_at = now(), note = coalesce(nt, note),
    status = case when ok then 'passed' else 'failed' end where id = p_id;
  res := case when ok then 'passed' else 'failed' end;
  if ok and m.mtype = 'main' then
    update motion set veto_until = ((add_workdays((now() at time zone 'Asia/Shanghai')::date, 3) + 1)::timestamp at time zone 'Asia/Shanghai') where id = p_id;
    perform council_notify_directors(format('联席会议决议：%s 以 %s 票同意、%s 票反对、%s 票弃权通过，三个工作日内未否决的生效', motion_label(m), y, n, ab));
  elsif ok then
    update motion set status = 'effective', effective_at = now() where id = p_id;
    if m.mtype = 'amend' then update motion set body_prev = body, body = m.body where id = m.parent_id; end if;
    if m.mtype = 'reconsider' then
      update motion set status = 'seconded', round = round + 1, decided_at = null, yes = null, no = null, abstain = null, eligible = null,
        veto_until = null, meeting_id = null, vote_open_at = null, note = null where id = m.parent_id;
    end if;
  elsif m.ref_kind = 'assessment' then
    perform assessment_council_apply(m.ref_id, false, (now() at time zone 'Asia/Shanghai')::date, null);
  end if;
  perform council_notify(m.proposer_id, format('联席会议：%s 表决%s（同意 %s、反对 %s、弃权 %s）%s', motion_label(m), case when ok then '通过' else '未通过' end, y, n, ab, coalesce('。' || nt, '')));
  return res;
end $$;
revoke execute on function motion_close(uuid) from public;

create function close_vote(p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare m motion;
begin
  if not council_chair() then raise exception '由联席会议主持人结束表决' using errcode = '42501'; end if;
  select * into m from motion where id = p_id;
  if not found then raise exception '议题不存在'; end if;
  if m.online then raise exception '会外表决到截止时间自动结束'; end if;
  return motion_close(p_id);
end $$;

create function veto_motion(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare m motion; r text := btrim(coalesce(p_reason, '')); u uuid;
begin
  if app_role() is distinct from 'director' then raise exception '由中心主任否决' using errcode = '42501'; end if;
  select * into m from motion where id = p_id for update;
  if not found then raise exception '议题不存在'; end if;
  if m.status <> 'passed' or m.mtype <> 'main' or m.veto_until < now() then raise exception '只能在决议通过后三个工作日内否决'; end if;
  if r = '' or length(r) > 1000 then raise exception '否决须写明理由，不超过 1000 字'; end if;
  update motion set status = 'vetoed', veto_reason = r, vetoed_by = app_uid() where id = p_id;
  for u in select id from app_user where active and (user_rank(id) in ('researcher','rising_star','pi') or id = m.proposer_id or id = council_rep()) loop
    perform council_notify(u, format('联席会议决议被否决：%s。理由：%s', motion_label(m), left(r, 300)));
  end loop;
end $$;

-- 定时任务：会外表决到点计票；否决期满的决议生效并转办
create function council_tick() returns int language plpgsql security definer set search_path = public as $$
declare m motion; k int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for m in select * from motion where status = 'voting' and online and vote_until < now() loop perform motion_close(m.id); k := k + 1; end loop;
  for m in select * from motion where status = 'passed' and mtype = 'main' and veto_until < now() loop
    update motion set status = 'effective', effective_at = now() where id = m.id;
    if m.ref_kind = 'assessment' then perform assessment_council_apply(m.ref_id, true, (m.decided_at at time zone 'Asia/Shanghai')::date, null); end if;
    perform council_notify(m.proposer_id, format('联席会议决议生效：%s，请按决议办理', motion_label(m)));
    k := k + 1;
  end loop;
  return k;
end $$;

-- ---------- 讨论发言 ----------
create function request_speech(p_id uuid, p_side text) returns uuid language plpgsql security definer set search_path = public as $$
declare m motion; v_id uuid;
begin
  select * into m from motion where id = p_id;
  if not found then raise exception '议题不存在'; end if;
  if m.status not in ('seconded','voting') then raise exception '这份不在讨论中'; end if;
  if p_side not in ('pro','con','neutral') then raise exception '请标明支持、反对或中立'; end if;
  if not (council_voter(app_uid()) or council_rep() = app_uid() or m.proposer_id = app_uid()) then raise exception '有表决权的成员、代表和提案人可以发言' using errcode = '42501'; end if;
  if (select count(*) from motion_speech where motion_id = p_id and round = m.round and user_id = app_uid() and spoke_at is not null) >= 2 then raise exception '同一议题最多发言两次'; end if;
  if exists (select 1 from motion_speech where motion_id = p_id and user_id = app_uid() and spoke_at is null) then raise exception '已在发言队列里'; end if;
  insert into motion_speech (motion_id, round, user_id, side) values (p_id, m.round, app_uid(), p_side) returning motion_speech.id into v_id;
  return v_id;
end $$;
create function mark_spoken(p_speech uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not council_chair() then raise exception '由主持人安排发言' using errcode = '42501'; end if;
  update motion_speech set spoke_at = now() where id = p_speech and spoke_at is null;
  if not found then raise exception '这条发言申请不存在或已发言'; end if;
end $$;
create function cancel_speech(p_speech uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from motion_speech where id = p_speech and spoke_at is null and (user_id = app_uid() or council_chair());
  if not found then raise exception '这条发言申请不存在或已发言'; end if;
end $$;

select expose('vote_council_rep(uuid)', 'submit_motion(text, text, text, text, uuid[], boolean, text, uuid, text, uuid, boolean)', 'second_motion(uuid)', 'withdraw_motion(uuid)',
  'recuse_motion(uuid, text)', 'open_vote(uuid, uuid)', 'open_online_vote(uuid, int)', 'cast_vote(uuid, text)', 'request_meeting(uuid)', 'close_vote(uuid)',
  'veto_motion(uuid, text)', 'request_speech(uuid, text)', 'mark_spoken(uuid)', 'cancel_speech(uuid)');

-- ---------- 视图 ----------
create view api.council_motion as
  select m.id, m.seq, m.mtype, m.category, m.title, m.body, m.link, m.parent_id, (select seq from motion p where p.id = m.parent_id) as parent_seq,
         (select title from motion p where p.id = m.parent_id) as parent_title,
         m.proposer_id, (select name from app_user where id = m.proposer_id) as proposer_name, (select name from app_user where id = m.seconder_id) as seconder_name,
         (select coalesce(jsonb_agg(u.name order by u.name), '[]') from app_user u where u.id = any(m.subjects)) as subject_names,
         m.threshold, m.ballot, m.urgent, m.ref_kind, m.ref_id, m.status, m.round, m.meeting_id, m.online, m.vote_open_at, m.vote_until,
         case when m.status <> 'voting' then m.yes end as yes, case when m.status <> 'voting' then m.no end as no, case when m.status <> 'voting' then m.abstain end as abstain,
         m.eligible, m.note, m.decided_at, m.veto_until, m.veto_reason, m.effective_at, m.body_prev, m.created_at, m.seconded_at,
         (select count(*)::int from motion_vote v where v.motion_id = m.id and v.round = m.round) as cast_count,
         (select choice from motion_vote v where v.motion_id = m.id and v.round = m.round and v.user_id = app_uid()) as my_vote,
         motion_can_vote(m.id, app_uid()) as can_vote,
         (council_voter(app_uid()) and m.status = 'proposed' and m.proposer_id <> app_uid()) as can_second,
         (m.proposer_id = app_uid() and m.status in ('proposed','seconded')) as can_withdraw,
         council_chair() as can_chair,
         (app_role() = 'director' and m.status = 'passed' and m.mtype = 'main' and m.veto_until > now()) as can_veto,
         exists (select 1 from motion_recusal r where r.motion_id = m.id and r.user_id = app_uid()) as recused,
         (select coalesce(jsonb_agg(u.name order by u.name), '[]') from motion_recusal r join app_user u on u.id = r.user_id where r.motion_id = m.id) as recused_names,
         (select count(*)::int from motion_meeting_request r where r.motion_id = m.id and r.round = m.round) as meeting_requests,
         exists (select 1 from motion_meeting_request r where r.motion_id = m.id and r.round = m.round and r.user_id = app_uid()) as my_request,
         (select count(*)::int from motion c where c.parent_id = m.id and c.mtype = 'amend' and c.status in ('proposed','seconded','voting')) as open_amendments
  from motion m where app_role() is not null;

-- 记名表决公开每人的选择；不记名的不公开
create view api.council_ballot as
  select v.motion_id, v.round, u.name, v.choice from motion_vote v join motion m on m.id = v.motion_id join app_user u on u.id = v.user_id
  where app_role() is not null and m.ballot = 'open' and m.status <> 'voting' and v.round = m.round;

create view api.council_speech as
  select s.id, s.motion_id, s.round, s.user_id, u.name as user_name, s.side, s.requested_at, s.spoke_at, (s.user_id = app_uid()) as mine,
         (select count(*)::int from motion_speech t where t.motion_id = s.motion_id and t.round = s.round and t.user_id = s.user_id and t.spoke_at is not null) as spoken
  from motion_speech s join app_user u on u.id = s.user_id join motion m on m.id = s.motion_id
  where app_role() is not null and s.round = m.round;

create view api.council_info as
  select council_term(app_today()) as term, council_electorate() as electorate, council_voter(app_uid()) as am_voter,
         (council_rep() = app_uid()) as am_rep, council_rep_eligible(app_uid()) as can_rep_vote, council_chair() as can_chair,
         (app_role() = 'director') as am_director, (select name from app_user where id = council_rep()) as rep_name,
         (select candidate_id from council_rep_vote where term = council_term(app_today()) and voter_id = app_uid()) as my_rep_vote
  where app_role() is not null;

create view api.council_rep as
  select v.candidate_id as id, u.name, count(*)::int as votes from council_rep_vote v join app_user u on u.id = v.candidate_id
  where app_role() is not null and v.term = council_term(app_today()) and council_rep_eligible(v.candidate_id)
  group by v.candidate_id, u.name;

create view api.council_rep_pick as
  select u.id, u.name from app_user u where app_role() is not null and council_rep_eligible(u.id);

create view api.council_meeting as
  select e.id, council_electorate() as electorate, council_present(e.id) as present_voters
  from attend_event e where app_role() is not null and e.kind = 'council';

grant select on api.council_motion, api.council_ballot, api.council_speech, api.council_info, api.council_rep, api.council_rep_pick, api.council_meeting to app_api;
