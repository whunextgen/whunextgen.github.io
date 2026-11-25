-- 反馈（黄济民 2026-11-26）：每个页面右下角的「反馈」按钮，提交即记下提交人、时间和页面；
--   定时任务转成 GitHub issue，记下编号和链接。反馈先存在中台，转议题失败的下一轮再试，不会丢
create table feedback (
  id           uuid primary key default gen_random_uuid(),
  seq          int generated always as identity,
  user_id      uuid not null references app_user(id),
  body         text not null check (length(btrim(body)) between 1 and 4000),
  page         text check (page is null or length(page) <= 300),
  page_title   text check (page_title is null or length(page_title) <= 120),
  created_at   timestamptz not null default now(),
  issue_number int,
  issue_url    text,
  tries        int not null default 0,
  tried_at     timestamptz,
  last_error   text
);
select seal('feedback');

create function submit_feedback(p_body text, p_page text default null, p_title text default null) returns int
language plpgsql security definer set search_path = public as $$
declare b text := btrim(coalesce(p_body, '')); s int;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if b = '' then raise exception '请写下遇到的问题或建议'; end if;
  if length(b) > 4000 then raise exception '反馈不超过 4000 字'; end if;
  if (select count(*) from feedback where user_id = app_uid() and created_at > now() - interval '1 hour') >= 20 then raise exception '一小时内提交太多了，请稍后再试'; end if;
  insert into feedback (user_id, body, page, page_title) values (app_uid(), b, left(nullif(btrim(coalesce(p_page, '')), ''), 300), left(nullif(btrim(coalesce(p_title, '')), ''), 120))
  returning seq into s;
  return s;
end $$;

-- 定时任务：还没转成议题的，失败的隔 10 分钟再试，最多 10 次
create function feedback_todo() returns table (id uuid, seq int, body text, page text, page_title text, user_name text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select f.id, f.seq, f.body, f.page, f.page_title, u.name, f.created_at from feedback f join app_user u on u.id = f.user_id
  where f.issue_number is null and f.tries < 10 and (f.tried_at is null or f.tried_at < now() - interval '10 minutes') order by f.created_at limit 10;
end $$;

create function feedback_issue_save(p_id uuid, p_number int, p_url text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare f feedback;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update feedback set issue_number = p_number, issue_url = p_url, tries = tries + 1, tried_at = now(), last_error = left(p_error, 300) where id = p_id returning * into f;
  if p_number is not null then perform notify_sys(f.user_id, format('反馈已收到：你的第 %s 号反馈已转为议题 #%s，处理进展可在「反馈」里查看', f.seq, p_number)); end if;
end $$;

select expose('submit_feedback(text, text, text)');

create view api.feedback as
  select f.id, f.seq, f.body, f.page, f.page_title, f.created_at, f.issue_number, f.issue_url, (f.user_id = app_uid()) as mine,
         (select name from app_user where id = f.user_id) as user_name
  from feedback f where app_role() is not null and (f.user_id = app_uid() or app_role() = 'director');
grant select on api.feedback to app_api;
