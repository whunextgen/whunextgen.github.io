-- 财务岗编制与调整课题预算（issue #111，黄济民 2026-11-27「都做」）
--   一、公共课题不评档次，年度方案也没给它们直接定金额；年度过了申报阶段，谁都补填不了。
--      现在：年度已过申报、尚未下达，公共课题由财务岗补填、提交、撤回明细，提交即按明细核定（沿用 0128 的做法）。
--      课题负责人本人仍只能在申报阶段填报；判断里带 has_perm，所以页面上只有财务岗看到公共课题的补填入口。
--   二、核定之后、年度整体下达之前，原来没有任何人能改核定数（下达后才有中心负责人的「调整核定数」）。
--      现在：财务岗可以逐行调整未下达课题的核定数，须写原因，记入预算调剂记录；
--      调整后课题及其研究单元的核定数合计不得超过档次（或方案确定的金额、特批档次）；
--      已按课题下达的，先撤销下达（尚无支出时可以撤销），调整后再审核下达；
--      调减到低于已分配到经费卡的数额时，按与「调整核定数」相同的顺序收回分配。

create or replace function special_budget_open(p_year int, p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from budget_year y where y.year = p_year and y.stage in ('summary','approved','applied','granted','fixed'))
     and exists (select 1 from project p join project t on t.id = coalesce(p.parent_id, p.id) where p.id = p_project and (
           exists (select 1 from special_approval s where s.kind = 'tier' and s.year = p_year and s.project_id = t.id)
        or exists (select 1 from tier_pick k where k.year = p_year and k.project_id = t.id and k.decided_tier_id is not null and not coalesce(k.rejected, false))
        or (t.kind = 'public' and has_perm('budget.compile'))))
$$;

-- 课题当年的核定上限：方案直接确定的金额 > 特批档次 > 评定档次；公共课题等没有上限的返回 null
create function topic_fixed_cap(p_year int, p_big uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select amount from budget_module where year = p_year and project_id = p_big),
    (select t.amount from special_approval s join budget_tier t on t.id = s.tier_id where s.kind = 'tier' and s.year = p_year and s.project_id = p_big order by s.approved_at desc limit 1),
    (select t.amount from tier_pick k join budget_tier t on t.id = k.decided_tier_id where k.year = p_year and k.project_id = p_big and not coalesce(k.rejected, false)))
$$;

create function adjust_fixed(p_id uuid, p_amount numeric, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare l project_budget_line; b project_budget; y budget_year; p project; big uuid; cap numeric; tot numeric; al numeric; over numeric; a record; cut numeric;
        n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director');
  select * into l from project_budget_line where id = p_id for update;
  if not found then raise exception '该预算行不存在'; end if;
  select * into b from project_budget where id = l.budget_id;
  y := lock_year(b.year);
  if y.stage = 'issued' then raise exception '年度预算已整体下达，核定数的调整由中心负责人在年度决算页办理'; end if;
  if y.stage <> 'fixed' then raise exception '年度预算核定之后、整体下达之前方可调整核定数'; end if;
  if b.status <> 'submitted' then raise exception '该课题预算尚未提交，请直接修改明细'; end if;
  if b.issued_at is not null then raise exception '该课题已下达。请先在「按课题审核下达」中撤销下达，调整后再审核下达'; end if;
  if p_amount is null or p_amount < 0 then raise exception '金额不得为空，且不得为负'; end if;
  if n is null then raise exception '请填写调整原因'; end if;
  if p_amount = coalesce(l.fixed, 0) then raise exception '金额未变化'; end if;
  select * into p from project where id = b.project_id;
  big := coalesce(p.parent_id, p.id);
  cap := topic_fixed_cap(b.year, big);
  if cap is not null then
    select coalesce(sum(coalesce(x.fixed, 0)), 0) - coalesce(l.fixed, 0) + p_amount into tot
    from project_budget_line x join project_budget xb on xb.id = x.budget_id join project xp on xp.id = xb.project_id
    where xb.year = b.year and xb.status = 'submitted' and (xp.id = big or xp.parent_id = big);
    if tot > cap then raise exception '调整后本课题核定数合计 % 超过档次金额 %，超出 %', tot, cap, tot - cap; end if;
  end if;
  select coalesce(sum(amount), 0) into al from budget_allocation where line_id = p_id;
  over := al - p_amount;
  if over > 0 then
    for a in select x.id, x.amount from budget_allocation x join fund_card k on k.id = x.card_id where x.line_id = p_id
             order by case k.end_rule when 'carry' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date) desc loop
      exit when over <= 0;
      cut := least(over, a.amount);
      if cut >= a.amount then delete from budget_allocation where id = a.id; else update budget_allocation set amount = amount - cut where id = a.id; end if;
      over := over - cut;
    end loop;
  end if;
  update project_budget_line set fixed = p_amount, adjust_note = n where id = p_id;
  insert into budget_revision (line_id, old_amount, new_amount, note, revised_by) values (p_id, coalesce(l.fixed, 0), p_amount, n, app_uid());
end $$;

-- 与「按课题审核下达」同一权限：有下达权的财务岗和中心负责人
insert into rbac_fn (fn, sig, perm) values ('adjust_fixed', '*', 'budget.issue') on conflict do nothing;
revoke execute on function topic_fixed_cap(int, uuid) from public;

-- 预算页据此判断课题是否已按课题下达（已下达的先撤销下达才能调整）
create or replace view api.project_budget as
  select b.id, b.year, b.project_id, b.status, b.return_note, b.submitted_at, s.name as submitted_by_name, b.issued_at
  from project_budget b left join app_user s on s.id = b.submitted_by
  where can_see_project(b.project_id);
