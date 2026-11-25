-- 投稿与评审可以在研究单元页自行填报，并按会议分开（黄济民 2026-11-25）。
--   谁能填：研究单元名单内的成员和负责人、中心负责人。
--   填什么：投稿（会议、轮次、编号、标题、状态、分制、是否沿用审稿人、AC 总评和意见）和各位审稿人的评审（分数和原文）。
--   质疑按理据体用的归类不在页面上做，仍由导入完成；自行填报的评审在归类前只显示分数和原文。
--   不同会议分制不同，分数只在同一会议内比较：投稿记分制，汇总按研究单元、本稿或前作、会议各一行。
--   自行填报的投稿可以由填报范围内的人修改、删除；导入的只能改状态和 AC 意见，不能删。
alter table submission alter column forum drop not null;
alter table submission add column scale numeric(3,1) not null default 5 check (scale between 2 and 100),
  add column source text not null default 'import' check (source in ('import', 'manual')),
  add column created_by uuid references app_user(id);

create function can_edit_review(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() is not null and (app_role() = 'director' or is_on_project(p_project))
$$;

-- 分数须在分制以内
create function review_score_ok(p_scale numeric, variadic p_scores numeric[]) returns void language plpgsql immutable as $$
declare v numeric;
begin
  foreach v in array p_scores loop
    if v is not null and (v < 0 or v > p_scale) then raise exception '分数须在 0 到 % 之间', trim(trailing '.' from trim(trailing '0' from p_scale::text)); end if;
  end loop;
end $$;

create function submission_save(p_id uuid, p_project uuid, p_relation text, p_venue text, p_cycle text, p_number int, p_title text, p_status text,
    p_link text, p_scale numeric, p_keep text, p_ac_overall numeric, p_ac_text text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare s submission; v_cycle date; v_forum text; v_keep boolean; v_id uuid;
begin
  if p_id is not null then
    select * into s from submission where id = p_id;
    if not found then raise exception '没有这条投稿记录'; end if;
    p_project := s.project_id;
  end if;
  if p_project is null or not exists (select 1 from project where id = p_project and layer = 'paper') then raise exception '请指定研究单元'; end if;
  if not can_edit_review(p_project) then raise exception '只有该研究单元名单内的成员、负责人和中心负责人可以填报'; end if;
  if coalesce(trim(p_venue), '') = '' or coalesce(trim(p_title), '') = '' then raise exception '会议和标题必填'; end if;
  if p_cycle !~ '^\d{4}-\d{2}' then raise exception '请填写轮次所在的年月'; end if;
  v_cycle := (left(p_cycle, 7) || '-01')::date;
  if coalesce(p_relation, 'self') not in ('self', 'prior') then raise exception '请选择本稿或前作'; end if;
  if coalesce(p_status, 'review') not in ('review', 'resubmitted', 'desk_reject', 'withdrawn', 'accepted', 'rejected') then raise exception '状态不对'; end if;
  perform review_score_ok(coalesce(p_scale, 5), p_ac_overall);
  -- 链接：取 OpenReview 帖子编号；不是这种链接的不记
  v_forum := coalesce(substring(p_link from '[?&]id=([A-Za-z0-9_-]{6,40})'), case when trim(coalesce(p_link, '')) ~ '^[A-Za-z0-9_-]{6,40}$' then trim(p_link) end);
  v_keep := case p_keep when 'same' then true when 'new' then false else null end;
  if v_forum is not null and exists (select 1 from submission where forum = v_forum and id is distinct from p_id) then raise exception '这个帖子已经登记过'; end if;
  if p_id is null then
    insert into submission (project_id, relation, venue, cycle, forum, number, title, status, scale, keep_reviewers, ac_overall, ac_text, source, created_by)
      values (p_project, coalesce(p_relation, 'self'), trim(p_venue), v_cycle, v_forum, p_number, trim(p_title), coalesce(p_status, 'review'), coalesce(p_scale, 5), v_keep, p_ac_overall, nullif(trim(coalesce(p_ac_text, '')), ''), 'manual', app_uid())
      returning id into v_id;
  elsif s.source = 'manual' then
    update submission set relation = coalesce(p_relation, relation), venue = trim(p_venue), cycle = v_cycle, forum = v_forum, number = p_number, title = trim(p_title), status = coalesce(p_status, status),
      scale = coalesce(p_scale, scale), keep_reviewers = v_keep, ac_overall = p_ac_overall, ac_text = nullif(trim(coalesce(p_ac_text, '')), '') where id = p_id;
    v_id := p_id;
  else
    -- 导入的：只改状态和 AC 的总评、意见
    perform review_score_ok(s.scale, p_ac_overall);
    update submission set status = coalesce(p_status, status), ac_overall = p_ac_overall, ac_text = coalesce(nullif(trim(coalesce(p_ac_text, '')), ''), ac_text) where id = p_id;
    v_id := p_id;
  end if;
  -- 上一轮：同一研究单元、同一关系、同一会议里更早的最近一轮
  update submission x set prev_id = (select y.id from submission y where y.project_id = x.project_id and y.relation = x.relation and y.venue = x.venue and y.cycle < x.cycle order by y.cycle desc limit 1)
    where x.id = v_id;
  return v_id;
end $$;

create function submission_delete(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare s submission;
begin
  select * into s from submission where id = p_id;
  if not found then raise exception '没有这条投稿记录'; end if;
  if not can_edit_review(s.project_id) then raise exception '只有该研究单元名单内的成员、负责人和中心负责人可以删除'; end if;
  if s.source <> 'manual' then raise exception '导入的投稿记录不能在页面上删除'; end if;
  update submission set prev_id = s.prev_id where prev_id = p_id;
  delete from submission where id = p_id;
end $$;

create function review_save(p_id uuid, p_submission uuid, p_reviewer text, p_overall numeric, p_soundness numeric, p_excitement numeric, p_confidence numeric,
    p_strengths text, p_weaknesses text, p_comments text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare s submission; v_id uuid; t text := coalesce(trim(p_reviewer), '');
begin
  if p_id is not null then select submission_id into p_submission from submission_review where id = p_id; end if;
  select * into s from submission where id = p_submission;
  if not found then raise exception '没有这条投稿记录'; end if;
  if not can_edit_review(s.project_id) then raise exception '只有该研究单元名单内的成员、负责人和中心负责人可以填报'; end if;
  if s.source <> 'manual' then raise exception '导入的评审不能在页面上修改'; end if;
  if t = '' then raise exception '请填写审稿人代号'; end if;
  perform review_score_ok(s.scale, p_overall, p_soundness, p_excitement, p_confidence);
  if exists (select 1 from submission_review where submission_id = s.id and reviewer = t and id is distinct from p_id) then raise exception '这位审稿人在这一轮已经登记过'; end if;
  if p_id is null then
    insert into submission_review (submission_id, reviewer, overall, soundness, excitement, confidence, strengths, weaknesses, comments)
      values (s.id, t, p_overall, p_soundness, p_excitement, p_confidence, nullif(trim(coalesce(p_strengths, '')), ''), nullif(trim(coalesce(p_weaknesses, '')), ''), nullif(trim(coalesce(p_comments, '')), ''))
      returning id into v_id;
  else
    update submission_review set reviewer = t, overall = p_overall, soundness = p_soundness, excitement = p_excitement, confidence = p_confidence,
      strengths = nullif(trim(coalesce(p_strengths, '')), ''), weaknesses = nullif(trim(coalesce(p_weaknesses, '')), ''), comments = nullif(trim(coalesce(p_comments, '')), '') where id = p_id;
    v_id := p_id;
  end if;
  return v_id;
end $$;

create function review_delete(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare s submission;
begin
  select x.* into s from submission x join submission_review r on r.submission_id = x.id where r.id = p_id;
  if not found then raise exception '没有这份评审'; end if;
  if not can_edit_review(s.project_id) then raise exception '只有该研究单元名单内的成员、负责人和中心负责人可以删除'; end if;
  if s.source <> 'manual' then raise exception '导入的评审不能在页面上删除'; end if;
  delete from submission_review where id = p_id;
end $$;

grant execute on function can_edit_review(uuid), submission_save(uuid, uuid, text, text, text, int, text, text, text, numeric, text, numeric, text), submission_delete(uuid),
  review_save(uuid, uuid, text, numeric, numeric, numeric, numeric, text, text, text), review_delete(uuid) to app_api;

create or replace view api.submission as
  select s.id, s.project_id, s.relation, s.venue, s.cycle, s.forum, s.number, s.title, s.submitted_on, s.status, s.prev_id,
         s.ac_overall, s.ac_text, s.ac_revisions, s.ac_gist, s.imported_at,
         (select round(avg(r.overall), 2) from submission_review r where r.submission_id = s.id) as mean_overall,
         s.keep_reviewers, s.keep_ac, s.scale, s.source, can_edit_review(s.project_id) as can_edit
  from submission s where can_see_review(s.project_id);

-- 汇总按会议分开：研究单元、本稿或前作、会议各一行
drop view api.review_summary;
create view api.review_summary as
with s as (
  select s.*,
         (select round(avg(r.overall), 2) from submission_review r where r.submission_id = s.id) as mean,
         (select count(*) from submission_review r where r.submission_id = s.id) as n_rev
  from submission s where can_see_review(s.project_id)),
k as (
  select s.*, row_number() over (partition by project_id, relation, venue order by cycle desc) as rn,
         case when n_rev > 0 then row_number() over (partition by project_id, relation, venue, (n_rev > 0) order by cycle desc) end as jn
  from s)
select p.id as project_id, p.code, p.name, u.name as owner_name, h.relation, h.venue, h.cycle, h.number, h.title, h.status, h.scale,
       (select count(*) from k x where x.project_id = h.project_id and x.relation = h.relation and x.venue = h.venue)::int as rounds,
       (select count(*) from k x where x.project_id = h.project_id and x.relation = h.relation and x.venue = h.venue and x.n_rev > 0)::int as judged_rounds,
       j.cycle as judged_cycle, j.mean, j.n_rev::int as reviewers, j2.mean as prev_mean,
       (select x.ac_overall from k x where x.project_id = h.project_id and x.relation = h.relation and x.venue = h.venue and x.ac_overall is not null order by x.cycle desc limit 1) as ac_overall,
       c.li, c.ju, c.ti, c.yong,
       (select count(*) from review_thread t where t.project_id = h.project_id and t.relation = h.relation and exists (
          select 1 from review_point q join submission_review r on r.id = q.review_id where q.thread_id = t.id and r.submission_id = j.id))::int as threads_open,
       (select count(*) from review_thread t where t.project_id = h.project_id and t.relation = h.relation and exists (
          select 1 from review_point q join submission_review r on r.id = q.review_id join submission x on x.id = r.submission_id where q.thread_id = t.id and x.venue = h.venue))::int as threads,
       j.keep_reviewers, j.keep_ac
from k h
join project p on p.id = h.project_id
left join app_user u on u.id = p.owner_id
left join k j on j.project_id = h.project_id and j.relation = h.relation and j.venue = h.venue and j.jn = 1
left join k j2 on j2.project_id = h.project_id and j2.relation = h.relation and j2.venue = h.venue and j2.jn = 2
left join lateral (
  select count(*) filter (where q.axis = 'li')::int as li, count(*) filter (where q.axis = 'ju')::int as ju,
         count(*) filter (where q.axis = 'ti')::int as ti, count(*) filter (where q.axis = 'yong')::int as yong
  from review_point q join submission_review r on r.id = q.review_id where r.submission_id = j.id) c on true
where h.rn = 1;
grant select on api.review_summary to app_api;
