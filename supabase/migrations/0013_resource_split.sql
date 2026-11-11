-- 资源使用权（API 配额、资产领用）、多卡分摊、账号合并。

-- ---------- 资源使用权 ----------
-- 这里只记谁在用、用多少。密钥本身放在保管库里，这张表只存编号或掩码，函数会拒绝看起来像密钥的内容。
create table resource (
  id      uuid primary key default gen_random_uuid(),
  kind    text not null check (kind in ('api','asset')),
  name    text not null,
  ref     text,                     -- 保管库里的编号、掩码或资产编码
  total   numeric(14,2),            -- API：可分配的总配额；资产不填
  unit    text,
  note    text,
  active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, name)
);
create table resource_allocation (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resource,
  user_id     uuid not null references app_user,
  quota       numeric(14,2),
  from_date   date not null,
  to_date     date,
  note        text,
  returned_on date,
  created_by  uuid references app_user,
  created_at  timestamptz not null default now()
);
create index on resource_allocation (resource_id);
create index on resource_allocation (user_id);
select seal('resource', 'resource_allocation');
create trigger audit after insert or update or delete on resource for each row execute function trg_audit();
create trigger audit after insert or update or delete on resource_allocation for each row execute function trg_audit();

create function save_resource(p_id uuid, p_kind text, p_name text, p_ref text default null, p_total numeric default null,
                              p_unit text default null, p_note text default null, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); rf text := nullif(btrim(coalesce(p_ref, '')), '');
  un text := nullif(btrim(coalesce(p_unit, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), ''); rid uuid;
begin
  perform need_role('finance','director');
  if p_kind is null or p_kind not in ('api','asset') then raise exception '类型只能是接口配额或资产'; end if;
  if n = '' then raise exception '请填写名称'; end if;
  if length(n) > 60 then raise exception '名称不能超过 60 个字'; end if;
  if length(un) > 10 then raise exception '单位不能超过 10 个字'; end if;
  if length(nt) > 300 then raise exception '备注不能超过 300 个字'; end if;
  if length(rf) > 40 or rf ~ '[A-Za-z0-9_\-]{24,}' or rf ~* '^(sk-|ak-|akia|ghp_|xox|bearer )[A-Za-z0-9_\-]{8,}' then
    raise exception '编号一栏只填保管库里的编号或掩码（例如 sk-…a3f9），不要填密钥本身';
  end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '备注里不要填密钥'; end if;
  if p_total is not null and p_total <= 0 then raise exception '总配额必须大于 0'; end if;
  if exists (select 1 from resource where kind = p_kind and name = n and id is distinct from p_id) then
    raise exception '已经有叫「%」的资源', n;
  end if;
  if p_id is null then
    insert into resource (kind, name, ref, total, unit, note, active)
    values (p_kind, n, rf, case when p_kind = 'api' then p_total end, un, nt, coalesce(p_active, true)) returning id into rid;
  else
    update resource set name = n, ref = rf, total = case when kind = 'api' then p_total end, unit = un, note = nt, active = coalesce(p_active, true)
    where id = p_id returning id into rid;
    if rid is null then raise exception '资源不存在'; end if;
    if p_total is not null and p_total < (select coalesce(sum(quota), 0) from resource_allocation a
        where a.resource_id = rid and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) then
      raise exception '总配额不能低于已经分出去的配额';
    end if;
  end if;
  return rid;
end $$;

create function allocate_resource(p_resource uuid, p_user uuid, p_quota numeric default null, p_from date default null,
                                  p_to date default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource; f date := coalesce(p_from, app_today()); out_ numeric; aid uuid; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director');
  select * into r from resource where id = p_resource for update;
  if not found then raise exception '资源不存在'; end if;
  if not r.active then raise exception '「%」已停用，不能再分配', r.name; end if;
  if not exists (select 1 from app_user where id = p_user and active) then raise exception '使用人不存在或已停用'; end if;
  if p_to is not null and p_to < f then raise exception '到期日不能早于起始日'; end if;
  if length(nt) > 200 then raise exception '备注不能超过 200 个字'; end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '备注里不要填密钥'; end if;
  if r.kind = 'asset' then
    if exists (select 1 from resource_allocation where resource_id = p_resource and returned_on is null) then
      raise exception '「%」还在别人名下，先登记归还', r.name;
    end if;
    p_quota := null;
  else
    if p_quota is not null and p_quota <= 0 then raise exception '配额必须大于 0'; end if;
    if r.total is not null then
      if p_quota is null then raise exception '「%」设了总配额，分配时要填配额', r.name; end if;
      select coalesce(sum(quota), 0) into out_ from resource_allocation
        where resource_id = p_resource and returned_on is null and (to_date is null or to_date >= app_today());
      if out_ + p_quota > r.total then raise exception '「%」剩余配额 %，不足 %', r.name, r.total - out_, p_quota; end if;
    end if;
  end if;
  insert into resource_allocation (resource_id, user_id, quota, from_date, to_date, note, created_by)
  values (p_resource, p_user, p_quota, f, p_to, nt, app_uid()) returning id into aid;
  return aid;
end $$;

-- 归还资产，或收回接口配额
create function return_allocation(p_id uuid, p_on date default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  update resource_allocation set returned_on = coalesce(p_on, app_today()) where id = p_id and returned_on is null;
  if not found then raise exception '这条分配不存在或已经收回'; end if;
end $$;

create view api.resource as
  select r.id, r.kind, r.name, r.ref, r.total, r.unit, r.note, r.active,
         coalesce((select sum(a.quota) from resource_allocation a
                   where a.resource_id = r.id and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())), 0) as allocated,
         (select count(*) from resource_allocation a
          where a.resource_id = r.id and a.returned_on is null and (a.to_date is null or a.to_date >= app_today()))::int as holders
  from resource r where is_staff();

-- 财务岗、中心负责人看全部；其他人只看分给自己的
create view api.allocation as
  select a.id, a.resource_id, r.kind, r.name as resource_name, r.ref, r.unit, a.user_id, u.name as user_name,
         a.quota, a.from_date, a.to_date, a.note, a.returned_on,
         (a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) as current
  from resource_allocation a join resource r on r.id = a.resource_id join app_user u on u.id = a.user_id
  where is_staff() or a.user_id = app_uid();

-- ---------- 多卡分摊 ----------
-- 一笔支出由几张卡（或几个科目）分担：拆成几笔申请，各自占各自卡的预算、各自审批和入账，用 split_group 串起来。
-- 采购只跟踪一次，记在第一笔上；整组要等采购验收后才能提交学校。
alter table expense_request add column split_group uuid;
create index on expense_request (split_group) where split_group is not null;

-- p_parts: [{"card_id": "...", "subject_id": "...", "amount": 30000}, ...]
create function submit_split(p_type uuid, p_title text, p_eta date, p_path text, p_parts jsonb, p_quota uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid := gen_random_uuid(); e jsonb; n int; i int := 0; rid uuid; total numeric;
begin
  perform need_role('finance','director','leader','member');
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) < 2 then raise exception '分摊至少要两张卡或两个科目'; end if;
  n := jsonb_array_length(p_parts);
  if n > 6 then raise exception '一笔支出最多分摊到 6 处'; end if;
  if exists (select 1 from jsonb_array_elements(p_parts) x
             where (x->>'card_id') is null or (x->>'subject_id') is null or (x->>'amount') is null or (x->>'amount')::numeric <= 0) then
    raise exception '每一处都要选经费卡、科目并填金额';
  end if;
  if (select count(*) <> count(distinct (x->>'card_id', x->>'subject_id')) from jsonb_array_elements(p_parts) x) then
    raise exception '同一张卡的同一个科目填了两次';
  end if;
  select sum((x->>'amount')::numeric) into total from jsonb_array_elements(p_parts) x;
  if p_path = '直采' and total > 50000 then raise exception '拦截：直采单件上限 5 万（分摊按合计算），请走分散采购'; end if;
  -- 按固定顺序先锁卡，避免两笔分摊互相等
  perform lock_card(s.cid) from (select distinct (x->>'card_id')::uuid as cid from jsonb_array_elements(p_parts) x order by 1) s;
  for e in select * from jsonb_array_elements(p_parts) loop
    i := i + 1;
    rid := submit_request((e->>'card_id')::uuid, (e->>'subject_id')::uuid, p_type,
                          btrim(coalesce(p_title, '')) || format('（分摊 %s/%s）', i, n), (e->>'amount')::numeric, p_eta, false, p_path);
    if i > 1 then delete from procurement where request_id = rid; end if;
    update expense_request set split_group = g where id = rid;
    if p_quota is not null then perform attach_quota(rid, p_quota); end if;
  end loop;
  return g;
end $$;

create or replace function send_to_school(p_req uuid) returns void language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  perform need_role('finance');
  select split_group into g from expense_request where id = p_req;
  if exists (select 1 from procurement p join expense_request r on r.id = p.request_id
             where (r.id = p_req or r.split_group = g) and p.stage < p.stages) then
    raise exception '采购未验收贴码，不能提交学校';
  end if;
  update expense_request set status = 'at_school', updated_at = now() where id = p_req and status in ('committed','returned');
  if not found then raise exception '该申请不能提交学校'; end if;
  perform log_event(p_req, 'to_school');
end $$;

-- 废标或流标：退回挂网阶段，预计入账顺延；分摊的几笔一起顺延
create or replace function procurement_fail(p_req uuid, p_kind text, p_reason text, p_delay_days int default 30) returns date
language plpgsql security definer set search_path = public as $$
declare d date; g uuid;
begin
  perform need_role('finance');
  if p_kind not in ('废标','流标') then raise exception '类型只能是废标或流标'; end if;
  if p_delay_days is null or p_delay_days < 0 or p_delay_days > 365 then raise exception '顺延天数要在 0 到 365 之间'; end if;
  update procurement set stage = case when path = '分散采购' then 2 else 0 end where request_id = p_req;
  if not found then raise exception '采购不存在'; end if;
  update expense_request set eta_date = eta_date + p_delay_days, updated_at = now() where id = p_req returning eta_date, split_group into d, g;
  if g is not null then
    update expense_request set eta_date = eta_date + p_delay_days, updated_at = now()
    where split_group = g and id <> p_req and status in ('pending','committed','returned');
  end if;
  insert into procurement_event (request_id, at, kind, note) values (p_req, app_today(), p_kind, p_reason);
  return d;
end $$;

create or replace view api.request as
  select r.id, r.code, r.card_id, r.subject_id, r.expense_type_id, r.title, r.amount, r.eta_date, r.emergency,
         r.status, r.requested_by, r.approved_by, r.created_at, r.updated_at,
         p.path, p.stage, p.stages, v.posted_on, v.amount as posted_amount, v.voucher_no,
         r.morningstar_quota_id, r.split_group
  from expense_request r
  left join procurement p on p.request_id = r.id
  left join voucher v on v.request_id = r.id
  where r.requested_by = app_uid() or can_see_card(r.card_id)
     or exists (select 1 from morningstar_quota q where q.id = r.morningstar_quota_id and q.leader_id = app_uid());

-- ---------- 账号合并 ----------
-- 同一个人有两个账号时（例如旧门户迁来一个、飞书登录又建了一个），把 p_from 的全部记录并到 p_into，并停用 p_from。
create function merge_user(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a app_user; b app_user;
begin
  perform need_role('director');
  if p_from is null or p_into is null or p_from = p_into then raise exception '请选择两个不同的账号'; end if;
  if p_from = app_uid() then raise exception '不能把自己正在用的账号并掉，请反过来合并'; end if;
  select * into a from app_user where id = p_from for update;
  if not found then raise exception '被合并的账号不存在'; end if;
  select * into b from app_user where id = p_into for update;
  if not found then raise exception '保留的账号不存在'; end if;
  if a.feishu_open_id is not null and b.feishu_open_id is not null then
    raise exception '两个账号都绑定了飞书，说明是两个飞书身份，不能合并';
  end if;
  if exists (select 1 from morningstar_quota x join morningstar_quota y on y.year = x.year
             where x.leader_id = p_from and y.leader_id = p_into) then
    raise exception '两个账号同一年都有晨星额度，先处理额度再合并';
  end if;
  update fund_card set owner_id = p_into where owner_id = p_from;
  update budget_change set requested_by = p_into where requested_by = p_from;
  update budget_change set confirmed_by = p_into where confirmed_by = p_from;
  update expense_request set requested_by = p_into where requested_by = p_from;
  update expense_request set approved_by = p_into where approved_by = p_from;
  update request_event set actor = p_into where actor = p_from;
  update person set user_id = p_into where user_id = p_from;
  update card_settlement set confirmed_by = p_into where confirmed_by = p_from;
  update morningstar_quota set leader_id = p_into where leader_id = p_from;
  update feishu_outbox set user_id = p_into where user_id = p_from;
  update resource_allocation set user_id = p_into where user_id = p_from;
  update resource_allocation set created_by = p_into where created_by = p_from;
  update app_user set feishu_open_id = null, email = null, legacy_serial = null, active = false, updated_at = now() where id = p_from;
  update app_user set feishu_open_id = coalesce(b.feishu_open_id, a.feishu_open_id), email = coalesce(b.email, a.email),
         legacy_serial = coalesce(b.legacy_serial, a.legacy_serial), updated_at = now() where id = p_into;
end $$;

grant select on api.resource, api.allocation to app_api;
select expose('save_resource(uuid, text, text, text, numeric, text, text, boolean)',
              'allocate_resource(uuid, uuid, numeric, date, date, text)', 'return_allocation(uuid, date)',
              'submit_split(uuid, text, date, text, jsonb, uuid)', 'merge_user(uuid, uuid)');
