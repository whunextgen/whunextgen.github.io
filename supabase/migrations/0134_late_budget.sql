-- 已评定档次的课题，年度下达前都能补交预算明细（黄济民 2026-11-26，issue #92）
--   原来年度过了申报阶段，明细就不能再填写、提交，只有中心负责人特批的课题例外（0128）。
--   熊瑶的课题 P-07 已评定为重点课题，明细却还是草稿，没赶上申报截止，于是看不到新增和提交按钮。
--   现在：年度已过申报、尚未下达，课题当年的档次已评定（未被否）或有档次特批的，负责人都可以补填、提交、撤回明细；
--   提交照常按档次的金额和限制校验，通过即按明细核定（沿用 0128 的做法），下达时与其他课题一并分到经费卡上。
create or replace function special_budget_open(p_year int, p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from budget_year y where y.year = p_year and y.stage in ('summary','approved','applied','granted','fixed'))
     and exists (select 1 from project p where p.id = p_project and (
           exists (select 1 from special_approval s where s.kind = 'tier' and s.year = p_year and s.project_id = coalesce(p.parent_id, p.id))
        or exists (select 1 from tier_pick k where k.year = p_year and k.project_id = coalesce(p.parent_id, p.id) and k.decided_tier_id is not null and not coalesce(k.rejected, false))))
$$;

-- 预算页据此显示补填入口：特批的和已评定的都列出
create or replace view api.special_budget_open as
  select y.year, p.id as project_id from budget_year y cross join project p
  where app_role() is not null and p.layer = 'big' and p.active and special_budget_open(y.year, p.id);
