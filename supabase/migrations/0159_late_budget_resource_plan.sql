-- 补报预算时资源计划存不上（#166，熊瑶 2027 年 P-07）
--   年度已过申报、经特批或评定档次补报预算的课题，各行都能填，唯独「所需资源」被拦：资源计划的判断只认申报阶段，补报时一律报「预算提交后…」。
--   现在：与预算明细同一规则——申报阶段或补报开放期间、且本课题预算尚未提交的，负责人可以填资源计划；提交后仍由财务岗调整。
CREATE OR REPLACE FUNCTION public.set_line_resource(p_line uuid, p_resource uuid, p_qty numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare pid uuid; yr int; bst text; st text; r resource; taken numeric;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select b.project_id, b.year, b.status into pid, yr, bst from project_budget_line l join project_budget b on b.id = l.budget_id where l.id = p_line for update of l;
  if not found then raise exception '该预算行不存在'; end if;
  if not can_edit_project(pid) then raise exception '仅研究单元负责人和财务岗可填报该研究单元预算' using errcode = '42501'; end if;
  select stage into st from budget_year where year = yr;
  if st = 'closed' then raise exception '% 年度已决算，不得修改', yr; end if;
  if not has_perm('budget.compile') and bst = 'submitted' then raise exception '预算提交后，资源计划由财务岗在复盘时调整'; end if;
  if not has_perm('budget.compile') and st <> 'declare' and not special_budget_open(yr, pid) then raise exception '% 年度预算申报已截止，资源计划由财务岗在复盘时调整', yr; end if;
  select coalesce(sum(coalesce(q.approved_amount, q.amount)), 0) into taken from resource_request q
  where q.budget_line_id = p_line and q.status in ('pending','reviewed','approved','fulfilled');
  if p_resource is null then
    if taken > 0 then raise exception '该预算行已有资源申请，不得删除资源计划'; end if;
    update project_budget_line set resource_id = null, plan_qty = null where id = p_line;
    return;
  end if;
  select * into r from resource where id = p_resource;
  if not found or not r.active then raise exception '资源不存在或已停用'; end if;
  if p_qty is null or p_qty <= 0 then raise exception '计划数量须大于 0'; end if;
  if r.kind <> 'asset' and (select kind from project where id = pid) = 'public' then
    raise exception '拦截：中心公共开支仅统一配置设备。接口额度类资源请编入各研究单元预算';
  end if;
  if r.kind = 'asset' and p_qty <> trunc(p_qty) then raise exception '资产数量须为整数'; end if;
  if taken > 0 and p_resource <> (select resource_id from project_budget_line where id = p_line) then raise exception '该预算行已有资源申请，不得更换资源'; end if;
  if p_qty < taken then raise exception '计划数量不得低于已申请的 %', taken; end if;
  update project_budget_line set resource_id = p_resource, plan_qty = p_qty where id = p_line;
end $$;
