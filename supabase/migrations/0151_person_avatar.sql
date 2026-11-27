-- 成员头像（黄济民 2026-11-27「从网站导入每个人的头像？」）
--   头像取中心网站人员页的照片，存的是网站的图片地址（经 jsDelivr 加速，国内可访问），照片本身不进正则的仓库。
--   挂在人员档案上（档案为准）；本人信息带上头像，侧栏和「我的事项」显示。
alter table person add column avatar_url text check (avatar_url is null or avatar_url ~ '^https://[^\s]+$');

create or replace view api.me as
  select id, name, role, kind, my_perms() as perms,
    coalesce((select array_agg(distinct rp.perm order by rp.perm) from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
              where g.user_id = app_user.id and (g.project_id is not null or g.card_id is not null) and g.revoked_at is null
                and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())), '{}'::text[]) as scoped,
    scholar_url,
    rank_label(user_rank(id)) as rank_label,
    (select p.avatar_url from person p where p.user_id = app_user.id and p.avatar_url is not null order by p.updated_at desc limit 1) as avatar_url
  from app_user
  where id = app_uid() and active;
