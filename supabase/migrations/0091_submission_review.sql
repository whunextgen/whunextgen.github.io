-- 投稿与评审挂到研究单元上：一个研究单元是一篇稿子，各轮投稿连成一条线（黄济民 2026-11-25）。
--   投稿：会议与轮次、OpenReview 上的帖子、编号、状态、上一轮；AC 的总评和意见记在投稿上。
--   评审：每位审稿人的四项分和各节原文。
--   质疑：把评审里的不足逐条拆开，按文章四字「理、据、体、用」归类
--         （理：为什么要关注这个问题；据：为什么别人没解决；体：方法；用：发现），每条带原文出处。
--   跨轮追踪：实质相同的质疑归到一条线上；最新一轮没有人再提的，记为已回应。
--   前作：研究单元以某篇已投的稿子为基础的，那篇稿子的评审作为前作挂上，与本稿分开列。
--   数据由导入写入，不开放页面录入。评审是保密材料：只有名单内成员和负责人、所挂课题的负责人、中心负责人看得到。

create table submission (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id),
  relation text not null default 'self' check (relation in ('self', 'prior')),   -- 本稿，或前作
  venue text not null,
  cycle date not null check (cycle = date_trunc('month', cycle)::date),          -- 轮次，记当月一日
  forum text not null unique,                                                    -- OpenReview 帖子编号
  number int,
  title text not null,
  submitted_on date,
  status text not null default 'review' check (status in ('review', 'resubmitted', 'desk_reject', 'withdrawn', 'accepted', 'rejected')),
  prev_id uuid references submission(id),
  ac_overall numeric(3,1),
  ac_text text,          -- AC 意见原文
  ac_revisions text,     -- AC 要求的修改，原文
  ac_gist text,          -- AC 要求的修改，中文摘要
  imported_at timestamptz not null default now()
);
create index on submission (project_id);

create table submission_review (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submission(id) on delete cascade,
  reviewer text not null,          -- 审稿人代号
  overall numeric(3,1), soundness numeric(3,1), excitement numeric(3,1), confidence numeric(3,1),
  summary text, strengths text, weaknesses text, comments text,
  unique (submission_id, reviewer)
);

create table review_thread (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id),
  relation text not null default 'self' check (relation in ('self', 'prior')),
  axis text not null check (axis in ('li', 'ju', 'ti', 'yong')),
  label text not null,
  ord int not null default 0
);

create table review_point (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references submission_review(id) on delete cascade,
  ord int not null default 0,
  axis text not null check (axis in ('li', 'ju', 'ti', 'yong')),
  gist text not null,          -- 中文概括
  quote text,                  -- 原文出处
  thread_id uuid references review_thread(id) on delete set null
);
create index on review_point (review_id);

select seal('submission', 'submission_review', 'review_thread', 'review_point');

-- 谁看得到这个研究单元的评审：名单内成员和负责人、所挂课题的负责人、中心负责人
create function can_see_review(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() is not null and (
    app_role() = 'director'
    or is_on_project(p_project)
    or exists (select 1 from project x where x.id = p_project and x.parent_id is not null and user_perm(app_uid(), 'budget.project', x.parent_id)))
$$;

create view api.submission as
  select s.id, s.project_id, s.relation, s.venue, s.cycle, s.forum, s.number, s.title, s.submitted_on, s.status, s.prev_id,
         s.ac_overall, s.ac_text, s.ac_revisions, s.ac_gist, s.imported_at,
         (select round(avg(r.overall), 2) from submission_review r where r.submission_id = s.id) as mean_overall
  from submission s where can_see_review(s.project_id);

create view api.submission_review as
  select r.id, r.submission_id, s.project_id, r.reviewer, r.overall, r.soundness, r.excitement, r.confidence,
         r.summary, r.strengths, r.weaknesses, r.comments
  from submission_review r join submission s on s.id = r.submission_id where can_see_review(s.project_id);

create view api.review_point as
  select p.id, p.review_id, r.submission_id, s.project_id, p.ord, p.axis, p.gist, p.quote, p.thread_id
  from review_point p join submission_review r on r.id = p.review_id join submission s on s.id = r.submission_id
  where can_see_review(s.project_id);

create view api.review_thread as
  select t.id, t.project_id, t.relation, t.axis, t.label, t.ord from review_thread t where can_see_review(t.project_id);

grant select on api.submission, api.submission_review, api.review_point, api.review_thread to app_api;
