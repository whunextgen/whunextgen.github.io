-- GitHub 事件发到协助群：中台仓库的 PR 开出、提交审查、合并或关闭时，由正则在协助群发一张通报。
-- 事件由 GitHub 推到 Worker，Worker 校验签名、筛出要发的几类，再调这里入队。群是哪一个不记在库里：
-- 队列里的对象写作 assist，由发送端按配置换成协助群。GitHub 会重发没收到回应的事件，按投递编号去重。
create table github_delivery (
  id      text primary key check (length(id) between 1 and 80),
  at      timestamptz not null default now()
);
select seal('github_delivery');

-- 只给定时任务和 Worker 自己调（不带登录身份）。重复的投递返回 false，不再入队
create function github_notice(p_delivery text, p_text text, p_url text default null, p_btn text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if coalesce(btrim(p_text), '') = '' then raise exception '通报内容为空'; end if;
  insert into github_delivery (id) values (p_delivery) on conflict do nothing;
  if not found then return false; end if;
  insert into feishu_outbox (target, payload)
  values ('assist', jsonb_strip_nulls(jsonb_build_object('text', left(p_text, 1500), 'url', p_url, 'btn', p_btn, 'kind', 'post',
    'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
  return true;
end $$;
select expose('github_notice(text, text, text, text)');
