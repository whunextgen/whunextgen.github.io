-- 模块也是课题：总预算里先行划出的每一块（如中心公共开支）对应一个课题，和其他课题一样有负责人、成员、明细和支出，
--   区别只在金额的来源：模块的金额由预算方案直接确定，不参加档次评定；其他课题的金额来自评定的档次。
alter table budget_module add column project_id uuid references project;

-- 已有的模块按名称对上现有课题
update budget_module m set project_id = p.id from project p where m.project_id is null and p.layer = 'big' and p.active and p.name = m.name;

drop function save_budget_module(uuid, int, text, numeric, text);
create function save_budget_module(p_id uuid, p_year int, p_name text, p_amount numeric, p_note text default null, p_project uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); mid uuid; yr int := p_year; pid uuid := p_project; c text; i int;
begin
  if p_id is not null then select year, coalesce(p_project, project_id) into yr, pid from budget_module where id = p_id; if not found then raise exception '模块不存在'; end if; end if;
  perform plan_open(yr);
  if p_id is not null and p_amount is null then delete from budget_module where id = p_id; return null; end if;
  if n = '' then raise exception '请填写模块名称'; end if;
  if p_amount is null or p_amount < 0 then raise exception '请填写金额'; end if;
  if exists (select 1 from budget_module where year = yr and name = n and id is distinct from p_id) then raise exception '已有同名模块'; end if;
  -- 对应的课题：指定的；否则同名的现有课题；都没有则新建一个
  if pid is not null then
    if not exists (select 1 from project where id = pid and layer = 'big' and active and not proposed) then raise exception '所选课题不存在或尚未立项'; end if;
  else
    select id into pid from project where layer = 'big' and active and name = n limit 1;
    if pid is null then
      perform pg_advisory_xact_lock(hashtext('project_code:new'));
      select coalesce(max(substring(code from '^P-(\d+)$')::int), 0) + 1 into i from project where code ~ '^P-\d+$';
      loop
        c := 'P-' || lpad(i::text, 2, '0');
        exit when not exists (select 1 from project where code = c);
        i := i + 1;
      end loop;
      insert into project (code, name, kind, owner_id, active, layer, parent_id) values (c, n, 'project', null, true, 'big', null) returning id into pid;
    end if;
  end if;
  if exists (select 1 from budget_module where year = yr and project_id = pid and id is distinct from p_id) then raise exception '该课题已对应本年度的另一个模块'; end if;
  if exists (select 1 from tier_pick where year = yr and project_id = pid) then raise exception '该课题已申请档次，不能同时作为模块'; end if;
  if p_id is null then
    insert into budget_module (year, name, amount, note, project_id) values (yr, n, p_amount, nullif(btrim(coalesce(p_note, '')), ''), pid) returning id into mid;
  else
    update budget_module set name = n, amount = p_amount, note = nullif(btrim(coalesce(p_note, '')), ''), project_id = pid where id = p_id returning id into mid;
  end if;
  perform plan_fits(yr);
  return mid;
end $$;
select expose('save_budget_module(uuid, int, text, numeric, text, uuid)');

-- 模块对应的课题连同研究单元已提交的明细合计
create function module_used(p_year int, p_big uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0)
  from project_budget_line l join project_budget b on b.id = l.budget_id join project p on p.id = b.project_id
  where b.year = p_year and b.status = 'submitted' and (p.id = p_big or p.parent_id = p_big) $$;

-- 提交预算时：模块对应的课题按模块金额把关；其余课题按所选档次把关
create or replace function trg_tier_submit() returns trigger language plpgsql security definer set search_path = public as $$
declare p project; big uuid; k tier_pick; bad text; m budget_module; u numeric;
begin
  if not exists (select 1 from budget_tier where year = new.year) and not exists (select 1 from budget_module where year = new.year) then return new; end if;
  select * into p from project where id = new.project_id;
  big := coalesce(p.parent_id, p.id);
  select * into m from budget_module where year = new.year and project_id = big;
  if found then
    u := module_used(new.year, big);
    if u > m.amount then raise exception '明细合计 % 超过模块「%」的金额 %，超出 %', u, m.name, m.amount, u - m.amount; end if;
    return new;
  end if;
  if (select kind from project where id = big) = 'public' then return new; end if;
  if not exists (select 1 from budget_tier where year = new.year) then return new; end if;
  select * into k from tier_pick where year = new.year and project_id = big;
  if not found then raise exception '请先为课题选择申请的档次，再提交预算'; end if;
  bad := tier_violation(new.year, big, coalesce(k.decided_tier_id, k.tier_id));
  if bad is not null then raise exception '%', bad; end if;
  return new;
end $$;

-- 模块对应的课题不申请档次
do $$
declare d text := pg_get_functiondef('public.pick_tier(integer, uuid, uuid, text)'::regprocedure); n text;
begin
  n := replace(d, $a$  select * into t from budget_tier where id = p_tier and year = p_year;$a$,
    $a$  if exists (select 1 from budget_module where year = p_year and project_id = p_project) then raise exception '该课题是本年度预算方案中的模块，金额已由方案确定，不申请档次'; end if;
  select * into t from budget_tier where id = p_tier and year = p_year;$a$);
  if n = d then raise exception '未找到申请档次的检查位置'; end if;
  execute n;
end $$;

-- 评定完成：模块对应的课题按模块金额定上限，明细一并核定
create or replace function settle_tiers(p_year int) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; n int; s numeric; tot numeric;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过评定阶段', p_year; end if;
  if y.plan_at is null then raise exception '% 年度预算方案尚未批准', p_year; end if;
  if not exists (select 1 from tier_pick where year = p_year) then raise exception '尚无课题申请档次'; end if;
  select count(*) into n from tier_pick where year = p_year and decided_tier_id is null and not rejected;
  if n > 0 then raise exception '尚有 % 个课题未评定', n; end if;
  select count(*) into n from project_budget b join project p on p.id = b.project_id join project g on g.id = coalesce(p.parent_id, p.id)
  where b.year = p_year and b.status = 'submitted' and g.kind <> 'public'
    and not exists (select 1 from tier_pick k where k.year = p_year and k.project_id = g.id)
    and not exists (select 1 from budget_module m where m.year = p_year and m.project_id = g.id);
  if n > 0 then raise exception '有 % 份已提交的预算所属课题没有申请档次，请先退回或补办申请', n; end if;
  update project_budget_line l set applied = l.q1 + l.q2 + l.q3 + l.q4, fixed = l.q1 + l.q2 + l.q3 + l.q4, adjust_note = null
  from project_budget b join project p on p.id = b.project_id join project g on g.id = coalesce(p.parent_id, p.id)
  where b.id = l.budget_id and b.year = p_year and b.status = 'submitted'
    and (g.kind = 'public' or exists (select 1 from budget_module m where m.year = p_year and m.project_id = g.id)
      or exists (select 1 from tier_pick k where k.year = p_year and k.project_id = g.id and k.decided_tier_id is not null));
  tot := plan_total(p_year);
  select coalesce(sum(l.fixed), 0) into s from project_budget_line l join project_budget b on b.id = l.budget_id where b.year = p_year and b.status = 'submitted';
  if s > tot then raise exception '各课题的明细合计 % 超过总预算 %，超出 %', s, tot, s - tot; end if;
  insert into project_cap (year, project_id, amount, set_by)
  select k.year, k.project_id, t.amount, app_uid() from tier_pick k join budget_tier t on t.id = k.decided_tier_id where k.year = p_year
  union all
  select m.year, m.project_id, m.amount, app_uid() from budget_module m where m.year = p_year and m.project_id is not null and m.amount > 0
  on conflict (year, project_id) do update set amount = excluded.amount, set_by = excluded.set_by, set_at = now();
  update project p set proposed = false from tier_pick k
  where k.year = p_year and k.kind = 'new' and k.decided_tier_id is not null and (p.id = k.project_id or p.parent_id = k.project_id);
  update project p set active = false from tier_pick k where k.year = p_year and k.kind = 'new' and k.rejected and p.parent_id = k.project_id;
  update project p set active = false from tier_pick k where k.year = p_year and k.kind = 'new' and k.rejected and p.id = k.project_id;
  update budget_year set stage = 'fixed', fixed_total = tot, fixed_by = app_uid(), fixed_at = now() where year = p_year;
end $$;

drop view api.budget_module;
create view api.budget_module as
  select m.id, m.year, m.name, m.amount, m.note, m.project_id, module_used(m.year, m.project_id) as used,
         (select u.name from app_user u join project p on p.owner_id = u.id where p.id = m.project_id) as owner_name
  from budget_module m where has_perm('read.finance');
grant select on api.budget_module to app_api;
-- 课题页上要知道本课题是不是某年度的模块：只给出年度、课题和金额
create view api.module_topic as
  select m.year, m.project_id, m.name, m.amount from budget_module m join budget_year y on y.year = m.year
  where app_role() is not null and m.project_id is not null and (y.plan_at is not null or has_perm('read.finance'));
grant select on api.module_topic to app_api;
