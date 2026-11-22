-- 访问令牌：成员给自己的智能体用，经 MCP 接口以本人身份调用后台。
--   令牌的权限就是本人的权限，数据库里的各项检查照常生效；默认只读，可写须在创建时选定。
--   令牌明文只在创建时显示一次，数据库里只存 SHA-256 和末四位。每次经令牌做的写操作留一条记录。

create table api_token (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(id),
  name text not null check (length(trim(name)) between 1 and 60),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  tail text not null check (length(tail) = 4),
  can_write boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  calls int not null default 0,
  revoked_at timestamptz,
  revoked_by uuid references app_user(id)
);
create index on api_token (user_id);
alter table api_token enable row level security;

create table api_call (
  id bigint generated always as identity primary key,
  token_id uuid not null references api_token(id),
  user_id uuid not null references app_user(id),
  action text not null,
  ok boolean not null,
  error text,
  at timestamptz not null default now()
);
create index on api_call (token_id, at desc);
alter table api_call enable row level security;

-- 创建：明文由接口层生成，这里只收哈希
create function create_api_token(p_name text, p_hash text, p_tail text, p_write boolean, p_days int) returns uuid
language plpgsql security definer set search_path = public as $$
declare me uuid := app_uid(); r uuid;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception '请填写令牌的用途'; end if;
  if p_days is null or p_days < 1 or p_days > 365 then raise exception '有效期须在 1 到 365 天之间'; end if;
  if (select count(*) from api_token where user_id = me and revoked_at is null and expires_at > now()) >= 5 then
    raise exception '每人最多同时持有 5 个有效令牌，请先停用不用的';
  end if;
  insert into api_token (user_id, name, hash, tail, can_write, expires_at)
    values (me, trim(p_name), p_hash, p_tail, coalesce(p_write, false), now() + make_interval(days => p_days)) returning id into r;
  return r;
end $$;

-- 停用：本人，或有账号管理权限的人
create function revoke_api_token(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t api_token;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into t from api_token where id = p_id;
  if t.id is null then raise exception '令牌不存在'; end if;
  if t.user_id <> app_uid() and not has_perm('user.manage') then raise exception '只能停用本人的令牌' using errcode = '42501'; end if;
  if t.revoked_at is not null then return; end if;
  update api_token set revoked_at = now(), revoked_by = app_uid() where id = p_id;
end $$;

-- 接口层凭哈希换取身份：令牌须未停用、未过期，持有人须在用。此时还没有登录身份。
create function api_token_login(p_hash text) returns table (token_id uuid, user_id uuid, can_write boolean)
language sql volatile security definer set search_path = public as $$
  update api_token t set last_used_at = now(), calls = calls + 1
   where t.hash = p_hash and t.revoked_at is null and t.expires_at > now()
     and exists (select 1 from app_user u where u.id = t.user_id and u.active)
  returning t.id, t.user_id, t.can_write
$$;

-- 经令牌做的写操作留一条记录（成功和失败都记）
create function log_api_call(p_token uuid, p_action text, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from api_token where id = p_token and user_id = app_uid()) then raise exception '令牌与身份不符' using errcode = '42501'; end if;
  insert into api_call (token_id, user_id, action, ok, error) values (p_token, app_uid(), left(p_action, 80), p_ok, left(p_error, 300));
end $$;

create view api.api_token as
  select t.id, t.user_id, u.name as user_name, t.name, t.tail, t.can_write, t.created_at, t.expires_at, t.last_used_at, t.calls, t.revoked_at,
         (t.user_id = app_uid()) as mine, (t.revoked_at is null and t.expires_at > now()) as live
    from api_token t join app_user u on u.id = t.user_id
   where app_role() is not null and (t.user_id = app_uid() or has_perm('user.manage'));

create view api.api_call as
  select c.id, c.token_id, t.name as token_name, c.user_id, u.name as user_name, c.action, c.ok, c.error, c.at, (c.user_id = app_uid()) as mine
    from api_call c join api_token t on t.id = c.token_id join app_user u on u.id = c.user_id
   where app_role() is not null and (c.user_id = app_uid() or has_perm('user.manage'))
   order by c.at desc limit 500;

grant select on api.api_token, api.api_call to app_api;
grant execute on function api_token_login(text) to app_api;
