-- 飞书头像补齐（黄济民 2026-11-27「Yes, use Feishu」）
--   中心网站只有 25 人有照片。其余人用飞书头像补：登录时从飞书身份信息里带上头像地址；
--   没登录过的，由定时任务经通讯录接口按 union_id 取（每小时一轮，每轮最多 30 人，取不到的 7 天后再试）。
--   显示时网站照片优先，没有的才用飞书头像。
alter table app_user add column feishu_avatar_url text check (feishu_avatar_url is null or feishu_avatar_url ~ '^https://[^\s]+$'),
                     add column feishu_avatar_at timestamptz;

create function feishu_avatar_save(p_user uuid, p_url text) returns void language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update app_user set feishu_avatar_url = case when p_url ~ '^https://[^\s]+$' then p_url else feishu_avatar_url end, feishu_avatar_at = now() where id = p_user;
end $$;

create function feishu_avatar_todo(p_limit int default 30) returns table (user_id uuid, union_id text) language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select u.id, u.feishu_union_id from app_user u
    where u.active and u.feishu_union_id is not null and u.feishu_avatar_url is null and (u.feishu_avatar_at is null or u.feishu_avatar_at < now() - interval '7 days')
    order by u.feishu_avatar_at nulls first limit greatest(1, least(coalesce(p_limit, 30), 50));
end $$;

create or replace view api.me as
  select id, name, role, kind, my_perms() as perms,
    coalesce((select array_agg(distinct rp.perm order by rp.perm) from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
              where g.user_id = app_user.id and (g.project_id is not null or g.card_id is not null) and g.revoked_at is null
                and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())), '{}'::text[]) as scoped,
    scholar_url,
    rank_label(user_rank(id)) as rank_label,
    coalesce((select p.avatar_url from person p where p.user_id = app_user.id and p.avatar_url is not null order by p.updated_at desc limit 1), feishu_avatar_url) as avatar_url
  from app_user
  where id = app_uid() and active;
