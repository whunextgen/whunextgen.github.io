-- 权限判断按事务缓存（提速）
--   has_perm、app_role 写成以定义者身份运行，数据库不能把它们展开进查询，视图里每一行都要完整执行一遍：
--   支出申请 251 行就是几百次重复的角色和授权查询，这张视图要近 300 毫秒。
--   现在同一事务里，当前用户的全局权限和基础角色只算一次，缓存在事务级设置里（记着是哪个用户的，换人就重算）；
--   授权、角色权限或账号一改动就清掉缓存。按课题、经费卡单独授权的判断照旧逐个查。判断结果与原来一致。

create or replace function has_perm(p_code text, p_project uuid default null, p_card uuid default null) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare u uuid := app_uid(); c text;
begin
  if u is null then return false; end if;
  c := current_setting('app.perm_cache', true);
  if c is null or c = '' or split_part(c, '|', 1) <> u::text then
    select u::text || '|,' || coalesce(string_agg(distinct x, ','), '') || ',' into c from (
      select rp.perm as x from app_user a join rbac_role r on r.code = a.role join rbac_role_perm rp on rp.role_id = r.id
      where a.id = u and a.active
      union all
      select rp.perm from app_user a join rbac_grant g on g.user_id = a.id join rbac_role_perm rp on rp.role_id = g.role_id
      where a.id = u and a.active and g.revoked_at is null and g.project_id is null and g.card_id is null
        and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())) s;
    perform set_config('app.perm_cache', c, true);
  end if;
  if position(',' || p_code || ',' in c) > 0 then return true; end if;
  if p_project is null and p_card is null then return false; end if;
  return user_perm(u, p_code, p_project, p_card);
end $$;

create or replace function app_role() returns text language plpgsql stable security definer set search_path = public as $$
declare u uuid := app_uid(); c text; r text;
begin
  if u is null then return null; end if;
  c := current_setting('app.role_cache', true);
  if c is not null and c <> '' and split_part(c, '|', 1) = u::text then return nullif(split_part(c, '|', 2), ''); end if;
  select role into r from app_user where id = u and active;
  perform set_config('app.role_cache', u::text || '|' || coalesce(r, ''), true);
  return r;
end $$;

-- 授权、角色权限、账号有改动时清掉本事务的缓存
create function trg_perm_cache_clear() returns trigger language plpgsql as $$
begin
  perform set_config('app.perm_cache', '', true);
  perform set_config('app.role_cache', '', true);
  return null;
end $$;
create trigger perm_cache_clear after insert or update or delete on rbac_grant for each statement execute function trg_perm_cache_clear();
create trigger perm_cache_clear after insert or update or delete on rbac_role_perm for each statement execute function trg_perm_cache_clear();
create trigger perm_cache_clear after insert or update or delete on rbac_role for each statement execute function trg_perm_cache_clear();
create trigger perm_cache_clear after insert or update or delete on app_user for each statement execute function trg_perm_cache_clear();
