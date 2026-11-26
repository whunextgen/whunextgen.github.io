-- 双选按人员档案核对，包含尚未关联账号的人员；不复制名单或敏感资料。
-- 全员可见范围沿用人员权限；普通成员只能查看本人。
create view api.selection_roster as
select p.id, p.user_id, p.name, p.kind,
       p.rank, rank_label(p.rank) as rank_label,
       case when p.user_id is null then 'unlinked' when not coalesce(u.active, false) then 'inactive'
            when jsonb_array_length(j.projects) > 0 then 'joined'
            when jsonb_array_length(i.interests) > 0 then 'interested' else 'unselected' end as selection_status,
       j.projects, i.interests
from person p left join app_user u on u.id = p.user_id
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code, 'name', x.name,
    'layer', x.layer, 'parent_name', x.parent_name, 'owner_name', x.owner_name, 'joined_on', x.joined_on) order by x.code), '[]'::jsonb) projects
  from (
    select pr.id, pr.code, pr.name, pr.layer, parent.name parent_name, owner.name owner_name, m.joined_on
    from project_member m join project pr on pr.id = m.project_id
    left join project parent on parent.id = pr.parent_id left join app_user owner on owner.id = pr.owner_id
    where m.user_id = p.user_id and m.left_on is null and m.joined_on <= app_today()
      and pr.active and not pr.proposed and pr.kind <> 'public' and pr.layer in ('big','paper')
  ) x
) j
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'code', pr.code, 'name', pr.name) order by pr.code), '[]'::jsonb) interests
  from recruit_interest r join project pr on pr.id = r.project_id
  where r.user_id = p.user_id and r.status = 'open' and pr.active and not pr.proposed
    and pr.kind <> 'public' and pr.layer in ('big','paper')
) i
where app_role() is not null and (has_perm('read.people') or has_perm('people.manage') or p.user_id = app_uid())
  and p.status in ('active','offroll') and p.left_on is null and (p.rank in ('intern','assistant') or p.kind = 'master');
grant select on api.selection_roster to app_api;
