-- 0186 API key 的分发和登记按权限办理：资源管理员（器械岗）也能办，财务岗和中心负责人照旧
--   章程第五十五条：器械岗维护中转平台的模型接口账户，按项目预算向各项目分发密钥并设置额度，项目结束后回收。
--   一、保存、更换、清除密钥（set_secret，resource、allocation、unit 三种）看 secret.manage；
--       登记期初库存和折算汇率（stock_opening、set_resource_fx）看 resource.manage，原来按 rbac_fn 对到 resource.approve，改为 resource.manage。
--       分配给个人、收回、回写用量、按申请分发（allocate_resource、return_allocation、set_allocation_info、fulfil_resource_request）
--       在 0022 已按 rbac_fn 对到 resource.grant，研究单元的 key 所在资源和库存（set_api_stock）已看 resource.manage，这里不动。
--       读取密钥（get_secret 看 secret.view）不放宽。
--   二、研究单元换了 API 额度、成员移出名单待换 key、项目收回接口额度要停用密钥，这几条提醒原来只发给财务岗，改为发给有 secret.manage 的人。

-- 财务岗和中心负责人本来就有这几项权限（0022）；授权管理里被去掉的，这里补上，保证原来能办的照样能办
insert into rbac_role_perm (role_id, perm)
select r.id, p from rbac_role r, unnest(array['secret.manage', 'resource.manage', 'resource.grant']) p
where r.code in ('finance', 'director')
on conflict do nothing;

-- 按权限点发提醒：基本角色或在有效期内的授权里有这项权限的人
create or replace function notify_perm(p_perm text, p_text text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform notify_user(u.id, p_text) from app_user u where u.active and user_perm(u.id, p_perm);
end $$;
revoke execute on function notify_perm(text, text) from public;

CREATE OR REPLACE FUNCTION public.set_secret(p_kind text, p_id uuid, p_cipher text, p_hint text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare un project; fresh boolean;
begin
  perform need_perm('secret.manage');
  if p_kind = 'resource' then
    if not exists (select 1 from resource where id = p_id) then raise exception '资源不存在'; end if;
  elsif p_kind = 'allocation' then
    if not exists (select 1 from resource_allocation where id = p_id and returned_on is null) then raise exception '分配记录不存在或已经收回'; end if;
  elsif p_kind = 'unit' then
    select * into un from project where id = p_id;
    if not found or un.layer <> 'paper' or not un.active or un.proposed then raise exception '研究单元不存在或未成立'; end if;
  else raise exception '无效对象';
  end if;
  if p_cipher is null or p_cipher = '' then
    delete from secret where owner_kind = p_kind and owner_id = p_id;
    return;
  end if;
  if p_cipher !~ '^v1\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$' then raise exception '密钥未经加密，拒绝保存'; end if;
  if length(p_hint) > 40 then raise exception '掩码过长'; end if;
  fresh := not exists (select 1 from secret where owner_kind = p_kind and owner_id = p_id);
  insert into secret (owner_kind, owner_id, cipher, hint, set_by) values (p_kind, p_id, p_cipher, p_hint, app_uid())
  on conflict (owner_kind, owner_id) do update set cipher = excluded.cipher, hint = excluded.hint, set_by = excluded.set_by, set_at = now();
  if p_kind = 'unit' then
    delete from unit_key_due where project_id = p_id;
    perform notify_user(x.u, format('研究单元「%s」的 API key %s，名单内成员在研究单元页「池子与成果 › 名义币」取用，每次取用均有记录', un.name, case when fresh then '已发放' else '已更换，旧 key 作废' end))
    from (select un.owner_id as u where un.owner_id is not null
          union select m.user_id from project_member m where m.project_id = p_id and m.left_on is null) x;
  end if;
end $function$;

create or replace function stock_opening(p_resource uuid, p_qty numeric, p_on date, p_unit text, p_fx numeric, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource; u text := nullif(btrim(coalesce(p_unit, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), ''); sid uuid; cny boolean;
begin
  perform need_perm('resource.manage');
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

create or replace function set_resource_fx(p_resource uuid, p_fx numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('resource.manage');
  if p_fx is null or p_fx <= 0 then raise exception '汇率须大于 0'; end if;
  update resource set fx_rate = p_fx, fx_on = app_today() where id = p_resource and kind = 'api' and unit not in ('元','CNY','人民币');
  if not found then raise exception '只有非人民币计价的接口资源需要汇率'; end if;
end $$;

-- 这三个函数不再经 need_role 查表
delete from rbac_fn where fn in ('set_secret', 'stock_opening', 'set_resource_fx');

-- 研究单元换了 API 额度：提醒有 secret.manage 的人计入这个研究单元的 key
CREATE OR REPLACE FUNCTION public.buy_api_quota(p_project uuid, p_coins numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if p_coins is null or p_coins <= 0 or p_coins <> round(p_coins, 2) then raise exception '换出的名义币须大于 0，最多两位小数'; end if;
  if unit_coin_balance(p_project) < p_coins then raise exception '研究单元的名义币不足：需要 %，账上 %', p_coins, unit_coin_balance(p_project); end if;
  fx := unit_key_fx(r);
  amt := round(p_coins * q.api_rate / fx, 2);
  if amt <= 0 then raise exception '换得的额度不足 0.01 %', r.unit; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  -- 本季度可换的 API 额度就是公布的总额对应的额度：财务岗本季度按总额直接充值（谢倩倩老师兜底），库存只做登记和对账（0175）
  cap := round(q.total / fx, 2);
  room := cap - used_q;
  if amt > room then
    raise exception '本季度全中心可换 API 额度 % %（总额 % 元折算），已换 %，剩余 %，最多还能用 % 名义币换；这次要换 %（换满即止）',
      cap, r.unit, q.total, used_q, greatest(room, 0), greatest(floor(room * fx / q.api_rate * 100) / 100, 0), amt;
  end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'api', -p_coins, app_uid(), format('换 %s %s API 额度', amt, r.unit));
  insert into api_grant (project_id, quota, coins, rate, q_start, bought_by, resource_id, fx_rate)
  values (p_project, amt, p_coins, q.api_rate, q.q_start, app_uid(), r.id, case when r.unit not in ('元', 'CNY', '人民币') then r.fx_rate end) returning api_grant.id into v_id;
  perform notify_perm('secret.manage', format('研究单元「%s」用名义币换了 %s %s API 额度（%s），请计入这个研究单元的 API key%s', p.name, amt, r.unit, r.name,
    case when exists (select 1 from secret where owner_kind = 'unit' and owner_id = p_project) then ''
         else '。这个研究单元还没有 key，请在「资产盘点 › 研究单元 API key」加密保存' end));
  return v_id;
end $function$;

-- 成员移出名单：研究单元已有 key 的，记为待换，并提醒有 secret.manage 的人换 key
create or replace function trg_unit_key_due() returns trigger language plpgsql security definer set search_path = public as $$
declare un project; who text;
begin
  if old.left_on is not null or new.left_on is null then return new; end if;
  if not exists (select 1 from secret where owner_kind = 'unit' and owner_id = new.project_id) then return new; end if;
  select * into un from project where id = new.project_id;
  if un.owner_id = new.user_id then return new; end if;
  select name into who from app_user where id = new.user_id;
  insert into unit_key_due (project_id, who) values (new.project_id, who)
  on conflict (project_id) do update set who = unit_key_due.who || '、' || excluded.who;
  perform notify_perm('secret.manage', format('研究单元「%s」的成员 %s 已移出名单，请更换这个研究单元的 API key：在服务商处作废旧 key，新 key 在「资产盘点 › 研究单元 API key」加密保存', un.name, who));
  return new;
end $$;

-- 研究单元负责人收回名下分出去的一项接口额度：提醒有 secret.manage 的人停用对应的密钥。
-- 这个函数的提示语经 0028、0033 等迁移整体改写过，这里在现行定义上只换发提醒的一句
do $$
declare d text := pg_get_functiondef('public.recall_project_allocation(uuid)'::regprocedure); n text;
begin
  n := replace(d, $a$perform notify_role('finance', format($a$, $b$perform notify_perm('secret.manage', format($b$);
  if n = d then raise exception 'recall_project_allocation 里找不到发给财务岗的提醒'; end if;
  execute n;
end $$;
