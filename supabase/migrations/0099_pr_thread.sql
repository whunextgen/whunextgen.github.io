-- 协助群的 GitHub 通报改为一个 PR 一个话题：同一个 PR 的待审、审查、合并都回复在它自己的话题里，不同的 PR 互不混在一起。
-- 话题的根消息就是这个 PR 的第一条通报，发送端发出后记下它的消息编号，键为 pr:<编号>。原来所有 PR 共用的话题不再使用。
delete from notice_thread where key = 'assist';
alter table notice_thread drop constraint notice_thread_key_check;
alter table notice_thread add constraint notice_thread_key_check check (key ~ '^pr:[0-9]{1,7}$');

-- 入队时带上话题的键，发送端据此找根消息
drop function github_notice(text, text, text, text);
create function github_notice(p_delivery text, p_text text, p_url text default null, p_btn text default null, p_thread text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if coalesce(btrim(p_text), '') = '' then raise exception '通报内容为空'; end if;
  if p_thread is not null and p_thread !~ '^pr:[0-9]{1,7}$' then raise exception '话题键不对'; end if;
  insert into github_delivery (id) values (p_delivery) on conflict do nothing;
  if not found then return false; end if;
  insert into feishu_outbox (target, payload)
  values ('assist', jsonb_strip_nulls(jsonb_build_object('text', left(p_text, 1500), 'url', p_url, 'btn', p_btn, 'kind', 'post', 'thread', p_thread,
    'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
  return true;
end $$;
select expose('github_notice(text, text, text, text, text)');
