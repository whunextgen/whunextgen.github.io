-- 协助群的 GitHub 通报发在同一个话题里，回复都在一起，不刷群聊。
-- 话题的第一条（根消息）由发送端在第一次发通报时发出，这里只记它的消息编号；根消息被撤回、回复失败的，发送端清掉后重开一个话题。
create table notice_thread (
  key        text primary key check (key in ('assist')),
  message_id text,
  updated_at timestamptz not null default now()
);
select seal('notice_thread');

create function notice_thread(p_key text) returns text language sql stable security definer set search_path = public as $$
  select case when app_uid() is null then (select message_id from notice_thread where key = p_key) end
$$;
create function notice_thread_set(p_key text, p_message text) returns void language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  insert into notice_thread (key, message_id) values (p_key, nullif(p_message, ''))
  on conflict (key) do update set message_id = excluded.message_id, updated_at = now();
end $$;
select expose('notice_thread(text)', 'notice_thread_set(text, text)');
