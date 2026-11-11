-- 科研财务中台：表结构
-- 金额一律 numeric(14,2)；状态用检查约束；流水表不存余额，余额由视图算出。

-- ---------- 人 ----------
create table app_user (
  id            uuid primary key default gen_random_uuid(),
  feishu_open_id text unique,
  email         text unique,                   -- 飞书企业邮箱；open_id 因应用而异，首次登录按邮箱认领旧账号
  name          text not null,
  role          text not null default 'member' check (role in ('finance','director','leader','member')),  -- 财务岗 / 中心负责人 / 项目或晨星负责人 / 成员
  active        boolean not null default true,
  legacy_serial text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- 经费卡模板 ----------
create table card_template (
  id      uuid primary key default gen_random_uuid(),
  code    text not null unique,
  name    text not null,
  locked  boolean not null default false      -- 科目不可增改（如外专项目）
);

create table template_subject (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references card_template on delete cascade,
  code        text not null,
  name        text not null,
  school_name text,                            -- 学校侧科目名
  sort        int not null default 0,
  unique (template_id, code)
);

create table template_cap (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references card_template on delete cascade,
  name        text not null,
  max_ratio   numeric(5,4) not null check (max_ratio > 0 and max_ratio <= 1)
);

create table template_cap_subject (
  cap_id     uuid not null references template_cap on delete cascade,
  subject_id uuid not null references template_subject on delete cascade,
  primary key (cap_id, subject_id)
);

-- ---------- 经费卡 ----------
create table fund_card (
  id           uuid primary key default gen_random_uuid(),
  card_no      text not null unique,           -- 学校经费卡号
  name         text not null,
  template_id  uuid not null references card_template,
  owner_id     uuid references app_user,
  start_date   date not null,                  -- 下达日
  cutoff_date  date not null,                  -- 单据截止日
  settle_date  date,                           -- 结清日；跨年卡为空
  end_rule     text not null check (end_rule in ('recall','carry','return')),
  rule_note    text,
  status       text not null default 'active' check (status in ('active','settled')),
  -- 学校财务系统里的三个数，财务岗定期回写，用于对账
  school_balance   numeric(14,2),
  school_frozen    numeric(14,2),
  school_available numeric(14,2),
  school_synced_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (cutoff_date >= start_date)
);

create table card_node (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references fund_card on delete cascade,
  node_date   date not null,
  ratio       numeric(5,4) not null check (ratio > 0 and ratio <= 1),
  consequence text not null,                   -- 通报 / 回收 / 清零 / 结题
  unique (card_id, node_date)
);

create table fund_event (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references fund_card,
  kind       text not null check (kind in ('下达','到账','认领','预借票','核销','冻结','回收')),
  event_date date not null,
  amount     numeric(14,2) not null,
  todo       text,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- 预算 ----------
create table budget_line (
  id         uuid primary key default gen_random_uuid(),
  card_id    uuid not null references fund_card,
  subject_id uuid not null references template_subject,
  amount     numeric(14,2) not null check (amount >= 0),   -- 年初预算
  unique (card_id, subject_id)
);

create table budget_change (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null references fund_card,
  reason       text not null,
  status       text not null default 'pending'
               check (status in ('pending','filed','approved','rejected')),  -- 待负责人确认 / 已报发规办 / 已批复 / 已驳回
  requested_by uuid references app_user,
  confirmed_by uuid references app_user,
  approved_on  date,
  created_at   timestamptz not null default now()
);

create table budget_change_line (
  change_id  uuid not null references budget_change on delete cascade,
  subject_id uuid not null references template_subject,
  delta      numeric(14,2) not null check (delta <> 0),
  primary key (change_id, subject_id)
);

-- ---------- 可报销规则 ----------
create table expense_type (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique,
  required_path text check (required_path in ('直采','集采','分散采购'))   -- 如电脑必须集采
);

create table reimb_ruling (
  id              uuid primary key default gen_random_uuid(),
  card_id         uuid not null references fund_card,
  expense_type_id uuid not null references expense_type,
  ruled_on        date not null,
  ruled_by        text not null,               -- 答复人（学校财务或职能部门，不一定是系统用户）
  verdict         text not null check (verdict in ('yes','no','conditional')),
  note            text,
  source          text,                        -- 来源：群消息、退单等
  created_at      timestamptz not null default now()
);
create index on reimb_ruling (card_id, expense_type_id, ruled_on, created_at);

-- ---------- 支出 ----------
create table expense_request (
  id              uuid primary key default gen_random_uuid(),
  code            text unique,
  card_id         uuid not null references fund_card,
  subject_id      uuid not null references template_subject,
  expense_type_id uuid not null references expense_type,
  title           text not null,
  amount          numeric(14,2) not null check (amount > 0),
  eta_date        date not null,               -- 预计学校入账日
  emergency       boolean not null default false,
  status          text not null default 'pending'
                  check (status in ('pending','committed','at_school','posted','returned','released','rejected')),
  requested_by    uuid references app_user,
  approved_by     uuid references app_user,
  legacy_id       text unique,                 -- 旧门户导入的幂等键
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on expense_request (card_id, status);

create table request_event (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references expense_request on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null,                    -- submit / approve / to_school / return / move / post / release / reject
  note       text,
  actor      uuid references app_user
);

create table voucher (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references expense_request,
  voucher_no text,
  posted_on  date not null,
  amount     numeric(14,2) not null check (amount > 0)
);

create table procurement (
  request_id uuid primary key references expense_request on delete cascade,
  path       text not null check (path in ('直采','集采','分散采购')),
  stage      int  not null default 0,
  stages     int  not null,                    -- 该路径的阶段数；stage = stages 表示已验收贴码
  check (stage between 0 and stages)
);

create table procurement_event (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references procurement on delete cascade,
  at         date not null default current_date,
  kind       text not null,                    -- advance / 废标 / 流标 / 论证 / 合同
  note       text
);

create table emergency_limit (
  year        int primary key,
  per_request numeric(14,2) not null,
  per_year    numeric(14,2) not null
);

-- ---------- 人员费 ----------
create table person (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  user_id uuid references app_user
);

create table pay_type (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,           -- 外聘人员劳务费 / 学生三兼费 / 编外人员工资 / 专家咨询费
  subject_code text not null,                  -- 对应模板科目的 code
  monthly_cap  numeric(14,2)
);

create table payroll_sheet (
  id          uuid primary key default gen_random_uuid(),
  month       date not null check (extract(day from month) = 1),
  pay_type_id uuid not null references pay_type,
  card_id     uuid not null references fund_card,
  status      text not null default 'draft' check (status in ('draft','submitted','posted')),
  posted_on   date,
  unique (month, pay_type_id, card_id)
);

create table staff_assignment (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person,
  pay_type_id uuid not null references pay_type,
  month       date not null check (extract(day from month) = 1),
  card_id     uuid not null references fund_card,
  amount      numeric(14,2) not null check (amount > 0),
  sheet_id    uuid references payroll_sheet,   -- 进了发放表后锁定
  unique (person_id, pay_type_id, month)
);
create index on staff_assignment (card_id, month);

-- ---------- 结清 ----------
create table card_settlement (
  id           uuid primary key default gen_random_uuid(),
  card_id      uuid not null unique references fund_card,
  settled_on   date not null,
  confirmed_by uuid references app_user,
  created_at   timestamptz not null default now()
);

create table settlement_line (
  settlement_id uuid not null references card_settlement on delete cascade,
  subject_id    uuid not null references template_subject,
  budget        numeric(14,2) not null,
  actual        numeric(14,2) not null,
  balance       numeric(14,2) not null,
  primary key (settlement_id, subject_id)
);

-- ---------- 晨星额度（叠在经费卡之上的内部额度） ----------
create table morningstar_quota (
  id        uuid primary key default gen_random_uuid(),
  leader_id uuid not null references app_user,
  year      int not null,
  amount    numeric(14,2) not null,
  labor_cap_ratio numeric(5,4) not null default 0.3,
  unique (leader_id, year)
);
alter table expense_request add column morningstar_quota_id uuid references morningstar_quota;

-- ---------- 通道与审计 ----------
create table audit_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  actor    uuid,
  action   text not null,
  entity   text not null,
  entity_id uuid,
  detail   jsonb
);

create table feishu_outbox (
  id        bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  target    text not null,                     -- open_id 或 chat_id
  payload   jsonb not null,
  status    text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts  int not null default 0,
  last_error text
);

-- ---------- 旧门户原始数据（导入暂存，转换完成后删除） ----------
create schema legacy;
create table legacy.record (
  table_id   text not null,
  table_name text not null,
  record_id  text not null,
  fields     jsonb not null,
  primary key (table_id, record_id)
);

-- 已结清的卡不能再动
create function trg_card_open() returns trigger language plpgsql as $$
begin
  if exists (select 1 from fund_card where id = new.card_id and status = 'settled') then
    raise exception '经费卡已结清，不能再变更' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger card_open before insert or update on expense_request  for each row execute function trg_card_open();
create trigger card_open before insert or update on budget_change    for each row execute function trg_card_open();
create trigger card_open before insert or update on staff_assignment for each row execute function trg_card_open();
create trigger card_open before insert or update on budget_line      for each row execute function trg_card_open();
