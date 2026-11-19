-- 中心负责人是管理员：财务岗能经办的事，中心负责人账号也能办（登记到款和回收、登记预算变更批复、
-- 交学校和登记退回、入账和补登、备用金核销、劳务发放表）。职责分离的冲突规则对中心负责人不适用。
-- 随课题或经费卡确定的权限（确认本研究单元的申请、查看指定的经费卡等）不在此列，仍按原规则。
-- 本人提交、本人审批的情形仍按原规则记入权限日志。

insert into rbac_role_perm (role_id, perm)
select r.id, p.code from rbac_role r, rbac_perm p
where r.code = 'director' and p.code in ('card.fund', 'change.record', 'request.process', 'ledger.post', 'petty.settle', 'payroll.run')
on conflict do nothing;

create or replace function rbac_conflict_of(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select c.note from rbac_conflict c
  where not exists (select 1 from app_user u where u.id = p_user and u.role = 'director')
    and c.a in (select user_global_perms(p_user)) and c.b in (select user_global_perms(p_user)) limit 1
$$;
