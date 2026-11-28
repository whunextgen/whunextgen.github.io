-- 本季度换 API 额度只用现有库存（黄济民 2026-11-28「可兑换的总额就是五万，然后下一期总额取决于这5万充的结果」）
--   公布的总额（coin_quarter.total）是课题预算本季度可兑换实际币的上限；兑进来的预算由财务岗下季度拿去充值，
--   充进去多少就是下一期的库存和总额。所以本季度换 API 额度的上限只算现有库存（api_stock），不再加上总额。
--   代币系统的覆盖率也按库存折实际币计（api.coin_quarter 加 api_stock 和 key 所在资源的汇率）。
CREATE OR REPLACE FUNCTION public.buy_api_quota(p_project uuid, p_coins numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare q coin_quarter; p project; r resource; fx numeric; amt numeric; used_q numeric; cap numeric; room numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = date_trunc('quarter', app_today())::date for update;
  if not found then raise exception '本季度的兑换比例尚未公布，请等财务岗公布'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception 'API 额度由研究单元换'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  select * into r from resource where unit_key and kind = 'api' and active;
  if not found then raise exception '财务岗尚未指定研究单元的 key 开在哪个接口资源上，请等财务岗在「资产盘点 › 研究单元 API key」登记'; end if;
  if p_coins is null or p_coins <= 0 or p_coins <> round(p_coins, 2) then raise exception '换出的实际币须大于 0，最多两位小数'; end if;
  if unit_coin_balance(p_project) < p_coins then raise exception '研究单元的实际币不足：需要 %，账上 %', p_coins, unit_coin_balance(p_project); end if;
  fx := unit_key_fx(r);
  amt := round(p_coins * q.api_rate / fx, 2);
  if amt <= 0 then raise exception '换得的额度不足 0.01 %', r.unit; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  -- 本季度能换的只有现有库存：本季度兑换的预算下季度才充值，充到多少决定下一期（0174）
  cap := coalesce(q.api_stock, 0);
  room := cap - used_q;
  if amt > room then
    raise exception '本季度全中心可换 API 额度 % %（现有库存），已换 %，剩余 %，最多还能用 % 实际币换；这次要换 %（换满即止）',
      cap, r.unit, used_q, greatest(room, 0), greatest(floor(room * fx / q.api_rate * 100) / 100, 0), amt;
  end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'api', -p_coins, app_uid(), format('换 %s %s API 额度', amt, r.unit));
  insert into api_grant (project_id, quota, coins, rate, q_start, bought_by, resource_id, fx_rate)
  values (p_project, amt, p_coins, q.api_rate, q.q_start, app_uid(), r.id, case when r.unit not in ('元', 'CNY', '人民币') then r.fx_rate end) returning api_grant.id into v_id;
  perform notify_role('finance', format('研究单元「%s」用实际币换了 %s %s API 额度（%s），请计入这个研究单元的 API key%s', p.name, amt, r.unit, r.name,
    case when exists (select 1 from secret where owner_kind = 'unit' and owner_id = p_project) then ''
         else '。这个研究单元还没有 key，请在「资产盘点 › 研究单元 API key」加密保存' end));
  return v_id;
end $$;

CREATE OR REPLACE FUNCTION public.set_api_stock(p_stock numeric, p_resource uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare q coin_quarter; r resource; used_q numeric;
begin
  perform need_perm('resource.manage');
  select * into q from coin_quarter where q_start = date_trunc('quarter', app_today())::date for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，公布后再登记库存'; end if;
  select * into r from resource where id = p_resource;
  if not found or r.kind <> 'api' or not r.active then raise exception '请选择在用的接口资源'; end if;
  if p_stock is null or p_stock < 0 then raise exception '库存不能为负'; end if;
  if exists (select 1 from api_grant where q_start = q.q_start and resource_id <> p_resource) then
    raise exception '本季度已有研究单元在另一个接口资源上换过额度，下季度再改'; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  if p_stock < used_q then
    raise exception '本季度已换出 % % API 额度，库存不能低于该数', used_q, r.unit;
  end if;
  update resource set unit_key = false where unit_key and id <> p_resource;
  update resource set unit_key = true where id = p_resource;
  update coin_quarter set api_stock = p_stock where q_start = q.q_start;
end $$;

create or replace view api.api_quarter as
SELECT q.q_start,
    q.total,
    q.api_rate,
    q.api_stock,
    COALESCE(g.bought, (0)::numeric) AS bought,
    (COALESCE(q.api_stock, (0)::numeric) - COALESCE(g.bought, (0)::numeric)) AS room,
    r.id AS resource_id,
    r.name AS resource_name,
    COALESCE(r.unit, '元'::text) AS unit,
        CASE
            WHEN (unit_key_fx(r.*) <> (1)::numeric) THEN r.fx_rate
            ELSE NULL::numeric
        END AS fx_rate,
    round((q.total / COALESCE(unit_key_fx(r.*), (1)::numeric)), 2) AS total_fx
   FROM ((coin_quarter q
     LEFT JOIN LATERAL ( SELECT sum(api_grant.quota) AS bought
           FROM api_grant
          WHERE (api_grant.q_start = q.q_start)) g ON (true))
     LEFT JOIN resource r ON ((r.unit_key AND (r.kind = 'api'::text) AND r.active)))
  WHERE ((q.q_start = (date_trunc('quarter'::text, (app_today())::timestamp with time zone))::date) AND (app_role() IS NOT NULL));

create or replace view api.coin_quarter as
SELECT q_start,
    total,
    rate,
    api_rate,
    gpu_price,
    note,
    published_at,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = q.published_by)) AS published_by_name,
    COALESCE(( SELECT sum(x.amount) AS sum
           FROM budget_coin_exchange x
          WHERE (x.q_start = q.q_start)), (0)::numeric) AS exchanged,
    (q_start = (date_trunc('quarter'::text, (app_today())::timestamp with time zone))::date) AS current,
    gpu_hours,
    api_stock,
    ( SELECT r.fx_rate FROM resource r WHERE r.unit_key AND r.kind = 'api'::text AND r.active) AS api_fx
   FROM coin_quarter q
  WHERE (app_role() IS NOT NULL);
