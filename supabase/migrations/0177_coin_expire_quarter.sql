-- 实际币按季度过期（黄济民 2026-11-28「按季度过期」）
--   按期发放的和做任务得的实际币，都到发放当季的最后一天作废，每季度从零开始，和季度公布的比例、季度上限对齐。
--   个人投给研究单元的沿用个人那笔的到期日（0173），即同一季末；课题预算兑入的不过期；成果铸造的仍按 valid 个月。
--   已发出、还没用完的按期发放和任务币，到期日改到当季最后一天。
create or replace function coin_quarter_end(d date) returns date language sql immutable as $$
  select ((date_trunc('quarter', d) + interval '3 months')::date - 1)
$$;

CREATE OR REPLACE FUNCTION public.coin_salary_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare per date := token_period(app_today()); s jsonb := (select value from token_param where key = 'salary'); r record; amt numeric; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for r in select pr.user_id, pr.rank from person pr join app_user u on u.id = pr.user_id where pr.status in ('active','offroll') and u.active loop
    amt := nullif(s ->> r.rank, '')::numeric;
    if amt is null or amt <= 0 then continue; end if;
    insert into coin_ledger (user_id, kind, amount, remain, expires_on, period_start, note)
    values (r.user_id, 'salary', amt, amt, coin_quarter_end(per), per, format('%s 起一期按身份发放（%s）', to_char(per, 'YYYY-MM-DD'), rank_label(r.rank)))
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

CREATE OR REPLACE FUNCTION public.coin_task_give(p_user uuid, p_code text, p_key text, p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare r coin_task_rule; q date := date_trunc('quarter', app_today())::date; amt numeric; cap numeric; got numeric; per date := token_period(app_today());
begin
  if p_user is null or p_amount is null or p_amount <= 0 then return 0; end if;
  if exists (select 1 from coin_task_award where user_id = p_user and code = p_code and source_key = p_key) then return 0; end if;
  if not exists (select 1 from app_user u join person pr on pr.user_id = u.id where u.id = p_user and u.active and pr.status in ('active','offroll')) then return 0; end if;
  select * into r from coin_task_rule where code = p_code;
  if not found then return 0; end if;
  amt := round(p_amount, 2);
  if r.quarter_cap is not null and (select count(*) from coin_task_award where user_id = p_user and code = p_code and q_start = q and amount > 0) >= r.quarter_cap then amt := 0; end if;
  select s.cap into cap from coin_task_setting s;
  select coalesce(sum(amount), 0) into got from coin_task_award where user_id = p_user and q_start = q;
  amt := greatest(least(amt, cap - got), 0);
  insert into coin_task_award (user_id, code, source_key, amount, q_start, note) values (p_user, p_code, p_key, amt, q, left(coalesce(p_note, r.label), 200));
  if amt > 0 then
    insert into coin_ledger (user_id, kind, amount, remain, expires_on, period_start, note)
    values (p_user, 'task', amt, amt, coin_quarter_end(app_today()), per, left(coalesce(p_note, r.label), 200));
  end if;
  return amt;
end $$;

update coin_ledger set expires_on = coin_quarter_end(coalesce(period_start, created_at::date))
where kind in ('salary','task') and remain > 0;
update unit_coin u set expires_on = coin_quarter_end(u.expires_on)
where u.kind = 'invest' and u.remain > 0 and u.expires_on is not null;
