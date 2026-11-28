-- 一、代币系统的流量把研究单元换 API 额度（0171，unit_coin kind = api）计入用掉，和换卡时、过期并列
create or replace view api.coin_flow as
  with b as (select date_trunc('quarter', least(
                coalesce((select min(created_at at time zone 'Asia/Shanghai') from coin_ledger), app_today()::timestamp),
                coalesce((select min(created_at at time zone 'Asia/Shanghai') from unit_coin), app_today()::timestamp)))::date as s),
       qs as (select g::date as q, (g + interval '3 months')::date as e from b, generate_series(b.s, date_trunc('quarter', app_today())::date, interval '3 months') g),
       cl as (select kind, amount, (created_at at time zone 'Asia/Shanghai')::date as d from coin_ledger),
       uc as (select kind, amount, (created_at at time zone 'Asia/Shanghai')::date as d from unit_coin)
  select qs.q as q_start,
         coalesce((select sum(amount) from cl where kind = 'salary' and d >= qs.q and d < qs.e), 0) as issued_salary,
         coalesce((select sum(amount) from cl where kind = 'mint' and d >= qs.q and d < qs.e), 0) as issued_mint,
         coalesce((select sum(amount) from uc where kind = 'budget' and d >= qs.q and d < qs.e), 0) as issued_budget,
         coalesce((select sum(amount) from cl where kind = 'adjust' and d >= qs.q and d < qs.e), 0) as adjusted,
         coalesce((select -sum(amount) from uc where kind = 'compute' and d >= qs.q and d < qs.e), 0) as spent_compute,
         coalesce((select -sum(amount) from cl where kind = 'expire' and d >= qs.q and d < qs.e), 0) as expired,
         coalesce((select sum(amount) from cl where d < qs.e), 0) as out_person,
         coalesce((select sum(amount) from uc where d < qs.e), 0) as out_unit,
         coalesce((select -sum(amount) from uc where kind = 'api' and d >= qs.q and d < qs.e), 0) as spent_api
  from qs
  where has_perm('read.finance') or has_perm('budget.approve');

-- 二、资源账：研究单元用实际币换走的额度（api_grant）计入这项资源的已发出，入库 = 发给个人 + 换给研究单元 + 结余
create or replace view api.resource as
SELECT id,
    kind,
    name,
    ref,
    total,
    unit,
    note,
    active,
    COALESCE(( SELECT sum(a.quota) AS sum
           FROM resource_allocation a
          WHERE ((a.resource_id = r.id) AND (a.returned_on IS NULL) AND ((a.to_date IS NULL) OR (a.to_date >= app_today())))), (0)::numeric) AS allocated,
    (( SELECT count(*) AS count
           FROM resource_allocation a
          WHERE ((a.resource_id = r.id) AND (a.returned_on IS NULL) AND ((a.to_date IS NULL) OR (a.to_date >= app_today())))))::integer AS holders,
    provider,
    model,
    currency,
    balance,
    balance_on,
    category,
    spec,
    unit_price,
    bundle,
    location,
    COALESCE(( SELECT sum(a.used) AS sum
           FROM resource_allocation a
          WHERE (a.resource_id = r.id)), (0)::numeric) AS used,
    COALESCE(( SELECT sum(COALESCE(q.approved_amount, q.amount)) AS sum
           FROM resource_request q
          WHERE ((q.resource_id = r.id) AND (q.status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'approved'::text])))), (0)::numeric) AS asked,
    (EXISTS ( SELECT 1
           FROM secret s
          WHERE ((s.owner_kind = 'resource'::text) AND (s.owner_id = r.id)))) AS has_secret,
    ( SELECT s.hint
           FROM secret s
          WHERE ((s.owner_kind = 'resource'::text) AND (s.owner_id = r.id))) AS secret_hint,
    fx_rate,
    fx_on,
    COALESCE(( SELECT sum(g.quota) AS sum
           FROM api_grant g
          WHERE (g.resource_id = r.id)), (0)::numeric) AS unit_granted
   FROM resource r
  WHERE has_perm('read.resource'::text);
