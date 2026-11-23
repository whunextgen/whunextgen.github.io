-- 飞书通知改为卡片：每条通知记下经办人和时间，发送端据此拼出落款。文字内容不变。
create or replace function notify_user(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if app_uid() is null or p_user is null or p_user = app_uid() then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null then return; end if;
  insert into feishu_outbox (target, payload, user_id)
  values (oid, jsonb_build_object('text', p_text, 'by', (select name from app_user where id = app_uid()),
                                  'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI')), p_user);
end $$;

-- 卡片被拒、改发纯文字发出去的，也把原因记下来，便于发现版式问题
create or replace function outbox_done(p_id bigint, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update feishu_outbox set
    status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
    sent_at = case when p_ok then now() end,
    last_error = case when p_ok then left(p_error, 300) else left(coalesce(p_error, '发送失败'), 300) end
  where id = p_id and status = 'queued';
end $$;
