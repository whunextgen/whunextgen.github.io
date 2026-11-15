-- 不再有单独的一类东西叫模块：中心公共开支这样的就是一个课题，和其他课题一样有负责人、成员、明细和支出。
--   区别只在金额怎么定：财务岗在预算方案里直接选这个课题并写金额，随方案由中心负责人批准，不参加档次评定。
--   表名 budget_module 沿用，只是每一行就是「某年度方案直接给某课题确定的金额」，不再有自己的名称。
do $$
begin
  if exists (select 1 from budget_module where project_id is null) then raise exception '方案里尚有未对应课题的记录，请先处理'; end if;
end $$;

drop view api.budget_module;
drop view api.module_topic;
alter table budget_module drop column name;
alter table budget_module alter column project_id set not null;
alter table budget_module add unique (year, project_id);

create or replace function plan_fits(p_year int) returns void language plpgsql security definer set search_path = public as $$
declare r numeric := plan_room(p_year);
begin
  if r < 0 then raise exception '直接确定金额的课题与各档次合计超过总预算，超出 %', -r; end if;
end $$;

drop function save_budget_module(uuid, int, text, numeric, text, uuid);
create function save_budget_module(p_id uuid, p_year int, p_project uuid, p_amount numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare mid uuid; yr int := p_year; pid uuid := p_project;
begin
  if p_id is not null then
    select year, coalesce(p_project, project_id) into yr, pid from budget_module where id = p_id;
    if not found then raise exception '记录不存在'; end if;
  end if;
  perform plan_open(yr);
  if p_id is not null and p_amount is null then delete from budget_module where id = p_id; return null; end if;
  if pid is null then raise exception '请选择课题'; end if;
  if p_amount is null or p_amount < 0 then raise exception '请填写金额'; end if;
  if not exists (select 1 from project where id = pid and layer = 'big' and active and not proposed) then raise exception '所选课题不存在或尚未立项'; end if;
  if exists (select 1 from budget_module where year = yr and project_id = pid and id is distinct from p_id) then raise exception '该课题已在本年度方案中确定了金额'; end if;
  if exists (select 1 from tier_pick where year = yr and project_id = pid) then raise exception '该课题已申请档次，不能再由方案直接确定金额'; end if;
  if p_id is null then
    insert into budget_module (year, project_id, amount, note) values (yr, pid, p_amount, nullif(btrim(coalesce(p_note, '')), '')) returning id into mid;
  else
    update budget_module set project_id = pid, amount = p_amount, note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id returning id into mid;
  end if;
  perform plan_fits(yr);
  return mid;
end $$;
select expose('save_budget_module(uuid, int, uuid, numeric, text)');

-- 提交预算时：方案直接确定金额的课题按该金额把关；其余课题按所选档次把关
create or replace function trg_tier_submit() returns trigger language plpgsql security definer set search_path = public as $$
declare p project; big uuid; k tier_pick; bad text; amt numeric; u numeric;
begin
  if not exists (select 1 from budget_tier where year = new.year) and not exists (select 1 from budget_module where year = new.year) then return new; end if;
  select * into p from project where id = new.project_id;
  big := coalesce(p.parent_id, p.id);
  select amount into amt from budget_module where year = new.year and project_id = big;
  if found then
    u := module_used(new.year, big);
    if u > amt then raise exception '明细合计 % 超过预算方案为本课题确定的金额 %，超出 %', u, amt, u - amt; end if;
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

do $$
declare d text := pg_get_functiondef('public.pick_tier(integer, uuid, uuid, text)'::regprocedure); n text;
begin
  n := replace(d, '该课题是本年度预算方案中的模块，金额已由方案确定，不申请档次', '该课题的金额已由本年度预算方案直接确定，不申请档次');
  if n = d then raise exception '未找到申请档次的检查位置'; end if;
  execute n;
end $$;

create view api.budget_module as
  select m.id, m.year, p.name, p.code, m.amount, m.note, m.project_id, module_used(m.year, m.project_id) as used,
         (select u.name from app_user u where u.id = p.owner_id) as owner_name
  from budget_module m join project p on p.id = m.project_id where has_perm('read.finance');
grant select on api.budget_module to app_api;
-- 课题页和申请名单要知道某课题某年度是不是由方案直接确定金额：只给出年度、课题和金额
create view api.module_topic as
  select m.year, m.project_id, p.name, m.amount from budget_module m join project p on p.id = m.project_id join budget_year y on y.year = m.year
  where app_role() is not null and (y.plan_at is not null or has_perm('read.finance'));
grant select on api.module_topic to app_api;
