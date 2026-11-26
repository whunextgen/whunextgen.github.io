-- 特批档次的课题补填预算明细（issue #50：陈焱凯的课题 P-16 有 1 万额度，却提不了支出申请）
--   支出申请按研究单元提交时，挂在课题当年已下达的预算明细行上。P-16 是在 2027 年度核定之后才特批的，
--   没赶上申报阶段，没有明细；而明细只能在申报阶段填写、提交，所以即使年度下达了也提不了。
--   现在：年度已过申报、尚未下达，课题有当年的档次特批的，负责人可以补填、提交、撤回明细；
--   提交时照常按档次的金额和限制校验，校验通过即按明细核定（与年度核定时的做法相同），年度下达时与其他课题一并分到经费卡上。

create function special_budget_open(p_year int, p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from budget_year y where y.year = p_year and y.stage in ('summary','approved','applied','granted','fixed'))
     and exists (select 1 from special_approval s join project p on p.id = p_project
                 where s.kind = 'tier' and s.year = p_year and s.project_id = coalesce(p.parent_id, p.id))
$$;

do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.save_budget_line(uuid, int, uuid, uuid, text, numeric, numeric, numeric, numeric)'::regprocedure);
  n := replace(d, 'if y.stage <> ''declare'' then raise exception ''% 年度预算申报已截止'', p_year; end if;',
                  'if y.stage <> ''declare'' and not special_budget_open(p_year, p_project) then raise exception ''% 年度预算申报已截止'', p_year; end if;');
  if n = d then raise exception 'save_budget_line 没有改上'; end if;
  execute n;

  d := pg_get_functiondef('public.delete_budget_line(uuid)'::regprocedure);
  n := replace(d, 'if y.stage <> ''declare'' then raise exception ''% 年度预算申报已截止'', b.year; end if;',
                  'if y.stage <> ''declare'' and not special_budget_open(b.year, b.project_id) then raise exception ''% 年度预算申报已截止'', b.year; end if;');
  if n = d then raise exception 'delete_budget_line 没有改上'; end if;
  execute n;

  d := pg_get_functiondef('public.set_project_budget(int, uuid, text, text)'::regprocedure);
  n := replace(d, E'    if y.stage <> ''declare'' then raise exception ''% 年度预算申报已截止'', p_year; end if;\n    if b.status = ''submitted'' then raise exception ''已提交，无需重复提交''; end if;',
                  E'    if y.stage <> ''declare'' and not special_budget_open(p_year, p_project) then raise exception ''% 年度预算申报已截止'', p_year; end if;\n    if b.status = ''submitted'' then raise exception ''已提交，无需重复提交''; end if;');
  if n = d then raise exception 'set_project_budget 提交没有改上'; end if;
  d := n;
  n := replace(d, 'if y.stage <> ''declare'' then raise exception ''申报已截止，不得撤回；如需修改请联系财务岗''; end if;',
                  'if y.stage <> ''declare'' and not special_budget_open(p_year, p_project) then raise exception ''申报已截止，不得撤回；如需修改请联系财务岗''; end if;');
  if n = d then raise exception 'set_project_budget 撤回没有改上'; end if;
  execute n;
end $$;

-- 特批的课题：提交即核定，撤回即取消核定
create function trg_special_budget_fix() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not special_budget_open(new.year, new.project_id) then return new; end if;
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    update project_budget_line set applied = q1 + q2 + q3 + q4, fixed = q1 + q2 + q3 + q4, adjust_note = null where budget_id = new.id;
  elsif old.status = 'submitted' and new.status <> 'submitted' then
    update project_budget_line set applied = null, fixed = null where budget_id = new.id;
  end if;
  return new;
end $$;
create trigger special_budget_fix after update of status on project_budget for each row execute function trg_special_budget_fix();

create view api.special_budget_open as
  select s.year, s.project_id from special_approval s where app_role() is not null and s.kind = 'tier' and special_budget_open(s.year, s.project_id);
grant select on api.special_budget_open to app_api;
