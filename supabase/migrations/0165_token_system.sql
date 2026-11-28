-- 专门的代币系统（黄济民 2026-11-28「应该是专门的代币系统？包括监控通货膨胀等等」）
--   一、季度公布加「本季度集群可供 GPU 卡时」：和兑换总额（下季度可报销的 API 充值）一起，算出本季度可兑资源折合多少实际币，用来和流通量比。
--   二、按季度统计实际币的流量：发放、铸造、预算兑换（进），换卡时、过期（出），期末流通量（个人账 + 研究单元账）。
--       投给研究单元是个人账转到单元账，总量不变，不计进出。
--   三、当前概况：流通量、三个月内将过期的。财务岗和中心负责人可见。

alter table coin_quarter add column gpu_hours numeric(14,2) check (gpu_hours is null or gpu_hours >= 0);

drop function publish_coin_quarter(numeric, numeric, numeric, numeric, text);
create function publish_coin_quarter(p_total numeric, p_rate numeric, p_api_rate numeric, p_gpu_price numeric, p_gpu_hours numeric default null, p_note text default null) returns date
language plpgsql security definer set search_path = public as $$
declare q date := date_trunc('quarter', app_today())::date; old coin_quarter; n text := nullif(btrim(coalesce(p_note, '')), ''); used numeric;
begin
  perform need_perm('budget.issue');
  if p_total is null or p_total < 0 then raise exception '可兑换总额不能为负'; end if;
  if coalesce(p_rate, 0) <= 0 or coalesce(p_api_rate, 0) <= 0 or coalesce(p_gpu_price, 0) <= 0 then raise exception '三个兑换比例都须大于 0'; end if;
  if p_gpu_hours is not null and p_gpu_hours < 0 then raise exception '可供卡时不能为负'; end if;
  if length(n) > 300 then raise exception '说明不超过 300 个字'; end if;
  select * into old from coin_quarter where q_start = q for update;
  if found then
    select coalesce(sum(amount), 0) into used from budget_coin_exchange where q_start = q;
    if used > 0 and (p_rate <> old.rate or p_api_rate <> old.api_rate or p_gpu_price <> old.gpu_price) then
      raise exception '本季度已有兑换，兑换比例不能再改；比例下季度重新公布';
    end if;
    if p_total < used then raise exception '本季度已兑换 %，总额不能低于该数', used; end if;
    update coin_quarter set total = p_total, rate = p_rate, api_rate = p_api_rate, gpu_price = p_gpu_price, gpu_hours = coalesce(p_gpu_hours, gpu_hours), note = coalesce(n, note),
           published_by = app_uid(), published_at = now() where q_start = q;
  else
    insert into coin_quarter (q_start, total, rate, api_rate, gpu_price, gpu_hours, note, published_by) values (q, p_total, p_rate, p_api_rate, p_gpu_price, p_gpu_hours, n, app_uid());
  end if;
  insert into token_param (key, value) values ('price', to_jsonb(p_gpu_price)) on conflict (key) do update set value = excluded.value;
  return q;
end $$;

create or replace view api.coin_quarter as
  select q.q_start, q.total, q.rate, q.api_rate, q.gpu_price, q.note, q.published_at, (select name from app_user where id = q.published_by) as published_by_name,
         coalesce((select sum(x.amount) from budget_coin_exchange x where x.q_start = q.q_start), 0) as exchanged,
         q.q_start = date_trunc('quarter', app_today())::date as current,
         q.gpu_hours
  from coin_quarter q where app_role() is not null;

-- 按季度的流量与期末流通量
create view api.coin_flow as
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
         coalesce((select sum(amount) from uc where d < qs.e), 0) as out_unit
  from qs
  where has_perm('read.finance') or has_perm('budget.approve');

create view api.coin_now as
  select coalesce((select sum(amount) from coin_ledger), 0) as out_person,
         coalesce((select sum(amount) from unit_coin), 0) as out_unit,
         coalesce((select sum(remain) from coin_ledger where remain > 0 and expires_on >= app_today() and expires_on < app_today() + 90), 0) as expiring_90d,
         (select count(distinct user_id) from coin_ledger where remain > 0 and (expires_on is null or expires_on >= app_today())) as holders,
         (select count(*) from (select project_id from unit_coin group by project_id having sum(amount) > 0) z) as unit_holders
  where has_perm('read.finance') or has_perm('budget.approve');

grant select on api.coin_flow, api.coin_now to app_api;
