-- 谷歌学术主页：本人自行填写，课题和成员名单里随姓名显示。按双选方案，参与双选的博士须在相应课题条目下附上本人 Google Scholar 主页链接。
alter table app_user add column scholar_url text;

-- 本人填写或清除。只认谷歌学术的个人主页链接（citations?user=…）
create function set_scholar_url(p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare u text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if u is not null then
    if length(u) > 300 then raise exception '链接不得超过 300 个字符'; end if;
    if u !~ '^https?://scholar\.google\.[a-z.]+/citations\?([^ ]*&)?user=[A-Za-z0-9_-]+' then
      raise exception '请填写谷歌学术个人主页的链接，形如 https://scholar.google.com/citations?user=…';
    end if;
  end if;
  update app_user set scholar_url = u, updated_at = now() where id = app_uid();
end $$;
select expose('set_scholar_url(text)');

-- 本人信息带上自己的链接，供填写时回显
create or replace view api.me as
select id, name, role, kind, my_perms() as perms,
       coalesce((select array_agg(distinct rp.perm order by rp.perm) from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
                 where g.user_id = app_user.id and (g.project_id is not null or g.card_id is not null) and g.revoked_at is null
                   and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())), '{}') as scoped,
       scholar_url
from app_user where id = app_uid() and active;

-- 课题和研究单元的负责人、名单里的成员，随姓名给出链接
create or replace view api.project as
  select p.id, p.code, p.name, p.kind, p.owner_id, u.name as owner_name, p.active,
         can_edit_project(p.id) as mine, p.labor_cap_ratio,
         p.layer, p.parent_id, pp.code as parent_code, pp.name as parent_name, pp.owner_id as parent_owner_id,
         can_see_project(p.id) as seen,
         is_on_project(p.id) as member,
         (p.kind <> 'public' and p.active and (has_perm('budget.project', p.id) or has_perm('budget.setup'))) as can_roster,
         (select count(*)::int from project_member m where m.project_id = p.id and m.left_on is null) as members,
         u.scholar_url as owner_scholar_url
  from project p left join app_user u on u.id = p.owner_id left join project pp on pp.id = p.parent_id
  where app_role() is not null and (p.active or has_perm('budget.setup'));

create or replace view api.project_member as
  select m.id, m.project_id, m.user_id, u.name as user_name, m.joined_on, m.left_on,
         (select name from app_user where id = m.added_by) as added_by_name,
         case when m.left_on is null then member_holding(m.project_id, m.user_id) else 0 end as holding,
         u.scholar_url
  from project_member m join app_user u on u.id = m.user_id
  where can_see_project(m.project_id) or m.user_id = app_uid();
