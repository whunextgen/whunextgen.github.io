-- 结清与年度汇总用的两个只读视图。
-- 各卡分年度的决算数（只认学校入账，按入账日归年）
create view api.year_actual as
  select f.card_id, extract(year from f.flow_date)::int as year, sum(f.amount) as actual
  from v_flow f where f.kind = 'actual' and can_see_card(f.card_id)
  group by 1, 2;

-- 在用卡结清前还差什么，与 settle_card 的拦截条件一致
create view api.settle_check as
  select c.id as card_id,
         (select count(*) from expense_request r where r.card_id = c.id and r.status in ('pending','committed','at_school','returned'))::int as open_requests,
         (select count(*) from budget_change b where b.card_id = c.id and b.status in ('pending','filed'))::int as open_changes,
         (select count(*) from v_flow f where f.card_id = c.id and f.kind = 'commit' and f.src = 'staff')::int as open_staff
  from fund_card c where c.status = 'active' and can_see_card(c.id);

grant select on api.year_actual, api.settle_check to app_api;
