-- 研究单元申请：中心负责人可以不等否决期届满，直接通过（即表示不行使否决权）。
--   须所挂课题的负责人已同意；通过即成立，不再经助理核对。否决期内助理仍按原规则等否决期届满后核对。
alter table project add column veto_waived_by uuid references app_user(id), add column veto_waived_at timestamptz;

create function pass_unit(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project; par project;
begin
  perform need_perm('budget.approve');
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待核对的申请'; end if;
  if u.return_note is not null then raise exception '该申请已退回，待申请人修改后重新提交'; end if;
  if u.parent_ok_at is null then raise exception '所挂课题的负责人尚未同意，同意后方可通过'; end if;
  select * into par from project where id = u.parent_id;
  if not par.active or par.proposed then raise exception '所挂课题尚未立项或已停用'; end if;
  update project set proposed = false, checked_by = app_uid(), checked_at = now(), veto_waived_by = app_uid(), veto_waived_at = now() where id = p_unit;
  perform notify_user(u.owner_id, format('研究单元「%s」已由中心负责人通过并成立，挂在课题「%s」之下。本人为负责人，可管理成员名单', u.name, par.name));
  perform notify_user(m.user_id, format('你已加入研究单元「%s」的成员名单，可使用课题「%s」的预算提交支出申请、申领资源', u.name, par.name))
  from project_member m where m.project_id = p_unit and m.left_on is null;
  if par.owner_id is not null and par.owner_id is distinct from u.owner_id then
    perform notify_user(par.owner_id, format('课题「%s」之下新成立研究单元「%s」，负责人 %s', par.name, u.name, (select name from app_user where id = u.owner_id)));
  end if;
end $$;
select expose('pass_unit(uuid)');

-- 申请列表：给出能否直接通过、是否由中心负责人提前通过
create or replace view api.unit_apply as
  select p.id, p.code, p.name, p.parent_id, pp.code as parent_code, pp.name as parent_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         p.apply_note, p.meeting_on, p.minutes_on, p.applied_at, p.return_note, (select name from app_user where id = p.checked_by) as checked_by_name, p.checked_at,
         p.proposed, add_workdays(p.minutes_on, 3) as veto_until,
         (select string_agg(u.name, '、' order by u.name) from project_member m join app_user u on u.id = m.user_id where m.project_id = p.id and m.left_on is null) as member_names,
         (select string_agg(m.user_id::text, ',') from project_member m where m.project_id = p.id and m.left_on is null) as member_ids,
         (p.owner_id is not distinct from app_uid()) as mine,
         p.parent_ok_at, (select name from app_user where id = p.parent_ok_by) as parent_ok_by_name, (select name from app_user where id = pp.owner_id) as parent_owner_name,
         (p.proposed and has_perm('budget.project', pp.id)) as can_ok,
         (p.proposed and p.return_note is null and p.parent_ok_at is not null and has_perm('budget.approve')) as can_pass,
         p.veto_waived_at, (select name from app_user where id = p.veto_waived_by) as veto_waived_by_name
  from project p join project pp on pp.id = p.parent_id
  where p.applied_at is not null and p.layer = 'paper' and p.active and app_role() is not null
    and (not p.proposed or p.owner_id = app_uid() or has_perm('budget.evaluate') or has_perm('budget.setup') or can_manage_project(pp.id) or has_perm('budget.project', pp.id));
