-- 换没换审稿人（黄济民 2026-11-25）：重投时作者在投稿表里选的是沿用上一轮的审稿人和 AC，还是换一组。
-- 记的是申请：沿用以对方有空为前提，OpenReview 每轮给审稿人重新编代号，实际是否同一人从数据里看不出。首次投稿为空。
alter table submission add column keep_reviewers boolean, add column keep_ac boolean;

create or replace view api.submission as
  select s.id, s.project_id, s.relation, s.venue, s.cycle, s.forum, s.number, s.title, s.submitted_on, s.status, s.prev_id,
         s.ac_overall, s.ac_text, s.ac_revisions, s.ac_gist, s.imported_at,
         (select round(avg(r.overall), 2) from submission_review r where r.submission_id = s.id) as mean_overall,
         s.keep_reviewers, s.keep_ac
  from submission s where can_see_review(s.project_id);

-- 汇总里跟着分数走：取最近一轮有评审的那一轮的申请
create or replace view api.review_summary as
with s as (
  select s.*,
         (select round(avg(r.overall), 2) from submission_review r where r.submission_id = s.id) as mean,
         (select count(*) from submission_review r where r.submission_id = s.id) as n_rev
  from submission s where can_see_review(s.project_id)),
k as (
  select s.*, row_number() over (partition by project_id, relation order by cycle desc) as rn,
         case when n_rev > 0 then row_number() over (partition by project_id, relation, (n_rev > 0) order by cycle desc) end as jn
  from s)
select p.id as project_id, p.code, p.name, u.name as owner_name, h.relation, h.venue, h.cycle, h.number, h.title, h.status,
       (select count(*) from k x where x.project_id = h.project_id and x.relation = h.relation)::int as rounds,
       (select count(*) from k x where x.project_id = h.project_id and x.relation = h.relation and x.n_rev > 0)::int as judged_rounds,
       j.cycle as judged_cycle, j.mean, j.n_rev::int as reviewers, j2.mean as prev_mean,
       (select x.ac_overall from k x where x.project_id = h.project_id and x.relation = h.relation and x.ac_overall is not null order by x.cycle desc limit 1) as ac_overall,
       c.li, c.ju, c.ti, c.yong,
       (select count(*) from review_thread t where t.project_id = h.project_id and t.relation = h.relation and exists (
          select 1 from review_point q join submission_review r on r.id = q.review_id where q.thread_id = t.id and r.submission_id = j.id))::int as threads_open,
       (select count(*) from review_thread t where t.project_id = h.project_id and t.relation = h.relation and exists (
          select 1 from review_point q where q.thread_id = t.id))::int as threads,
       j.keep_reviewers, j.keep_ac
from k h
join project p on p.id = h.project_id
left join app_user u on u.id = p.owner_id
left join k j on j.project_id = h.project_id and j.relation = h.relation and j.jn = 1
left join k j2 on j2.project_id = h.project_id and j2.relation = h.relation and j2.jn = 2
left join lateral (
  select count(*) filter (where q.axis = 'li')::int as li, count(*) filter (where q.axis = 'ju')::int as ju,
         count(*) filter (where q.axis = 'ti')::int as ti, count(*) filter (where q.axis = 'yong')::int as yong
  from review_point q join submission_review r on r.id = q.review_id where r.submission_id = j.id) c on true
where h.rn = 1;
