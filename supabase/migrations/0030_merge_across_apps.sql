-- 登录换了应用之后，个别旧账号没能预先记下 union_id，本人首次登录会另建一个新账号。
-- 这时两个账号都有 open_id（一个是原应用的，一个是新应用的），原规则一律拒绝合并。
-- 改为：只有一边记了 union_id 时允许合并（同一个人在两个应用下的身份）；
-- 两边都有或都没有 union_id 的，仍视为两个飞书身份，不得合并。
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.merge_user(uuid, uuid)'::regprocedure);
  d2 := replace(d, 'if a.feishu_open_id is not null and b.feishu_open_id is not null then',
                   'if a.feishu_open_id is not null and b.feishu_open_id is not null and ((a.feishu_union_id is null) = (b.feishu_union_id is null)) then');
  if d2 = d then raise exception 'merge_user：未找到绑定判断的语句'; end if;
  execute d2;
end $do$;
