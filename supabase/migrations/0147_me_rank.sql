-- 侧栏左下角显示中心身份（issue #65，黄济民 2026-11-27「只显示中心身份」）
--   原来凡负责研究单元的成员一律显示「负责人」，看不出 Intern、Assistant 等身份。
--   现在 api.me 带上中心身份（以人员档案为准），侧栏显示它；没有人员档案的账号（如财务岗）仍显示基础角色。
create or replace view api.me as
  select id, name, role, kind, my_perms() as perms,
    coalesce((select array_agg(distinct rp.perm order by rp.perm) from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
              where g.user_id = app_user.id and (g.project_id is not null or g.card_id is not null) and g.revoked_at is null
                and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())), '{}'::text[]) as scoped,
    scholar_url,
    rank_label(user_rank(id)) as rank_label
  from app_user
  where id = app_uid() and active;
