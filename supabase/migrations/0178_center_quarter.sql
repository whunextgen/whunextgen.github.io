-- 中心的季度是 11–1 月、2–4 月、5–7 月、8–10 月（黄济民 2026-11-28「这个季度是11 12 1」）
--   代币的季度（公布比例、兑换和换 API 的季度上限、任务币的季度上限、季末作废、流量统计）一律按中心季度，比自然季度晚一个月。
--   center_quarter(d) 给出 d 所在中心季度的第一天；coin_quarter_end(d) 改为中心季度的最后一天。
--   已公布的 2026-10-01 一期改为 2026-11-01（本季度 11-01 至 2027-01-31，92 天，卡时不变）；已发出的币到期日改为 2027-01-31。
--   年度预算的预算期（q1–q4）仍按自然季度，不在此列。
create or replace function center_quarter(d date) returns date language sql immutable as $$
  select (date_trunc('quarter', d - interval '1 month') + interval '1 month')::date
$$;
create or replace function coin_quarter_end(d date) returns date language sql immutable as $$
  select ((center_quarter(d) + interval '3 months')::date - 1)
$$;
alter table coin_quarter drop constraint coin_quarter_q_start_check;
update coin_quarter set q_start = center_quarter(q_start) where q_start <> center_quarter(q_start)
  and not exists (select 1 from budget_coin_exchange x where x.q_start = coin_quarter.q_start) and not exists (select 1 from api_grant g where g.q_start = coin_quarter.q_start);
alter table coin_quarter add constraint coin_quarter_q_start_check check (q_start = center_quarter(q_start));
update coin_task_award set q_start = center_quarter(created_at::date) where q_start <> center_quarter(created_at::date);
update coin_ledger set expires_on = coin_quarter_end(coalesce(period_start, created_at::date)) where kind in ('salary','task') and remain > 0;
update unit_coin set expires_on = coin_quarter_end(expires_on) where kind = 'invest' and remain > 0 and expires_on is not null;


CREATE OR REPLACE FUNCTION public.exchange_budget(p_line uuid, p_unit uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare q coin_quarter; pl project_budget_line; topic uuid; u project; used_q numeric; room numeric; c numeric;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = center_quarter(app_today()) for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，请等财务岗公布'; end if;
  select l.* into pl from project_budget_line l where l.id = p_line for update;
  if not found then raise exception '预算行不存在'; end if;
  if not exists (select 1 from budget_category bc where bc.id = pl.category_id and bc.coin) then raise exception '只有「算力与模型接口」科目的预算可以兑换实际币'; end if;
  select b.project_id into topic from project_budget b where b.id = pl.budget_id;
  if not (can_manage_project(topic) or has_perm('budget.issue')) then raise exception '由课题负责人办理' using errcode = '42501'; end if;
  if not line_live(p_line) or coalesce(pl.fixed, 0) <= 0 then raise exception '这一行预算尚未下达，不能兑换'; end if;
  select * into u from project where id = p_unit;
  if not found or u.layer <> 'paper' or not u.active or u.proposed or (u.parent_id is distinct from topic and u.id <> topic) then
    raise exception '实际币记入本课题下已成立的研究单元';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception '兑换的预算须大于 0'; end if;
  select coalesce(sum(amt), 0) into room from v_line_use where line_id = p_line;
  room := coalesce(pl.fixed, 0) - room;
  if p_amount > room then raise exception '这一行核定 %，已用和已兑换 %，最多还能兑 %', pl.fixed, pl.fixed - room, greatest(room, 0); end if;
  select coalesce(sum(amount), 0) into used_q from budget_coin_exchange where q_start = q.q_start;
  if used_q + p_amount > q.total then
    raise exception '本季度全中心可兑换 %，已兑 %，剩余 %，不够兑 %（兑满即止）', q.total, used_q, greatest(q.total - used_q, 0), p_amount;
  end if;
  c := round(p_amount * q.rate, 2);
  insert into budget_coin_exchange (q_start, line_id, topic_id, unit_id, amount, coins, rate, by_user) values (q.q_start, p_line, topic, p_unit, p_amount, c, q.rate, app_uid());
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_unit, 'budget', c, app_uid(), format('课题预算兑换：%s 元 × %s', p_amount, q.rate));
  if u.owner_id is not null and u.owner_id <> app_uid() then
    perform notify_user(u.owner_id, format('研究单元「%s」收到课题预算兑换的 %s 实际币，可用来换 API 额度或 GPU 卡时', u.name, c));
  end if;
  return c;
end $$;

CREATE OR REPLACE FUNCTION public.publish_coin_quarter(p_total numeric, p_rate numeric, p_api_rate numeric, p_gpu_price numeric, p_gpu_hours numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS date
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare q date := center_quarter(app_today()); old coin_quarter; n text := nullif(btrim(coalesce(p_note, '')), ''); used numeric;
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

CREATE OR REPLACE FUNCTION public.buy_api_quota(p_project uuid, p_coins numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare q coin_quarter; p project; r resource; fx numeric; amt numeric; used_q numeric; cap numeric; room numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = center_quarter(app_today()) for update;
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
  -- 本季度可换的 API 额度就是公布的总额对应的额度：财务岗本季度按总额直接充值（谢倩倩老师兜底），库存只做登记和对账（0175）
  cap := round(q.total / fx, 2);
  room := cap - used_q;
  if amt > room then
    raise exception '本季度全中心可换 API 额度 % %（总额 % 元折算），已换 %，剩余 %，最多还能用 % 实际币换；这次要换 %（换满即止）',
      cap, r.unit, q.total, used_q, greatest(room, 0), greatest(floor(room * fx / q.api_rate * 100) / 100, 0), amt;
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
  select * into q from coin_quarter where q_start = center_quarter(app_today()) for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，公布后再登记库存'; end if;
  select * into r from resource where id = p_resource;
  if not found or r.kind <> 'api' or not r.active then raise exception '请选择在用的接口资源'; end if;
  if p_stock is null or p_stock < 0 then raise exception '库存不能为负'; end if;
  if exists (select 1 from api_grant where q_start = q.q_start and resource_id <> p_resource) then
    raise exception '本季度已有研究单元在另一个接口资源上换过额度，下季度再改'; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  update resource set unit_key = false where unit_key and id <> p_resource;
  update resource set unit_key = true where id = p_resource;
  update coin_quarter set api_stock = p_stock where q_start = q.q_start;
end $$;

CREATE OR REPLACE FUNCTION public.coin_task_give(p_user uuid, p_code text, p_key text, p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare r coin_task_rule; q date := center_quarter(app_today()); amt numeric; cap numeric; got numeric; per date := token_period(app_today());
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
    (q_start = center_quarter(app_today())) AS current,
    gpu_hours,
    api_stock,
    ( SELECT r.fx_rate
           FROM resource r
          WHERE (r.unit_key AND (r.kind = 'api'::text) AND r.active)) AS api_fx
   FROM coin_quarter q
  WHERE (app_role() IS NOT NULL);

create or replace view api.api_quarter as
SELECT q.q_start,
    q.total,
    q.api_rate,
    q.api_stock,
    COALESCE(g.bought, (0)::numeric) AS bought,
    (round((q.total / COALESCE(unit_key_fx(r.*), (1)::numeric)), 2) - COALESCE(g.bought, (0)::numeric)) AS room,
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
  WHERE ((q.q_start = center_quarter(app_today())) AND (app_role() IS NOT NULL));

create or replace view api.coin_flow as
WITH b AS (
         SELECT center_quarter((LEAST(COALESCE(( SELECT min((coin_ledger.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AS min
                   FROM coin_ledger), (app_today())::timestamp without time zone), COALESCE(( SELECT min((unit_coin.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AS min
                   FROM unit_coin), (app_today())::timestamp without time zone)))::date) AS s
        ), qs AS (
         SELECT (g.g)::date AS q,
            ((g.g + '3 mons'::interval))::date AS e
           FROM b,
            LATERAL generate_series((b.s)::timestamp with time zone, (center_quarter(app_today()))::timestamp with time zone, '3 mons'::interval) g(g)
        ), cl AS (
         SELECT coin_ledger.kind,
            coin_ledger.amount,
            ((coin_ledger.created_at AT TIME ZONE 'Asia/Shanghai'::text))::date AS d
           FROM coin_ledger
        ), uc AS (
         SELECT unit_coin.kind,
            unit_coin.amount,
            ((unit_coin.created_at AT TIME ZONE 'Asia/Shanghai'::text))::date AS d
           FROM unit_coin
        )
 SELECT q AS q_start,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'salary'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_salary,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'mint'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_mint,
    COALESCE(( SELECT sum(uc.amount) AS sum
           FROM uc
          WHERE ((uc.kind = 'budget'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS issued_budget,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'adjust'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS adjusted,
    COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'compute'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS spent_compute,
    (COALESCE(( SELECT (- sum(cl.amount))
           FROM cl
          WHERE ((cl.kind = 'expire'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) + COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'expire'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric)) AS expired,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE (cl.d < qs.e)), (0)::numeric) AS out_person,
    COALESCE(( SELECT sum(uc.amount) AS sum
           FROM uc
          WHERE (uc.d < qs.e)), (0)::numeric) AS out_unit,
    COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'api'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS spent_api,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'task'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_task
   FROM qs
  WHERE (has_perm('read.finance'::text) OR has_perm('budget.approve'::text));
