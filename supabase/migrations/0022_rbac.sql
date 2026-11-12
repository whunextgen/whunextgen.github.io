-- 权限管理：权限点、角色、按范围授权。
-- 原来只有四个固定角色，能做什么写死在各个函数里。这里改成：
--   权限点   一件具体的事，比如批准支出申请、入账、下达预算
--   角色     一组权限点；可以在界面上增删改，一个人可以有多个角色
--   授权     把角色给某个人，可以限定在某个项目或某张经费卡，可以带起止日期
-- 用户表里的 role 仍然是每个人的基本角色，对应同名的预置角色，权限点和迁移前完全一致。
-- 项目负责人对自己的项目自动带「项目负责人」角色，不用单独授权。

create table rbac_perm (
  code  text primary key,
  name  text not null,
  grp   text not null,
  scope text not null default 'global' check (scope in ('global','project','card')),
  sort  int  not null
);

create table rbac_role (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,
  name     text not null unique,
  note     text,
  builtin  boolean not null default false,   -- 预置角色，不能删
  locked   boolean not null default false,   -- 不能改权限点，也不能通过授权给人
  implicit boolean not null default false,   -- 跟着项目走，不用授权
  sort     int not null default 100,
  created_at timestamptz not null default now()
);

create table rbac_role_perm (
  role_id uuid not null references rbac_role(id) on delete cascade,
  perm    text not null references rbac_perm(code),
  primary key (role_id, perm)
);

create table rbac_grant (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user(id),
  role_id    uuid not null references rbac_role(id) on delete cascade,
  project_id uuid references project(id),
  card_id    uuid references fund_card(id),
  from_date  date not null,
  to_date    date,
  note       text,
  granted_by uuid references app_user(id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references app_user(id),
  revoked_at timestamptz,
  check (project_id is null or card_id is null),
  check (to_date is null or to_date >= from_date)
);
create index on rbac_grant (user_id);

-- 哪个函数里的哪一处角色检查，对应哪个权限点。sig 是原来那处检查允许的角色，按字母排序；* 表示这个函数里只有一处。
-- perm 为空表示这一处只要求已登录，具体谁能做在函数里另有判断。
create table rbac_fn (
  fn   text not null,
  sig  text not null default '*',
  perm text references rbac_perm(code),
  primary key (fn, sig)
);

-- 不能同时落在一个人身上的权限点
create table rbac_conflict (
  a text not null references rbac_perm(code),
  b text not null references rbac_perm(code),
  note text not null,
  primary key (a, b)
);

create table rbac_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   uuid references app_user(id),
  action  text not null,
  user_id uuid references app_user(id),
  summary text not null
);

do $$ declare t text; begin
  foreach t in array array['rbac_perm','rbac_role','rbac_role_perm','rbac_grant','rbac_fn','rbac_conflict','rbac_log'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- 权限点 ----------
insert into rbac_perm (code, name, grp, scope, sort) values
  ('budget.setup',     '开年度预算，维护项目和预算类别',           '预算', 'global', 10),
  ('budget.project',   '填报、提交项目预算',                       '预算', 'project', 11),
  ('budget.compile',   '汇总各项目预算，退回、代填，报学校、录批复', '预算', 'global', 12),
  ('budget.approve',   '批准年度预算，核定年度总预算，年度决算',   '预算', 'global', 13),
  ('budget.issue',     '把核定数下达到经费卡，调整下达',           '预算', 'global', 14),
  ('budget.review',    '项目预算复盘',                             '预算', 'global', 15),
  ('read.budget',      '查看项目预算和执行情况',                   '预算', 'project', 16),

  ('card.manage',      '建经费卡，录年初预算，维护节点和学校余额信息', '经费卡', 'global', 20),
  ('card.rebudget',    '更正已经录入的年初预算',                   '经费卡', 'global', 21),
  ('card.fund',        '登记到款和回收',                           '经费卡', 'global', 22),
  ('card.settle',      '经费卡结清',                               '经费卡', 'global', 23),
  ('change.create',    '发起预算变更',                             '经费卡', 'global', 24),
  ('change.confirm',   '确认或驳回预算变更',                       '经费卡', 'global', 25),
  ('change.record',    '登记预算变更的批复',                       '经费卡', 'global', 26),
  ('card.own',         '查看自己负责的经费卡',                     '经费卡', 'global', 27),
  ('card.read',        '查看指定的经费卡',                         '经费卡', 'card', 28),
  ('read.finance',     '查看全部经费卡、支出申请、备用金和额度',   '经费卡', 'global', 29),

  ('request.submit',   '提支出申请',                               '支出', 'global', 30),
  ('request.approve',  '批准或驳回支出申请',                       '支出', 'global', 31),
  ('request.process',  '交学校、登记退回、改挂经费卡、采购进度',   '支出', 'global', 32),
  ('request.adjust',   '释放承诺，调整申请对应的预算行和额度',     '支出', 'global', 33),
  ('ledger.post',      '入账，补录支出，更新学校余额',             '支出', 'global', 34),
  ('limit.manage',     '设置应急额度',                             '支出', 'global', 35),
  ('petty.use',        '申请备用金',                               '支出', 'global', 36),
  ('petty.approve',    '批准或驳回备用金',                         '支出', 'global', 37),
  ('petty.settle',     '备用金核销',                               '支出', 'global', 38),

  ('people.manage',    '维护人员、身份、劳务安排和发放类型',       '人员劳务', 'global', 40),
  ('payroll.run',      '生成和入账劳务发放表',                     '人员劳务', 'global', 41),
  ('payroll.reassign', '改派劳务所走的经费卡',                     '人员劳务', 'global', 42),
  ('read.people',      '查看人员、劳务安排和发放表',               '人员劳务', 'global', 43),

  ('resource.request', '申请资源',                                 '资源', 'global', 50),
  ('resource.review',  '批示项目内的资源申请',                     '资源', 'project', 51),
  ('resource.approve', '批准资源申请',                             '资源', 'global', 52),
  ('resource.fasttrack', '不等项目负责人批示直接批准',             '资源', 'global', 53),
  ('resource.manage',  '维护资源目录，入库',                       '资源', 'global', 54),
  ('resource.grant',   '分发和收回资源',                           '资源', 'global', 55),
  ('quota.set',        '核定额度',                                 '资源', 'global', 56),
  ('quota.manage',     '把额度对到项目',                           '资源', 'global', 57),
  ('secret.manage',    '保存和更换密钥',                           '资源', 'global', 58),
  ('secret.view',      '查看任何一把密钥',                         '资源', 'global', 59),
  ('secret.audit',     '查看密钥的查看记录',                       '资源', 'global', 60),
  ('read.resource',    '查看全部资源、库存、分发和申请',           '资源', 'global', 61),

  ('rule.manage',      '维护科目、模板、支出类型和口径',           '规则与系统', 'global', 70),
  ('user.manage',      '管理用户和基本角色，合并账号',             '规则与系统', 'global', 71),
  ('rbac.manage',      '管理角色和授权',                           '规则与系统', 'global', 72),
  ('read.legacy',      '查看旧门户的全部历史记录',                 '规则与系统', 'global', 73),
  ('read.admin',       '查看通知发送记录、角色和授权记录',         '规则与系统', 'global', 74);

-- ---------- 预置角色 ----------
insert into rbac_role (code, name, note, builtin, locked, implicit, sort) values
  ('director',      '中心负责人', '审批和核定。为了不把授权管理锁死，这个角色不能改', true, true,  false, 1),
  ('finance',       '财务岗',     '日常经办：汇总预算、下达、交学校、入账', true, false, false, 2),
  ('leader',        '负责人',     '能看自己负责的经费卡', true, false, false, 3),
  ('member',        '成员',       '提申请', true, false, false, 4),
  ('project_owner', '项目负责人', '跟着项目走：谁是项目负责人，谁在这个项目里就有这些权限', true, false, true, 5),
  ('deputy_approve', '代理审批',  '中心负责人外出时临时授权，建议填上截止日期', false, false, false, 10),
  ('cashier',       '出纳报销',   '只管交学校和入账，不碰预算', false, false, false, 11),
  ('budget_officer', '预算专员',  '只管年度预算的汇总和下达', false, false, false, 12),
  ('resource_admin', '资源管理员', '管资源目录、库存、分发和密钥', false, false, false, 13),
  ('hr',            '人事劳务',   '管人员和劳务发放', false, false, false, 14),
  ('auditor',       '审计只读',   '什么都能看，什么都不能改', false, false, false, 15),
  ('project_deputy', '项目副手',  '按项目授权：替负责人填预算、批示资源申请', false, false, false, 16),
  ('card_viewer',   '经费卡协管', '按经费卡授权：能看这张卡的预算和支出', false, false, false, 17);

create function _role_perms(p_role text, variadic p_perms text[]) returns void language sql as $$
  insert into rbac_role_perm (role_id, perm) select r.id, x from rbac_role r, unnest(p_perms) x where r.code = p_role
$$;
select _role_perms('member', 'request.submit', 'petty.use', 'resource.request');
select _role_perms('leader', 'request.submit', 'petty.use', 'resource.request', 'card.own');
select _role_perms('finance', 'request.submit', 'petty.use', 'resource.request',
  'budget.setup', 'budget.compile', 'budget.issue', 'budget.review', 'read.budget',
  'card.manage', 'card.fund', 'change.create', 'change.record', 'read.finance',
  'request.process', 'request.adjust', 'ledger.post', 'petty.settle',
  'people.manage', 'payroll.run', 'read.people',
  'resource.review', 'resource.approve', 'resource.manage', 'resource.grant', 'quota.manage',
  'secret.manage', 'secret.view', 'secret.audit', 'read.resource',
  'rule.manage', 'read.legacy', 'read.admin');
select _role_perms('director', 'request.submit', 'petty.use', 'resource.request',
  'budget.setup', 'budget.compile', 'budget.approve', 'budget.issue', 'budget.review', 'read.budget',
  'card.manage', 'card.rebudget', 'card.settle', 'change.create', 'change.confirm', 'read.finance',
  'request.approve', 'request.adjust', 'limit.manage', 'petty.approve',
  'people.manage', 'payroll.reassign', 'read.people',
  'resource.review', 'resource.approve', 'resource.fasttrack', 'resource.manage', 'resource.grant', 'quota.set', 'quota.manage',
  'secret.manage', 'secret.view', 'secret.audit', 'read.resource',
  'rule.manage', 'user.manage', 'rbac.manage', 'read.legacy', 'read.admin');
select _role_perms('project_owner', 'budget.project', 'resource.review', 'read.budget');
select _role_perms('deputy_approve', 'request.approve', 'petty.approve', 'change.confirm', 'read.finance', 'read.budget');
select _role_perms('cashier', 'request.process', 'ledger.post', 'petty.settle', 'card.fund', 'read.finance');
select _role_perms('budget_officer', 'budget.setup', 'budget.compile', 'budget.issue', 'budget.review', 'read.budget', 'read.finance');
select _role_perms('resource_admin', 'resource.review', 'resource.approve', 'resource.manage', 'resource.grant', 'quota.manage', 'secret.manage', 'read.resource');
select _role_perms('hr', 'people.manage', 'payroll.run', 'read.people');
select _role_perms('auditor', 'read.finance', 'read.budget', 'read.resource', 'read.people', 'read.legacy', 'read.admin', 'secret.audit');
select _role_perms('project_deputy', 'budget.project', 'resource.review', 'read.budget');
select _role_perms('card_viewer', 'card.read');
drop function _role_perms(text, text[]);

-- 职责分离：批的人不经办
insert into rbac_conflict (a, b, note) values
  ('request.approve', 'request.process', '批准支出申请的人不能同时经办交学校'),
  ('request.approve', 'ledger.post',     '批准支出申请的人不能同时入账'),
  ('petty.approve',   'petty.settle',    '批准备用金的人不能同时核销'),
  ('change.confirm',  'change.record',   '确认预算变更的人不能同时登记批复');

-- ---------- 判断 ----------
create function user_perm(p_user uuid, p_code text, p_project uuid default null, p_card uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_user u where u.id = p_user and u.active) and (
    exists (select 1 from app_user u join rbac_role r on r.code = u.role join rbac_role_perm rp on rp.role_id = r.id
            where u.id = p_user and rp.perm = p_code)
    or exists (select 1 from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
               where g.user_id = p_user and rp.perm = p_code and g.revoked_at is null
                 and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())
                 and ((g.project_id is null and g.card_id is null) or g.project_id = p_project or g.card_id = p_card))
    or (p_project is not null and exists (
               select 1 from project p, rbac_role r, rbac_role_perm rp
               where p.id = p_project and p.owner_id = p_user and r.code = 'project_owner' and rp.role_id = r.id and rp.perm = p_code)))
$$;

create function has_perm(p_code text, p_project uuid default null, p_card uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select app_uid() is not null and user_perm(app_uid(), p_code, p_project, p_card)
$$;

create function need_perm(p_code text) returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not has_perm(p_code) then
    raise exception '当前角色不能执行此操作（需要权限：%）', (select name from rbac_perm where code = p_code) using errcode = '42501';
  end if;
end $$;

-- 原来各函数里的角色检查不动，改成在这里查表换成权限点。没登记的函数照旧按角色判断。
create or replace function need_role(variadic roles text[]) returns void language plpgsql stable security definer set search_path = public as $$
declare ctx text; v_fn text; v_sig text; m rbac_fn;
begin
  if app_role() is null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  get diagnostics ctx = pg_context;
  v_fn := (regexp_match(ctx, E'\\n[^\\n]*function (?:[a-z_]+\\.)?([a-z_0-9]+)\\('))[1];
  select string_agg(x, ',' order by x) into v_sig from unnest(roles) x;
  select * into m from rbac_fn f where f.fn = v_fn and f.sig in (v_sig, '*') order by (f.sig = '*') limit 1;
  if found and m.perm is not null then
    perform need_perm(m.perm);
  elsif not found and not (app_role() = any(roles)) then
    raise exception '当前角色不能执行此操作' using errcode = '42501';
  end if;
end $$;

insert into rbac_fn (fn, sig, perm) values
  ('open_budget_year', '*', 'budget.setup'), ('save_project', '*', 'budget.setup'), ('save_budget_category', '*', 'budget.setup'), ('set_category_subjects', '*', 'budget.setup'),
  ('advance_budget_year', 'director,finance', 'budget.compile'), ('advance_budget_year', 'director', 'budget.approve'),
  ('set_project_budget', '*', 'budget.compile'), ('revise_fixed', '*', 'budget.approve'),
  ('allocate_line', '*', 'budget.issue'), ('auto_allocate', '*', 'budget.issue'), ('adjust_budget_line', '*', 'budget.issue'),
  ('review_project', '*', 'budget.review'),
  ('save_card', '*', 'card.manage'), ('set_card_info', '*', 'card.manage'), ('set_node', '*', 'card.manage'), ('delete_node', '*', 'card.manage'), ('set_budget', '*', 'card.manage'),
  ('add_fund_event', '*', 'card.fund'), ('finish_fund_event', '*', 'card.fund'), ('settle_card', '*', 'card.settle'),
  ('create_change', '*', 'change.create'), ('confirm_change', '*', 'change.confirm'), ('reject_change', '*', 'change.confirm'), ('approve_change', '*', 'change.record'),
  ('submit_request', '*', 'request.submit'), ('submit_split', '*', 'request.submit'), ('submit_project_request', '*', 'request.submit'),
  ('approve_request', '*', 'request.approve'), ('reject_request', '*', 'request.approve'),
  ('send_to_school', '*', 'request.process'), ('school_return', '*', 'request.process'), ('move_request', '*', 'request.process'),
  ('procurement_advance', '*', 'request.process'), ('procurement_fail', '*', 'request.process'),
  ('release_request', '*', 'request.adjust'), ('set_request_line', '*', 'request.adjust'), ('set_request_quota', '*', 'request.adjust'),
  ('post_voucher', '*', 'ledger.post'), ('post_vouchers', '*', 'ledger.post'), ('record_expense', '*', 'ledger.post'), ('record_expenses', '*', 'ledger.post'), ('set_school_balance', '*', 'ledger.post'),
  ('set_emergency_limit', '*', 'limit.manage'),
  ('save_petty_cash', '*', 'petty.use'), ('decide_petty_cash', 'director,finance,leader,member', null), ('decide_petty_cash', 'director', 'petty.approve'), ('settle_petty_cash', '*', 'petty.settle'),
  ('save_person', '*', 'people.manage'), ('set_staff', '*', 'people.manage'), ('save_pay_type', '*', 'people.manage'), ('set_user_kind', '*', 'people.manage'),
  ('build_payroll', '*', 'payroll.run'), ('post_payroll', '*', 'payroll.run'), ('reassign_staff', '*', 'payroll.reassign'),
  ('save_resource_request', '*', 'resource.request'), ('decide_resource_request', '*', null), ('get_secret', '*', null),
  ('save_resource', '*', 'resource.manage'), ('set_resource_info', '*', 'resource.manage'), ('stock_in', '*', 'resource.manage'),
  ('allocate_resource', '*', 'resource.grant'), ('fulfil_resource_request', '*', 'resource.grant'), ('return_allocation', '*', 'resource.grant'), ('set_allocation_info', '*', 'resource.grant'),
  ('save_quota', '*', 'quota.set'), ('quota_to_project', '*', 'quota.manage'), ('set_secret', '*', 'secret.manage'),
  ('add_ruling', '*', 'rule.manage'), ('save_expense_type', '*', 'rule.manage'), ('save_subject', '*', 'rule.manage'), ('delete_subject', '*', 'rule.manage'),
  ('save_template', '*', 'rule.manage'), ('save_cap', '*', 'rule.manage'), ('delete_cap', '*', 'rule.manage'),
  ('save_user', '*', 'user.manage'), ('set_user_role', '*', 'user.manage'), ('merge_user', '*', 'user.manage');

-- 每个做角色检查的函数都要登记，漏了就停下来
do $$ declare miss text; begin
  select string_agg(p.proname, ', ') into miss from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prosrc like '%need_role(%' and p.proname <> 'need_role'
    and not exists (select 1 from rbac_fn f where f.fn = p.proname);
  if miss is not null then raise exception '这些函数还没有登记权限点：%', miss; end if;
  select string_agg(f.fn, ', ') into miss from rbac_fn f
  where not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f.fn);
  if miss is not null then raise exception '登记了不存在的函数：%', miss; end if;
end $$;

create or replace function can_see_card(p_card uuid) returns boolean language sql stable security definer set search_path = public as $$
  select has_perm('read.finance') or has_perm('card.read', null, p_card)
      or (has_perm('card.own') and exists (select 1 from fund_card where id = p_card and owner_id = app_uid()))
$$;

create or replace function can_edit_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select has_perm('budget.compile')
      or (has_perm('budget.project', p_project) and exists (select 1 from project where id = p_project and active))
$$;

create function can_see_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select can_edit_project(p_project)
      or (has_perm('read.budget', p_project) and exists (select 1 from project where id = p_project and active))
      or (has_perm('read.budget') and has_perm('read.finance'))
$$;

-- 职责分离：自己提的不能自己批。全中心只有一位审批人的时候放行，但记一笔。
create function sod_self(p_perm text, p_other uuid, p_what text) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_other is distinct from app_uid() then return; end if;
  if exists (select 1 from app_user u where u.active and u.id <> app_uid() and user_perm(u.id, p_perm)) then
    raise exception '职责分离：自己提的%不能自己批，请交给另一位有审批权的人', p_what using errcode = '42501';
  end if;
  insert into rbac_log (actor, action, user_id, summary)
  values (app_uid(), 'self_approve', app_uid(), format('批了自己提的%s（当时只有这一位审批人）', p_what));
end $$;

-- ---------- 把视图和函数里写死的角色判断换成权限点 ----------
create function _patch_view(p_view text, p_find text, p_repl text) returns void language plpgsql as $$
declare d text;
begin
  d := pg_get_viewdef(('api.' || p_view)::regclass);
  if position(p_find in d) = 0 then raise exception '视图 % 里找不到：%', p_view, p_find; end if;
  execute format('create or replace view api.%I as %s', p_view, replace(d, p_find, p_repl));
end $$;

create function _patch_fn(p_fn text, p_find text, p_repl text) returns void language plpgsql as $$
declare d text; o oid;
begin
  select oid into strict o from pg_proc where proname = p_fn and pronamespace = 'public'::regnamespace;
  d := pg_get_functiondef(o);
  if position(p_find in d) = 0 then raise exception '函数 % 里找不到：%', p_fn, p_find; end if;
  execute replace(d, p_find, p_repl);
end $$;

select _patch_view('project', '(is_staff() OR (p.owner_id = app_uid())) AS mine', 'can_edit_project(p.id) AS mine');
select _patch_view(v, 'is_staff()', format('has_perm(%L)', p)) from (values
  ('project', 'budget.setup'), ('budget_category', 'budget.setup'), ('budget_year', 'read.finance'), ('category_subject', 'read.finance'),
  ('template', 'read.finance'), ('template_cap', 'read.finance'), ('petty_cash', 'read.finance'), ('quota', 'read.finance'),
  ('person', 'read.people'), ('staff', 'read.people'), ('pay_type', 'read.people'), ('payroll_sheet', 'read.people'), ('users', 'read.people'),
  ('resource', 'read.resource'), ('resource_stock', 'read.resource'), ('allocation', 'read.resource'), ('resource_request', 'read.resource'),
  ('secret_access', 'secret.audit'), ('outbox', 'read.admin'),
  ('legacy_ms_item', 'read.legacy'), ('legacy_ms_submission', 'read.legacy'), ('legacy_quota_ledger', 'read.legacy'), ('legacy_recon', 'read.legacy'),
  ('legacy_record', 'read.legacy'), ('legacy_resource_request', 'read.legacy'), ('legacy_source', 'read.legacy')) t(v, p);
create function has_scoped(p_code text, p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
    where g.user_id = app_uid() and g.project_id = p_project and rp.perm = p_code and g.revoked_at is null
      and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today()))
$$;
-- 项目副手和项目负责人一样，看得到挂在这个项目上的资源申请
select _patch_view('resource_request', '((p.owner_id IS NOT NULL) AND (p.owner_id = app_uid())) AS my_project',
  '(((p.owner_id IS NOT NULL) AND (p.owner_id = app_uid())) OR has_scoped(''resource.review'', p.id)) AS my_project');
select _patch_view('resource_request', 'OR (p.owner_id = app_uid()))', 'OR (p.owner_id = app_uid()) OR has_scoped(''resource.review'', p.id))');
select _patch_view('user_admin', 'app_role() = ''director''::text', 'has_perm(''user.manage'')');
select _patch_view(v, 'can_edit_project(', 'can_see_project(') from unnest(array[
  'budget_alloc', 'budget_line', 'budget_review', 'budget_revision', 'line_exec', 'project_budget', 'resource_plan']) v;

select _patch_fn('get_secret', 'if not is_staff() then', 'if not has_perm(''secret.view'') then');
select _patch_fn('set_budget', 'if app_role() <> ''director'' and exists', 'if not has_perm(''card.rebudget'') and exists');
select _patch_fn('set_line_resource', 'if not is_staff() and (st', 'if not has_perm(''budget.compile'') and (st');
select _patch_fn('decide_resource_request', 'if own is distinct from app_uid() and not is_staff() then raise exception ''只有项目负责人能批示''',
  'if not has_perm(''resource.review'', r.project_id) then raise exception ''只有项目负责人能批示''');
select _patch_fn('decide_resource_request', 'if not is_staff() then raise exception ''只有财务岗和中心负责人能批准''; end if;',
  'if not has_perm(''resource.approve'') then raise exception ''只有财务岗和中心负责人能批准''; end if;
    perform sod_self(''resource.approve'', r.requested_by, ''资源申请'');');
select _patch_fn('decide_resource_request', 'app_role() <> ''director'' then raise exception ''先等项目负责人批示''',
  'not has_perm(''resource.fasttrack'') then raise exception ''先等项目负责人批示''');
select _patch_fn('decide_resource_request', 'if own is distinct from app_uid() and not is_staff() then raise exception ''只有项目负责人、财务岗和中心负责人能驳回''',
  'if not has_perm(''resource.review'', r.project_id) and not has_perm(''resource.approve'') then raise exception ''只有项目负责人、财务岗和中心负责人能驳回''');
select _patch_fn('approve_request', 'if r.status <> ''pending'' then raise exception ''该申请不在待审批状态''; end if;',
  'if r.status <> ''pending'' then raise exception ''该申请不在待审批状态''; end if;
  perform sod_self(''request.approve'', r.requested_by, ''支出申请'');');
select _patch_fn('decide_petty_cash', 'perform need_role(''director'');',
  'perform need_role(''director'');
    if p_action = ''approve'' then perform sod_self(''petty.approve'', r.requested_by, ''备用金''); end if;');

drop function _patch_view(text, text, text);
drop function _patch_fn(text, text, text);

-- ---------- 管理：角色、授权 ----------
-- 一个人在全中心范围内现在和将来会有的权限点（基本角色，加上没收回、没过期的不限范围授权）
create function user_global_perms(p_user uuid) returns setof text language sql stable security definer set search_path = public as $$
  select rp.perm from app_user u join rbac_role r on r.code = u.role join rbac_role_perm rp on rp.role_id = r.id where u.id = p_user and u.active
  union
  select rp.perm from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
  where g.user_id = p_user and g.revoked_at is null and g.project_id is null and g.card_id is null
    and (g.to_date is null or g.to_date >= app_today())
$$;

create function rbac_conflict_of(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select c.note from rbac_conflict c
  where c.a in (select user_global_perms(p_user)) and c.b in (select user_global_perms(p_user)) limit 1
$$;

create function save_role(p_id uuid, p_name text, p_note text, p_perms jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare r rbac_role; rid uuid; nm text := btrim(coalesce(p_name, '')); nt text := nullif(btrim(coalesce(p_note, '')), '');
        bad text; added text; removed text; who text;
begin
  perform need_perm('rbac.manage');
  if nm = '' then raise exception '请填写角色名称'; end if;
  if length(nm) > 20 then raise exception '角色名称不超过 20 个字'; end if;
  if length(nt) > 200 then raise exception '说明不超过 200 个字'; end if;
  if p_perms is null or jsonb_typeof(p_perms) <> 'array' then raise exception '请勾选权限点'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_perms) e where not exists (select 1 from rbac_perm where code = e)) then
    raise exception '有不认识的权限点';
  end if;
  select c.note into bad from rbac_conflict c where p_perms ? c.a and p_perms ? c.b limit 1;
  if bad is not null then raise exception '职责分离：%，不能放进同一个角色', bad; end if;
  if exists (select 1 from rbac_role where name = nm and id is distinct from p_id) then raise exception '已经有叫这个名字的角色'; end if;
  if p_id is null then
    insert into rbac_role (code, name, note) values ('c_' || replace(gen_random_uuid()::text, '-', ''), nm, nt) returning id into rid;
    insert into rbac_role_perm (role_id, perm) select rid, e from jsonb_array_elements_text(p_perms) e group by e;
    insert into rbac_log (actor, action, summary) values (app_uid(), 'role_new', format('新建角色「%s」，%s 个权限点', nm, jsonb_array_length(p_perms)));
    return rid;
  end if;
  select * into r from rbac_role where id = p_id for update;
  if not found then raise exception '角色不存在'; end if;
  if r.locked then raise exception '「%」这个角色不能改，免得把授权管理锁死', r.name; end if;
  if r.builtin and nm <> r.name then raise exception '预置角色不能改名'; end if;
  select string_agg(p.name, '、' order by p.sort) into added from rbac_perm p
  where p_perms ? p.code and not exists (select 1 from rbac_role_perm x where x.role_id = p_id and x.perm = p.code);
  select string_agg(p.name, '、' order by p.sort) into removed from rbac_perm p
  where not p_perms ? p.code and exists (select 1 from rbac_role_perm x where x.role_id = p_id and x.perm = p.code);
  update rbac_role set name = nm, note = nt where id = p_id;
  delete from rbac_role_perm where role_id = p_id and not p_perms ? perm;
  insert into rbac_role_perm (role_id, perm) select p_id, e from jsonb_array_elements_text(p_perms) e group by e on conflict do nothing;
  select u.name || '：' || rbac_conflict_of(u.id) into who from app_user u where u.active and rbac_conflict_of(u.id) is not null limit 1;
  if who is not null then raise exception '职责分离：这样改以后 %', who; end if;
  if added is not null or removed is not null or nm <> r.name then
    insert into rbac_log (actor, action, summary) values (app_uid(), 'role_edit',
      format('修改角色「%s」%s%s', nm, coalesce('，加上：' || added, ''), coalesce('，去掉：' || removed, '')));
  end if;
  return p_id;
end $$;

create function delete_role(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r rbac_role;
begin
  perform need_perm('rbac.manage');
  select * into r from rbac_role where id = p_id for update;
  if not found then raise exception '角色不存在'; end if;
  if r.builtin then raise exception '预置角色不能删'; end if;
  if exists (select 1 from rbac_grant g where g.role_id = p_id and g.revoked_at is null and (g.to_date is null or g.to_date >= app_today())) then
    raise exception '还有人持有这个角色，先收回授权';
  end if;
  delete from rbac_role where id = p_id;
  insert into rbac_log (actor, action, summary) values (app_uid(), 'role_delete', format('删除角色「%s」', r.name));
end $$;

create function grant_role(p_user uuid, p_role uuid, p_project uuid, p_card uuid, p_from date, p_to date, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r rbac_role; u app_user; gid uuid; bad text; sc text; nt text := nullif(btrim(coalesce(p_note, '')), '');
        d0 date := coalesce(p_from, app_today()); sname text := '全中心';
begin
  perform need_perm('rbac.manage');
  select * into u from app_user where id = p_user;
  if not found or not u.active then raise exception '这个人不存在或已停用'; end if;
  if p_user = app_uid() then raise exception '不能给自己授权'; end if;
  select * into r from rbac_role where id = p_role;
  if not found then raise exception '角色不存在'; end if;
  if r.implicit then raise exception '「%」跟着项目走，不用单独授权；换负责人请改项目', r.name; end if;
  if r.locked then raise exception '「%」只能在用户管理里指定', r.name; end if;
  if p_project is not null and p_card is not null then raise exception '项目和经费卡只能选一个'; end if;
  if p_to is not null and p_to < d0 then raise exception '截止日期不能早于开始日期'; end if;
  if p_to is not null and p_to < app_today() then raise exception '截止日期已经过了'; end if;
  if length(nt) > 200 then raise exception '说明不超过 200 个字'; end if;
  if not exists (select 1 from rbac_role_perm where role_id = p_role) then raise exception '这个角色还没有任何权限点'; end if;
  sc := case when p_project is not null then 'project' when p_card is not null then 'card' end;
  if sc is not null then
    select string_agg(p.name, '、' order by p.sort) into bad from rbac_role_perm rp join rbac_perm p on p.code = rp.perm
    where rp.role_id = p_role and p.scope <> sc;
    if bad is not null then
      raise exception '这个角色不能按%授权，里面有只能全中心生效的权限：%', case sc when 'project' then '项目' else '经费卡' end, bad;
    end if;
    if sc = 'project' then select name into sname from project where id = p_project;
    else select card_no || ' ' || name into sname from fund_card where id = p_card; end if;
    if sname is null then raise exception '选的项目或经费卡不存在'; end if;
  end if;
  if exists (select 1 from rbac_grant g where g.user_id = p_user and g.role_id = p_role and g.revoked_at is null
             and g.project_id is not distinct from p_project and g.card_id is not distinct from p_card
             and (g.to_date is null or g.to_date >= app_today())) then
    raise exception '这个人在这个范围内已经有这个角色，先收回旧的再重新授权';
  end if;
  insert into rbac_grant (user_id, role_id, project_id, card_id, from_date, to_date, note, granted_by)
  values (p_user, p_role, p_project, p_card, d0, p_to, nt, app_uid()) returning id into gid;
  bad := rbac_conflict_of(p_user);
  if bad is not null then raise exception '职责分离：%。% 现有的权限和这个角色冲突', bad, u.name; end if;
  insert into rbac_log (actor, action, user_id, summary) values (app_uid(), 'grant', p_user,
    format('给 %s 授予「%s」，范围：%s，%s 起%s%s', u.name, r.name, sname, d0, coalesce('，到 ' || p_to, '，长期'), coalesce('。' || nt, '')));
  perform notify_user(p_user, format('你被授予「%s」角色，范围：%s，%s 起%s', r.name, sname, d0, coalesce('，到 ' || p_to, '')));
  return gid;
end $$;

create function revoke_grant(p_id uuid, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare g rbac_grant; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('rbac.manage');
  select * into g from rbac_grant where id = p_id for update;
  if not found then raise exception '授权不存在'; end if;
  if g.revoked_at is not null then raise exception '这条授权已经收回'; end if;
  update rbac_grant set revoked_at = now(), revoked_by = app_uid() where id = p_id;
  insert into rbac_log (actor, action, user_id, summary) values (app_uid(), 'revoke', g.user_id,
    format('收回 %s 的「%s」%s', (select name from app_user where id = g.user_id), (select name from rbac_role where id = g.role_id), coalesce('。' || nt, '')));
end $$;

-- 基本角色变动也留痕，并且同样受职责分离约束
create function rbac_user_change() returns trigger language plpgsql security definer set search_path = public as $$
declare bad text;
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    bad := rbac_conflict_of(new.id);
    if bad is not null then raise exception '职责分离：%。先收回 % 的相关授权', bad, new.name; end if;
    insert into rbac_log (actor, action, user_id, summary) values (app_uid(), 'base_role', new.id,
      case when new.active is distinct from old.active then format('%s %s', new.name, case when new.active then '重新启用' else '停用' end)
           else format('%s 的基本角色从「%s」改为「%s」', new.name,
                  (select name from rbac_role where code = old.role), (select name from rbac_role where code = new.role)) end);
  end if;
  return new;
end $$;
create trigger rbac_user_change after update of role, active on app_user for each row execute function rbac_user_change();

-- ---------- 读 ----------
create function my_perms() returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct x.perm order by x.perm), '{}') from (
    select rp.perm from app_user u join rbac_role r on r.code = u.role join rbac_role_perm rp on rp.role_id = r.id where u.id = app_uid() and u.active
    union all
    select rp.perm from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id join app_user u on u.id = g.user_id and u.active
    where g.user_id = app_uid() and g.project_id is null and g.card_id is null
      and g.revoked_at is null and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())) x
$$;

create or replace view api.me as
select id, name, role, kind, my_perms() as perms,
       -- 只在某个项目或某张卡上有的权限点，页面用来决定给不给入口
       coalesce((select array_agg(distinct rp.perm order by rp.perm) from rbac_grant g join rbac_role_perm rp on rp.role_id = g.role_id
                 where g.user_id = app_user.id and (g.project_id is not null or g.card_id is not null) and g.revoked_at is null
                   and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today())), '{}') as scoped
from app_user where id = app_uid() and active;

create view api.perm as
select code, name, grp, scope, sort from rbac_perm where app_role() is not null;

create view api.role as
select r.id, r.code, r.name, r.note, r.builtin, r.locked, r.implicit, r.sort,
       coalesce((select array_agg(rp.perm order by rp.perm) from rbac_role_perm rp where rp.role_id = r.id), '{}') as perms,
       ((select count(*) from app_user u where u.active and u.role = r.code)
        + (select count(distinct g.user_id) from rbac_grant g where g.role_id = r.id and g.revoked_at is null
             and g.from_date <= app_today() and (g.to_date is null or g.to_date >= app_today()))
        + case when r.implicit then (select count(distinct p.owner_id) from project p where p.active and p.owner_id is not null) else 0 end)::int as holders
from rbac_role r
where has_perm('rbac.manage') or has_perm('read.admin');

create view api.role_grant as
select g.id, g.user_id, u.name as user_name, g.role_id, r.name as role_name,
       g.project_id, p.name as project_name, g.card_id, c.card_no || ' ' || c.name as card_name,
       g.from_date, g.to_date, g.note, gb.name as granted_by_name, g.granted_at, g.revoked_at, rb.name as revoked_by_name,
       case when g.revoked_at is not null then 'revoked' when g.to_date < app_today() then 'expired'
            when g.from_date > app_today() then 'upcoming' else 'active' end as state
from rbac_grant g
join app_user u on u.id = g.user_id
join rbac_role r on r.id = g.role_id
left join project p on p.id = g.project_id
left join fund_card c on c.id = g.card_id
left join app_user gb on gb.id = g.granted_by
left join app_user rb on rb.id = g.revoked_by
where has_perm('rbac.manage') or has_perm('read.admin') or g.user_id = app_uid();

create view api.rbac_log as
select l.id, l.at, a.name as actor_name, l.action, u.name as user_name, l.summary
from rbac_log l left join app_user a on a.id = l.actor left join app_user u on u.id = l.user_id
where has_perm('rbac.manage') or has_perm('read.admin');

grant select on api.perm, api.role, api.role_grant, api.rbac_log to app_api;
select expose('save_role(uuid, text, text, jsonb)', 'delete_role(uuid)',
              'grant_role(uuid, uuid, uuid, uuid, date, date, text)', 'revoke_grant(uuid, text)',
              'has_perm(text, uuid, uuid)', 'can_see_project(uuid)', 'can_edit_project(uuid)', 'my_perms()', 'has_scoped(text, uuid)');
revoke all on function user_perm(uuid, text, uuid, uuid), user_global_perms(uuid), rbac_conflict_of(uuid), sod_self(text, uuid, text), need_perm(text) from public;
