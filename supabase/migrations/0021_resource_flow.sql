-- 把旧门户里还没有搬过来的功能补齐，按新框架重做：
--   资源申请：成员申请接口额度、申领资产 → 项目负责人批示 → 财务岗批准 → 分发，分发后就是一条使用权记录
--   资源池与库存：服务商、模型、币种、余额；资产的类别、规格、单价、配置包、存放地；入库（充值）记录
--   密钥与账号：进系统，但只存接口层加密后的密文；只有财务岗、中心负责人和使用人本人能取，每次取用都留记录
--   用量：财务岗回写每条接口额度的已用量
--   备用金：领用申请 → 中心负责人批准 → 财务岗核销
--   经费卡属性：经费性质、已到账金额、下达优先级
--   补登支出：学校已经入账、系统里没有申请的支出，财务岗一步补登
-- 资源和备用金都从年度预算里出：
--   申报时在预算行上写明要哪种资源、多少（资源计划）；资源申请只能挂在有资源计划的预算行上，累计不能超过计划；
--   入库和充值必须对应一笔已批准的支出申请；备用金申请时选预算行，核销时对应到这一行上的支出申请

-- ---------- 资源池与库存的属性 ----------
-- 身份：博士后 / 博士 / 硕士 / 研究助理 / 研究实习生 / 访问学生。只是人员信息，不决定权限
alter table app_user add column kind text check (kind in ('postdoc','phd','master','ra','ri','visitor'));

alter table resource
  add column provider text, add column model text, add column currency text,
  add column balance numeric(14,2), add column balance_on date,
  add column category text, add column spec text, add column unit_price numeric(14,2),
  add column bundle text, add column location text;

alter table resource_allocation
  add column used numeric(14,2) check (used is null or used >= 0), add column used_on date,
  add column asset_no text, add column location text, add column request_id uuid;

-- p_info 里出现的键才改：provider model currency balance balance_on category spec unit_price bundle location
create function set_resource_info(p_id uuid, p_info jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v text;
begin
  perform need_role('finance','director');
  if not exists (select 1 from resource where id = p_id) then raise exception '资源不存在'; end if;
  if p_info is null or jsonb_typeof(p_info) <> 'object' then raise exception '没有要改的内容'; end if;
  for k, v in select key, nullif(btrim(value), '') from jsonb_each_text(p_info) loop
    if k not in ('provider','model','currency','balance','balance_on','category','spec','unit_price','bundle','location') then
      raise exception '不认识的属性：%', k;
    end if;
    if length(v) > 120 then raise exception '每一项不能超过 120 个字'; end if;
    if v ~ '[A-Za-z0-9_\-]{32,}' then raise exception '属性里不要填密钥，密钥单独保存'; end if;
    if k in ('balance','unit_price') and v is not null and (v !~ '^-?\d+(\.\d+)?$' or v::numeric < 0) then raise exception '金额要填不小于 0 的数字'; end if;
    if k = 'balance_on' and v is not null and v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '日期格式不对'; end if;
    if k in ('balance','unit_price') then execute format('update resource set %I = $1::numeric where id = $2', k) using v, p_id;
    elsif k = 'balance_on' then update resource set balance_on = v::date where id = p_id;
    else execute format('update resource set %I = $1 where id = $2', k) using v, p_id;
    end if;
  end loop;
  if p_info ? 'balance' and not p_info ? 'balance_on' then update resource set balance_on = app_today() where id = p_id; end if;
end $$;

-- 入库：资产验收入库加库存；接口充值加总配额和余额
create table resource_stock (
  id          uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resource,
  qty         numeric(14,2) not null check (qty > 0),
  unit_price  numeric(14,2) check (unit_price is null or unit_price >= 0),
  supplier    text,
  note        text,
  expense_request_id uuid not null references expense_request,   -- 采购这批资源的那笔支出
  received_on date not null,
  created_by  uuid references app_user,
  created_at  timestamptz not null default now()
);
create index on resource_stock (resource_id);

create function stock_in(p_resource uuid, p_qty numeric, p_unit_price numeric default null, p_on date default null,
                         p_supplier text default null, p_note text default null, p_request uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource; sid uuid; sp text := nullif(btrim(coalesce(p_supplier, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director');
  select * into r from resource where id = p_resource for update;
  if not found then raise exception '资源不存在'; end if;
  if p_qty is null or p_qty <= 0 then raise exception '数量要大于 0'; end if;
  if r.kind = 'asset' then
    if r.total is null then raise exception '「%」是单件资产，不记库存。成批管理的资产先填上库存数量', r.name; end if;
    if p_qty <> trunc(p_qty) then raise exception '资产数量要填整数'; end if;
  end if;
  if length(sp) > 60 or length(nt) > 200 then raise exception '供应商不超过 60 个字，备注不超过 200 个字'; end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '备注里不要填密钥'; end if;
  if p_request is null then raise exception '入库和充值都要对应一笔已批准的支出申请：采购先走预算，再来入库'; end if;
  if not exists (select 1 from expense_request where id = p_request and status in ('committed','at_school','posted')) then raise exception '对应的支出申请不存在，或者还没有批准'; end if;
  insert into resource_stock (resource_id, qty, unit_price, supplier, note, expense_request_id, received_on, created_by)
  values (p_resource, p_qty, p_unit_price, sp, nt, p_request, coalesce(p_on, app_today()), app_uid()) returning id into sid;
  update resource set total = coalesce(total, 0) + p_qty,
         unit_price = coalesce(p_unit_price, unit_price),
         balance = case when kind = 'api' then coalesce(balance, 0) + p_qty else balance end,
         balance_on = case when kind = 'api' then coalesce(p_on, app_today()) else balance_on end
  where id = p_resource;
  return sid;
end $$;

-- 使用权记录的补充信息：接口额度的已用量；资产的编号和存放地
create function set_allocation_info(p_id uuid, p_used numeric default null, p_used_on date default null,
                                    p_asset_no text default null, p_location text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a resource_allocation; k text; no_ text := nullif(btrim(coalesce(p_asset_no, '')), ''); loc text := nullif(btrim(coalesce(p_location, '')), '');
begin
  perform need_role('finance','director');
  select * into a from resource_allocation where id = p_id for update;
  if not found then raise exception '分配记录不存在'; end if;
  select kind into k from resource where id = a.resource_id;
  if k = 'api' then
    if p_used is null or p_used < 0 then raise exception '已用量要填不小于 0 的数字'; end if;
    if a.quota is not null and p_used > a.quota then raise exception '已用量 % 超过了分给他的额度 %', p_used, a.quota; end if;
    update resource_allocation set used = p_used, used_on = coalesce(p_used_on, app_today()) where id = p_id;
  else
    if length(no_) > 40 or length(loc) > 60 then raise exception '资产编号不超过 40 个字，存放地不超过 60 个字'; end if;
    update resource_allocation set asset_no = no_, location = loc where id = p_id;
  end if;
end $$;

-- ---------- 资源进预算 ----------
alter table project_budget_line
  add column resource_id uuid references resource,
  add column plan_qty numeric(14,2) check (plan_qty is null or plan_qty > 0),
  add constraint project_budget_line_plan_check check ((resource_id is null) = (plan_qty is null));

-- 执行阶段用预算行之前的统一检查：当年、已下达、有核定数、项目在用
create function open_line(p_line uuid) returns v_line language plpgsql as $$
declare l v_line; st text;
begin
  if p_line is null then raise exception '请选择预算行：资源和备用金都从年度预算里出'; end if;
  perform 1 from project_budget_line where id = p_line for update;
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在，或者所在项目的预算还没有提交'; end if;
  select stage into st from budget_year where year = l.year;
  if st = 'closed' then raise exception '拦截：% 年度已经决算', l.year; end if;
  if st <> 'issued' then raise exception '拦截：% 年度预算还没有下达，下达后才能申请', l.year; end if;
  if l.year <> extract(year from app_today()) then raise exception '拦截：这是 % 年的预算，只能在当年使用', l.year; end if;
  if coalesce(l.fixed, 0) <= 0 then raise exception '拦截：这一行预算没有核定数'; end if;
  if not exists (select 1 from project where id = l.project_id and active) then raise exception '拦截：项目已经停用'; end if;
  return l;
end $$;

-- 预算行上的资源计划：要哪种资源、多少。申报时项目负责人填；之后只有财务岗和中心负责人能调，不能低于已经申请的量
create function set_line_resource(p_line uuid, p_resource uuid, p_qty numeric) returns void
language plpgsql security definer set search_path = public as $$
declare pid uuid; yr int; bst text; st text; r resource; taken numeric;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select b.project_id, b.year, b.status into pid, yr, bst from project_budget_line l join project_budget b on b.id = l.budget_id where l.id = p_line for update of l;
  if not found then raise exception '这一行不存在'; end if;
  if not can_edit_project(pid) then raise exception '只有项目负责人和财务岗能填这个项目的预算' using errcode = '42501'; end if;
  select stage into st from budget_year where year = yr;
  if st = 'closed' then raise exception '% 年度已经决算，不能再改', yr; end if;
  if not is_staff() and (st <> 'declare' or bst = 'submitted') then raise exception '预算提交以后，资源计划由财务岗在复盘时调整'; end if;
  select coalesce(sum(coalesce(q.approved_amount, q.amount)), 0) into taken from resource_request q
  where q.budget_line_id = p_line and q.status in ('pending','reviewed','approved','fulfilled');
  if p_resource is null then
    if taken > 0 then raise exception '这一行上已经有资源申请，不能去掉资源计划'; end if;
    update project_budget_line set resource_id = null, plan_qty = null where id = p_line;
    return;
  end if;
  select * into r from resource where id = p_resource;
  if not found or not r.active then raise exception '资源不存在或已停用'; end if;
  if p_qty is null or p_qty <= 0 then raise exception '计划数量要大于 0'; end if;
  if r.kind <> 'asset' and (select kind from project where id = pid) = 'public' then
    raise exception '拦截：中心公共开支只统一配设备。接口额度这类资源写进各项目自己的预算';
  end if;
  if r.kind = 'asset' and p_qty <> trunc(p_qty) then raise exception '资产数量要填整数'; end if;
  if taken > 0 and p_resource <> (select resource_id from project_budget_line where id = p_line) then raise exception '这一行上已经有资源申请，不能换成别的资源'; end if;
  if p_qty < taken then raise exception '计划数量不能低于已经申请的 %', taken; end if;
  update project_budget_line set resource_id = p_resource, plan_qty = p_qty where id = p_line;
end $$;

-- ---------- 资源申请 ----------
create table resource_request (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('api','asset')),
  resource_id   uuid references resource,          -- 预算行资源计划里的那个资源；分发时财务岗可以换成同类的另一个
  project_id    uuid not null references project,
  budget_line_id uuid not null references project_budget_line,   -- 挂在哪一行预算的资源计划上
  requested_by  uuid not null references app_user,
  amount        numeric(14,2) not null check (amount > 0),   -- 接口：额度；资产：件数
  period        date,                               -- 接口额度用在哪个月
  purpose       text not null,
  usage_note    text,
  urgent        boolean not null default false,
  status        text not null default 'pending' check (status in ('pending','reviewed','approved','fulfilled','rejected','withdrawn')),
  reviewed_by   uuid references app_user,
  reviewed_at   timestamptz,
  approved_amount numeric(14,2),
  decided_by    uuid references app_user,
  decided_at    timestamptz,
  decide_note   text,
  fulfilled_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on resource_request (requested_by);
create index on resource_request (status);
create index on resource_request (budget_line_id);
alter table resource_allocation add constraint resource_allocation_request_fk foreign key (request_id) references resource_request;

-- 新申请，或者在还没人处理之前修改
create function save_resource_request(p_id uuid, p_kind text, p_resource uuid, p_line uuid, p_amount numeric, p_period date,
                                      p_purpose text, p_usage text default null, p_urgent boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource; pu text := btrim(coalesce(p_purpose, '')); us text := nullif(btrim(coalesce(p_usage, '')), ''); rid uuid; own uuid; old resource_request;
  l v_line; pl project_budget_line; taken numeric;
begin
  perform need_role('finance','director','leader','member');
  if p_kind is null or p_kind not in ('api','asset') then raise exception '类型只能是接口额度或资产'; end if;
  if pu = '' then raise exception '请写明用途'; end if;
  if length(pu) > 300 or length(us) > 600 then raise exception '用途不超过 300 个字，用量说明不超过 600 个字'; end if;
  if pu ~ '[A-Za-z0-9_\-]{32,}' or us ~ '[A-Za-z0-9_\-]{32,}' then raise exception '申请里不要填密钥'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '%', case p_kind when 'api' then '额度要大于 0' else '数量要大于 0' end; end if;
  l := open_line(p_line);
  select * into pl from project_budget_line where id = p_line;
  if pl.resource_id is null then raise exception '拦截：这一行预算没有做资源计划。先在年度预算里写明要哪种资源、多少，再来申请'; end if;
  if p_resource is not null and p_resource <> pl.resource_id then raise exception '选的资源和这一行预算计划的不是同一个'; end if;
  p_resource := pl.resource_id;
  select coalesce(sum(coalesce(q.approved_amount, q.amount)), 0) into taken from resource_request q
  where q.budget_line_id = p_line and q.status in ('pending','reviewed','approved','fulfilled') and q.id is distinct from p_id;
  if taken + p_amount > pl.plan_qty then
    raise exception '拦截：这一行预算计划 %，已申请 %，剩 %，不够 %。要追加先调整预算里的资源计划', pl.plan_qty, taken, pl.plan_qty - taken, p_amount;
  end if;
  select owner_id into own from project where id = l.project_id;
  -- 公共设备：中心统一配给博士后、博士、硕士、研究助理本人的设备。其余资源都在各项目里，归项目负责人
  if (select kind from project where id = l.project_id) = 'public' then
    if p_kind <> 'asset' then raise exception '拦截：中心公共开支只统一配设备，接口额度从各项目自己的预算里出'; end if;
    if coalesce((select kind from app_user where id = app_uid()), '') not in ('postdoc','phd','master','ra') then
      raise exception '拦截：公共设备只给博士后、博士、硕士和研究助理申领。身份还没登记的，先请财务岗登记';
    end if;
  end if;
  if p_resource is not null then
    select * into r from resource where id = p_resource;
    if not found or r.kind <> p_kind then raise exception '选的资源不存在，或者类型对不上'; end if;
    if not r.active then raise exception '「%」已停用，不能再申请', r.name; end if;
  end if;
  if p_kind = 'asset' then
    if p_resource is null then raise exception '请选择要申领的资产'; end if;
    if p_amount <> trunc(p_amount) then raise exception '数量要填整数'; end if;
    if r.total is null and p_amount <> 1 then raise exception '「%」是单件资产，数量只能是 1', r.name; end if;
    p_period := null;
  else
    if p_period is null then raise exception '请选择用在哪个月'; end if;
    if extract(year from p_period) <> l.year then raise exception '用在哪个月要在 % 年度以内', l.year; end if;
    p_period := date_trunc('month', p_period)::date;
  end if;
  if p_urgent and us is null then raise exception '紧急申请要在用量说明里写明为什么急'; end if;
  if p_id is null then
    insert into resource_request (kind, resource_id, project_id, budget_line_id, requested_by, amount, period, purpose, usage_note, urgent, status, reviewed_by, reviewed_at)
    values (p_kind, p_resource, l.project_id, p_line, app_uid(), p_amount, p_period, pu, us, coalesce(p_urgent, false),
            -- 项目没有负责人的，或者负责人自己申请的，不用再批示
            case when own is null or own = app_uid() then 'reviewed' else 'pending' end,
            case when own = app_uid() then app_uid() end, case when own = app_uid() then now() end)
    returning id into rid;
    if own is not null and own <> app_uid() then
      perform notify_user(own, format('%s 提交了%s申请，等你批示：%s', (select name from app_user where id = app_uid()), case p_kind when 'api' then '接口额度' else '资产' end, pu));
    else
      perform notify_role('finance', format('有新的%s申请等财务岗处理：%s', case p_kind when 'api' then '接口额度' else '资产' end, pu));
    end if;
  else
    select * into old from resource_request where id = p_id for update;
    if not found or old.requested_by <> app_uid() then raise exception '只能修改自己的申请'; end if;
    if old.kind <> p_kind then raise exception '申请类型不能改，撤回后重新提交'; end if;
    if old.status not in ('pending','reviewed') or old.decided_by is not null then raise exception '这笔申请已经在处理，不能再改；需要调整请撤回后重新提交'; end if;
    update resource_request set resource_id = p_resource, project_id = l.project_id, budget_line_id = p_line, amount = p_amount, period = p_period, purpose = pu, usage_note = us,
           urgent = coalesce(p_urgent, false), updated_at = now(),
           status = case when own is null or own = app_uid() then 'reviewed' else 'pending' end,
           reviewed_by = case when own = app_uid() then app_uid() end, reviewed_at = case when own = app_uid() then now() end
    where id = p_id returning id into rid;
  end if;
  return rid;
end $$;

-- review 项目负责人批示；approve 财务岗批准（可以改批准的数量）；reject 驳回；withdraw 申请人撤回
create function decide_resource_request(p_id uuid, p_action text, p_amount numeric default null, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r resource_request; own uuid; n text := nullif(btrim(coalesce(p_note, '')), ''); what text;
begin
  perform need_role('finance','director','leader','member');
  select * into r from resource_request where id = p_id for update;
  if not found then raise exception '申请不存在'; end if;
  select owner_id into own from project where id = r.project_id;
  if length(n) > 300 then raise exception '意见不超过 300 个字'; end if;
  what := case r.kind when 'api' then '接口额度' else '资产' end;
  if p_action = 'withdraw' then
    if r.requested_by <> app_uid() then raise exception '只能撤回自己的申请'; end if;
    if r.status not in ('pending','reviewed','approved') then raise exception '这笔申请已经处理完，不能撤回'; end if;
    update resource_request set status = 'withdrawn', updated_at = now() where id = p_id;
  elsif p_action = 'review' then
    if own is distinct from app_uid() and not is_staff() then raise exception '只有项目负责人能批示'; end if;
    if r.status <> 'pending' then raise exception '这笔申请不在待批示状态'; end if;
    update resource_request set status = 'reviewed', reviewed_by = app_uid(), reviewed_at = now(), decide_note = coalesce(n, decide_note), updated_at = now() where id = p_id;
    perform notify_role('finance', format('%s申请已经过项目负责人批示，等财务岗处理：%s', what, r.purpose));
  elsif p_action = 'approve' then
    if not is_staff() then raise exception '只有财务岗和中心负责人能批准'; end if;
    if r.status = 'pending' and app_role() <> 'director' then raise exception '先等项目负责人批示'; end if;
    if r.status not in ('pending','reviewed') then raise exception '这笔申请不在待批准状态'; end if;
    p_amount := coalesce(p_amount, r.amount);
    if p_amount <= 0 then raise exception '批准的数量要大于 0'; end if;
    if p_amount > r.amount then raise exception '批准的数量不能超过申请的 %', r.amount; end if;
    if r.kind = 'asset' and p_amount <> trunc(p_amount) then raise exception '数量要填整数'; end if;
    if p_amount < r.amount and n is null then raise exception '批准的数量比申请的少，请写明原因'; end if;
    update resource_request set status = 'approved', approved_amount = p_amount, decided_by = app_uid(), decided_at = now(), decide_note = coalesce(n, decide_note), updated_at = now() where id = p_id;
    perform notify_user(r.requested_by, format('你的%s申请已批准，等财务岗分发：%s', what, r.purpose));
  elsif p_action = 'reject' then
    if own is distinct from app_uid() and not is_staff() then raise exception '只有项目负责人、财务岗和中心负责人能驳回'; end if;
    if r.status not in ('pending','reviewed','approved') then raise exception '这笔申请已经处理完'; end if;
    if n is null then raise exception '请写明驳回原因'; end if;
    update resource_request set status = 'rejected', decided_by = app_uid(), decided_at = now(), decide_note = n, updated_at = now() where id = p_id;
    perform notify_user(r.requested_by, format('你的%s申请被驳回：%s。原因：%s', what, r.purpose, n));
  else
    raise exception '不认识的操作';
  end if;
end $$;

-- 分发：按批准的数量生成一条使用权记录，库存和总配额的检查与手工分配相同
create function fulfil_resource_request(p_id uuid, p_resource uuid default null, p_to date default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource_request; res resource; aid uuid;
begin
  perform need_role('finance','director');
  select * into r from resource_request where id = p_id for update;
  if not found then raise exception '申请不存在'; end if;
  if r.status <> 'approved' then raise exception '批准之后才能分发'; end if;
  select * into res from resource where id = coalesce(p_resource, r.resource_id);
  if not found then raise exception '请选择从哪个资源分发'; end if;
  if res.kind <> r.kind then raise exception '资源类型和申请对不上'; end if;
  aid := allocate_resource(res.id, r.requested_by, case when res.kind = 'asset' and res.total is null then null else r.approved_amount end,
                           app_today(), p_to, coalesce(nullif(btrim(coalesce(p_note, '')), ''), '按申请分发'));
  update resource_allocation set request_id = p_id where id = aid;
  update resource_request set status = 'fulfilled', resource_id = res.id, fulfilled_at = now(), updated_at = now() where id = p_id;
  perform notify_user(r.requested_by, format('你申请的「%s」已经分发，到资源页面查看', res.name));
  return aid;
end $$;

-- ---------- 密钥与账号 ----------
-- 明文不进数据库：接口层用单独的加密口令加密后再存，这里只有密文和一段掩码。
create table secret (
  owner_kind text not null check (owner_kind in ('resource','allocation')),
  owner_id   uuid not null,
  cipher     text not null,
  hint       text,
  set_by     uuid references app_user,
  set_at     timestamptz not null default now(),
  primary key (owner_kind, owner_id)
);
create table secret_access (
  id         bigint generated always as identity primary key,
  owner_kind text not null,
  owner_id   uuid not null,
  user_id    uuid references app_user,
  at         timestamptz not null default now()
);

create function set_secret(p_kind text, p_id uuid, p_cipher text, p_hint text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if p_kind = 'resource' then
    if not exists (select 1 from resource where id = p_id) then raise exception '资源不存在'; end if;
  elsif p_kind = 'allocation' then
    if not exists (select 1 from resource_allocation where id = p_id and returned_on is null) then raise exception '分配记录不存在或已经收回'; end if;
  else raise exception '不认识的对象';
  end if;
  if p_cipher is null or p_cipher = '' then
    delete from secret where owner_kind = p_kind and owner_id = p_id;
    return;
  end if;
  if p_cipher !~ '^v1\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$' then raise exception '密钥没有经过加密，拒绝保存'; end if;
  if length(p_hint) > 40 then raise exception '掩码太长'; end if;
  insert into secret (owner_kind, owner_id, cipher, hint, set_by) values (p_kind, p_id, p_cipher, p_hint, app_uid())
  on conflict (owner_kind, owner_id) do update set cipher = excluded.cipher, hint = excluded.hint, set_by = excluded.set_by, set_at = now();
end $$;

-- 取密文。资源池的只有财务岗和中心负责人能取；分到个人名下的，使用人本人在有效期内也能取。每次都留记录。
create function get_secret(p_kind text, p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  perform need_role('finance','director','leader','member');
  if not is_staff() then
    if p_kind <> 'allocation' or not exists (select 1 from resource_allocation a where a.id = p_id and a.user_id = app_uid()
        and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) then
      raise exception '只能查看分到自己名下、还在有效期内的密钥' using errcode = '42501';
    end if;
  end if;
  select cipher into c from secret where owner_kind = p_kind and owner_id = p_id;
  if c is null then raise exception '这里还没有保存密钥'; end if;
  insert into secret_access (owner_kind, owner_id, user_id) values (p_kind, p_id, app_uid());
  return c;
end $$;

-- 使用权收回时，名下的密钥一并删除（服务商那边仍要另外停用或轮换）
create function trg_allocation_returned() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.returned_on is not null and old.returned_on is null then
    delete from secret where owner_kind = 'allocation' and owner_id = new.id;
  end if;
  return new;
end $$;
create trigger allocation_returned after update on resource_allocation for each row execute function trg_allocation_returned();

-- ---------- 备用金 ----------
create table petty_cash (
  id           uuid primary key default gen_random_uuid(),
  requested_by uuid not null references app_user,
  project_id   uuid not null references project,
  budget_line_id uuid not null references project_budget_line,   -- 这笔备用金从哪一行预算出
  amount       numeric(14,2) not null check (amount > 0),
  purpose      text not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected','withdrawn','settled')),
  decided_by   uuid references app_user,
  decided_at   timestamptz,
  decide_note  text,
  spent        numeric(14,2),
  settled_on   date,
  settle_note  text,
  expense_request_id uuid references expense_request,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on petty_cash (requested_by);

create function save_petty_cash(p_id uuid, p_amount numeric, p_purpose text, p_line uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare pu text := btrim(coalesce(p_purpose, '')); rid uuid; l v_line; held numeric;
begin
  perform need_role('finance','director','leader','member');
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if pu = '' then raise exception '请写明用途'; end if;
  if length(pu) > 300 then raise exception '用途不超过 300 个字'; end if;
  l := open_line(p_line);
  select coalesce(sum(c.amount), 0) into held from petty_cash c
  where c.budget_line_id = p_line and c.status in ('pending','approved') and c.id is distinct from p_id;
  if l.used + held + p_amount > l.fixed then
    raise exception '拦截：这一行预算核定 %，已用 %，在外的备用金 %，剩 %，不够 %', l.fixed, l.used, held, l.fixed - l.used - held, p_amount;
  end if;
  if p_id is null then
    insert into petty_cash (requested_by, project_id, budget_line_id, amount, purpose) values (app_uid(), l.project_id, p_line, p_amount, pu) returning id into rid;
    perform notify_role('director', format('%s 申请备用金 %s 元：%s', (select name from app_user where id = app_uid()), p_amount, pu));
  else
    update petty_cash set amount = p_amount, purpose = pu, project_id = l.project_id, budget_line_id = p_line, updated_at = now()
    where id = p_id and requested_by = app_uid() and status = 'pending' returning id into rid;
    if rid is null then raise exception '只能修改自己还在待审批的备用金申请'; end if;
  end if;
  return rid;
end $$;

create function decide_petty_cash(p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r petty_cash; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director','leader','member');
  select * into r from petty_cash where id = p_id for update;
  if not found then raise exception '备用金申请不存在'; end if;
  if r.status <> 'pending' then raise exception '这笔备用金不在待审批状态'; end if;
  if p_action = 'withdraw' then
    if r.requested_by <> app_uid() then raise exception '只能撤回自己的申请'; end if;
    update petty_cash set status = 'withdrawn', updated_at = now() where id = p_id;
  elsif p_action in ('approve','reject') then
    perform need_role('director');
    if p_action = 'reject' and n is null then raise exception '请写明驳回原因'; end if;
    update petty_cash set status = case p_action when 'approve' then 'approved' else 'rejected' end,
           decided_by = app_uid(), decided_at = now(), decide_note = n, updated_at = now() where id = p_id;
    perform notify_user(r.requested_by, format('你的备用金申请（%s 元）%s', r.amount, case p_action when 'approve' then '已批准' else '被驳回：' || n end));
    if p_action = 'approve' then perform notify_role('finance', format('备用金 %s 元已批准，请支付并跟进核销：%s', r.amount, r.purpose)); end if;
  else raise exception '不认识的操作';
  end if;
end $$;

-- 核销：实际花了多少，余款退回；花掉的部分必须对应到同一行预算上的一笔支出申请，这样才计入预算执行
create function settle_petty_cash(p_id uuid, p_spent numeric, p_on date default null, p_note text default null, p_request uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare r petty_cash; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance');
  select * into r from petty_cash where id = p_id for update;
  if not found then raise exception '备用金申请不存在'; end if;
  if r.status <> 'approved' then raise exception '批准之后、核销之前才能核销'; end if;
  if p_spent is null or p_spent < 0 then raise exception '实际支出要填不小于 0 的数字'; end if;
  if p_spent > r.amount then raise exception '实际支出 % 超过领用的 %，超出部分请另走支出申请', p_spent, r.amount; end if;
  if p_spent > 0 then
    if p_request is null then raise exception '花掉的钱要对应到一笔支出申请：先把票据按支出申请或补登入到这一行预算，再来核销'; end if;
    if not exists (select 1 from expense_request e where e.id = p_request and e.budget_line_id = r.budget_line_id and e.status in ('committed','at_school','posted')) then
      raise exception '对应的支出申请不存在、还没有批准，或者不在这笔备用金的预算行上';
    end if;
  else
    p_request := null;
  end if;
  update petty_cash set status = 'settled', spent = p_spent, settled_on = coalesce(p_on, app_today()), settle_note = n,
         expense_request_id = p_request, updated_at = now() where id = p_id;
end $$;

-- ---------- 经费卡属性 ----------
alter table fund_card
  add column fund_kind text check (fund_kind in ('vertical','fiscal','horizontal')),   -- 纵向 / 财政 / 横向
  add column received numeric(14,2) check (received is null or received >= 0),            -- 已到账金额
  add column priority int check (priority is null or priority between 1 and 99);          -- 人工指定的下达顺序，数字小的先用

create function set_card_info(p_card uuid, p_fund_kind text, p_received numeric, p_priority int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if nullif(p_fund_kind, '') is not null and p_fund_kind not in ('vertical','fiscal','horizontal') then raise exception '经费性质只能是纵向、财政或横向'; end if;
  if p_received < 0 then raise exception '已到账金额不能是负数'; end if;
  if p_priority is not null and p_priority not between 1 and 99 then raise exception '优先级填 1 到 99，数字小的先用'; end if;
  update fund_card set fund_kind = nullif(p_fund_kind, ''), received = p_received, priority = p_priority, updated_at = now() where id = p_card;
  if not found then raise exception '经费卡不存在'; end if;
end $$;

-- 自动下达：人工指定了优先级的卡排最前，其余仍按到期回收、退回、可结转的顺序
create or replace function auto_allocate(p_year int) returns int
language plpgsql security definer set search_path = public as $$
declare y budget_year; l record; c record; need numeric; cap numeric; take numeric; done int := 0;
begin
  perform need_role('finance','director');
  y := lock_year(p_year);
  if y.stage not in ('fixed','issued') then raise exception '年度总预算确定之后才能下达'; end if;
  if not exists (select 1 from category_subject) then raise exception '还没有设置预算科目对应的学校科目，请先到财务工作台设置'; end if;
  for l in select v.id, v.category_id, v.fixed - v.allocated as need from v_line v
           where v.year = p_year and coalesce(v.fixed, 0) > v.allocated order by v.fixed desc, v.id loop
    need := l.need;
    for c in select k.id as card_id, m.subject_id
             from fund_card k join template_subject s on s.template_id = k.template_id
             join category_subject m on m.subject_id = s.id and m.category_id = l.category_id
             where k.status = 'active' and k.start_date <= make_date(p_year, 12, 31) and k.cutoff_date >= make_date(p_year, 1, 1)
             order by coalesce(k.priority, 100), case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no, s.sort loop
      exit when need <= 0;
      select coalesce(avail(c.card_id, c.subject_id), 0) - coalesce(sum(greatest(x.amount - x.used, 0)), 0) into cap
      from v_alloc x join project_budget_line pl on pl.id = x.line_id join project_budget b on b.id = pl.budget_id
      join budget_year by on by.year = b.year
      where x.card_id = c.card_id and x.subject_id = c.subject_id and by.stage <> 'closed';
      take := least(need, coalesce(cap, 0));
      if take > 0 then
        insert into budget_allocation (line_id, card_id, subject_id, amount) values (l.id, c.card_id, c.subject_id, take)
        on conflict (line_id, card_id, subject_id) do update set amount = budget_allocation.amount + excluded.amount;
        need := need - take;
      end if;
    end loop;
    if need <= 0 then done := done + 1; end if;
  end loop;
  return done;
end $$;

-- ---------- 补登支出 ----------
-- 学校已经入账、系统里却没有申请的支出，财务岗一步补登成已入账。只核对卡、科目和可用额；可以挂到预算行上。
create function record_expense(p_card uuid, p_subject uuid, p_type uuid, p_title text, p_amount numeric, p_posted_on date,
                               p_voucher_no text default null, p_line uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c fund_card; t text := btrim(coalesce(p_title, '')); a numeric; rid uuid; l v_line;
begin
  perform need_role('finance');
  c := lock_card(p_card);
  if c.status <> 'active' then raise exception '% 已结清，不能再补登', c.card_no; end if;
  if not exists (select 1 from template_subject where id = p_subject and template_id = c.template_id) then raise exception '该卡没有这个科目'; end if;
  if not exists (select 1 from expense_type where id = p_type) then raise exception '支出类型不存在'; end if;
  if t = '' then raise exception '请填写事项'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if p_posted_on is null or p_posted_on > app_today() then raise exception '入账日期不能为空，也不能晚于今天'; end if;
  if p_posted_on < c.start_date then raise exception '入账日期早于 % 的下达日 %', c.card_no, c.start_date; end if;
  a := avail(p_card, p_subject);
  if p_amount > coalesce(a, 0) then raise exception '% 这个科目可用 %，不足 %', c.card_no, coalesce(a, 0), p_amount; end if;
  if p_line is not null then
    select * into l from v_line where id = p_line;
    if not found then raise exception '预算行不存在'; end if;
  end if;
  insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by, project_id, budget_line_id)
  values (p_card, p_subject, p_type, t, p_amount, p_posted_on, 'posted', app_uid(), app_uid(), l.project_id, p_line) returning id into rid;
  insert into voucher (request_id, voucher_no, posted_on, amount) values (rid, nullif(btrim(coalesce(p_voucher_no, '')), ''), p_posted_on, p_amount);
  perform log_event(rid, 'post', '补登：学校已入账 ' || p_amount);
  return rid;
end $$;

-- 批量补登：[{card_id, subject_id, expense_type_id, title, amount, posted_on, voucher_no, line_id}]
create function record_expenses(p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare e jsonb; i int := 0;
begin
  perform need_role('finance');
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '没有要补登的支出'; end if;
  if jsonb_array_length(p_rows) > 200 then raise exception '一次最多补登 200 笔'; end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      perform record_expense((e->>'card_id')::uuid, (e->>'subject_id')::uuid, (e->>'expense_type_id')::uuid, e->>'title', (e->>'amount')::numeric,
                             (e->>'posted_on')::date, e->>'voucher_no', nullif(e->>'line_id', '')::uuid);
    exception when raise_exception then
      raise exception '第 % 行（%）：%', i, coalesce(e->>'title', ''), sqlerrm;
    end;
  end loop;
  return i;
end $$;

-- ---------- 账号合并：凡是指向用户的列都改过去，以后加表不用再改这里 ----------
create or replace function merge_user(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a app_user; b app_user; f record;
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
  for f in select c.conrelid::regclass::text as tbl, t.attname as col
           from pg_constraint c join pg_attribute t on t.attrelid = c.conrelid and t.attnum = c.conkey[1]
           where c.contype = 'f' and c.confrelid = 'public.app_user'::regclass and array_length(c.conkey, 1) = 1 loop
    execute format('update %s set %I = $2 where %I = $1', f.tbl, f.col, f.col) using p_from, p_into;
  end loop;
  update app_user set feishu_open_id = null, email = null, legacy_serial = null, active = false, updated_at = now() where id = p_from;
  update app_user set feishu_open_id = coalesce(b.feishu_open_id, a.feishu_open_id), email = coalesce(b.email, a.email),
         legacy_serial = coalesce(b.legacy_serial, a.legacy_serial), updated_at = now() where id = p_into;
end $$;

-- ---------- 收口 ----------
select seal('resource_stock', 'resource_request', 'secret', 'secret_access', 'petty_cash');
create trigger audit after insert or update or delete on resource_stock    for each row execute function trg_audit();
create trigger audit after insert or update or delete on resource_request  for each row execute function trg_audit();
create trigger audit after insert or update or delete on petty_cash        for each row execute function trg_audit();

-- ---------- 只读视图 ----------
create or replace view api.resource as
  select r.id, r.kind, r.name, r.ref, r.total, r.unit, r.note, r.active,
         coalesce((select sum(a.quota) from resource_allocation a
                   where a.resource_id = r.id and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())), 0) as allocated,
         (select count(*) from resource_allocation a
          where a.resource_id = r.id and a.returned_on is null and (a.to_date is null or a.to_date >= app_today()))::int as holders,
         r.provider, r.model, r.currency, r.balance, r.balance_on, r.category, r.spec, r.unit_price, r.bundle, r.location,
         coalesce((select sum(a.used) from resource_allocation a where a.resource_id = r.id), 0) as used,
         coalesce((select sum(coalesce(q.approved_amount, q.amount)) from resource_request q
                   where q.resource_id = r.id and q.status in ('pending','reviewed','approved')), 0) as asked,
         exists (select 1 from secret s where s.owner_kind = 'resource' and s.owner_id = r.id) as has_secret,
         (select s.hint from secret s where s.owner_kind = 'resource' and s.owner_id = r.id) as secret_hint
  from resource r where is_staff();

create or replace view api.allocation as
  select a.id, a.resource_id, r.kind, r.name as resource_name, r.ref, r.unit, a.user_id, u.name as user_name,
         a.quota, a.from_date, a.to_date, a.note, a.returned_on,
         (a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) as current,
         a.used, a.used_on, a.asset_no, a.location, a.request_id, r.spec, r.model, r.provider,
         exists (select 1 from secret s where s.owner_kind = 'allocation' and s.owner_id = a.id) as has_secret,
         (select s.hint from secret s where s.owner_kind = 'allocation' and s.owner_id = a.id) as secret_hint
  from resource_allocation a join resource r on r.id = a.resource_id join app_user u on u.id = a.user_id
  where is_staff() or a.user_id = app_uid();

-- 申请时可选的资源：所有登录的人都能看，不含余额、密钥和备注
create view api.resource_pick as
  select r.id, r.kind, r.name, r.unit, r.category, r.spec, r.bundle, r.provider, r.model, r.unit_price,
         case when r.total is null then null else r.total - coalesce((select sum(a.quota) from resource_allocation a
              where a.resource_id = r.id and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())), 0) end as left_,
         (r.kind = 'asset' and r.total is null) as single
  from resource r where r.active and app_role() is not null;

-- 财务岗、中心负责人看全部；申请人看自己的；项目负责人看挂在自己项目上的
create view api.resource_request as
  select q.id, q.kind, q.resource_id, r.name as resource_name, r.unit, q.project_id, p.code as project_code, p.name as project_name,
         q.requested_by, u.name as requester_name, q.amount, q.period, q.purpose, q.usage_note, q.urgent, q.status,
         q.reviewed_at, (select name from app_user where id = q.reviewed_by) as reviewed_by_name,
         q.approved_amount, q.decided_at, (select name from app_user where id = q.decided_by) as decided_by_name, q.decide_note,
         q.fulfilled_at, q.created_at, (p.owner_id is not null and p.owner_id = app_uid()) as my_project,
         q.budget_line_id, bl.purpose as line_purpose, bl.plan_qty
  from resource_request q join app_user u on u.id = q.requested_by
  left join resource r on r.id = q.resource_id left join project p on p.id = q.project_id
  left join project_budget_line bl on bl.id = q.budget_line_id
  where is_staff() or q.requested_by = app_uid() or p.owner_id = app_uid();

-- 预算行带上资源计划
create or replace view api.budget_line as
  select l.id, l.budget_id, b.year, b.project_id, l.category_id, l.purpose, l.q1, l.q2, l.q3, l.q4,
         l.q1 + l.q2 + l.q3 + l.q4 as declared, l.applied, l.adjust_note, l.fixed,
         l.resource_id, r.name as resource_name, r.kind as resource_kind, r.unit as resource_unit, l.plan_qty
  from project_budget_line l join project_budget b on b.id = l.budget_id left join resource r on r.id = l.resource_id
  where can_edit_project(b.project_id);

-- 资源计划和它的使用情况：只有数量，没有金额。open 表示现在可以挂申请（当年、已下达、有核定数）
create view api.resource_plan as
  select l.id, b.year, b.project_id, p.code as project_code, p.name as project_name, c.name as category_name, l.purpose,
         l.resource_id, r.name as resource_name, r.kind, r.unit, l.plan_qty,
         coalesce((select sum(coalesce(q.approved_amount, q.amount)) from resource_request q
                   where q.budget_line_id = l.id and q.status in ('pending','reviewed','approved')), 0) as asked,
         coalesce((select sum(q.approved_amount) from resource_request q where q.budget_line_id = l.id and q.status = 'fulfilled'), 0) as granted,
         (b.status = 'submitted' and y.stage = 'issued' and b.year = extract(year from app_today()) and coalesce(l.fixed, 0) > 0 and p.active) as open,
         p.kind as project_kind
  from project_budget_line l join project_budget b on b.id = l.budget_id join budget_year y on y.year = b.year
  join project p on p.id = b.project_id join budget_category c on c.id = l.category_id join resource r on r.id = l.resource_id
  where app_role() is not null and (can_edit_project(b.project_id) or (b.status = 'submitted' and y.stage = 'issued'));

create view api.resource_stock as
  select s.id, s.resource_id, r.kind, r.name as resource_name, r.unit, s.qty, s.unit_price, s.supplier, s.note, s.received_on,
         s.expense_request_id, (select name from app_user where id = s.created_by) as created_by_name
  from resource_stock s join resource r on r.id = s.resource_id where is_staff();

create view api.secret_access as
  select x.id, x.owner_kind, x.owner_id, x.at, u.name as user_name,
         coalesce(r.name, r2.name) as resource_name, hu.name as holder_name
  from secret_access x left join app_user u on u.id = x.user_id
  left join resource r on x.owner_kind = 'resource' and r.id = x.owner_id
  left join resource_allocation a on x.owner_kind = 'allocation' and a.id = x.owner_id
  left join resource r2 on r2.id = a.resource_id left join app_user hu on hu.id = a.user_id
  where is_staff();

create view api.petty_cash as
  select c.id, c.requested_by, u.name as requester_name, c.amount, c.purpose, c.status, c.decided_at,
         (select name from app_user where id = c.decided_by) as decided_by_name, c.decide_note,
         c.spent, c.settled_on, c.settle_note, c.expense_request_id, c.created_at,
         c.project_id, p.code as project_code, p.name as project_name, c.budget_line_id, bl.purpose as line_purpose
  from petty_cash c join app_user u on u.id = c.requested_by
  join project p on p.id = c.project_id join project_budget_line bl on bl.id = c.budget_line_id
  where is_staff() or c.requested_by = app_uid() or p.owner_id = app_uid();

create or replace view api.card as
  select v.*, c.template_id, t.name as template_name, t.locked, c.owner_id, c.rule_note,
         c.school_balance, c.school_frozen, c.school_available, c.school_synced_at,
         c.fund_kind, c.received, c.priority
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

-- ---------- 身份 ----------
-- 身份只是人员信息，不决定权限：项目里的事看项目负责人是谁。唯一用到身份的地方是公共设备的申领资格
create function set_user_kind(p_user uuid, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if p_kind is not null and p_kind not in ('postdoc','phd','master','ra','ri','visitor') then raise exception '身份只能是博士后、博士、硕士、研究助理、研究实习生或访问学生'; end if;
  update app_user set kind = p_kind, updated_at = now() where id = p_user;
  if not found then raise exception '用户不存在'; end if;
end $$;

create or replace view api.me as
  select id, name, role, kind from app_user where id = app_uid() and active;
create or replace view api.users as
  select id, name, role, active, kind from app_user where is_staff();

grant select on api.resource_plan, api.resource_pick, api.resource_request, api.resource_stock, api.secret_access, api.petty_cash to app_api;
select expose('set_resource_info(uuid, jsonb)', 'stock_in(uuid, numeric, numeric, date, text, text, uuid)',
              'set_allocation_info(uuid, numeric, date, text, text)',
              'save_resource_request(uuid, text, uuid, uuid, numeric, date, text, text, boolean)',
              'decide_resource_request(uuid, text, numeric, text)', 'fulfil_resource_request(uuid, uuid, date, text)',
              'set_secret(text, uuid, text, text)', 'get_secret(text, uuid)',
              'save_petty_cash(uuid, numeric, text, uuid)', 'set_line_resource(uuid, uuid, numeric)', 'set_user_kind(uuid, text)', 'decide_petty_cash(uuid, text, text)', 'settle_petty_cash(uuid, numeric, date, text, uuid)',
              'set_card_info(uuid, text, numeric, int)',
              'record_expense(uuid, uuid, uuid, text, numeric, date, text, uuid)', 'record_expenses(jsonb)');
