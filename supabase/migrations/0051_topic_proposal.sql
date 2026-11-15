-- 申请档次是课题每一年的起点：新课题通过它立项，已有课题通过它延续。
--   立项申请里直接填新课题和研究单元，课题先记为待立项；联席会议评定通过、中心负责人确认评定完成后才成立。
--   评定结果除了定档，还可以是不予通过：立项的不成立，延续的当年没有预算、课题保留。
alter table project add column proposed boolean not null default false;   -- 待立项：已提交立项申请，尚未成立
alter table tier_pick add column kind text not null default 'renew' check (kind in ('new', 'renew')),
                      add column rejected boolean not null default false;

-- 申请立项：负责人这一级及以上可以提。新课题和研究单元先建为待立项，负责人为申请人
create function propose_project(p_year int, p_name text, p_tier uuid, p_reason text, p_units text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare y budget_year; n text := btrim(coalesce(p_name, '')); r text := nullif(btrim(coalesce(p_reason, '')), ''); c text; i int; pid uuid; u text; j int := 0;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if app_role() not in ('leader', 'finance', 'director') and not exists (select 1 from project where owner_id = app_uid() and active) then
    raise exception '仅课题、研究单元负责人可申请立项' using errcode = '42501';
  end if;
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过申请阶段', p_year; end if;
  if y.plan_at is null then raise exception '% 年度预算方案尚未批准，暂不能申请立项', p_year; end if;
  if n = '' then raise exception '请填写课题名称'; end if;
  if length(n) > 60 then raise exception '课题名称不得超过 60 个字'; end if;
  if r is null then raise exception '请填写研究内容和申请理由'; end if;
  if not exists (select 1 from budget_tier where id = p_tier and year = p_year) then raise exception '档次不存在'; end if;
  if exists (select 1 from project where name = n and layer = 'big' and (active or proposed)) then raise exception '已有同名课题「%」', n; end if;
  perform pg_advisory_xact_lock(hashtext('project_code:new'));
  select coalesce(max(substring(code from '^P-(\d+)$')::int), 0) + 1 into i from project where code ~ '^P-\d+$';
  loop
    c := 'P-' || lpad(i::text, 2, '0');
    exit when not exists (select 1 from project where code = c);
    i := i + 1;
  end loop;
  insert into project (code, name, kind, owner_id, active, layer, parent_id, proposed) values (c, n, 'project', app_uid(), true, 'big', null, true) returning id into pid;
  foreach u in array regexp_split_to_array(coalesce(p_units, ''), E'[\r\n]+') loop
    u := btrim(u);
    if u = '' then continue; end if;
    if length(u) > 60 then raise exception '研究单元名称不得超过 60 个字'; end if;
    j := j + 1;
    insert into project (code, name, kind, owner_id, active, layer, parent_id, proposed) values (c || '-' || lpad(j::text, 2, '0'), u, 'project', app_uid(), true, 'paper', pid, true);
  end loop;
  insert into tier_pick (year, project_id, tier_id, reason, picked_by, kind) values (p_year, pid, p_tier, r, app_uid(), 'new');
  return pid;
end $$;

-- 撤回立项申请：评定前，申请人或财务岗可以撤回；课题、研究单元和未提交的预算一并删除
create function withdraw_proposal(p_year int, p_project uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k tier_pick; p project;
begin
  if not can_edit_project(p_project) then raise exception '仅申请人和财务岗可撤回立项申请' using errcode = '42501'; end if;
  perform lock_year(p_year);
  select * into p from project where id = p_project;
  select * into k from tier_pick where year = p_year and project_id = p_project for update;
  if not found or k.kind <> 'new' or not p.proposed then raise exception '该课题不是待立项的申请'; end if;
  if k.decided_tier_id is not null or k.rejected then raise exception '评定结果已录入，不得撤回'; end if;
  if exists (select 1 from project_budget b join project q on q.id = b.project_id where (q.id = p_project or q.parent_id = p_project) and b.status = 'submitted') then
    raise exception '已提交的预算请先撤回，再撤回立项申请';
  end if;
  delete from project_budget b using project q where q.id = b.project_id and (q.id = p_project or q.parent_id = p_project);
  delete from tier_pick where year = p_year and project_id = p_project;
  delete from project where parent_id = p_project;
  delete from project where id = p_project;
end $$;

-- 已有课题申请延续时不得是待立项的；申请档次的办法不变，记为延续
create or replace function trg_pick_kind() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'renew' and (select proposed from project where id = new.project_id) then new.kind := 'new'; end if;
  return new;
end $$;
create trigger pick_kind before insert on tier_pick for each row execute function trg_pick_kind();

-- 评定结果为不予通过
create function reject_tier(p_year int, p_project uuid, p_note text, p_on date) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('budget.evaluate');
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过评定阶段', p_year; end if;
  if not exists (select 1 from tier_pick where year = p_year and project_id = p_project) then raise exception '该课题尚未申请档次'; end if;
  if p_on is null then raise exception '请填写联席会议日期'; end if;
  if p_on > app_today() then raise exception '联席会议日期不得晚于今日'; end if;
  if n is null then raise exception '请填写不予通过的原因'; end if;
  update tier_pick set rejected = true, decided_tier_id = null, decided_by = app_uid(), decided_at = now(), decide_note = n, meeting_on = p_on
  where year = p_year and project_id = p_project;
end $$;

-- 录入定档时清掉不予通过；撤销时两样都清
do $$
declare d text := pg_get_functiondef('public.decide_tier(integer, uuid, uuid, text, date)'::regprocedure); n text;
begin
  n := replace(d, 'update tier_pick set decided_tier_id = null, decided_by = null,', 'update tier_pick set rejected = false, decided_tier_id = null, decided_by = null,');
  n := replace(n, 'update tier_pick set decided_tier_id = p_tier, decided_by = app_uid(),', 'update tier_pick set rejected = false, decided_tier_id = p_tier, decided_by = app_uid(),');
  if n = d then raise exception '未找到定档的写入语句'; end if;
  execute n;
end $$;

-- 评定完成：定档的课题生效；立项通过的正式成立，立项未通过的不成立；未通过的课题名下的预算不带入
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
  where b.year = p_year and b.status = 'submitted' and g.kind <> 'public' and not exists (select 1 from tier_pick k where k.year = p_year and k.project_id = g.id);
  if n > 0 then raise exception '有 % 份已提交的预算所属课题没有申请档次，请先退回或补办申请', n; end if;
  update project_budget_line l set applied = l.q1 + l.q2 + l.q3 + l.q4, fixed = l.q1 + l.q2 + l.q3 + l.q4, adjust_note = null
  from project_budget b join project p on p.id = b.project_id join project g on g.id = coalesce(p.parent_id, p.id)
  where b.id = l.budget_id and b.year = p_year and b.status = 'submitted'
    and (g.kind = 'public' or exists (select 1 from tier_pick k where k.year = p_year and k.project_id = g.id and k.decided_tier_id is not null));
  tot := plan_total(p_year);
  select coalesce(sum(l.fixed), 0) into s from project_budget_line l join project_budget b on b.id = l.budget_id where b.year = p_year and b.status = 'submitted';
  if s > tot then raise exception '各课题和公共开支的明细合计 % 超过总预算 %，超出 %', s, tot, s - tot; end if;
  insert into project_cap (year, project_id, amount, set_by)
  select k.year, k.project_id, t.amount, app_uid() from tier_pick k join budget_tier t on t.id = k.decided_tier_id where k.year = p_year
  on conflict (year, project_id) do update set amount = excluded.amount, set_by = excluded.set_by, set_at = now();
  -- 立项通过的正式成立；未通过的不成立
  update project p set proposed = false from tier_pick k
  where k.year = p_year and k.kind = 'new' and k.decided_tier_id is not null and (p.id = k.project_id or p.parent_id = k.project_id);
  update project p set active = false from tier_pick k where k.year = p_year and k.kind = 'new' and k.rejected and p.parent_id = k.project_id;
  update project p set active = false from tier_pick k where k.year = p_year and k.kind = 'new' and k.rejected and p.id = k.project_id;
  update budget_year set stage = 'fixed', fixed_total = tot, fixed_by = app_uid(), fixed_at = now() where year = p_year;
end $$;

create or replace function unsettle_tiers(p_year int) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage <> 'fixed' or not exists (select 1 from budget_tier where year = p_year) then raise exception '当前阶段不可撤回'; end if;
  if exists (select 1 from v_line where year = p_year and allocated > 0) then raise exception '已有预算行下达至经费卡，请先撤销下达再撤回'; end if;
  update project_budget_line l set applied = null, fixed = null from project_budget b where b.id = l.budget_id and b.year = p_year;
  delete from project_cap where year = p_year;
  update project p set proposed = true, active = true from tier_pick k where k.year = p_year and k.kind = 'new' and p.id = k.project_id;
  update project p set proposed = true, active = true from tier_pick k where k.year = p_year and k.kind = 'new' and p.parent_id = k.project_id;
  update budget_year set stage = 'declare', fixed_total = null, fixed_by = null, fixed_at = null where year = p_year;
end $$;

select expose('propose_project(int, text, uuid, text, text)', 'withdraw_proposal(int, uuid)', 'reject_tier(int, uuid, text, date)');

-- 视图：申请的种类、是否不予通过；课题是否待立项
drop view api.tier_pick;
create view api.tier_pick as
  select k.year, k.project_id, p.name as project_name, (select name from app_user where id = p.owner_id) as owner_name,
         k.tier_id, k.reason, k.picked_at, k.decided_tier_id, k.decide_note, k.decided_at,
         (select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0) from project_budget_line l join project_budget b on b.id = l.budget_id join project q on q.id = b.project_id
           where b.year = k.year and b.status = 'submitted' and (q.id = k.project_id or q.parent_id = k.project_id)) as total,
         (select count(*) from project_budget b join project q on q.id = b.project_id
           where b.year = k.year and b.status <> 'submitted' and (q.id = k.project_id or q.parent_id = k.project_id)
             and exists (select 1 from project_budget_line l where l.budget_id = b.id))::int as drafts,
         tier_violation(k.year, k.project_id, coalesce(k.decided_tier_id, k.tier_id)) as violation,
         k.meeting_on, (select name from app_user where id = k.decided_by) as decided_by_name,
         k.kind, k.rejected,
         (select count(*) from project q where q.parent_id = k.project_id)::int as units
  from tier_pick k join project p on p.id = k.project_id where can_see_project(k.project_id) or has_perm('budget.evaluate');
grant select on api.tier_pick to app_api;

drop view api.project_tag;
create view api.project_tag as
  select p.id, p.morningstar, p.proposed from project p where exists (select 1 from api.project v where v.id = p.id);
grant select on api.project_tag to app_api;
