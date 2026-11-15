-- 年度预算改为自上而下：
--   财务岗按明年各项目可用的经费测算总预算，从中划出公共开支等模块，余下的编成档次（每档金额、名额、限制）；
--   中心负责人批准方案后，各课题带着明细申请一个档次；中心负责人在名额内评定；
--   评定完成后，档次金额即课题的年度上限，提交的明细即核定的预算行，转入下达。
-- 向学校申请下达不在这条流程里，归项目一侧。旧的「申报、汇总、报学校、批复、核定」办法保留给没有编档次的年度。

alter table budget_year add column plan_by uuid references app_user, add column plan_at timestamptz;

create table budget_source (
  year            int  not null references budget_year,
  fund_project_id uuid not null references fund_project,
  amount          numeric(14,2) not null check (amount >= 0),   -- 该项目计入这一年度总预算的数
  note            text,
  primary key (year, fund_project_id)
);
create table budget_module (
  id     uuid primary key default gen_random_uuid(),
  year   int  not null references budget_year,
  name   text not null,
  amount numeric(14,2) not null check (amount >= 0),
  note   text,
  unique (year, name)
);
create table budget_tier (
  id          uuid primary key default gen_random_uuid(),
  year        int  not null references budget_year,
  name        text not null,
  amount      numeric(14,2) not null check (amount > 0),        -- 每个课题的金额
  slots       int  not null check (slots > 0),                  -- 名额
  labor_ratio numeric(5,4) check (labor_ratio > 0 and labor_ratio <= 1),   -- 劳务类预算占该档金额的上限
  limits      jsonb not null default '[]',                      -- 其他类别的比例上限：[{category_id, ratio}]
  sort        int  not null default 0,
  unique (year, name)
);
create table tier_pick (
  year            int  not null references budget_year,
  project_id      uuid not null references project,
  tier_id         uuid not null references budget_tier,         -- 申请的档次
  reason          text,
  picked_by       uuid references app_user,
  picked_at       timestamptz not null default now(),
  decided_tier_id uuid references budget_tier,                  -- 评定的档次
  decided_by      uuid references app_user,
  decided_at      timestamptz,
  decide_note     text,
  primary key (year, project_id)
);
select seal('budget_source', 'budget_module', 'budget_tier', 'tier_pick');

-- 总预算、模块合计、档次合计、未分配
create function plan_total(p_year int) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from budget_source where year = p_year $$;
create function plan_room(p_year int) returns numeric language sql stable security definer set search_path = public as $$
  select plan_total(p_year) - (select coalesce(sum(amount), 0) from budget_module where year = p_year)
       - (select coalesce(sum(amount * slots), 0) from budget_tier where year = p_year) $$;

-- 编方案前的共同检查：财务岗、申报阶段、方案尚未批准
create function plan_open(p_year int) returns budget_year language plpgsql security definer set search_path = public as $$
declare y budget_year;
begin
  perform need_perm('budget.setup');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过编制阶段', p_year; end if;
  if y.plan_at is not null then raise exception '% 年度预算方案已批准，修改前请中心负责人撤回批准', p_year; end if;
  return y;
end $$;
create function plan_fits(p_year int) returns void language plpgsql security definer set search_path = public as $$
declare r numeric := plan_room(p_year);
begin
  if r < 0 then raise exception '模块和档次合计超过总预算，超出 %', -r; end if;
end $$;

create function save_budget_source(p_year int, p_fund_project uuid, p_amount numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform plan_open(p_year);
  if not exists (select 1 from fund_project where id = p_fund_project and not auto) then raise exception '项目不存在'; end if;
  if p_amount is null or p_amount = 0 then
    delete from budget_source where year = p_year and fund_project_id = p_fund_project;
  else
    if p_amount < 0 then raise exception '金额不得为负'; end if;
    insert into budget_source (year, fund_project_id, amount, note) values (p_year, p_fund_project, p_amount, nullif(btrim(coalesce(p_note, '')), ''))
    on conflict (year, fund_project_id) do update set amount = excluded.amount, note = excluded.note;
  end if;
  perform plan_fits(p_year);
end $$;

create function save_budget_module(p_id uuid, p_year int, p_name text, p_amount numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); mid uuid; yr int := p_year;
begin
  if p_id is not null then select year into yr from budget_module where id = p_id; if not found then raise exception '模块不存在'; end if; end if;
  perform plan_open(yr);
  if p_id is not null and p_amount is null then delete from budget_module where id = p_id; return null; end if;
  if n = '' then raise exception '请填写模块名称'; end if;
  if p_amount is null or p_amount < 0 then raise exception '请填写金额'; end if;
  if exists (select 1 from budget_module where year = yr and name = n and id is distinct from p_id) then raise exception '已有同名模块'; end if;
  if p_id is null then
    insert into budget_module (year, name, amount, note) values (yr, n, p_amount, nullif(btrim(coalesce(p_note, '')), '')) returning id into mid;
  else
    update budget_module set name = n, amount = p_amount, note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id returning id into mid;
  end if;
  perform plan_fits(yr);
  return mid;
end $$;

create function save_budget_tier(p_id uuid, p_year int, p_name text, p_amount numeric, p_slots int, p_labor_ratio numeric default null, p_limits jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); tid uuid; yr int := p_year; lim jsonb := coalesce(p_limits, '[]'::jsonb); e jsonb;
begin
  if p_id is not null then select year into yr from budget_tier where id = p_id; if not found then raise exception '档次不存在'; end if; end if;
  perform plan_open(yr);
  if p_id is not null and p_amount is null then delete from budget_tier where id = p_id; return null; end if;
  if n = '' then raise exception '请填写档次名称'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '请填写每个课题的金额'; end if;
  if p_slots is null or p_slots <= 0 then raise exception '请填写名额'; end if;
  if p_labor_ratio is not null and (p_labor_ratio <= 0 or p_labor_ratio > 1) then raise exception '劳务类比例上限须在 0 到 100%% 之间'; end if;
  if jsonb_typeof(lim) <> 'array' then raise exception '限制格式有误'; end if;
  for e in select * from jsonb_array_elements(lim) loop
    if not exists (select 1 from budget_category where id = (e->>'category_id')::uuid) then raise exception '限制中的类别不存在'; end if;
    if (e->>'ratio')::numeric <= 0 or (e->>'ratio')::numeric > 1 then raise exception '类别比例上限须在 0 到 100%% 之间'; end if;
  end loop;
  if exists (select 1 from budget_tier where year = yr and name = n and id is distinct from p_id) then raise exception '已有同名档次'; end if;
  if p_id is null then
    insert into budget_tier (year, name, amount, slots, labor_ratio, limits, sort)
    values (yr, n, p_amount, p_slots, p_labor_ratio, lim, (select coalesce(max(sort), 0) + 10 from budget_tier where year = yr)) returning id into tid;
  else
    update budget_tier set name = n, amount = p_amount, slots = p_slots, labor_ratio = p_labor_ratio, limits = lim where id = p_id returning id into tid;
  end if;
  perform plan_fits(yr);
  return tid;
end $$;

-- 批准方案、撤回批准
create function publish_budget_plan(p_year int, p_on boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过编制阶段', p_year; end if;
  if coalesce(p_on, true) then
    if y.plan_at is not null then raise exception '方案已批准'; end if;
    if plan_total(p_year) <= 0 then raise exception '尚未测算总预算'; end if;
    if not exists (select 1 from budget_tier where year = p_year) then raise exception '尚未编制档次'; end if;
    perform plan_fits(p_year);
    update budget_year set plan_by = app_uid(), plan_at = now() where year = p_year;
  else
    if y.plan_at is null then raise exception '方案尚未批准'; end if;
    if exists (select 1 from tier_pick where year = p_year) then raise exception '已有课题申请档次，不得撤回批准'; end if;
    update budget_year set plan_by = null, plan_at = null where year = p_year;
  end if;
end $$;

-- 课题连同研究单元已提交的明细是否符合某一档：不符合时返回原因
create function tier_violation(p_year int, p_big uuid, p_tier uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare t budget_tier; tot numeric; lab numeric; e jsonb; c numeric; cn text;
begin
  select * into t from budget_tier where id = p_tier;
  select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0), coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4) filter (where k.labor), 0) into tot, lab
  from project_budget_line l join project_budget b on b.id = l.budget_id join project p on p.id = b.project_id join budget_category k on k.id = l.category_id
  where b.year = p_year and b.status = 'submitted' and (p.id = p_big or p.parent_id = p_big);
  if tot > t.amount then return format('明细合计 %s 超过「%s」的金额 %s，超出 %s', tot, t.name, t.amount, tot - t.amount); end if;
  if t.labor_ratio is not null and lab > round(t.amount * t.labor_ratio, 2) then
    return format('劳务类预算 %s 超过「%s」的上限 %s（%s%%）', lab, t.name, round(t.amount * t.labor_ratio, 2), round(t.labor_ratio * 100));
  end if;
  for e in select * from jsonb_array_elements(t.limits) loop
    select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0) into c
    from project_budget_line l join project_budget b on b.id = l.budget_id join project p on p.id = b.project_id
    where b.year = p_year and b.status = 'submitted' and (p.id = p_big or p.parent_id = p_big) and l.category_id = (e->>'category_id')::uuid;
    if c > round(t.amount * (e->>'ratio')::numeric, 2) then
      select name into cn from budget_category where id = (e->>'category_id')::uuid;
      return format('「%s」类预算 %s 超过「%s」的上限 %s（%s%%）', cn, c, t.name, round(t.amount * (e->>'ratio')::numeric, 2), round((e->>'ratio')::numeric * 100));
    end if;
  end loop;
  return null;
end $$;

-- 课题申请档次
create function pick_tier(p_year int, p_project uuid, p_tier uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; p project; t budget_tier; k tier_pick; bad text;
begin
  if not can_edit_project(p_project) then raise exception '仅课题负责人和财务岗可申请档次' using errcode = '42501'; end if;
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过申请阶段', p_year; end if;
  if y.plan_at is null then raise exception '% 年度预算方案尚未批准，暂不能申请档次', p_year; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'big' or p.kind = 'public' then raise exception '档次按课题申请；研究单元计入所属课题，中心公共开支不申请档次'; end if;
  select * into t from budget_tier where id = p_tier and year = p_year;
  if not found then raise exception '档次不存在'; end if;
  select * into k from tier_pick where year = p_year and project_id = p_project for update;
  if found and k.decided_tier_id is not null then raise exception '该课题已评定，不得再改申请的档次'; end if;
  bad := tier_violation(p_year, p_project, p_tier);
  if bad is not null then raise exception '已提交的%；请先撤回相应预算并调整明细', bad; end if;
  insert into tier_pick (year, project_id, tier_id, reason, picked_by) values (p_year, p_project, p_tier, nullif(btrim(coalesce(p_reason, '')), ''), app_uid())
  on conflict (year, project_id) do update set tier_id = excluded.tier_id, reason = excluded.reason, picked_by = excluded.picked_by, picked_at = now();
end $$;

-- 编了档次的年度：提交预算时须已选档次，且课题连同研究单元已提交的明细符合该档
create function trg_tier_submit() returns trigger language plpgsql security definer set search_path = public as $$
declare p project; big uuid; k tier_pick; bad text;
begin
  if not exists (select 1 from budget_tier where year = new.year) then return new; end if;
  select * into p from project where id = new.project_id;
  big := coalesce(p.parent_id, p.id);
  if (select kind from project where id = big) = 'public' then return new; end if;
  select * into k from tier_pick where year = new.year and project_id = big;
  if not found then raise exception '请先为课题选择申请的档次，再提交预算'; end if;
  bad := tier_violation(new.year, big, coalesce(k.decided_tier_id, k.tier_id));
  if bad is not null then raise exception '%', bad; end if;
  return new;
end $$;
create trigger tier_submit after update of status on project_budget for each row
  when (new.status = 'submitted' and old.status is distinct from 'submitted') execute function trg_tier_submit();

-- 评定：在名额内定档。p_tier 为空表示撤销评定
create function decide_tier(p_year int, p_project uuid, p_tier uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; k tier_pick; t budget_tier; n int; bad text;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过评定阶段', p_year; end if;
  select * into k from tier_pick where year = p_year and project_id = p_project for update;
  if not found then raise exception '该课题尚未申请档次'; end if;
  if p_tier is null then
    update tier_pick set decided_tier_id = null, decided_by = null, decided_at = null, decide_note = null where year = p_year and project_id = p_project;
    return;
  end if;
  select * into t from budget_tier where id = p_tier and year = p_year;
  if not found then raise exception '档次不存在'; end if;
  select count(*) into n from tier_pick where year = p_year and decided_tier_id = p_tier and project_id <> p_project;
  if n >= t.slots then raise exception '「%」的名额 % 个已评满', t.name, t.slots; end if;
  bad := tier_violation(p_year, p_project, p_tier);
  if bad is not null then raise exception '%；请退回该课题调整明细后再评定', bad; end if;
  update tier_pick set decided_tier_id = p_tier, decided_by = app_uid(), decided_at = now(), decide_note = nullif(btrim(coalesce(p_note, '')), '')
  where year = p_year and project_id = p_project;
end $$;

-- 评定完成：档次金额成为课题的年度上限，已提交的明细成为核定的预算行，转入下达
create function settle_tiers(p_year int) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; n int; s numeric; tot numeric;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过评定阶段', p_year; end if;
  if y.plan_at is null then raise exception '% 年度预算方案尚未批准', p_year; end if;
  select count(*) into n from tier_pick where year = p_year and decided_tier_id is null;
  if n > 0 then raise exception '尚有 % 个课题未评定', n; end if;
  if not exists (select 1 from tier_pick where year = p_year) then raise exception '尚无课题申请档次'; end if;
  -- 未评定档次的课题（没有申请的）名下已提交的预算不得带入
  select count(*) into n from project_budget b join project p on p.id = b.project_id join project g on g.id = coalesce(p.parent_id, p.id)
  where b.year = p_year and b.status = 'submitted' and g.kind <> 'public' and not exists (select 1 from tier_pick k where k.year = p_year and k.project_id = g.id);
  if n > 0 then raise exception '有 % 份已提交的预算所属课题没有申请档次，请先退回或补办申请', n; end if;
  update project_budget_line l set applied = l.q1 + l.q2 + l.q3 + l.q4, fixed = l.q1 + l.q2 + l.q3 + l.q4, adjust_note = null
  from project_budget b where b.id = l.budget_id and b.year = p_year and b.status = 'submitted';
  tot := plan_total(p_year);
  select coalesce(sum(l.fixed), 0) into s from project_budget_line l join project_budget b on b.id = l.budget_id where b.year = p_year and b.status = 'submitted';
  if s > tot then raise exception '各课题和公共开支的明细合计 % 超过总预算 %，超出 %', s, tot, s - tot; end if;
  insert into project_cap (year, project_id, amount, set_by)
  select k.year, k.project_id, t.amount, app_uid() from tier_pick k join budget_tier t on t.id = k.decided_tier_id where k.year = p_year
  on conflict (year, project_id) do update set amount = excluded.amount, set_by = excluded.set_by, set_at = now();
  update budget_year set stage = 'fixed', fixed_total = tot, fixed_by = app_uid(), fixed_at = now() where year = p_year;
end $$;

-- 撤回评定完成：回到评定阶段。已有预算行下达到经费卡的不得撤回
create function unsettle_tiers(p_year int) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage <> 'fixed' or not exists (select 1 from budget_tier where year = p_year) then raise exception '当前阶段不可撤回'; end if;
  if exists (select 1 from v_line where year = p_year and allocated > 0) then raise exception '已有预算行下达至经费卡，请先撤销下达再撤回'; end if;
  update project_budget_line l set applied = null, fixed = null from project_budget b where b.id = l.budget_id and b.year = p_year;
  delete from project_cap where year = p_year;
  update budget_year set stage = 'declare', fixed_total = null, fixed_by = null, fixed_at = null where year = p_year;
end $$;

-- 编了档次的年度不走旧的「截止申报、汇总」
do $$
declare d text := pg_get_functiondef('public.advance_budget_year(integer, text, numeric, date)'::regprocedure); n text;
begin
  n := replace(d, $a$    if y.stage <> 'declare' then raise exception '% 年度预算不在申报阶段', p_year; end if;$a$,
    $a$    if y.stage <> 'declare' then raise exception '% 年度预算不在申报阶段', p_year; end if;
    if exists (select 1 from budget_tier where year = p_year) then raise exception '% 年度预算按档次评定，请在「总预算与档次」中办理评定', p_year; end if;$a$);
  if n = d then raise exception '未找到截止申报的检查'; end if;
  execute n;
end $$;

select expose('save_budget_source(int, uuid, numeric, text)', 'save_budget_module(uuid, int, text, numeric, text)',
  'save_budget_tier(uuid, int, text, numeric, int, numeric, jsonb)', 'publish_budget_plan(int, boolean)',
  'pick_tier(int, uuid, uuid, text)', 'decide_tier(int, uuid, uuid, text)', 'settle_tiers(int)', 'unsettle_tiers(int)');
do $$ declare r text; begin
  -- 视图里用到的 plan_total、tier_violation 须保留默认的执行权限
  foreach r in array array['plan_open(int)', 'plan_fits(int)'] loop
    execute format('revoke all on function %s from public', r);
  end loop;
end $$;

-- 视图
create view api.budget_plan as
  select y.year, y.plan_at is not null as published, y.plan_at, (select name from app_user where id = y.plan_by) as plan_by_name,
         case when has_perm('read.finance') then plan_total(y.year) end as total,
         case when has_perm('read.finance') then (select coalesce(sum(amount), 0) from budget_module m where m.year = y.year) end as modules,
         (select coalesce(sum(amount * slots), 0) from budget_tier t where t.year = y.year and (y.plan_at is not null or has_perm('read.finance'))) as tiers
  from budget_year y where app_role() is not null;
create view api.budget_source as
  select s.year, s.fund_project_id, s.amount, s.note from budget_source s where has_perm('read.finance');
create view api.budget_module as
  select m.id, m.year, m.name, m.amount, m.note from budget_module m where has_perm('read.finance');
create view api.budget_tier as
  select t.id, t.year, t.name, t.amount, t.slots, t.labor_ratio, t.limits, t.sort,
         (select count(*) from tier_pick k where k.tier_id = t.id)::int as picked,
         (select count(*) from tier_pick k where k.decided_tier_id = t.id)::int as decided
  from budget_tier t join budget_year y on y.year = t.year
  where app_role() is not null and (y.plan_at is not null or has_perm('read.finance'));
create view api.tier_pick as
  select k.year, k.project_id, p.name as project_name, (select name from app_user where id = p.owner_id) as owner_name,
         k.tier_id, k.reason, k.picked_at, k.decided_tier_id, k.decide_note, k.decided_at,
         (select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0) from project_budget_line l join project_budget b on b.id = l.budget_id join project q on q.id = b.project_id
           where b.year = k.year and b.status = 'submitted' and (q.id = k.project_id or q.parent_id = k.project_id)) as total,
         (select count(*) from project_budget b join project q on q.id = b.project_id
           where b.year = k.year and b.status <> 'submitted' and (q.id = k.project_id or q.parent_id = k.project_id)
             and exists (select 1 from project_budget_line l where l.budget_id = b.id))::int as drafts,
         tier_violation(k.year, k.project_id, coalesce(k.decided_tier_id, k.tier_id)) as violation
  from tier_pick k join project p on p.id = k.project_id where can_see_project(k.project_id);
grant select on api.budget_plan, api.budget_source, api.budget_module, api.budget_tier, api.tier_pick to app_api;
