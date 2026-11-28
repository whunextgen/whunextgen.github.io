-- 实际币兑换 API key（黄济民 2026-11-28 定的执行细则：API 额度和 GPU 卡时一律用实际币兑换；课题不直接兑换资源）
--   一、换：研究单元负责人用单元账上的实际币，按本季度公布的比例（coin_quarter.api_rate，1 实际币兑多少元 API 额度）
--       换 API 额度，从单元的实际币账上扣（unit_coin，kind = api），记在研究单元名下（api_grant）。本季度比例未公布的不能换。
--   二、季度上限：每季度全中心换出的 API 额度，不超过当季公布的充值额（coin_quarter.total）加上现有库存（coin_quarter.api_stock，
--       由财务岗在「资产盘点」登记，没登记的按 0 算），超出即止。
--   三、key 发到研究单元，不发到个人（和 GPU 每个研究单元一个 QOS、名单内共用一致）：换得的额度计入这个研究单元的 key，
--       财务岗把 key 加密保存（secret，owner_kind = unit）；名单内成员和负责人在研究单元页取用，每次取用留记录（secret_access）。
--   四、成员移出名单时，正则提醒财务岗换 key（旧 key 作废、新 key 加密保存），换好之前标注「待换 key」。
--   GPU 卡时仍由研究单元用 buy_compute 换，标价跟着季度公布走（0164）。

alter table unit_coin drop constraint unit_coin_kind_check;
alter table unit_coin add constraint unit_coin_kind_check check (kind in ('invest','compute','budget','api'));

-- 现有库存：本季度换 API 额度时，充值额之外还能动用的 API 额度（元）
alter table coin_quarter add column api_stock numeric(14,2) check (api_stock is null or api_stock >= 0);

create table api_grant (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references project,
  quota      numeric(14,2) not null check (quota > 0),          -- 换得的 API 额度（元），计入研究单元的 key
  coins      numeric(14,2) not null check (coins > 0),          -- 用去的实际币
  rate       numeric(12,4) not null,                            -- 当时的比例：1 实际币兑多少元
  q_start    date not null references coin_quarter,
  bought_by  uuid not null references app_user,
  bought_at  timestamptz not null default now()
);
create index on api_grant (project_id);
create index on api_grant (q_start);

-- 待换 key：名单内有人移出、key 还没换的研究单元
create table unit_key_due (
  project_id uuid primary key references project,
  since      timestamptz not null default now(),
  who        text not null                                      -- 移出名单的人
);
select seal('api_grant', 'unit_key_due');
create trigger audit after insert or update or delete on api_grant for each row execute function trg_audit();

-- 研究单元的 key 也存进 secret：owner_kind = unit，owner_id 是研究单元
alter table secret drop constraint secret_owner_kind_check;
alter table secret add constraint secret_owner_kind_check check (owner_kind in ('resource','allocation','unit'));

-- 名单内：负责人，或者名单上还没移出的成员
create function on_unit_roster(p_project uuid, p_user uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from project p where p.id = p_project and p.owner_id = p_user)
      or exists (select 1 from project_member m where m.project_id = p_project and m.user_id = p_user and m.left_on is null)
$$;

-- 研究单元换 API 额度：由负责人办理，按本季度公布的比例从研究单元的账上扣；全中心本季度换满即止
create function buy_api_quota(p_project uuid, p_coins numeric) returns uuid language plpgsql security definer set search_path = public as $$
declare q coin_quarter; p project; amt numeric; used_q numeric; room numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = date_trunc('quarter', app_today())::date for update;
  if not found then raise exception '本季度的兑换比例尚未公布，请等财务岗公布'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception 'API 额度由研究单元换'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  if p_coins is null or p_coins <= 0 or p_coins <> round(p_coins, 2) then raise exception '换出的实际币须大于 0，最多两位小数'; end if;
  if unit_coin_balance(p_project) < p_coins then raise exception '研究单元的实际币不足：需要 %，账上 %', p_coins, unit_coin_balance(p_project); end if;
  amt := round(p_coins * q.api_rate, 2);
  if amt <= 0 then raise exception '换得的额度不足 0.01 元'; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  room := q.total + coalesce(q.api_stock, 0) - used_q;
  if amt > room then
    raise exception '本季度全中心可换 API 额度 % 元（充值额 % 加库存 %），已换 %，剩余 %，最多还能用 % 实际币换；这次要换 %（换满即止）',
      q.total + coalesce(q.api_stock, 0), q.total, coalesce(q.api_stock, 0), used_q, greatest(room, 0), greatest(floor(room / q.api_rate * 100) / 100, 0), amt;
  end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'api', -p_coins, app_uid(), format('换 %s 元 API 额度', amt));
  insert into api_grant (project_id, quota, coins, rate, q_start, bought_by) values (p_project, amt, p_coins, q.api_rate, q.q_start, app_uid()) returning api_grant.id into v_id;
  perform notify_role('finance', format('研究单元「%s」用实际币换了 %s 元 API 额度，请计入这个研究单元的 API key%s', p.name, amt,
    case when exists (select 1 from secret where owner_kind = 'unit' and owner_id = p_project) then ''
         else '。这个研究单元还没有 key，请在「资产盘点 › 研究单元 API key」加密保存' end));
  return v_id;
end $$;

-- 财务岗登记本季度的 API 库存
create function set_api_stock(p_stock numeric) returns void language plpgsql security definer set search_path = public as $$
declare q coin_quarter; used_q numeric;
begin
  perform need_perm('resource.manage');
  select * into q from coin_quarter where q_start = date_trunc('quarter', app_today())::date for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，公布后再登记库存'; end if;
  if p_stock is null or p_stock < 0 then raise exception '库存不能为负'; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  if q.total + p_stock < used_q then raise exception '本季度已换出 % 元 API 额度，充值额 % 加库存不能低于该数', used_q, q.total; end if;
  update coin_quarter set api_stock = p_stock where q_start = q.q_start;
end $$;

select expose('buy_api_quota(uuid, numeric)', 'set_api_stock(numeric)');

-- 研究单元的 key：财务岗保存和更换，保存后通知名单内成员
CREATE OR REPLACE FUNCTION public.set_secret(p_kind text, p_id uuid, p_cipher text, p_hint text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare un project; fresh boolean;
begin
  perform need_role('finance','director');
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
    perform notify_user(x.u, format('研究单元「%s」的 API key %s，名单内成员在研究单元页「池子与成果 › 实际币」取用，每次取用均有记录', un.name, case when fresh then '已发放' else '已更换，旧 key 作废' end))
    from (select un.owner_id as u where un.owner_id is not null
          union select m.user_id from project_member m where m.project_id = p_id and m.left_on is null) x;
  end if;
end $$;

-- 取用：研究单元的 key 名单内成员（含负责人）可取，研究单元停用后不能再取
CREATE OR REPLACE FUNCTION public.get_secret(p_kind text, p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare c text;
begin
  perform need_role('finance','director','leader','member');
  if not has_perm('secret.view') then
    if p_kind = 'unit' then
      if not (on_unit_roster(p_id, app_uid()) and exists (select 1 from project where id = p_id and layer = 'paper' and active and not proposed)) then
        raise exception '研究单元的 API key 仅名单内成员可取用' using errcode = '42501';
      end if;
    elsif p_kind <> 'allocation' or not exists (select 1 from resource_allocation a where a.id = p_id and a.user_id = app_uid()
        and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) then
      raise exception '仅可查看分配至本人名下且在有效期内的密钥' using errcode = '42501';
    end if;
  end if;
  select cipher into c from secret where owner_kind = p_kind and owner_id = p_id;
  if c is null then raise exception '尚未保存密钥'; end if;
  insert into secret_access (owner_kind, owner_id, user_id) values (p_kind, p_id, app_uid());
  return c;
end $$;

-- 成员移出名单：研究单元已有 key 的，记为待换，并提醒财务岗换 key
create function trg_unit_key_due() returns trigger language plpgsql security definer set search_path = public as $$
declare un project; who text;
begin
  if old.left_on is not null or new.left_on is null then return new; end if;
  if not exists (select 1 from secret where owner_kind = 'unit' and owner_id = new.project_id) then return new; end if;
  select * into un from project where id = new.project_id;
  if un.owner_id = new.user_id then return new; end if;
  select name into who from app_user where id = new.user_id;
  insert into unit_key_due (project_id, who) values (new.project_id, who)
  on conflict (project_id) do update set who = unit_key_due.who || '、' || excluded.who;
  perform notify_role('finance', format('研究单元「%s」的成员 %s 已移出名单，请更换这个研究单元的 API key：在服务商处作废旧 key，新 key 在「资产盘点 › 研究单元 API key」加密保存', un.name, who));
  return new;
end $$;
create trigger unit_key_due after update of left_on on project_member for each row execute function trg_unit_key_due();

-- 本季度换 API 额度的上限和剩余：所有登录的人可见
create view api.api_quarter as
  select q.q_start, q.total, q.api_rate, q.api_stock, coalesce(g.bought, 0) as bought,
         q.total + coalesce(q.api_stock, 0) - coalesce(g.bought, 0) as room
  from coin_quarter q left join lateral (select sum(quota) as bought from api_grant where q_start = q.q_start) g on true
  where q.q_start = date_trunc('quarter', app_today())::date and app_role() is not null;

-- 研究单元换得的 API 额度：全中心看得到，与换得的卡时一样
create view api.api_grant as
  select g.id, g.project_id, p.code as project_code, p.name as project_name, g.quota, g.coins, g.rate, g.q_start,
         (select name from app_user where id = g.bought_by) as bought_by_name, g.bought_at
  from api_grant g join project p on p.id = g.project_id where app_role() is not null;

-- 研究单元的 key：财务岗看全部；名单内成员看本单元的
create view api.unit_api_key as
  select p.id as project_id, p.code as project_code, p.name as project_name, (select name from app_user where id = p.owner_id) as owner_name,
         coalesce((select sum(g.quota) from api_grant g where g.project_id = p.id), 0) as api_quota,
         (select max(g.bought_at) from api_grant g where g.project_id = p.id) as last_bought_at,
         s.owner_id is not null as has_key, s.hint as key_hint, s.set_at as key_set_at,
         d.since as rotate_since, d.who as rotate_who,
         (has_perm('secret.view') or on_unit_roster(p.id, app_uid())) as can_get
  from project p
  left join secret s on s.owner_kind = 'unit' and s.owner_id = p.id
  left join unit_key_due d on d.project_id = p.id
  where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null
    and (s.owner_id is not null or exists (select 1 from api_grant g where g.project_id = p.id))
    and (has_perm('read.resource') or on_unit_roster(p.id, app_uid()));

-- 研究单元 key 的取用记录：负责人看本单元的，审计看全部
create view api.unit_key_access as
  select x.id, x.owner_id as project_id, x.at, u.name as user_name
  from secret_access x join project p on p.id = x.owner_id left join app_user u on u.id = x.user_id
  where x.owner_kind = 'unit' and (has_perm('secret.audit') or p.owner_id = app_uid());

-- 密钥取用记录：研究单元的 key 在「密钥归属」里写研究单元
create or replace view api.secret_access as
  select x.id, x.owner_kind, x.owner_id, x.at, u.name as user_name,
         coalesce(r.name, r2.name, case when x.owner_kind = 'unit' then '研究单元 API key' end) as resource_name, coalesce(hu.name, un.name) as holder_name
  from secret_access x left join app_user u on u.id = x.user_id
  left join resource r on x.owner_kind = 'resource' and r.id = x.owner_id
  left join resource_allocation a on x.owner_kind = 'allocation' and a.id = x.owner_id
  left join resource r2 on r2.id = a.resource_id left join app_user hu on hu.id = a.user_id
  left join project un on x.owner_kind = 'unit' and un.id = x.owner_id
  where has_perm('secret.audit');

grant select on api.api_quarter, api.api_grant, api.unit_api_key, api.unit_key_access to app_api;

-- 研究单元的实际币账：加上换得的 API 额度
create or replace view api.unit_coin_balance as
  select p.id as project_id, unit_coin_balance(p.id) as balance,
         coalesce((select sum(hours) from compute_grant g where g.project_id = p.id), 0) as hours,
         (p.owner_id = app_uid() or app_role() = 'director') as can_buy,
         coalesce((select sum(quota) from api_grant g where g.project_id = p.id), 0) as api_quota
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;
