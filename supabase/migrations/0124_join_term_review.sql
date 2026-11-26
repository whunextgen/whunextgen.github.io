-- 人员加入与学期考核进中台（黄济民 2026-11-26「把人员加入和学期考核接进来」）
-- 依据：章程第十八条、第三十条至第三十八条；《独立研究者成长路径》（第五十三版）第三节「成为 RI」、第七节「保持与收回」。
--
-- 人员加入
--   成长路径：加入中心即为 RI，不需要考核，也不做小任务（黄济民否定了「RI 也要先做小任务」）。
--   章程第十八条：招生及博士后的接收由联席会议表决后向中心主任推荐，由中心主任决定；第三十三条研究助理的聘用同此，占名额。
--   所以分两路：
--     博士研究生、博士后、研究助理：成员推荐 → 自动列入联席会议议程（免附议）→ 表决通过、否决期满 → 中心负责人决定 → 建档。
--     硕士研究生、研究实习生（本科生）、访问学生：成员推荐 → 人事确认建档，直接为 RI。
--   名额（第三十条）：中心负责人按年度、按类别确定；需表决的三类在名额内推荐，没有确定名额的不能推荐。
--   建档后身份为 RI（Intern），以后按成长路径升级；本人首次飞书登录时由人事并入这条档案。
--   成长路径第三节：加入满两期仍未进入任何研究单元的，办理离开。这里按天检查，满 28 天仍不在任何研究单元的，通知人事办理。
--
-- 学期考核（第三十六至三十八条）
--   每学期由联席会议主持人发起一次，在册成员每人一条，不另写总结：页面直接汇总双周表、主线、研究单元名单、支出和出勤，加上合作者匿名短评。
--   Researcher、Rising Star：进展小组两人（主持人按联席会议指定的登记），审阅后出具意见，两人都签署后自动列入联席会议议程表决。
--   Intern、Assistant：由合作的 Researcher 及以上成员评价（默认取本人所在研究单元的负责人），报联席会议备案。
--     章程写的是「博士研究生、博士后」与「硕士、研究助理、研究实习生」；中台按成长路径的身份分，与联席会议有表决权的范围一致。
--   结论三种：正常、需改进、建议退组。需改进的，写明两个月的改进目标，到期由考核人记录是否达成。
--   建议退组的，不论哪一类，都列入联席会议议程，须投票者三分之二同意、不记名；本人可书面申辩一次，并可到会陈述；
--     决议生效后由中心负责人决定。
--   PI、Director 不在考核范围。

-- ---------- 名额 ----------
create table admission_quota (
  year     int  not null,
  kind     text not null check (kind in ('phd','postdoc','ra')),
  quota    int  not null check (quota between 0 and 200),
  set_by   uuid references app_user(id),
  set_at   timestamptz not null default now(),
  primary key (year, kind)
);
select seal('admission_quota');
create trigger audit after insert or update or delete on admission_quota for each row execute function trg_audit();

create function admission_kind_label(k text) returns text language sql immutable as $$
  select case k when 'phd' then '博士研究生' when 'postdoc' then '博士后' when 'ra' then '研究助理' when 'master' then '硕士研究生'
    when 'ri' then '研究实习生' when 'visitor' then '访问学生' end
$$;
create function admission_needs_vote(k text) returns boolean language sql immutable as $$ select k in ('phd','postdoc','ra') $$;

create function set_admission_quota(p_year int, p_kind text, p_quota int) returns void language plpgsql security definer set search_path = public as $$
begin
  if app_role() is distinct from 'director' then raise exception '名额由中心负责人确定' using errcode = '42501'; end if;
  if p_kind not in ('phd','postdoc','ra') then raise exception '只有博士研究生、博士后、研究助理设名额'; end if;
  if p_year is null or p_year < 2026 or p_year > 2100 then raise exception '年度不对'; end if;
  insert into admission_quota (year, kind, quota, set_by) values (p_year, p_kind, p_quota, app_uid())
  on conflict (year, kind) do update set quota = excluded.quota, set_by = excluded.set_by, set_at = now();
end $$;

-- ---------- 加入申请 ----------
create table admission (
  id            uuid primary key default gen_random_uuid(),
  seq           serial unique,
  year          int  not null,
  name          text not null check (length(btrim(name)) between 1 and 40),
  kind          text not null check (kind in ('phd','postdoc','ra','master','ri','visitor')),
  school        text check (school is null or length(school) <= 80),
  direction     text check (direction is null or length(direction) <= 120),
  intro         text not null check (length(btrim(intro)) between 1 and 2000),   -- 推荐理由：研究兴趣、已有工作、拟加入的课题或研究单元
  link          text check (link is null or (link ~ '^https?://' and length(link) <= 500)),
  recommender   uuid not null references app_user(id),
  status        text not null default 'pending' check (status in ('pending','voting','recommended','admitted','declined','withdrawn')),
  person_id     uuid references person(id),
  decided_by    uuid references app_user(id),
  decided_at    timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  created_at    timestamptz not null default now()
);
select seal('admission');
create trigger audit after insert or update or delete on admission for each row execute function trg_audit();

alter table motion drop constraint motion_ref_kind_check;
alter table motion add constraint motion_ref_kind_check check (ref_kind in ('assessment','unit','tier','path','fixed_change','period_report','unit_stall','project_end','removal','trial_appeal','admission','term_review'));

-- 名额内已用：在办和已加入的
create function admission_used(p_year int, p_kind text) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from admission where year = p_year and kind = p_kind and status in ('pending','voting','recommended','admitted')
$$;

create function submit_admission(p_name text, p_kind text, p_school text, p_direction text, p_intro text, p_link text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; y int := extract(year from app_today())::int; q int; n text := btrim(coalesce(p_name, '')); a admission;
begin
  if app_uid() is null or not exists (select 1 from person where user_id = app_uid() and status in ('active','offroll')) then raise exception '由在册成员推荐' using errcode = '42501'; end if;
  if p_kind not in ('phd','postdoc','ra','master','ri','visitor') then raise exception '请选择类别'; end if;
  if n = '' or length(n) > 40 then raise exception '请填写姓名'; end if;
  if btrim(coalesce(p_intro, '')) = '' or length(p_intro) > 2000 then raise exception '请写明推荐理由：研究兴趣、已有工作、拟参与的课题或研究单元，不超过 2000 字'; end if;
  if exists (select 1 from admission where name = n and status in ('pending','voting','recommended')) then raise exception '% 已有一份在办理中的加入申请', n; end if;
  if exists (select 1 from person where name = n and status in ('active','offroll')) then raise exception '% 已在人员档案中', n; end if;
  if admission_needs_vote(p_kind) then
    select quota into q from admission_quota where year = y and kind = p_kind;
    if q is null then raise exception '% 年度%名额尚未确定，请中心负责人先在「加入与考核」页确定名额', y, admission_kind_label(p_kind); end if;
    if admission_used(y, p_kind) >= q then raise exception '% 年度%名额已满（% 人）', y, admission_kind_label(p_kind), q; end if;
  end if;
  insert into admission (year, name, kind, school, direction, intro, link, recommender, status)
  values (y, n, p_kind, nullif(btrim(coalesce(p_school, '')), ''), nullif(btrim(coalesce(p_direction, '')), ''), btrim(p_intro), nullif(btrim(coalesce(p_link, '')), ''), app_uid(),
          case when admission_needs_vote(p_kind) then 'voting' else 'pending' end)
  returning * into a;
  if admission_needs_vote(p_kind) then
    perform motion_auto('admission', a.id, y, 'personnel', format('推荐接收 %s 为%s', n, admission_kind_label(p_kind)),
      format(E'推荐接收 %s 为%s（%s 年度名额 %s 人，含本人已用 %s 人）\n学校：%s\n研究方向：%s\n推荐人：%s\n%s\n推荐理由：\n%s\n\n按章程第十八条，表决通过、否决期满后，由中心主任决定。与申请人有私人关系的成员请申报回避。',
        n, admission_kind_label(p_kind), y, q, admission_used(y, p_kind), coalesce(a.school, '—'), coalesce(a.direction, '—'),
        (select name from app_user where id = app_uid()), coalesce('材料：' || a.link || E'\n', ''), a.intro),
      app_uid(), '{}'::uuid[]);
  else
    for v_id in select id from app_user where active and user_perm(id, 'people.manage') loop
      perform notify_user(v_id, format('加入待确认：%s 推荐 %s（%s）加入中心，请在「加入与考核」页确认建档', (select name from app_user where id = app_uid()), n, admission_kind_label(p_kind)));
    end loop;
  end if;
  return a.id;
end $$;

create function withdraw_admission(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare a admission;
begin
  select * into a from admission where id = p_id for update;
  if not found or a.recommender <> app_uid() then raise exception '由推荐人撤回' using errcode = '42501'; end if;
  if a.status not in ('pending','voting') then raise exception '已办结的不能撤回'; end if;
  if a.status = 'voting' then perform motion_auto_withdraw('admission', a.id, a.year); end if;
  update admission set status = 'withdrawn', decided_at = now() where id = p_id;
end $$;

-- 建档：身份为 RI，加入日期为当天；本人首次登录时由人事并入
create function admission_person(a admission) returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  insert into person (name, kind, status, joined_on, school, direction, rank, note)
  values (a.name, a.kind, 'active', app_today(), a.school, a.direction, 'intern', format('加入申请第 %s 号', a.seq))
  returning id into pid;
  return pid;
end $$;
revoke execute on function admission_person(admission) from public;

-- 不需表决的：人事确认建档
create function confirm_admission(p_id uuid, p_accept boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare a admission; pid uuid;
begin
  if not has_perm('people.manage') then raise exception '由人事确认' using errcode = '42501'; end if;
  select * into a from admission where id = p_id for update;
  if not found or a.status <> 'pending' then raise exception '只能确认待确认的申请'; end if;
  if p_accept then
    pid := admission_person(a);
    update admission set status = 'admitted', person_id = pid, decided_by = app_uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
    perform notify_user(a.recommender, format('%s 已加入中心，身份为 Intern（RI）。本人用飞书登录正则后即可使用；加入后第一期内写出开题稿', a.name));
  else
    if btrim(coalesce(p_note, '')) = '' then raise exception '不予建档的请写明原因'; end if;
    update admission set status = 'declined', decided_by = app_uid(), decided_at = now(), decision_note = btrim(p_note) where id = p_id;
    perform notify_user(a.recommender, format('加入申请未建档：%s。原因：%s', a.name, btrim(p_note)));
  end if;
end $$;

-- 需表决的：决议生效后中心负责人决定
create function decide_admission(p_id uuid, p_accept boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare a admission; pid uuid;
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人决定' using errcode = '42501'; end if;
  select * into a from admission where id = p_id for update;
  if not found or a.status <> 'recommended' then raise exception '只能对联席会议已推荐的申请作决定'; end if;
  if p_accept then
    pid := admission_person(a);
    update admission set status = 'admitted', person_id = pid, decided_by = app_uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
    perform notify_user(a.recommender, format('中心负责人决定接收 %s 为%s，已建档，身份为 Intern（RI）；以后按成长路径认定', a.name, admission_kind_label(a.kind)));
    for pid in select id from app_user where active and user_perm(id, 'people.manage') loop
      perform notify_user(pid, format('新成员已建档：%s（%s），本人首次登录时请并入这条档案', a.name, admission_kind_label(a.kind)));
    end loop;
  else
    update admission set status = 'declined', decided_by = app_uid(), decided_at = now(), decision_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
    perform notify_user(a.recommender, format('中心负责人决定：%s 的接收申请不予采纳%s', a.name, coalesce('。说明：' || nullif(btrim(coalesce(p_note, '')), ''), '')));
  end if;
end $$;

-- ---------- 学期考核 ----------
create function term_bounds(p_term text) returns daterange language sql immutable as $$
  select case when right(p_term, 1) = '秋' then daterange(make_date(left(p_term, 4)::int, 9, 1), make_date(left(p_term, 4)::int + 1, 2, 1))
              else daterange(make_date(left(p_term, 4)::int, 2, 1), make_date(left(p_term, 4)::int, 9, 1)) end
$$;

create table term_review (
  id           uuid primary key default gen_random_uuid(),
  term         text not null,
  person_id    uuid not null references person(id),
  user_id      uuid not null references app_user(id),
  track        text not null check (track in ('group','collab')),        -- 进展小组表决 / 合作者评价备案
  status       text not null default 'open' check (status in ('open','voting','leave_pending','done')),
  conclusion   text check (conclusion in ('normal','improve','leave')),
  opinion      text check (opinion is null or length(opinion) <= 3000),
  goals        text check (goals is null or length(goals) <= 1000),
  goals_due    date,
  goals_met    boolean,
  goals_note   text check (goals_note is null or length(goals_note) <= 500),
  goals_at     timestamptz,
  drafted_by   uuid references app_user(id),
  drafted_at   timestamptz,
  defense      text check (defense is null or length(defense) <= 3000),
  defense_at   timestamptz,
  decided_at   timestamptz,
  decided_note text check (decided_note is null or length(decided_note) <= 500),
  created_at   timestamptz not null default now(),
  unique (term, person_id)
);
create table term_reviewer (
  review_id uuid not null references term_review(id) on delete cascade,
  user_id   uuid not null references app_user(id),
  signed_at timestamptz,
  primary key (review_id, user_id)
);
-- 合作者匿名短评：作者只记在库里用于去重，任何视图都不给出作者
create table term_comment (
  review_id  uuid not null references term_review(id) on delete cascade,
  author_id  uuid not null references app_user(id),
  body       text not null check (length(btrim(body)) between 1 and 300),
  created_at timestamptz not null default now(),
  primary key (review_id, author_id)
);
create table term_notice (review_id uuid not null references term_review(id) on delete cascade, kind text not null, primary key (review_id, kind));
select seal('term_review', 'term_reviewer', 'term_comment', 'term_notice');
create trigger audit after insert or update or delete on term_review for each row execute function trg_audit();
create trigger audit after insert or update or delete on term_reviewer for each row execute function trg_audit();

create function term_conclusion_label(c text) returns text language sql immutable as $$
  select case c when 'normal' then '正常' when 'improve' then '需改进' when 'leave' then '建议退组' end
$$;

-- 合作者：同在一个在用的课题或研究单元（负责人或名单上），或一方负责的课题下挂着另一方所在的研究单元
create function user_projects(p_user uuid) returns setof uuid language sql stable security definer set search_path = public as $$
  select id from project where owner_id = p_user and active
  union select m.project_id from project_member m join project p on p.id = m.project_id where m.user_id = p_user and m.left_on is null and p.active
$$;
create function collaborates(a uuid, b uuid) returns boolean language sql stable security definer set search_path = public as $$
  select a <> b and (exists (select 1 from user_projects(a) x join user_projects(b) y on x = y)
    or exists (select 1 from project p where p.id in (select user_projects(a)) and p.parent_id in (select user_projects(b)))
    or exists (select 1 from project p where p.id in (select user_projects(b)) and p.parent_id in (select user_projects(a))))
$$;

-- 发起：本学期在册的 Intern、Assistant、Researcher、Rising Star 每人一条；合作者评价默认取其所在研究单元的负责人
create function open_term_review() returns int language plpgsql security definer set search_path = public as $$
declare t text := council_term(app_today()); r record; v_id uuid; k int := 0;
begin
  if not council_chair() then raise exception '由联席会议主持人发起' using errcode = '42501'; end if;
  for r in select p.id, p.user_id, p.rank from person p join app_user u on u.id = p.user_id
           where u.active and p.status in ('active','offroll') and p.rank in ('intern','assistant','researcher','rising_star') loop
    insert into term_review (term, person_id, user_id, track) values (t, r.id, r.user_id, case when r.rank in ('researcher','rising_star') then 'group' else 'collab' end)
    on conflict (term, person_id) do nothing returning id into v_id;
    if v_id is null then continue; end if;
    k := k + 1;
    if r.rank in ('intern','assistant') then
      insert into term_reviewer (review_id, user_id)
      select v_id, o from (select distinct p.owner_id o from project_member m join project p on p.id = m.project_id
                           where m.user_id = r.user_id and m.left_on is null and p.active and p.layer = 'paper' and p.owner_id is not null and p.owner_id <> r.user_id
                             and user_rank_at_least(p.owner_id, 'researcher') limit 2) s;
    end if;
    perform notify_user(r.user_id, format('%s 学期成员考核已开始：不另写总结，依据你在正则里的记录和合作者匿名短评。考核结论为需改进的，会与你商定两个月的改进目标', t));
    v_id := null;
  end loop;
  return k;
end $$;

-- 指定考核人：进展小组两人，按联席会议的指定登记；合作者评价一至两人。本人、与本人有私人关系的不担任
create function set_term_reviewers(p_id uuid, p_users uuid[], p_no_conflict boolean) returns void language plpgsql security definer set search_path = public as $$
declare r term_review; u uuid;
begin
  if not council_chair() then raise exception '由联席会议主持人登记' using errcode = '42501'; end if;
  select * into r from term_review where id = p_id for update;
  if not found or r.status <> 'open' then raise exception '只能为进行中的考核指定考核人'; end if;
  if not coalesce(p_no_conflict, false) then raise exception '请确认考核人与本人没有私人关系（章程第三十五条）'; end if;
  if r.track = 'group' and coalesce(array_length(p_users, 1), 0) <> 2 then raise exception '进展小组由两名成员组成'; end if;
  if r.track = 'collab' and coalesce(array_length(p_users, 1), 0) not between 1 and 2 then raise exception '合作者评价由一至两人给出'; end if;
  foreach u in array p_users loop
    if u = r.user_id then raise exception '本人不担任考核人'; end if;
    if not user_rank_at_least(u, 'researcher') or not exists (select 1 from app_user where id = u and active) then raise exception '考核人须为 Researcher 及以上的在用账号'; end if;
  end loop;
  delete from term_reviewer where review_id = p_id;
  insert into term_reviewer (review_id, user_id) select p_id, x from unnest(p_users) x;
  update term_review set conclusion = null, opinion = null, goals = null, goals_due = null, drafted_by = null, drafted_at = null where id = p_id;
  foreach u in array p_users loop
    perform notify_user(u, format('学期考核：请%s审阅 %s 的记录，在「加入与考核」页出具意见', case when r.track = 'group' then '作为进展小组成员' else '作为合作者' end, (select name from app_user where id = r.user_id)));
  end loop;
end $$;

-- 合作者匿名短评：每人一条，可以改；考核意见出具之后不再收
create function write_term_comment(p_id uuid, p_body text) returns void language plpgsql security definer set search_path = public as $$
declare r term_review; b text := btrim(coalesce(p_body, ''));
begin
  select * into r from term_review where id = p_id;
  if not found or r.status <> 'open' then raise exception '这条考核不在收短评的阶段'; end if;
  if r.user_id = app_uid() then raise exception '不能给本人写短评'; end if;
  if exists (select 1 from term_reviewer where review_id = p_id and user_id = app_uid()) then raise exception '考核人在意见里写，不另写短评'; end if;
  if not collaborates(app_uid(), r.user_id) then raise exception '短评由合作者写：同在一个课题或研究单元的成员'; end if;
  if b = '' or length(b) > 300 then raise exception '短评不超过 300 字'; end if;
  insert into term_comment (review_id, author_id, body) values (p_id, app_uid(), b)
  on conflict (review_id, author_id) do update set body = excluded.body, created_at = now();
end $$;

create function term_review_body(r term_review) returns text language sql stable security definer set search_path = public as $$
  select format(E'%s 学期成员考核：%s（%s）\n%s：%s\n结论：%s\n\n意见：\n%s%s%s\n\n依据本人在正则里的记录和合作者匿名短评，详见「加入与考核」页。',
    r.term, (select name from app_user where id = r.user_id), rank_label(user_rank(r.user_id)),
    case when r.track = 'group' then '进展小组' else '合作者评价' end,
    (select string_agg(a.name, '、' order by a.name) from term_reviewer x join app_user a on a.id = x.user_id where x.review_id = r.id),
    term_conclusion_label(r.conclusion), coalesce(r.opinion, ''),
    case when r.conclusion = 'improve' then format(E'\n\n改进目标（%s 前）：\n%s', r.goals_due, r.goals) else '' end,
    case when r.conclusion = 'leave' then E'\n\n建议退组的，须投票者三分之二同意、不记名；本人可书面申辩一次，并可到会陈述。决议生效后由中心主任决定。' else '' end)
$$;
revoke execute on function term_review_body(term_review) from public;

-- 列入议程：进展小组的，两人都签署后；建议退组的，不论哪一类。合作者评价的正常、需改进，报备案
create function term_review_route(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r term_review; mid uuid; others int;
begin
  select * into r from term_review where id = p_id for update;
  select count(*) into others from term_reviewer where review_id = p_id and signed_at is null;
  if others > 0 then return; end if;
  if r.track = 'collab' and r.conclusion <> 'leave' then
    update term_review set status = 'done', decided_at = now() where id = p_id;
    perform council_notify(r.user_id, format('%s 学期考核结论：%s。已报联席会议备案%s', r.term, term_conclusion_label(r.conclusion),
      case when r.conclusion = 'improve' then format('。改进目标（%s 前）：%s', r.goals_due, r.goals) else '' end));
    return;
  end if;
  mid := motion_auto('term_review', p_id, null, 'assessment',
    format('%s 学期考核：%s，%s', r.term, (select name from app_user where id = r.user_id), term_conclusion_label(r.conclusion)),
    term_review_body(r), r.drafted_by, array[r.user_id]);
  if r.conclusion = 'leave' then update motion set threshold = 'two_thirds', ballot = 'secret', category = 'removal' where id = mid; end if;
  update term_review set status = 'voting' where id = p_id;
  perform council_notify(r.user_id, format('%s 学期考核意见已列入联席会议议程：%s%s', r.term, term_conclusion_label(r.conclusion),
    case when r.conclusion = 'leave' then '。你可以在「加入与考核」页书面申辩一次，并可到会陈述' else '' end));
end $$;
revoke execute on function term_review_route(uuid) from public;

-- 出具意见：考核人之一起草，即为本人签署；进展小组的另一人签署后列入议程。改了意见，其他人的签署作废
create function draft_term_review(p_id uuid, p_conclusion text, p_opinion text, p_goals text default null, p_goals_due date default null) returns void
language plpgsql security definer set search_path = public as $$
declare r term_review; o text := btrim(coalesce(p_opinion, ''));
begin
  select * into r from term_review where id = p_id for update;
  if not found or not exists (select 1 from term_reviewer where review_id = p_id and user_id = app_uid()) then raise exception '由考核人出具意见' using errcode = '42501'; end if;
  if r.status <> 'open' then raise exception '已列入议程或已办结，不能再改'; end if;
  if p_conclusion not in ('normal','improve','leave') then raise exception '请选择结论'; end if;
  if o = '' or length(o) > 3000 then raise exception '请写明意见，不超过 3000 字'; end if;
  if p_conclusion = 'improve' and (btrim(coalesce(p_goals, '')) = '' or p_goals_due is null) then raise exception '需改进的，请写明与本人商定的改进目标和期限'; end if;
  if p_conclusion = 'improve' and (p_goals_due <= app_today() or p_goals_due > app_today() + 75) then raise exception '改进目标的期限为两个月左右'; end if;
  update term_review set conclusion = p_conclusion, opinion = o,
    goals = case when p_conclusion = 'improve' then btrim(p_goals) end, goals_due = case when p_conclusion = 'improve' then p_goals_due end,
    drafted_by = app_uid(), drafted_at = now() where id = p_id;
  update term_reviewer set signed_at = case when user_id = app_uid() then now() end where review_id = p_id;
  if exists (select 1 from term_reviewer where review_id = p_id and signed_at is null) then
    perform notify_user(x.user_id, format('学期考核待签署：%s 起草了对 %s 的意见（%s），请在「加入与考核」页签署或修改', (select name from app_user where id = app_uid()),
      (select name from app_user where id = r.user_id), term_conclusion_label(p_conclusion))) from term_reviewer x where x.review_id = p_id and x.signed_at is null;
  end if;
  perform term_review_route(p_id);
end $$;

create function sign_term_review(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r term_review;
begin
  select * into r from term_review where id = p_id;
  if not found or not exists (select 1 from term_reviewer where review_id = p_id and user_id = app_uid()) then raise exception '由考核人签署' using errcode = '42501'; end if;
  if r.status <> 'open' or r.conclusion is null then raise exception '还没有起草的意见可以签署'; end if;
  update term_reviewer set signed_at = now() where review_id = p_id and user_id = app_uid();
  perform term_review_route(p_id);
end $$;

-- 书面申辩：本人一次，附在议题后
create function defend_term_review(p_id uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare r term_review; d text := btrim(coalesce(p_text, ''));
begin
  select * into r from term_review where id = p_id for update;
  if not found or r.user_id <> app_uid() then raise exception '由本人申辩' using errcode = '42501'; end if;
  if r.status <> 'voting' then raise exception '列入联席会议议程、表决结束之前可以申辩'; end if;
  if r.defense is not null then raise exception '书面申辩只有一次'; end if;
  if d = '' or length(d) > 3000 then raise exception '申辩不超过 3000 字'; end if;
  update term_review set defense = d, defense_at = now() where id = p_id;
  update motion set body = left(body || E'\n\n本人书面申辩（' || to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI') || E'）：\n' || d, 12000)
  where ref_kind = 'term_review' and ref_id = p_id and status in ('proposed','seconded','voting');
end $$;

-- 改进目标到期：考核人记录是否达成。连续两次需改进且未达成的，有表决权的成员可以据此提议建议退组
create function check_term_goals(p_id uuid, p_met boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare r term_review;
begin
  select * into r from term_review where id = p_id for update;
  if not found or not exists (select 1 from term_reviewer where review_id = p_id and user_id = app_uid()) then raise exception '由考核人记录' using errcode = '42501'; end if;
  if r.conclusion <> 'improve' or r.status <> 'done' then raise exception '只有已办结的需改进结论有改进目标'; end if;
  if p_met is null then raise exception '请选择是否达成'; end if;
  update term_review set goals_met = p_met, goals_note = nullif(btrim(coalesce(p_note, '')), ''), goals_at = now() where id = p_id;
  perform notify_user(r.user_id, format('%s 学期考核的改进目标：%s%s', r.term, case when p_met then '已达成' else '未达成' end, coalesce('。说明：' || nullif(btrim(coalesce(p_note, '')), ''), '')));
end $$;

-- 建议退组生效后：中心负责人决定
create function decide_term_leave(p_id uuid, p_accept boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare r term_review;
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人决定' using errcode = '42501'; end if;
  select * into r from term_review where id = p_id for update;
  if not found or r.status <> 'leave_pending' then raise exception '只能对已生效的退组建议作决定'; end if;
  update term_review set status = 'done', decided_at = now(), decided_note = format('中心负责人%s%s', case when p_accept then '同意退组' else '不予采纳' end, coalesce('：' || nullif(btrim(coalesce(p_note, '')), ''), '')) where id = p_id;
  if p_accept then update person set status = 'left', left_on = app_today(), updated_at = now() where id = r.person_id; end if;
  perform council_notify(r.user_id, format('中心负责人决定：%s 学期考核的退组建议%s%s', r.term, case when p_accept then '予以采纳，人员档案记为已离开' else '不予采纳' end,
    coalesce('。说明：' || nullif(btrim(coalesce(p_note, '')), ''), '')));
end $$;

-- ---------- 落回 ----------
do $$
declare d text := pg_get_functiondef('public.motion_apply(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, E'  elsif m.ref_kind = ''removal'' then',
E'  elsif m.ref_kind = ''admission'' then
    if p_result = ''effective'' then
      update admission set status = ''recommended'' where id = m.ref_id and status = ''voting'';
      perform council_notify_directors(format(''接收待决定：%s 决议已生效，请在「加入与考核」页决定'', motion_label(m)));
      perform council_notify((select recommender from admission where id = m.ref_id), format(''%s 决议已生效，待中心负责人决定'', motion_label(m)));
    else
      update admission set status = ''declined'', decided_at = now(), decision_note = case when p_result = ''vetoed'' then ''中心主任否决：'' || m.veto_reason else ''联席会议表决未通过'' end
      where id = m.ref_id and status = ''voting'';
      perform council_notify((select recommender from admission where id = m.ref_id), format(''%s %s'', motion_label(m), case when p_result = ''vetoed'' then ''被中心主任否决'' else ''联席会议表决未通过'' end));
    end if;
  elsif m.ref_kind = ''term_review'' then
    if p_result = ''effective'' then
      update term_review set status = case when conclusion = ''leave'' then ''leave_pending'' else ''done'' end, decided_at = case when conclusion = ''leave'' then null else now() end,
        decided_note = format(''联席会议第 %s 号决议'', m.seq) where id = m.ref_id and status = ''voting'';
      if (select conclusion from term_review where id = m.ref_id) = ''leave'' then
        perform council_notify_directors(format(''退组建议待决定：%s 决议已生效，请在「加入与考核」页决定'', motion_label(m)));
      end if;
      perform council_notify((select user_id from term_review where id = m.ref_id), format(''学期考核：%s 决议已生效'', motion_label(m)));
    else
      update term_review set status = ''open'', decided_note = case when p_result = ''vetoed'' then ''中心主任否决：'' || m.veto_reason else ''联席会议表决未通过，请考核人重新出具意见'' end
      where id = m.ref_id and status = ''voting'';
      update term_reviewer set signed_at = null where review_id = m.ref_id;
      perform council_notify(x.user_id, format(''学期考核：%s %s，请重新出具意见'', motion_label(m), case when p_result = ''vetoed'' then ''被中心主任否决'' else ''联席会议表决未通过'' end))
      from term_reviewer x where x.review_id = m.ref_id;
    end if;
  elsif m.ref_kind = ''removal'' then');
  if n = d then raise exception '落回函数没有改上'; end if;
  execute n;
end $$;

-- ---------- 定时：新人两期未进研究单元；改进目标到期 ----------
create table join_notice (person_id uuid not null references person(id) on delete cascade, kind text not null, at timestamptz not null default now(), primary key (person_id, kind));
select seal('join_notice');

create function join_tick() returns int language plpgsql security definer set search_path = public as $$
declare p record; r record; k int := 0; who uuid;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for p in select x.* from person x join app_user u on u.id = x.user_id
           where u.active and x.status in ('active','offroll') and x.rank = 'intern' and x.joined_on is not null and x.joined_on <= app_today() - 28
             and not exists (select 1 from project q where q.layer = 'paper' and q.active and q.owner_id = x.user_id)
             and not exists (select 1 from project_member m join project q on q.id = m.project_id where m.user_id = x.user_id and m.left_on is null and q.layer = 'paper' and q.active) loop
    insert into join_notice (person_id, kind) values (p.id, 'no_unit') on conflict do nothing;
    if not found then continue; end if;
    k := k + 1;
    for who in select id from app_user where active and user_perm(id, 'people.manage') loop
      perform notify_sys(who, format('%s 加入已满两期（%s 加入）仍未进入任何研究单元。按成长路径第三节，请办理离开，或确认其已在研究单元中工作', p.name, p.joined_on));
    end loop;
    perform notify_sys(p.user_id, format('你加入中心已满两期，仍未进入任何研究单元。按成长路径，去回应某个研究单元的一条质疑、经负责人同意即可进入；未进入的将办理离开'));
  end loop;
  for r in select t.* from term_review t where t.conclusion = 'improve' and t.status = 'done' and t.goals_met is null and t.goals_due <= app_today() loop
    insert into term_notice values (r.id, 'goals_due') on conflict do nothing;
    if not found then continue; end if;
    k := k + 1;
    perform notify_sys(x.user_id, format('改进目标到期：%s 的 %s 学期考核改进目标今天到期，请在「加入与考核」页记录是否达成', (select name from app_user where id = r.user_id), r.term))
    from term_reviewer x where x.review_id = r.id;
  end loop;
  return k;
end $$;

select expose('set_admission_quota(int, text, int)', 'submit_admission(text, text, text, text, text, text)', 'withdraw_admission(uuid)',
  'confirm_admission(uuid, boolean, text)', 'decide_admission(uuid, boolean, text)',
  'open_term_review()', 'set_term_reviewers(uuid, uuid[], boolean)', 'write_term_comment(uuid, text)', 'draft_term_review(uuid, text, text, text, date)',
  'sign_term_review(uuid)', 'defend_term_review(uuid, text)', 'check_term_goals(uuid, boolean, text)', 'decide_term_leave(uuid, boolean, text)', 'join_tick()');

-- ---------- 视图 ----------
create view api.admission_quota as
  select y.year, k.kind, admission_kind_label(k.kind) as kind_label, q.quota, admission_used(y.year, k.kind) as used
  from (select extract(year from app_today())::int as year union select extract(year from app_today())::int + 1) y
  cross join (values ('phd'), ('postdoc'), ('ra')) k(kind)
  left join admission_quota q on q.year = y.year and q.kind = k.kind
  where app_role() is not null;

create view api.admission as
  select a.id, a.seq, a.year, a.name, a.kind, admission_kind_label(a.kind) as kind_label, admission_needs_vote(a.kind) as needs_vote,
         a.school, a.direction, a.intro, a.link, a.recommender, (select name from app_user where id = a.recommender) as recommender_name,
         a.status, a.person_id, (select name from app_user where id = a.decided_by) as decided_by_name, a.decided_at, a.decision_note, a.created_at,
         (select id from motion m where m.ref_kind = 'admission' and m.ref_id = a.id order by m.created_at desc limit 1) as motion_id,
         (select seq from motion m where m.ref_kind = 'admission' and m.ref_id = a.id order by m.created_at desc limit 1) as motion_seq,
         (a.recommender = app_uid() and a.status in ('pending','voting')
           and not exists (select 1 from motion m where m.ref_kind = 'admission' and m.ref_id = a.id and m.status = 'voting')) as can_withdraw,
         (a.status = 'pending' and has_perm('people.manage')) as can_confirm,
         (a.status = 'recommended' and app_role() = 'director') as can_decide
  from admission a where app_role() is not null;

-- 新人：加入未满两期、或已满仍未进研究单元的
create view api.newcomer as
  select x.id as person_id, x.name, x.kind, admission_kind_label(x.kind) as kind_label, x.joined_on, x.user_id,
         (app_today() - x.joined_on) as days,
         (select string_agg(q.name, '、' order by q.name) from project_member m join project q on q.id = m.project_id
           where m.user_id = x.user_id and m.left_on is null and q.layer = 'paper' and q.active) as units,
         exists (select 1 from join_notice n where n.person_id = x.id) as flagged
  from person x
  where app_role() is not null and x.status in ('active','offroll') and x.rank = 'intern' and x.joined_on is not null and x.joined_on > app_today() - 120;

create view api.term_review as
  select t.id, t.term, t.person_id, t.user_id, u.name as user_name, rank_label(user_rank(t.user_id)) as rank_label, t.track, t.status,
         t.conclusion, term_conclusion_label(t.conclusion) as conclusion_label,
         case when t.conclusion is null or t.status <> 'open' or exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) or council_chair() then t.opinion end as opinion,
         t.goals, t.goals_due, t.goals_met, t.goals_note, t.goals_at, (select name from app_user where id = t.drafted_by) as drafted_by_name, t.drafted_at,
         t.defense, t.defense_at, t.decided_at, t.decided_note,
         (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'signed', x.signed_at is not null) order by a.name), '[]')
            from term_reviewer x join app_user a on a.id = x.user_id where x.review_id = t.id) as reviewers,
         exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) as am_reviewer,
         exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid() and x.signed_at is not null) as i_signed,
         (t.user_id = app_uid()) as mine,
         (t.status = 'open' and t.user_id <> app_uid() and not exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid())
           and collaborates(app_uid(), t.user_id)) as can_comment,
         (select body from term_comment c where c.review_id = t.id and c.author_id = app_uid()) as my_comment,
         (select count(*)::int from term_comment c where c.review_id = t.id) as comment_count,
         -- 匿名短评只给考核人和主持人看，不给作者
         case when exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) or council_chair()
              then (select coalesce(jsonb_agg(c.body order by md5(c.author_id::text || t.id::text)), '[]') from term_comment c where c.review_id = t.id) end as comments,
         (select id from motion m where m.ref_kind = 'term_review' and m.ref_id = t.id order by m.created_at desc limit 1) as motion_id,
         (select seq from motion m where m.ref_kind = 'term_review' and m.ref_id = t.id order by m.created_at desc limit 1) as motion_seq,
         (select p.conclusion from term_review p where p.person_id = t.person_id and p.term < t.term order by p.term desc limit 1) as prev_conclusion,
         (select p.goals_met from term_review p where p.person_id = t.person_id and p.term < t.term order by p.term desc limit 1) as prev_goals_met,
         (t.status = 'leave_pending' and app_role() = 'director') as can_decide,
         council_chair() as can_chair
  from term_review t join app_user u on u.id = t.user_id
  where app_role() is not null and (t.user_id = app_uid() or council_voter(app_uid()) or council_chair() or app_role() = 'director'
    or exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) or collaborates(app_uid(), t.user_id));

-- 记录汇总：本学期内的双周表、主线、研究单元、支出和出勤；只给考核人、主持人、中心负责人和本人
create view api.term_record as
  select t.id, t.term, lower(term_bounds(t.term)) as term_from, upper(term_bounds(t.term)) - 1 as term_to,
         (select string_agg(format('%s%s', q.name, case when q.owner_id = t.user_id then '（负责）' else '' end), '、' order by q.name)
            from project q where q.layer = 'paper' and q.active and (q.owner_id = t.user_id or exists (select 1 from project_member m where m.project_id = q.id and m.user_id = t.user_id and m.left_on is null))) as units,
         (select count(*)::int from biweekly_report b join project q on q.id = b.project_id where q.owner_id = t.user_id and b.period_start <@ term_bounds(t.term)) as biweekly_count,
         (select count(*)::int from path_done d where d.person_id = t.person_id and d.done_on <@ term_bounds(t.term)) as path_done,
         (select string_agg(k.title, '、' order by d.done_on) from path_done d join path_task k on k.code = d.task_code where d.person_id = t.person_id and d.done_on <@ term_bounds(t.term)) as path_titles,
         (select count(*)::int from snapshot_author a join snapshot s on s.id = a.snapshot_id where a.user_id = t.user_id and s.period_start <@ term_bounds(t.term)) as snapshots,
         (select count(*)::int from query_member qm join query qq on qq.id = qm.query_id where qm.user_id = t.user_id and qq.period_start <@ term_bounds(t.term)) as queries,
         (select count(*)::int from query qq where qq.raised_by = t.user_id and qq.period_start <@ term_bounds(t.term)) as queries_raised,
         (select coalesce(sum(r.amount), 0) from expense_request r where r.requested_by = t.user_id and r.created_at::date <@ term_bounds(t.term) and r.status not in ('returned','released')) as spent,
         (select count(*)::int from expense_request r where r.requested_by = t.user_id and r.created_at::date <@ term_bounds(t.term) and r.status not in ('returned','released')) as spent_count,
         (select count(*)::int from attend a join attend_event e on e.id = a.event_id where a.user_id = t.user_id and e.kind = 'lecture' and e.held_on <@ term_bounds(t.term)) as lecture_total,
         (select count(*)::int from attend a join attend_event e on e.id = a.event_id where a.user_id = t.user_id and e.kind = 'lecture' and e.held_on <@ term_bounds(t.term) and (a.status = 'present' or a.made_up)) as lecture_ok,
         (select count(*)::int from attend a join attend_event e on e.id = a.event_id where a.user_id = t.user_id and e.kind = 'seminar' and e.held_on <@ term_bounds(t.term)) as seminar_total,
         (select count(*)::int from attend a join attend_event e on e.id = a.event_id where a.user_id = t.user_id and e.kind = 'seminar' and e.held_on <@ term_bounds(t.term) and (a.status = 'present' or a.made_up)) as seminar_ok
  from term_review t
  where app_role() is not null and (t.user_id = app_uid() or council_chair() or app_role() = 'director'
    or exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()));

grant select on api.admission_quota, api.admission, api.newcomer, api.term_review, api.term_record to app_api;
