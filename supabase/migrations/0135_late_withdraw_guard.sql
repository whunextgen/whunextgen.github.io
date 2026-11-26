-- 0134 的副作用收紧：核定后放开的是「补交」，不是让按时提交、已核定的课题撤回重改
--   核定后撤回只限：特批课题，或年度核定之后才提交的（补交进来的）；而且课题已按课题下达的不能撤回。
--   按时提交、在年度核定时已核定的课题，撤回会清掉核定数，仍须联系财务岗。
create function late_withdraw_ok(p_year int, p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select special_budget_open(p_year, p_project)
     and exists (select 1 from project_budget b join budget_year y on y.year = b.year
                 where b.year = p_year and b.project_id = p_project and b.issued_at is null
                   and (exists (select 1 from special_approval s where s.kind = 'tier' and s.year = p_year and s.project_id = p_project)
                        or (y.fixed_at is not null and b.submitted_at > y.fixed_at)))
$$;
do $$
declare d text := pg_get_functiondef('public.set_project_budget(int, uuid, text, text)'::regprocedure); n text;
begin
  n := replace(d, 'if y.stage <> ''declare'' and not special_budget_open(p_year, p_project) then raise exception ''申报已截止，不得撤回；如需修改请联系财务岗''; end if;',
                  'if y.stage <> ''declare'' and not late_withdraw_ok(p_year, p_project) then raise exception ''申报已截止，不得撤回；核定后补交的明细在下达前可以撤回，其余如需修改请联系财务岗''; end if;');
  if n = d then raise exception 'set_project_budget 撤回没有改上'; end if;
  execute n;
end $$;

-- 预算页据此决定是否显示撤回按钮
create or replace view api.special_budget_open as
  select y.year, p.id as project_id, late_withdraw_ok(y.year, p.id) as can_withdraw from budget_year y cross join project p
  where app_role() is not null and p.layer = 'big' and p.active and special_budget_open(y.year, p.id);
