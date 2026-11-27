-- 人数只汇总展示；不写入父课题成员名单，不改变权限、份额或审批关系。
create function project_member_count(p_project uuid, p_include_units boolean default true) returns integer
language sql stable security definer set search_path = public as $$
  select count(distinct m.user_id)::integer
  from project root join project scope on scope.id = root.id
    or (p_include_units and root.layer = 'big' and scope.parent_id = root.id and scope.layer = 'paper')
  join project_member m on m.project_id = scope.id
  join app_user u on u.id = m.user_id
  where root.id = p_project and app_role() is not null and root.active and not root.proposed and root.kind <> 'public'
    and scope.active and not scope.proposed and scope.kind <> 'public'
    and u.active and m.joined_on <= app_today() and (m.left_on is null or m.left_on > app_today())
$$;
revoke all on function project_member_count(uuid, boolean) from public;
grant execute on function project_member_count(uuid, boolean) to app_api;

create or replace view api.project as
select p.id, p.code, p.name, p.kind, p.owner_id, u.name as owner_name, p.active,
         can_edit_project(p.id) as mine, p.labor_cap_ratio,
         p.layer, p.parent_id, pp.code as parent_code, pp.name as parent_name, pp.owner_id as parent_owner_id,
         can_see_project(p.id) as seen,
         is_on_project(p.id) as member,
         (p.kind <> 'public' and p.active and (has_perm('budget.project', p.id) or has_perm('budget.setup'))) as can_roster,
         project_member_count(p.id) as members,
         u.scholar_url as owner_scholar_url, project_member_count(p.id, false) as direct_members
  from project p left join app_user u on u.id = p.owner_id left join project pp on pp.id = p.parent_id
  where app_role() is not null and (p.active or has_perm('budget.setup'));

create or replace view api.recruit as
select p.id, p.code, p.name, p.layer, p.parent_id, (select name from project q where q.id = p.parent_id) as parent_name,
         p.owner_id, (select name from app_user where id = p.owner_id) as owner_name, (select scholar_url from app_user where id = p.owner_id) as owner_scholar_url,
         case when p.layer = 'paper' then p.apply_note else (select k.reason from tier_pick k where k.project_id = p.id order by k.year desc limit 1) end as intro,
         (select jsonb_build_object('id', s.id, 'seq', s.seq, 'link', s.link, 'period_start', s.period_start) from snapshot s where s.project_id = p.id and s.person_id is null order by s.seq desc limit 1) as snapshot,
         (select count(*)::int from query q where q.project_id = p.id and q.status = 'open' and q.parent_id is null) as open_queries,
         (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]') from (select jsonb_build_object('id', q.id, 'axis', axis_label(q.axis), 'body', q.body, 'at', q.recorded_at) x
            from query q where q.project_id = p.id and q.status = 'open' and q.parent_id is null order by q.recorded_at desc limit 3) z) as queries,
         project_member_count(p.id) as members,
         has_perm('budget.project', p.id) as can_manage,
         (p.owner_id = app_uid() or exists (select 1 from project_member m where m.project_id = p.id and m.user_id = app_uid() and m.left_on is null)) as am_member,
         exists (select 1 from recruit_interest i where i.project_id = p.id and i.user_id = app_uid() and i.status = 'open') as my_interest, project_member_count(p.id, false) as direct_members
  from project p
  where app_role() is not null and p.active and not p.proposed and p.kind <> 'public' and p.layer in ('big','paper');
