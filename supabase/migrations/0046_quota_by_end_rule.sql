-- 结清后的结余算不算额度，按建项目时选的到期处理（各卡沿用）定：
--   到期回收：未用完的由学校收回，项目额度仍在，可在以后年度重新申请——回收的部分回到额度剩余；
--   结余上缴：未用完的上缴，不再属于本项目——仍占额度，不回到额度剩余；
--   结转：未用完的带到下一年的经费卡——仍算在原来那张卡的下达数里。
create or replace function fund_granted(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(coalesce(c.granted, (select coalesce(sum(b.amount), 0) from budget_line b where b.card_id = c.id) - c.carried_in)
                      - case when c.status = 'settled' and c.end_rule = 'recall' then coalesce(c.recalled, 0) else 0 end), 0)
  from fund_card c where c.project_id = p_project
$$;

-- 经费卡可以跨年度使用：课题的年度预算可以下达到有效期覆盖该年度的经费卡上（恢复按有效期判断，不再要求下达年度相同）
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.auto_allocate(int)'::regprocedure);
  d2 := replace(d, 'k.year = p_year', 'k.start_date <= make_date(p_year, 12, 31) and k.cutoff_date >= make_date(p_year, 1, 1)');
  if d2 = d then raise exception 'auto_allocate：未找到按年度筛选经费卡的语句'; end if;
  execute d2;
  d := pg_get_functiondef('public.allocate_line(uuid, jsonb)'::regprocedure);
  d2 := replace(d, 'if x.card_year <> l.year then', 'if x.start_date > make_date(l.year, 12, 31) or x.cutoff_date < make_date(l.year, 1, 1) then');
  if d2 = d then raise exception 'allocate_line：未找到按年度判断的语句'; end if;
  execute d2;
end $do$;

-- 结转的去处：同一项目里下达年度更晚、同卡号的在用经费卡中最早的一张；没有同卡号的，且更晚的卡只有一张时，带到那一张
create or replace function carry_target(p_card fund_card) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from fund_card where project_id = p_card.project_id and year > p_card.year and status = 'active' and carried_in = 0 and card_no = p_card.card_no order by year limit 1),
    (select min(id::text)::uuid from fund_card where project_id = p_card.project_id and year > p_card.year and status = 'active' and carried_in = 0
       having count(*) = 1 and (select count(*) from fund_card where project_id = p_card.project_id and year > p_card.year) = 1))
$$;
