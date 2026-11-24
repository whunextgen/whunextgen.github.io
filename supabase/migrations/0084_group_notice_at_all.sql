-- 群通知可以 @所有人：只用于公告和双周表截止前一日的提醒，成立公告、期中汇总、本期结果不 @。
drop function notify_group(text, text, text);
create function notify_group(p_text text, p_url text default null, p_btn text default null, p_all boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into feishu_outbox (target, payload)
  values ('group', jsonb_strip_nulls(jsonb_build_object('text', p_text, 'url', p_url, 'btn', p_btn, 'all', case when p_all then true end,
    'by', (select name from app_user where id = app_uid()),
    'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
end $$;
revoke all on function notify_group(text, text, text, boolean) from public;

do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.group_digest_tick()'::regprocedure);
  n := replace(d, 'perform notify_group(msg);', 'perform notify_group(msg, null, null, k = ''last'');');
  if n = d then raise exception 'group_digest_tick：没有找到发送的那一句'; end if;
  execute n;
end $$;
