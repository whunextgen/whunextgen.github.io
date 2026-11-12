-- 年度预算编制：预算这一段的前三步。
--   01 申报      各项目按科目、按三个月预算期报下一年要用的钱；中心公共开支由财务岗列
--   02 汇总报批  财务岗汇总、调整出申请数，中心负责人批准后报学校
--   03 核定下达  学校批复后录入批复数，按联席会议的决定定各项目核定数，中心负责人确定年度总预算
-- 每一行存三个数，互不覆盖：申报数（四个预算期之和）、申请数（报学校的）、核定数（批复后定的）。
-- 把核定数对到经费卡和科目上（下达）在后续迁移里做，这里只留出 issued 这个阶段。

create table project (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  kind       text not null default 'project' check (kind in ('project','line','public')),  -- 研究项目 / 独立研究线 / 中心公共开支
  owner_id   uuid references app_user,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- 中心自己的预算科目。申报按它填；和学校经费卡科目的对应在下达时由财务岗定。
create table budget_category (
  id     uuid primary key default gen_random_uuid(),
  code   text not null unique,
  name   text not null,
  labor  boolean not null default false,     -- 劳务类，用于劳务上限
  sort   int not null default 0,
  active boolean not null default true
);
insert into budget_category (code, name, labor, sort) values
  ('EQUIP', '设备', false, 10), ('COMPUTE', '算力与模型接口', false, 20), ('MATERIAL', '材料与数据', false, 30),
  ('LABOR', '劳务费', true, 40), ('TRAVEL', '差旅', false, 50), ('MEETING', '会议与交流', false, 60),
  ('PUBLISH', '出版与知识产权', false, 70), ('OTHER', '其他', false, 90);

create table budget_year (
  year           int primary key check (year between 2020 and 2100),
  due_date       date not null,               -- 申报截止日
  stage          text not null default 'declare'
                 check (stage in ('declare','summary','approved','applied','granted','fixed','issued')),
  approved_by    uuid references app_user,    -- 批准申请数的中心负责人
  approved_at    timestamptz,
  applied_on     date,                        -- 报学校的日期
  granted_amount numeric(14,2),               -- 学校批复数
  granted_on     date,
  fixed_total    numeric(14,2),               -- 中心负责人确定的年度总预算
  fixed_by       uuid references app_user,
  fixed_at       timestamptz,
  created_at     timestamptz not null default now()
);

create table project_budget (
  id           uuid primary key default gen_random_uuid(),
  year         int not null references budget_year,
  project_id   uuid not null references project,
  status       text not null default 'draft' check (status in ('draft','submitted','returned')),
  return_note  text,
  submitted_by uuid references app_user,
  submitted_at timestamptz,
  unique (year, project_id)
);

create table project_budget_line (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references project_budget on delete cascade,
  category_id uuid not null references budget_category,
  purpose     text not null,
  q1 numeric(14,2) not null default 0 check (q1 >= 0),   -- 四个三个月预算期
  q2 numeric(14,2) not null default 0 check (q2 >= 0),
  q3 numeric(14,2) not null default 0 check (q3 >= 0),
  q4 numeric(14,2) not null default 0 check (q4 >= 0),
  applied     numeric(14,2) check (applied >= 0),        -- 申请数
  adjust_note text,                                      -- 申请数和申报数不同时的说明
  fixed       numeric(14,2) check (fixed >= 0)           -- 核定数
);
create index on project_budget_line (budget_id);

select seal('project', 'budget_category', 'budget_year', 'project_budget', 'project_budget_line');
do $$ declare t text; begin
  foreach t in array array['project','budget_category','budget_year','project_budget','project_budget_line'] loop
    execute format('create trigger audit after insert or update or delete on %I for each row execute function trg_audit()', t);
  end loop;
end $$;

-- ---------- 身份 ----------
create function can_edit_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select is_staff() or exists (select 1 from project where id = p_project and owner_id = app_uid() and active)
$$;

create function lock_year(p_year int) returns budget_year language plpgsql as $$
declare y budget_year;
begin
  select * into y from budget_year where year = p_year for update;
  if not found then raise exception '% 年度预算还没有开始', p_year; end if;
  return y;
end $$;

-- ---------- 主数据 ----------
create function save_project(p_id uuid, p_code text, p_name text, p_kind text, p_owner uuid, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare c text := btrim(coalesce(p_code, '')); n text := btrim(coalesce(p_name, '')); pid uuid;
begin
  perform need_role('finance','director');
  if c = '' then raise exception '请填写项目编号'; end if;
  if n = '' then raise exception '请填写项目名称'; end if;
  if length(n) > 60 then raise exception '项目名称不能超过 60 个字'; end if;
  if p_kind is null or p_kind not in ('project','line','public') then raise exception '类型只能是研究项目、独立研究线或中心公共开支'; end if;
  if p_owner is not null and not exists (select 1 from app_user where id = p_owner and active) then raise exception '负责人不存在或已停用'; end if;
  if exists (select 1 from project where code = c and id is distinct from p_id) then raise exception '已经有编号为「%」的项目', c; end if;
  if p_id is null then
    insert into project (code, name, kind, owner_id, active) values (c, n, p_kind, p_owner, coalesce(p_active, true)) returning id into pid;
  else
    update project set code = c, name = n, kind = p_kind, owner_id = p_owner, active = coalesce(p_active, true) where id = p_id returning id into pid;
    if pid is null then raise exception '项目不存在'; end if;
  end if;
  return pid;
end $$;

create function save_budget_category(p_id uuid, p_code text, p_name text, p_labor boolean, p_sort int, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare c text := btrim(coalesce(p_code, '')); n text := btrim(coalesce(p_name, '')); cid uuid;
begin
  perform need_role('finance','director');
  if c = '' then raise exception '请填写科目代码'; end if;
  if n = '' then raise exception '请填写科目名称'; end if;
  if exists (select 1 from budget_category where code = c and id is distinct from p_id) then raise exception '已经有代码为「%」的科目', c; end if;
  if p_id is null then
    insert into budget_category (code, name, labor, sort, active) values (c, n, coalesce(p_labor, false), coalesce(p_sort, 0), coalesce(p_active, true)) returning id into cid;
  else
    update budget_category set code = c, name = n, labor = coalesce(p_labor, false), sort = coalesce(p_sort, 0), active = coalesce(p_active, true)
    where id = p_id returning id into cid;
    if cid is null then raise exception '科目不存在'; end if;
  end if;
  return cid;
end $$;

-- ---------- 01 申报 ----------
-- 开始一个年度的预算，或者在申报阶段改截止日
create function open_budget_year(p_year int, p_due date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if p_year is null or p_year < 2020 or p_year > 2100 then raise exception '请填写年度'; end if;
  if p_due is null then raise exception '请填写申报截止日'; end if;
  if exists (select 1 from budget_year where year = p_year and stage <> 'declare') then raise exception '% 年度预算已经过了申报阶段，截止日不能再改', p_year; end if;
  insert into budget_year (year, due_date) values (p_year, p_due) on conflict (year) do update set due_date = excluded.due_date;
end $$;

create function save_budget_line(p_id uuid, p_year int, p_project uuid, p_category uuid, p_purpose text,
                                 p_q1 numeric, p_q2 numeric, p_q3 numeric, p_q4 numeric) returns uuid
language plpgsql security definer set search_path = public as $$
declare y budget_year; b project_budget; lid uuid; t text := btrim(coalesce(p_purpose, ''));
  a numeric[] := array[coalesce(p_q1, 0), coalesce(p_q2, 0), coalesce(p_q3, 0), coalesce(p_q4, 0)];
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if p_id is not null then
    select b2.year, b2.project_id into p_year, p_project from project_budget_line l join project_budget b2 on b2.id = l.budget_id where l.id = p_id;
    if not found then raise exception '这一行不存在'; end if;
  end if;
  if not can_edit_project(p_project) then raise exception '只有项目负责人和财务岗能填这个项目的预算' using errcode = '42501'; end if;
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算的申报已经截止', p_year; end if;
  if not exists (select 1 from budget_category where id = p_category and active) then raise exception '科目不存在或已停用'; end if;
  if t = '' then raise exception '请写明这笔钱做什么用'; end if;
  if length(t) > 200 then raise exception '用途不能超过 200 个字'; end if;
  if exists (select 1 from unnest(a) v where v < 0) then raise exception '金额不能是负数'; end if;
  if a[1] + a[2] + a[3] + a[4] <= 0 then raise exception '四个预算期至少有一期要填金额'; end if;
  insert into project_budget (year, project_id) values (p_year, p_project) on conflict (year, project_id) do nothing;
  select * into b from project_budget where year = p_year and project_id = p_project for update;
  if b.status = 'submitted' then raise exception '这个项目的预算已经提交；要改先撤回'; end if;
  if p_id is null then
    insert into project_budget_line (budget_id, category_id, purpose, q1, q2, q3, q4) values (b.id, p_category, t, a[1], a[2], a[3], a[4]) returning id into lid;
  else
    update project_budget_line set category_id = p_category, purpose = t, q1 = a[1], q2 = a[2], q3 = a[3], q4 = a[4] where id = p_id returning id into lid;
  end if;
  return lid;
end $$;

create function delete_budget_line(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b project_budget; y budget_year;
begin
  select pb.* into b from project_budget_line l join project_budget pb on pb.id = l.budget_id where l.id = p_id;
  if not found then raise exception '这一行不存在'; end if;
  if not can_edit_project(b.project_id) then raise exception '只有项目负责人和财务岗能改这个项目的预算' using errcode = '42501'; end if;
  y := lock_year(b.year);
  if y.stage <> 'declare' then raise exception '% 年度预算的申报已经截止', b.year; end if;
  if b.status = 'submitted' then raise exception '这个项目的预算已经提交；要改先撤回'; end if;
  delete from project_budget_line where id = p_id;
end $$;

-- 提交、撤回、退回。p_action：submit / withdraw / return
create function set_project_budget(p_year int, p_project uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; b project_budget; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  y := lock_year(p_year);
  select * into b from project_budget where year = p_year and project_id = p_project for update;
  if not found then raise exception '这个项目还没有填预算'; end if;
  if p_action = 'submit' then
    if not can_edit_project(p_project) then raise exception '只有项目负责人和财务岗能提交' using errcode = '42501'; end if;
    if y.stage <> 'declare' then raise exception '% 年度预算的申报已经截止', p_year; end if;
    if b.status = 'submitted' then raise exception '已经提交过了'; end if;
    if not exists (select 1 from project_budget_line where budget_id = b.id) then raise exception '还没有填任何一行预算'; end if;
    update project_budget set status = 'submitted', return_note = null, submitted_by = app_uid(), submitted_at = now() where id = b.id;
  elsif p_action = 'withdraw' then
    if not can_edit_project(p_project) then raise exception '只有项目负责人和财务岗能撤回' using errcode = '42501'; end if;
    if y.stage <> 'declare' then raise exception '申报已经截止，不能撤回；需要修改请联系财务岗'; end if;
    if b.status <> 'submitted' then raise exception '这份预算没有提交'; end if;
    update project_budget set status = 'draft' where id = b.id;
  elsif p_action = 'return' then
    perform need_role('finance','director');
    if y.stage <> 'declare' then raise exception '申报已经截止；要退回先把年度预算退回申报阶段'; end if;
    if b.status <> 'submitted' then raise exception '这份预算没有提交'; end if;
    if n is null then raise exception '请写明退回原因'; end if;
    update project_budget set status = 'returned', return_note = n where id = b.id;
  else
    raise exception '不认识的操作';
  end if;
end $$;

-- ---------- 02 汇总报批 ----------
-- 推进年度预算的阶段。p_action：
--   close    财务岗截止申报，进入汇总；已提交的行以申报数作为申请数的起点
--   reopen   退回上一步（汇总 → 申报，会清空申请数的调整；已批准 → 汇总，只有中心负责人能做）
--   approve  中心负责人批准申请数
--   apply    财务岗登记已报学校（p_on 报送日期）
--   grant    财务岗录入学校批复数（p_amount、p_on）；核定数以申请数为起点
--   fix      中心负责人确定年度总预算（p_amount），各项目核定数合计不能超过它
create function advance_budget_year(p_year int, p_action text, p_amount numeric default null, p_on date default null) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; s numeric;
begin
  y := lock_year(p_year);
  if p_action = 'close' then
    perform need_role('finance','director');
    if y.stage <> 'declare' then raise exception '% 年度预算不在申报阶段', p_year; end if;
    if not exists (select 1 from project_budget where year = p_year and status = 'submitted') then raise exception '还没有项目提交预算'; end if;
    update project_budget_line l set applied = l.q1 + l.q2 + l.q3 + l.q4, adjust_note = null
    from project_budget b where b.id = l.budget_id and b.year = p_year and b.status = 'submitted';
    update budget_year set stage = 'summary' where year = p_year;
  elsif p_action = 'reopen' then
    if y.stage = 'summary' then
      perform need_role('finance','director');
      update project_budget_line l set applied = null, adjust_note = null from project_budget b where b.id = l.budget_id and b.year = p_year;
      update budget_year set stage = 'declare' where year = p_year;
    elsif y.stage = 'approved' then
      perform need_role('director');
      update budget_year set stage = 'summary', approved_by = null, approved_at = null where year = p_year;
    else
      raise exception '这个阶段不能退回';
    end if;
  elsif p_action = 'approve' then
    perform need_role('director');
    if y.stage <> 'summary' then raise exception '% 年度预算不在汇总阶段', p_year; end if;
    update budget_year set stage = 'approved', approved_by = app_uid(), approved_at = now() where year = p_year;
  elsif p_action = 'apply' then
    perform need_role('finance','director');
    if y.stage <> 'approved' then raise exception '中心负责人批准之后才能报学校'; end if;
    update budget_year set stage = 'applied', applied_on = coalesce(p_on, app_today()) where year = p_year;
  elsif p_action = 'grant' then
    perform need_role('finance','director');
    if y.stage not in ('applied','granted') then raise exception '报学校之后才能录入批复数'; end if;
    if p_amount is null or p_amount < 0 then raise exception '请填写学校批复数'; end if;
    update project_budget_line l set fixed = l.applied
    from project_budget b where b.id = l.budget_id and b.year = p_year and b.status = 'submitted' and l.fixed is null;
    update budget_year set stage = 'granted', granted_amount = p_amount, granted_on = coalesce(p_on, app_today()) where year = p_year;
  elsif p_action = 'fix' then
    perform need_role('director');
    if y.stage <> 'granted' then raise exception '录入学校批复数之后才能核定'; end if;
    if p_amount is null or p_amount <= 0 then raise exception '请填写年度总预算'; end if;
    select coalesce(sum(l.fixed), 0) into s from project_budget_line l join project_budget b on b.id = l.budget_id where b.year = p_year and b.status = 'submitted';
    if s > p_amount then raise exception '各项目核定数合计 % 超过年度总预算 %，超出 %', s, p_amount, s - p_amount; end if;
    update budget_year set stage = 'fixed', fixed_total = p_amount, fixed_by = app_uid(), fixed_at = now() where year = p_year;
  else
    raise exception '不认识的操作';
  end if;
end $$;

-- 财务岗在汇总表上逐行调整。汇总阶段改申请数，批复之后改核定数。
create function adjust_budget_line(p_id uuid, p_amount numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare l project_budget_line; b project_budget; y budget_year; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director');
  select * into l from project_budget_line where id = p_id;
  if not found then raise exception '这一行不存在'; end if;
  select * into b from project_budget where id = l.budget_id;
  y := lock_year(b.year);
  if b.status <> 'submitted' then raise exception '这个项目的预算没有提交，不在汇总里'; end if;
  if p_amount is null or p_amount < 0 then raise exception '金额不能为空，也不能是负数'; end if;
  if y.stage = 'summary' then
    if p_amount <> l.q1 + l.q2 + l.q3 + l.q4 and n is null then raise exception '申请数和申报数不一样时，请写明原因'; end if;
    update project_budget_line set applied = p_amount, adjust_note = case when p_amount = l.q1 + l.q2 + l.q3 + l.q4 then null else n end where id = p_id;
  elsif y.stage = 'granted' then
    update project_budget_line set fixed = p_amount where id = p_id;
  else
    raise exception '现在这个阶段不能调整金额';
  end if;
end $$;

-- ---------- 只读视图 ----------
create view api.project as
  select p.id, p.code, p.name, p.kind, p.owner_id, u.name as owner_name, p.active,
         (is_staff() or p.owner_id = app_uid()) as mine
  from project p left join app_user u on u.id = p.owner_id
  where app_role() is not null and (p.active or is_staff());

create view api.budget_category as
  select id, code, name, labor, sort, active from budget_category where app_role() is not null and (active or is_staff());

-- 年度和阶段所有人都能看；金额只给财务岗和中心负责人
create view api.budget_year as
  select y.year, y.due_date, y.stage, y.applied_on, y.granted_on, y.approved_at, a.name as approved_by_name,
         case when is_staff() then y.granted_amount end as granted_amount,
         case when is_staff() then y.fixed_total end as fixed_total
  from budget_year y left join app_user a on a.id = y.approved_by
  where app_role() is not null;

create view api.project_budget as
  select b.id, b.year, b.project_id, b.status, b.return_note, b.submitted_at, s.name as submitted_by_name
  from project_budget b left join app_user s on s.id = b.submitted_by
  where can_edit_project(b.project_id);

create view api.budget_line as
  select l.id, l.budget_id, b.year, b.project_id, l.category_id, l.purpose, l.q1, l.q2, l.q3, l.q4,
         l.q1 + l.q2 + l.q3 + l.q4 as declared, l.applied, l.adjust_note, l.fixed
  from project_budget_line l join project_budget b on b.id = l.budget_id
  where can_edit_project(b.project_id);

grant select on api.project, api.budget_category, api.budget_year, api.project_budget, api.budget_line to app_api;

select expose(
  'can_edit_project(uuid)',
  'save_project(uuid, text, text, text, uuid, boolean)', 'save_budget_category(uuid, text, text, boolean, int, boolean)',
  'open_budget_year(int, date)', 'save_budget_line(uuid, int, uuid, uuid, text, numeric, numeric, numeric, numeric)',
  'delete_budget_line(uuid)', 'set_project_budget(int, uuid, text, text)',
  'advance_budget_year(int, text, numeric, date)', 'adjust_budget_line(uuid, numeric, text)');
do $$ declare r text; begin
  execute 'revoke all on function lock_year(int) from public';
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function lock_year(int) from %I', r); end if;
  end loop;
end $$;
