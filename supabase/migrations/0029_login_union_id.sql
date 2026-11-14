-- 登录改用单独的飞书应用。open_id 因应用而异，换应用后旧的 open_id 对不上；
-- union_id 在本单位的各个自建应用之间相同，登录改为先按 union_id 认人。
-- feishu_open_id 保留，含义不变（原应用下的 open_id，或新用户首次登录时的 open_id）。

alter table app_user add column feishu_union_id text unique;

drop function login_feishu(text, text, text);

create function login_feishu(p_open_id text, p_name text, p_email text default null, p_union_id text default null) returns app_user
language plpgsql security definer set search_path = public as $$
declare u app_user; e text := nullif(lower(trim(p_email)), ''); n text := nullif(trim(p_union_id), '');
begin
  if coalesce(p_open_id, '') = '' then raise exception '缺少 open_id'; end if;
  if n is not null then
    select * into u from app_user where feishu_union_id = n;
  end if;
  if u.id is null then
    select * into u from app_user where feishu_open_id = p_open_id;
    if u.id is not null and n is not null and u.feishu_union_id is null then
      update app_user set feishu_union_id = n, updated_at = now() where id = u.id returning * into u;
    end if;
  end if;
  if u.id is null and e is not null then
    update app_user set feishu_open_id = p_open_id, feishu_union_id = n, updated_at = now()
    where email = e and feishu_open_id is null and feishu_union_id is null returning * into u;
  end if;
  if u.id is null then
    insert into app_user (feishu_open_id, feishu_union_id, name, email)
    values (p_open_id, n, p_name, case when exists (select 1 from app_user where email = e) then null else e end)
    returning * into u;
  end if;
  if not u.active then raise exception '账号已停用' using errcode = '42501'; end if;
  return u;
end $$;

grant execute on function login_feishu(text, text, text, text) to app_api;

-- 通知的接收人：有 union_id 用 union_id（发通知的应用与登录应用可以不是同一个），否则沿用 open_id
create or replace function notify_user(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if app_uid() is null or p_user is null or p_user = app_uid() then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null then return; end if;
  insert into feishu_outbox (target, payload, user_id) values (oid, jsonb_build_object('text', p_text), p_user);
end $$;

-- 合并账号时 union_id 跟着走。按线上现有定义改两处，不动其余内容。
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.merge_user(uuid, uuid)'::regprocedure);
  d2 := replace(d, 'set feishu_open_id = null, email = null,', 'set feishu_open_id = null, feishu_union_id = null, email = null,');
  if d2 = d then raise exception 'merge_user：未找到清空绑定的语句'; end if;
  d := d2;
  d2 := replace(d, 'set feishu_open_id = coalesce(b.feishu_open_id, a.feishu_open_id),',
                   'set feishu_open_id = coalesce(b.feishu_open_id, a.feishu_open_id), feishu_union_id = coalesce(b.feishu_union_id, a.feishu_union_id),');
  if d2 = d then raise exception 'merge_user：未找到合并绑定的语句'; end if;
  execute d2;
end $do$;
