-- 档次的评定由联席会议决定，结果由助理录入；中心负责人确认评定完成、转入下达。
insert into rbac_perm (code, name, grp, scope, sort) values ('budget.evaluate', '录入联席会议对课题档次的评定结果', '预算', 'global', 14)
on conflict (code) do nothing;
insert into rbac_role (code, name, note, builtin, locked, implicit, sort)
values ('assistant', '中心助理', '录入联席会议的评定结果', false, false, false, 9) on conflict (code) do nothing;
insert into rbac_role_perm (role_id, perm) select r.id, 'budget.evaluate' from rbac_role r where r.code in ('assistant', 'director') on conflict do nothing;

alter table tier_pick add column meeting_on date;   -- 作出评定的联席会议日期

drop function decide_tier(int, uuid, uuid, text);
create function decide_tier(p_year int, p_project uuid, p_tier uuid, p_note text default null, p_on date default null) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; k tier_pick; t budget_tier; n int; bad text;
begin
  perform need_perm('budget.evaluate');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过评定阶段', p_year; end if;
  select * into k from tier_pick where year = p_year and project_id = p_project for update;
  if not found then raise exception '该课题尚未申请档次'; end if;
  if p_tier is null then
    update tier_pick set decided_tier_id = null, decided_by = null, decided_at = null, decide_note = null, meeting_on = null where year = p_year and project_id = p_project;
    return;
  end if;
  if p_on is null then raise exception '请填写联席会议日期'; end if;
  if p_on > app_today() then raise exception '联席会议日期不得晚于今日'; end if;
  select * into t from budget_tier where id = p_tier and year = p_year;
  if not found then raise exception '档次不存在'; end if;
  select count(*) into n from tier_pick where year = p_year and decided_tier_id = p_tier and project_id <> p_project;
  if n >= t.slots then raise exception '「%」的名额 % 个已评满', t.name, t.slots; end if;
  bad := tier_violation(p_year, p_project, p_tier);
  if bad is not null then raise exception '%；请退回该课题调整明细后再录入', bad; end if;
  update tier_pick set decided_tier_id = p_tier, decided_by = app_uid(), decided_at = now(), decide_note = nullif(btrim(coalesce(p_note, '')), ''), meeting_on = p_on
  where year = p_year and project_id = p_project;
end $$;
select expose('decide_tier(int, uuid, uuid, text, date)');

-- 录入评定结果的人看得到各课题的申请
create or replace view api.tier_pick as
  select k.year, k.project_id, p.name as project_name, (select name from app_user where id = p.owner_id) as owner_name,
         k.tier_id, k.reason, k.picked_at, k.decided_tier_id, k.decide_note, k.decided_at,
         (select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0) from project_budget_line l join project_budget b on b.id = l.budget_id join project q on q.id = b.project_id
           where b.year = k.year and b.status = 'submitted' and (q.id = k.project_id or q.parent_id = k.project_id)) as total,
         (select count(*) from project_budget b join project q on q.id = b.project_id
           where b.year = k.year and b.status <> 'submitted' and (q.id = k.project_id or q.parent_id = k.project_id)
             and exists (select 1 from project_budget_line l where l.budget_id = b.id))::int as drafts,
         tier_violation(k.year, k.project_id, coalesce(k.decided_tier_id, k.tier_id)) as violation,
         k.meeting_on, (select name from app_user where id = k.decided_by) as decided_by_name
  from tier_pick k join project p on p.id = k.project_id where can_see_project(k.project_id) or has_perm('budget.evaluate');
