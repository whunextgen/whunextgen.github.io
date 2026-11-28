-- API 额度按美元记，录入期初余额（黄济民 2026-11-28「先按市场汇率折算，做入口录进去，按美元申请和发放额度」）
--   API 平台按美元计价：资源的计价单位改为美元，记一个折算汇率（元/美元，财务岗按市场汇率填，可更新）。
--   申请、批准、发放、密钥额度都按美元；和课题预算行（人民币）比较时按汇率折算。
--   期初余额：不对应本年支出的库存（旧门户充值、往年充值剩下的），由财务岗按平台后台余额录一次，写明截至日期和来源。
alter table resource add column fx_rate numeric(12,4) check (fx_rate is null or fx_rate > 0), add column fx_on date;
alter table resource_stock alter column expense_request_id drop not null;
alter table resource_stock add column source text not null default 'purchase' check (source in ('purchase','opening'));
alter table resource_stock add constraint resource_stock_opening_check check (source = 'opening' or expense_request_id is not null);

create or replace function stock_opening(p_resource uuid, p_qty numeric, p_on date, p_unit text, p_fx numeric, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource; u text := nullif(btrim(coalesce(p_unit, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), ''); sid uuid; cny boolean;
begin
  perform need_role('finance','director');
  select * into r from resource where id = p_resource for update;
  if not found then raise exception '资源不存在'; end if;
  if r.kind <> 'api' then raise exception '期初余额只用于接口额度；资产按件入库'; end if;
  if exists (select 1 from resource_stock where resource_id = p_resource and source = 'opening') then raise exception '「%」已录过期初余额，之后的充值按支出入库', r.name; end if;
  if p_qty is null or p_qty <= 0 then raise exception '余额须大于 0'; end if;
  if p_on is null or p_on > app_today() then raise exception '截至日期不能晚于今天'; end if;
  u := coalesce(u, r.unit, '元');
  if length(u) > 10 then raise exception '计价单位不超过 10 个字'; end if;
  cny := u in ('元', 'CNY', '人民币');
  if not cny and coalesce(p_fx, 0) <= 0 then raise exception '「%」不是人民币，请填折算汇率（1 % 合多少元）', u, u; end if;
  if nt is null then raise exception '请写明来源，比如「旧门户充值和 11-26 入账的充值，截至平台后台余额」'; end if;
  if length(nt) > 200 then raise exception '说明不超过 200 个字'; end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '说明里不要填密钥'; end if;
  if u is distinct from r.unit and (exists (select 1 from resource_request where resource_id = p_resource and status in ('pending','reviewed','approved'))
     or exists (select 1 from resource_allocation where resource_id = p_resource and returned_on is null)) then
    raise exception '「%」已有在办的申请或在用的额度，不能改计价单位', r.name;
  end if;
  insert into resource_stock (resource_id, qty, unit_price, supplier, note, expense_request_id, received_on, created_by, source)
  values (p_resource, p_qty, null, null, nt, null, p_on, app_uid(), 'opening') returning id into sid;
  update resource set unit = u, fx_rate = case when cny then null else p_fx end, fx_on = case when cny then null else p_on end,
         total = p_qty, balance = p_qty, balance_on = p_on where id = p_resource;
  return sid;
end $$;

-- 折算汇率按市场汇率更新
create or replace function set_resource_fx(p_resource uuid, p_fx numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if p_fx is null or p_fx <= 0 then raise exception '汇率须大于 0'; end if;
  update resource set fx_rate = p_fx, fx_on = app_today() where id = p_resource and kind = 'api' and unit not in ('元','CNY','人民币');
  if not found then raise exception '只有非人民币计价的接口资源需要汇率'; end if;
end $$;
insert into rbac_fn (fn, sig, perm) values ('stock_opening', '*', 'resource.approve'), ('set_resource_fx', '*', 'resource.approve') on conflict do nothing;

CREATE OR REPLACE FUNCTION public.save_resource_request(p_id uuid, p_kind text, p_resource uuid, p_line uuid, p_amount numeric, p_period date, p_purpose text, p_usage text DEFAULT NULL::text, p_urgent boolean DEFAULT false, p_unit uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare tgt uuid; r resource; pu text := btrim(coalesce(p_purpose, '')); us text := nullif(btrim(coalesce(p_usage, '')), ''); rid uuid; own uuid; old resource_request;
  l v_line; pl project_budget_line; taken numeric; short numeric;
begin
  perform need_role('finance','director','leader','member');
  if p_kind is null or p_kind not in ('api','asset') then raise exception '类型仅限接口额度或资产'; end if;
  if pu = '' then raise exception '请填写用途'; end if;
  if length(pu) > 300 or length(us) > 600 then raise exception '用途不得超过 300 个字，用量说明不得超过 600 个字'; end if;
  if pu ~ '[A-Za-z0-9_\-]{32,}' or us ~ '[A-Za-z0-9_\-]{32,}' then raise exception '申请中不得填写密钥'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '%', case p_kind when 'api' then '额度须大于 0' else '数量须大于 0' end; end if;
  l := open_line(p_line);
  select * into pl from project_budget_line where id = p_line;
  -- 接口额度：预算行没有资源计划、或计划不够的，照样可以申请，财务岗批准时按本行核定数追加资源计划（#158）
  if pl.resource_id is null then
    if p_kind <> 'api' then raise exception '拦截：该预算行未编制资源计划。请先在年度预算中填写所需资源及数量，再提交申请'; end if;
    if p_resource is null then raise exception '该预算行尚未编制资源计划，请选择要申请的接口资源'; end if;
  else
    if p_resource is not null and p_resource <> pl.resource_id then raise exception '所选资源与该预算行计划的资源不一致'; end if;
    p_resource := pl.resource_id;
  end if;
  select coalesce(sum(coalesce(q.approved_amount, q.amount)), 0) into taken from resource_request q
  where q.budget_line_id = p_line and q.status in ('pending','reviewed','approved','fulfilled') and q.id is distinct from p_id;
  short := greatest(taken + p_amount - coalesce(pl.plan_qty, 0), 0);
  if short > 0 and p_kind <> 'api' then
    raise exception '拦截：该预算行计划 %，已申请 %，剩余 %，不足 %。如需追加请先调整预算中的资源计划', pl.plan_qty, taken, pl.plan_qty - taken, p_amount;
  end if;
  -- 额度按资源的计价单位（如美元）记，和预算行比时按折算汇率换成人民币（0170）
  if short > 0 and (select coalesce(sum(amt), 0) from v_line_use where line_id = p_line) + (taken + p_amount) * coalesce((select fx_rate from resource where id = p_resource), 1) > coalesce(pl.fixed, 0) then
    raise exception '拦截：该预算行核定 % 元，已支出 % 元，已申请额度 %，再申请 %（按汇率 % 折人民币）将超出核定数', coalesce(pl.fixed, 0), (select coalesce(sum(amt), 0) from v_line_use where line_id = p_line), taken, p_amount, coalesce((select fx_rate from resource where id = p_resource), 1);
  end if;
  select owner_id into own from project where id = l.project_id;
  tgt := request_owner(l.project_id, p_unit); select owner_id into own from project where id = tgt;
  -- 公共设备：中心统一配给博士后、博士、硕士、研究助理本人的设备。其余资源都在各项目里，归项目负责人
  if (select kind from project where id = l.project_id) = 'public' then
    if p_kind <> 'asset' then raise exception '拦截：中心公共开支仅统一配置设备，接口额度从各研究单元预算列支'; end if;
    if coalesce((select kind from app_user where id = app_uid()), '') not in ('postdoc','phd','master','ra') then
      raise exception '拦截：公共设备仅限博士后、博士、硕士和研究助理申领。身份尚未登记的，请先由财务岗登记';
    end if;
  end if;
  if p_resource is not null then
    select * into r from resource where id = p_resource;
    if not found or r.kind <> p_kind then raise exception '所选资源不存在，或类型不一致'; end if;
    if not r.active then raise exception '「%」已停用，不得申请', r.name; end if;
  end if;
  if p_kind = 'asset' then
    if p_resource is null then raise exception '请选择要申领的资产'; end if;
    if p_amount <> trunc(p_amount) then raise exception '数量须为整数'; end if;
    if r.total is null and p_amount <> 1 then raise exception '「%」为单件资产，数量仅可为 1', r.name; end if;
    p_period := null;
  else
    if p_period is null then raise exception '请选择使用月份'; end if;
    if extract(year from p_period) <> l.year then raise exception '使用月份须在 % 年度以内', l.year; end if;
    p_period := date_trunc('month', p_period)::date;
  end if;
  if p_urgent and us is null then raise exception '紧急申请须在用量说明中写明紧急原因'; end if;
  if p_id is null then
    insert into resource_request (kind, resource_id, project_id, budget_line_id, requested_by, amount, period, purpose, usage_note, urgent, plan_add, status, reviewed_by, reviewed_at)
    values (p_kind, p_resource, tgt, p_line, app_uid(), p_amount, p_period, pu, us, coalesce(p_urgent, false), nullif(short, 0),
            -- 项目没有负责人的，或者负责人自己申请的，不用再批示
            case when own is null or own = app_uid() then 'reviewed' else 'pending' end,
            case when own = app_uid() then app_uid() end, case when own = app_uid() then now() end)
    returning id into rid;
    if own is not null and own <> app_uid() then
      perform notify_user(own, format('%s 提交了%s申请，待批示：%s', (select name from app_user where id = app_uid()), case p_kind when 'api' then '接口额度' else '资产' end, pu));
    else
      perform notify_role('finance', format('有新的%s申请待财务岗处理：%s%s', case p_kind when 'api' then '接口额度' else '资产' end, pu, case when short > 0 then format('（预算行资源计划不足，批准时追加 %s）', short) else '' end));
    end if;
  else
    select * into old from resource_request where id = p_id for update;
    if not found or old.requested_by <> app_uid() then raise exception '仅可修改本人的申请'; end if;
    if old.kind <> p_kind then raise exception '申请类型不得修改，请撤回后重新提交'; end if;
    if old.status not in ('pending','reviewed') or old.decided_by is not null then raise exception '该申请已在处理中，不得修改；如需调整请撤回后重新提交'; end if;
    update resource_request set resource_id = p_resource, project_id = tgt, budget_line_id = p_line, amount = p_amount, period = p_period, purpose = pu, usage_note = us,
           urgent = coalesce(p_urgent, false), plan_add = nullif(short, 0), updated_at = now(),
           status = case when own is null or own = app_uid() then 'reviewed' else 'pending' end,
           reviewed_by = case when own = app_uid() then app_uid() end, reviewed_at = case when own = app_uid() then now() end
    where id = p_id returning id into rid;
  end if;
  return rid;
end $$;

CREATE OR REPLACE FUNCTION public.decide_resource_request(p_id uuid, p_action text, p_amount numeric DEFAULT NULL::numeric, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare r resource_request; own uuid; pl project_budget_line; taken numeric; cash numeric; n text := nullif(btrim(coalesce(p_note, '')), ''); what text;
begin
  perform need_role('finance','director','leader','member');
  select * into r from resource_request where id = p_id for update;
  if not found then raise exception '申请不存在'; end if;
  select owner_id into own from project where id = r.project_id;
  if length(n) > 300 then raise exception '意见不得超过 300 个字'; end if;
  what := case r.kind when 'api' then '接口额度' else '资产' end;
  if p_action = 'withdraw' then
    if r.requested_by <> app_uid() then raise exception '仅可撤回本人的申请'; end if;
    if r.status not in ('pending','reviewed','approved') then raise exception '该申请已处理完毕，不得撤回'; end if;
    update resource_request set status = 'withdrawn', updated_at = now() where id = p_id;
  elsif p_action = 'review' then
    if not has_perm('resource.review', r.project_id) then raise exception '仅研究单元负责人可批示'; end if;
    if r.status <> 'pending' then raise exception '该申请不在待批示状态'; end if;
    update resource_request set status = 'reviewed', reviewed_by = app_uid(), reviewed_at = now(), decide_note = coalesce(n, decide_note), updated_at = now() where id = p_id;
    perform notify_role('finance', format('%s申请已经研究单元负责人批示，待财务岗处理：%s', what, r.purpose));
  elsif p_action = 'approve' then
    if not has_perm('resource.approve') then raise exception '仅财务岗和中心负责人可批准'; end if;
    perform sod_self('resource.approve', r.requested_by, '资源申请');
    if r.status = 'pending' and not has_perm('resource.fasttrack') then raise exception '须待研究单元负责人批示'; end if;
    if r.status not in ('pending','reviewed') then raise exception '该申请不在待批准状态'; end if;
    p_amount := coalesce(p_amount, r.amount);
    if p_amount <= 0 then raise exception '批准数量须大于 0'; end if;
    if p_amount > r.amount then raise exception '批准数量不得超过申请的 %', r.amount; end if;
    if r.kind = 'asset' and p_amount <> trunc(p_amount) then raise exception '数量须为整数'; end if;
    if p_amount < r.amount and n is null then raise exception '批准数量少于申请数量，请填写原因'; end if;
    -- 接口额度超出本行资源计划的，批准即追加资源计划：追加后本行支出加资源占用不得超过核定数（#158）
    if r.kind = 'api' then
      select * into pl from project_budget_line where id = r.budget_line_id for update;
      select coalesce(sum(coalesce(q.approved_amount, q.amount)), 0) into taken from resource_request q
      where q.budget_line_id = r.budget_line_id and q.status in ('pending','reviewed','approved','fulfilled') and q.id <> p_id;
      if pl.resource_id is null or taken + p_amount > coalesce(pl.plan_qty, 0) then
        select coalesce(sum(amt), 0) into cash from v_line_use where line_id = r.budget_line_id;
        if cash + (taken + p_amount) * coalesce((select fx_rate from resource where id = r.resource_id), 1) > coalesce(pl.fixed, 0) then
          raise exception '拦截：该预算行核定 %，已支出 %，其他额度申请 %，批准 % 将超出核定数。可少批，或先调整核定数', coalesce(pl.fixed, 0), cash, taken, p_amount;
        end if;
        if pl.resource_id is not null and pl.resource_id <> r.resource_id then raise exception '该预算行计划的是另一种资源，不能追加'; end if;
        update project_budget_line set resource_id = coalesce(resource_id, r.resource_id), plan_qty = taken + p_amount where id = r.budget_line_id;
        n := concat_ws('；', n, format('资源计划由 %s 追加至 %s', coalesce(pl.plan_qty, 0), taken + p_amount));
      end if;
    end if;
    update resource_request set status = 'approved', approved_amount = p_amount, decided_by = app_uid(), decided_at = now(), decide_note = coalesce(n, decide_note), updated_at = now() where id = p_id;
    perform notify_user(r.requested_by, format('%s申请已批准，待财务岗分发：%s', what, r.purpose));
  elsif p_action = 'reject' then
    if not has_perm('resource.review', r.project_id) and not has_perm('resource.approve') then raise exception '仅研究单元负责人、财务岗和中心负责人可驳回'; end if;
    if r.status not in ('pending','reviewed','approved') then raise exception '该申请已处理完毕'; end if;
    if n is null then raise exception '请填写驳回原因'; end if;
    update resource_request set status = 'rejected', decided_by = app_uid(), decided_at = now(), decide_note = n, updated_at = now() where id = p_id;
    perform notify_user(r.requested_by, format('%s申请被驳回：%s。原因：%s', what, r.purpose, n));
  else
    raise exception '无效操作';
  end if;
end $$;

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
    r.fx_rate,
    r.fx_on
   FROM resource r
  WHERE has_perm('read.resource'::text);

create or replace view api.resource_stock as
SELECT s.id,
    s.resource_id,
    r.kind,
    r.name AS resource_name,
    r.unit,
    s.qty,
    s.unit_price,
    s.supplier,
    s.note,
    s.received_on,
    s.expense_request_id,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = s.created_by)) AS created_by_name,
    s.project_id,
    ( SELECT project.name
           FROM project
          WHERE (project.id = s.project_id)) AS project_name,
    ( SELECT project_budget_line.purpose
           FROM project_budget_line
          WHERE (project_budget_line.id = s.budget_line_id)) AS line_purpose,
    s.source
   FROM (resource_stock s
     JOIN resource r ON ((r.id = s.resource_id)))
  WHERE has_perm('read.resource'::text);
