-- 第 2 到第 8 项：大项目年度上限、成员名单、支出按项目层层确认、超预算和科目间调剂、
-- 买回来的设备归公共设备并记下出钱的项目、经费卡只给中心负责人和财务岗看。
-- 中心公共开支项目和晨星额度不动：公共开支的支出照旧由中心负责人直接批。

create function _pf(p_fn text, p_find text, p_repl text) returns void language plpgsql as $$
declare d text; o oid;
begin
  select oid into strict o from pg_proc where proname = p_fn and pronamespace = 'public'::regnamespace;
  d := pg_get_functiondef(o);
  if position(p_find in d) = 0 then raise exception '函数 % 里找不到：%', p_fn, p_find; end if;
  execute replace(d, p_find, p_repl);
end $$;

-- ====================================================================
-- 第 8 项：经费卡只给中心负责人和财务岗看
-- ====================================================================
-- 卡上的负责人不再因此看得到卡；要给某个人看某张卡，仍然可以单独授权（card.read）。
create or replace function can_see_card(p_card uuid) returns boolean language sql stable security definer set search_path = public as $$
  select has_perm('read.finance') or has_perm('card.read', null, p_card)
$$;

create or replace view api.card_pick as
  select c.id, c.card_no, c.name, c.template_id, c.start_date, c.cutoff_date, c.status
  from fund_card c where can_see_card(c.id);

create or replace view api.rule as
  select * from v_reimb_rule where can_see_card(card_id);
create or replace view api.ruling as
  select id, card_id, expense_type_id, ruled_on, ruled_by, verdict, note, source
  from reimb_ruling where can_see_card(card_id);

-- 项目负责人看得到自己的预算行下达了多少、用了多少，但看不到落在哪张卡上
create or replace view api.budget_alloc as
  select a.id, a.line_id, l.year, l.project_id,
         case when can_see_card(a.card_id) then a.card_id end as card_id,
         case when can_see_card(a.card_id) then k.card_no end as card_no,
         case when can_see_card(a.card_id) then k.name end as card_name,
         k.end_rule, coalesce(k.settle_date, k.cutoff_date) as card_end, a.subject_id, s.name as subject_name, a.amount, a.used, a.actual
  from v_alloc a join v_line l on l.id = a.line_id join fund_card k on k.id = a.card_id join template_subject s on s.id = a.subject_id
  where can_see_project(l.project_id);

-- 经费卡记总金额和执行年限（起止日期）
alter table fund_card
  add column total_amount numeric(14,2) check (total_amount >= 0),
  add column period_start date,
  add column period_end   date,
  add constraint fund_card_period check (period_end is null or period_start is null or period_end >= period_start);

create function set_card_total(p_card uuid, p_total numeric, p_start date, p_end date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('card.manage');
  if p_total is not null and p_total < 0 then raise exception '总金额不能是负数'; end if;
  if p_start is not null and p_end is not null and p_end < p_start then raise exception '执行年限的结束日期不能早于开始日期'; end if;
  update fund_card set total_amount = p_total, period_start = p_start, period_end = p_end, updated_at = now() where id = p_card;
  if not found then raise exception '经费卡不存在'; end if;
end $$;

create or replace view api.card as
  select v.card_id, v.card_no, v.name, v.status, v.start_date, v.cutoff_date, v.settle_date, v.end_rule,
         v.orig, v.adj, v.cur, v.commit, v.actual, v.avail,
         c.template_id, t.name as template_name, t.locked, c.owner_id, c.rule_note,
         c.school_balance, c.school_frozen, c.school_available, c.school_synced_at, c.fund_kind, c.received, c.priority,
         c.total_amount, c.period_start, c.period_end
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

-- ====================================================================
-- 第 3 项：成员名单
-- ====================================================================
create table project_member (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references project,
  user_id    uuid not null references app_user,
  joined_on  date not null,
  left_on    date,
  added_by   uuid references app_user,
  removed_by uuid references app_user,
  created_at timestamptz not null default now()
);
create unique index project_member_open on project_member (project_id, user_id) where left_on is null;
create index on project_member (user_id);

-- 在不在这个项目里：名单上的人，加上负责人和副手
create function is_on_project(p_project uuid, p_user uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_user, app_uid()) is not null and (
    exists (select 1 from project_member m where m.project_id = p_project and m.user_id = coalesce(p_user, app_uid()) and m.left_on is null)
    or user_perm(coalesce(p_user, app_uid()), 'budget.project', p_project))
$$;

-- 能不能从这个项目提支出、申请资源：公共开支照旧人人可提；其余只有名单里的人和财务岗
create function can_use_project(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from project where id = p_project and kind = 'public')
      or has_perm('budget.compile') or is_on_project(p_project)
$$;

-- 这个人在这个项目名下还拿着几项没收回的接口额度
create function member_holding(p_project uuid, p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from resource_allocation a
  join resource r on r.id = a.resource_id join resource_request q on q.id = a.request_id
  where q.project_id = p_project and a.user_id = p_user and r.kind = 'api'
    and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())
$$;

-- 负责人直接加，不用成员确认
create function add_project_member(p_project uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; mid uuid;
begin
  select * into p from project where id = p_project;
  if not found then raise exception '项目不存在'; end if;
  if not (has_perm('budget.project', p_project) or has_perm('budget.setup')) then
    raise exception '只有项目负责人、副手和财务岗能改成员名单' using errcode = '42501';
  end if;
  if p.kind = 'public' then raise exception '中心公共开支不设成员名单'; end if;
  if not p.active then raise exception '项目已经停用'; end if;
  if not exists (select 1 from app_user where id = p_user and active) then raise exception '这个人不存在或已停用'; end if;
  if exists (select 1 from project_member where project_id = p_project and user_id = p_user and left_on is null) then
    raise exception '这个人已经在名单里了';
  end if;
  insert into project_member (project_id, user_id, joined_on, added_by) values (p_project, p_user, app_today(), app_uid()) returning id into mid;
  perform notify_user(p_user, format('你已加入项目「%s」的成员名单，可以从这个项目提支出、申请资源', p.name));
  return mid;
end $$;

-- 移出前要先把这个人在本项目名下的接口额度逐项收回。手里的设备是公共设备，不跟着名单走。
create function remove_project_member(p_project uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p project; n int;
begin
  select * into p from project where id = p_project;
  if not found then raise exception '项目不存在'; end if;
  if not (has_perm('budget.project', p_project) or has_perm('budget.setup')) then
    raise exception '只有项目负责人、副手和财务岗能改成员名单' using errcode = '42501';
  end if;
  perform 1 from project_member where project_id = p_project and user_id = p_user and left_on is null for update;
  if not found then raise exception '这个人不在名单里'; end if;
  n := member_holding(p_project, p_user);
  if n > 0 then raise exception '拦截：这个人在本项目名下还有 % 项接口额度没有收回，逐项收回之后才能移出', n; end if;
  update project_member set left_on = app_today(), removed_by = app_uid() where project_id = p_project and user_id = p_user and left_on is null;
  perform notify_user(p_user, format('你已被移出项目「%s」的成员名单', p.name));
end $$;

-- 项目负责人收回本项目名下分出去的一项接口额度
create function recall_project_allocation(p_alloc uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a resource_allocation; r resource; pid uuid;
begin
  select * into a from resource_allocation where id = p_alloc for update;
  if not found then raise exception '这条分配不存在'; end if;
  select * into r from resource where id = a.resource_id;
  select q.project_id into pid from resource_request q where q.id = a.request_id;
  if pid is null or r.kind <> 'api' then raise exception '只能收回本项目名下的接口额度；设备是公共设备，交还找财务岗'; end if;
  if not (has_perm('budget.project', pid) or has_perm('resource.grant')) then
    raise exception '只有项目负责人、副手和财务岗能收回' using errcode = '42501';
  end if;
  if a.returned_on is not null then raise exception '这条分配已经收回'; end if;
  update resource_allocation set returned_on = app_today() where id = p_alloc;
  perform notify_user(a.user_id, format('你名下的接口额度「%s」已被收回', r.name));
  perform notify_role('finance', format('项目收回了一项接口额度「%s」，请在服务商那边停用对应的密钥', r.name));
end $$;

create view api.project_member as
  select m.id, m.project_id, m.user_id, u.name as user_name, m.joined_on, m.left_on,
         (select name from app_user where id = m.added_by) as added_by_name,
         case when m.left_on is null then member_holding(m.project_id, m.user_id) else 0 end as holding
  from project_member m join app_user u on u.id = m.user_id
  where can_see_project(m.project_id) or m.user_id = app_uid();

-- 加人时选人用：只有姓名
create view api.people_pick as
  select u.id, u.name from app_user u where u.active and app_role() is not null;

create or replace view api.project as
  select p.id, p.code, p.name, p.kind, p.owner_id, u.name as owner_name, p.active,
         can_edit_project(p.id) as mine, p.labor_cap_ratio,
         p.layer, p.parent_id, pp.code as parent_code, pp.name as parent_name, pp.owner_id as parent_owner_id,
         can_see_project(p.id) as seen,
         is_on_project(p.id) as member,
         (p.kind <> 'public' and p.active and (has_perm('budget.project', p.id) or has_perm('budget.setup'))) as can_roster,
         (select count(*)::int from project_member m where m.project_id = p.id and m.left_on is null) as members
  from project p left join app_user u on u.id = p.owner_id left join project pp on pp.id = p.parent_id
  where app_role() is not null and (p.active or has_perm('budget.setup'));

-- 提支出时只能选自己在名单里的项目
create or replace view api.line_pick as
  select l.id, l.project_id, p.code as project_code, p.name as project_name, l.category_id, c.name as category_name, l.purpose
  from v_line l join project p on p.id = l.project_id join budget_category c on c.id = l.category_id
  join budget_year y on y.year = l.year
  where app_role() is not null and p.active and y.stage = 'issued' and l.year = extract(year from app_today())
    and coalesce(l.fixed, 0) > 0 and can_use_project(p.id);

create or replace view api.resource_plan as
  select l.id, b.year, b.project_id, p.code as project_code, p.name as project_name, c.name as category_name, l.purpose,
         l.resource_id, r.name as resource_name, r.kind, r.unit, l.plan_qty,
         coalesce((select sum(coalesce(q.approved_amount, q.amount)) from resource_request q
                   where q.budget_line_id = l.id and q.status in ('pending','reviewed','approved')), 0) as asked,
         coalesce((select sum(q.approved_amount) from resource_request q where q.budget_line_id = l.id and q.status = 'fulfilled'), 0) as granted,
         (b.status = 'submitted' and y.stage = 'issued' and b.year = extract(year from app_today()) and coalesce(l.fixed, 0) > 0 and p.active) as open,
         p.kind as project_kind
  from project_budget_line l join project_budget b on b.id = l.budget_id join budget_year y on y.year = b.year
  join project p on p.id = b.project_id join budget_category c on c.id = l.category_id join resource r on r.id = l.resource_id
  where app_role() is not null
    and (can_see_project(b.project_id) or (b.status = 'submitted' and y.stage = 'issued' and can_use_project(p.id)));

select _pf('save_resource_request', '  select owner_id into own from project where id = l.project_id;',
  '  select owner_id into own from project where id = l.project_id;
  if not can_use_project(l.project_id) then raise exception ''拦截：你不在这个项目的成员名单里，请项目负责人先把你加进名单''; end if;');

-- ====================================================================
-- 第 2 项：大项目年度上限；第 6 项：提高上限的申请
-- ====================================================================
create table project_cap (
  year       int  not null references budget_year,
  project_id uuid not null references project,
  amount     numeric(14,2) not null check (amount > 0),
  set_by     uuid references app_user,
  set_at     timestamptz not null default now(),
  primary key (year, project_id)
);

create table cap_request (
  id           uuid primary key default gen_random_uuid(),
  year         int  not null references budget_year,
  project_id   uuid not null references project,
  amount       numeric(14,2) not null check (amount > 0),
  reason       text not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by uuid references app_user,
  decided_by   uuid references app_user,
  decide_note  text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create unique index cap_request_open on cap_request (year, project_id) where status = 'pending';

-- 大项目连同下面论文项目，这一年已提交预算的合计：有核定数用核定数，没有就用上报数、申报数
create function cap_used(p_year int, p_big uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(coalesce(l.fixed, l.applied, l.q1 + l.q2 + l.q3 + l.q4)), 0)
  from project_budget_line l join project_budget b on b.id = l.budget_id join project p on p.id = b.project_id
  where b.year = p_year and b.status = 'submitted' and (p.id = p_big or p.parent_id = p_big)
$$;

create function check_cap(p_year int, p_project uuid, p_extra numeric default 0) returns void language plpgsql as $$
declare big uuid; c numeric; u numeric; nm text;
begin
  select coalesce(parent_id, id) into big from project where id = p_project;
  select amount into c from project_cap where year = p_year and project_id = big;
  if c is null then return; end if;
  u := cap_used(p_year, big) + coalesce(p_extra, 0);
  if u > c then
    select name into nm from project where id = big;
    raise exception '拦截：「%」% 年的上限是 %，连同下面论文项目的预算合计 %，超出 %。先压预算，或者请大项目负责人向中心负责人申请提高上限', nm, p_year, c, u, u - c;
  end if;
end $$;

create function cap_tier_ok(p_amount numeric) returns boolean language sql immutable as $$
  select p_amount in (1000, 5000, 20000, 50000, 200000, 500000) or p_amount > 500000
$$;

create function set_project_cap(p_year int, p_project uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare p project; y budget_year; u numeric; s numeric; tot numeric;
begin
  perform need_perm('budget.approve');
  y := lock_year(p_year);
  if y.stage = 'closed' then raise exception '% 年度已经决算', p_year; end if;
  select * into p from project where id = p_project;
  if not found then raise exception '项目不存在'; end if;
  if p.layer <> 'big' or p.kind = 'public' then raise exception '上限只给大项目定；论文项目算在所属大项目里，中心公共开支不设上限'; end if;
  if p_amount is null then
    delete from project_cap where year = p_year and project_id = p_project;
    return;
  end if;
  if not cap_tier_ok(p_amount) then raise exception '上限按档定：1 千、5 千、2 万、5 万、20 万、50 万，50 万以上按实际数填'; end if;
  u := cap_used(p_year, p_project);
  if u > p_amount then raise exception '这个大项目连同论文项目已提交的预算合计 %，上限不能低于它', u; end if;
  tot := coalesce(y.fixed_total, y.granted_amount);
  select coalesce(sum(amount), 0) into s from project_cap where year = p_year and project_id <> p_project;
  if tot is not null and s + p_amount > tot then
    raise exception '各大项目上限合计 % 超过年度总预算 %，超出 %', s + p_amount, tot, s + p_amount - tot;
  end if;
  insert into project_cap (year, project_id, amount, set_by) values (p_year, p_project, p_amount, app_uid())
  on conflict (year, project_id) do update set amount = excluded.amount, set_by = excluded.set_by, set_at = now();
end $$;

-- 年度总预算不能定得比各大项目上限合计还低
create function trg_year_caps() returns trigger language plpgsql security definer set search_path = public as $$
declare s numeric;
begin
  if new.fixed_total is not null and new.fixed_total is distinct from old.fixed_total then
    select coalesce(sum(amount), 0) into s from project_cap where year = new.year;
    if s > new.fixed_total then raise exception '各大项目上限合计 % 超过年度总预算 %，先调低上限', s, new.fixed_total; end if;
  end if;
  return new;
end $$;
create trigger year_caps before update of fixed_total on budget_year for each row execute function trg_year_caps();

-- 预算行的上报数、核定数调高时也要过上限
create function trg_line_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare b project_budget;
begin
  if coalesce(new.fixed, new.applied, new.q1 + new.q2 + new.q3 + new.q4) > coalesce(old.fixed, old.applied, old.q1 + old.q2 + old.q3 + old.q4) then
    select * into b from project_budget where id = new.budget_id;
    if b.status = 'submitted' then perform check_cap(b.year, b.project_id); end if;
  end if;
  return new;
end $$;
create trigger line_cap after update on project_budget_line for each row execute function trg_line_cap();

-- 提交年度预算时：晨星额度、劳务上限照旧，再加大项目上限
create or replace function trg_budget_submit() returns trigger language plpgsql security definer set search_path = public as $$
declare tot numeric; lab numeric; q numeric; r numeric;
begin
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    select coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4), 0),
           coalesce(sum(l.q1 + l.q2 + l.q3 + l.q4) filter (where c.labor), 0) into tot, lab
    from project_budget_line l join budget_category c on c.id = l.category_id where l.budget_id = new.id;
    select amount into q from morningstar_quota where project_id = new.project_id and year = new.year;
    if q is not null and tot > q then raise exception '这个项目 % 年的晨星额度是 %，预算合计 %，超出 %', new.year, q, tot, tot - q; end if;
    select labor_cap_ratio into r from project where id = new.project_id;
    if r is not null and lab > round(coalesce(q, tot) * r, 2) then
      raise exception '劳务类预算 % 超过上限 %（%）', lab, round(coalesce(q, tot) * r, 2), round(r * 100) || '%';
    end if;
    perform check_cap(new.year, new.project_id, tot);
  end if;
  return new;
end $$;

create function request_cap(p_year int, p_project uuid, p_amount numeric, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; c numeric; n text := nullif(btrim(coalesce(p_reason, '')), ''); rid uuid;
begin
  select * into p from project where id = p_project;
  if not found then raise exception '项目不存在'; end if;
  if p.layer <> 'big' or p.kind = 'public' then raise exception '提高上限由大项目负责人申请'; end if;
  if not has_perm('budget.project', p_project) then raise exception '只有大项目负责人和副手能申请提高上限' using errcode = '42501'; end if;
  if exists (select 1 from budget_year where year = p_year and stage = 'closed') or not exists (select 1 from budget_year where year = p_year) then
    raise exception '% 年度不存在或已经决算', p_year;
  end if;
  select amount into c from project_cap where year = p_year and project_id = p_project;
  if c is null then raise exception '这个大项目 % 年还没有定上限，不用申请', p_year; end if;
  if p_amount is null or p_amount <= c then raise exception '申请的上限要高于现在的 %', c; end if;
  if not cap_tier_ok(p_amount) then raise exception '上限按档定：1 千、5 千、2 万、5 万、20 万、50 万，50 万以上按实际数填'; end if;
  if n is null then raise exception '请写明为什么要提高上限'; end if;
  if length(n) > 500 then raise exception '理由不超过 500 个字'; end if;
  if exists (select 1 from cap_request where year = p_year and project_id = p_project and status = 'pending') then
    raise exception '已经有一份提高上限的申请在等中心负责人批';
  end if;
  insert into cap_request (year, project_id, amount, reason, requested_by) values (p_year, p_project, p_amount, n, app_uid()) returning id into rid;
  perform notify_role('director', format('「%s」申请把 %s 年的上限从 %s 提到 %s，等你批', p.name, p_year, c, p_amount));
  return rid;
end $$;

create function decide_cap_request(p_id uuid, p_ok boolean, p_amount numeric default null, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r cap_request; n text := nullif(btrim(coalesce(p_note, '')), ''); a numeric;
begin
  perform need_perm('budget.approve');
  select * into r from cap_request where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception '这份申请不存在，或者已经处理过'; end if;
  if p_ok then
    a := coalesce(p_amount, r.amount);
    perform set_project_cap(r.year, r.project_id, a);
    update cap_request set status = 'approved', amount = a, decided_by = app_uid(), decide_note = n, decided_at = now() where id = p_id;
    perform notify_user(r.requested_by, format('提高上限的申请已批准，新的上限是 %s', a));
  else
    if n is null then raise exception '不同意要写原因'; end if;
    update cap_request set status = 'rejected', decided_by = app_uid(), decide_note = n, decided_at = now() where id = p_id;
    perform notify_user(r.requested_by, '提高上限的申请没有批准。原因：' || n);
  end if;
end $$;

create view api.project_cap as
  select c.year, c.project_id, c.amount, cap_used(c.year, c.project_id) as used
  from project_cap c where can_see_project(c.project_id);

create view api.cap_request as
  select r.id, r.year, r.project_id, p.name as project_name, r.amount, r.reason, r.status,
         (select name from app_user where id = r.requested_by) as requester_name, r.decide_note, r.created_at, r.decided_at,
         (select amount from project_cap c where c.year = r.year and c.project_id = r.project_id) as cap,
         cap_used(r.year, r.project_id) as used
  from cap_request r join project p on p.id = r.project_id
  where can_see_project(r.project_id);

-- ====================================================================
-- 第 4、5 项：支出按项目层层确认
-- ====================================================================
-- 待批的申请停在哪一步：confirm 等项目负责人或副手确认；director 超预算，等中心负责人批；check 等财务岗核对。
-- step 为空的是老路：中心公共开支、按卡直接提的，照旧由中心负责人批准后直接承诺。
alter table expense_request
  add column step           text check (step in ('confirm','director','check')),
  add column over_amount    numeric(14,2) not null default 0,
  add column confirmed_by   uuid references app_user,
  add column confirmed_at   timestamptz,
  add column self_confirmed boolean not null default false,
  add column checked_by     uuid references app_user,
  add column checked_at     timestamptz,
  add column return_note    text;

insert into rbac_perm (code, name, grp, scope, sort) values
  ('request.confirm', '确认本项目成员提的支出申请', '支出', 'project', 32);
insert into rbac_role_perm (role_id, perm) select r.id, 'request.confirm' from rbac_role r where r.code in ('project_owner', 'project_deputy');

create function req_msg(r expense_request) returns text language sql stable security definer set search_path = public as $$
  select format('「%s」%s 元（%s）', r.title, to_char(r.amount, 'FM999,999,999,990.00'),
                coalesce((select name from project where id = r.project_id), '未挂项目'))
$$;

-- 直接选卡提交只留给看得到卡的人（财务岗、中心负责人）
select _pf('submit_request', '  c := lock_card(p_card);',
  '  if coalesce(current_setting(''app.via_line'', true), '''') <> ''1'' and not can_see_card(p_card) then
    raise exception ''拦截：支出从项目的预算行提交，不能直接选经费卡'';
  end if;
  c := lock_card(p_card);');

-- 提交时的通知：从预算行提的由 submit_project_request 自己发，发给谁看停在哪一步；通知里不带经费卡
create or replace function trg_notify_request() returns trigger language plpgsql security definer set search_path = public as $$
declare r expense_request; msg text; cmsg text;
begin
  select * into r from expense_request where id = new.request_id;
  msg := req_msg(r);
  cmsg := format('「%s」%s 元（%s）', r.title, to_char(r.amount, 'FM999,999,999,990.00'), (select name from fund_card where id = r.card_id));
  case new.kind
    when 'submit' then
      if coalesce(current_setting('app.via_line', true), '') = '1' and r.status = 'pending' then null;
      elsif r.status = 'pending' then perform notify_role('director', '待审批：' || cmsg);
      else perform notify_role('director', '紧急通道已直接承诺，请事后补批：' || cmsg); end if;
    when 'approve' then
      if r.status = 'committed' then
        perform notify_user(r.requested_by, '已批准：' || msg);
        perform notify_role('finance', '已批准，待提交学校：' || cmsg);
      else
        perform notify_user(r.requested_by, '中心负责人已批准超预算的部分，等财务岗核对：' || msg);
        perform notify_role('finance', '待核对：' || cmsg);
      end if;
    when 'confirm' then
      perform notify_user(r.requested_by, '项目负责人已确认：' || msg);
      if r.step = 'director' then perform notify_role('director', '超出预算，等你批：' || msg || coalesce('。' || new.note, ''));
      else perform notify_role('finance', '待核对：' || cmsg); end if;
    when 'check' then perform notify_user(r.requested_by, '财务岗核对通过，开始办理：' || msg);
    when 'reject' then perform notify_user(r.requested_by, '已退回：' || msg || coalesce('。原因：' || new.note, ''));
    when 'return' then
      perform notify_user(r.requested_by, '学校退回：' || msg || coalesce('。原因：' || new.note, ''));
      perform notify_role('director', '学校退回：' || cmsg || coalesce('。原因：' || new.note, ''));
    when 'move' then perform notify_user(r.requested_by, '已改到另一处经费重新送审：' || msg);
    when 'post' then perform notify_user(r.requested_by, '学校已入账：' || msg);
    when 'release' then perform notify_user(r.requested_by, '已释放，这笔申请作废：' || msg);
    else null;
  end case;
  return new;
end $$;

-- 从预算行提支出。只有名单里的人能提；超出这一行预算的不再拦，标出超多少，交中心负责人。
create or replace function submit_project_request(
  p_line uuid, p_type uuid, p_title text, p_amount numeric, p_eta date,
  p_emergency boolean default false, p_path text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare l v_line; y budget_year; c record; v text; why text := ''; rid uuid; pick record; qid uuid; tn text;
  pj project; ov numeric := 0; st text; me uuid := app_uid(); mine boolean; others boolean; r expense_request; ln text;
begin
  perform need_role('finance','director','leader','member');
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在'; end if;
  select * into y from budget_year where year = l.year;
  if y.stage = 'closed' then raise exception '拦截：% 年度已经决算，不能再支出', l.year; end if;
  if y.stage <> 'issued' then raise exception '拦截：% 年度预算还没有下达，下达后才能支出', l.year; end if;
  if l.year <> extract(year from app_today()) then raise exception '拦截：这是 % 年的预算，只能在当年支出', l.year; end if;
  select * into pj from project where id = l.project_id;
  if not pj.active then raise exception '拦截：项目已经停用'; end if;
  if not can_use_project(pj.id) then raise exception '拦截：你不在这个项目的成员名单里，请项目负责人先把你加进名单'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if l.used + p_amount > coalesce(l.fixed, 0) then
    if pj.kind = 'public' then
      raise exception '拦截：这一行预算核定 %，已用 %，剩 %，不够 %。要追加请在季度复盘时提出', l.fixed, l.used, l.fixed - l.used, p_amount;
    end if;
    if p_emergency then raise exception '拦截：超出预算的支出不能走紧急通道'; end if;
    ov := l.used + p_amount - coalesce(l.fixed, 0);
  end if;
  select name into tn from expense_type where id = p_type;
  for c in select a.card_id, a.subject_id, a.amount - a.used as rest, k.card_no, k.start_date, k.cutoff_date, k.status
           from v_alloc a join fund_card k on k.id = a.card_id
           where a.line_id = p_line
           order by case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no loop
    select x.verdict into v from v_reimb_rule x where x.card_id = c.card_id and x.expense_type_id = p_type;
    if c.status <> 'active' then why := why || c.card_no || ' 已结清；';
    elsif ov = 0 and c.rest < p_amount then why := why || c.card_no || ' 下达的预算只剩 ' || c.rest || '；';
    elsif app_today() < c.start_date then why := why || c.card_no || ' ' || c.start_date || ' 才下达；';
    elsif p_eta > c.cutoff_date then why := why || c.card_no || ' 单据 ' || c.cutoff_date || ' 截止；';
    elsif v is null then why := why || c.card_no || ' 能否列支「' || coalesce(tn, '') || '」还没有答复；';
    elsif v = 'no' then why := why || c.card_no || ' 不能列支「' || coalesce(tn, '') || '」；';
    elsif coalesce(avail(c.card_id, c.subject_id), 0) < p_amount then why := why || c.card_no || ' 这个科目可用额不够；';
    else pick := c; exit;
    end if;
  end loop;
  if pick is null then
    if why = '' then raise exception '拦截：这一行预算还没有下达到经费，请联系财务岗'; end if;
    -- 经费卡的细节只说给看得到卡的人
    if not has_perm('read.finance') then raise exception '拦截：这一行预算下达到的经费现在放不下这笔，请联系财务岗'; end if;
    raise exception '拦截：这一行预算下达到的经费卡都放不下这笔。%', why;
  end if;
  perform set_config('app.via_line', '1', true);
  rid := submit_request(pick.card_id, pick.subject_id, p_type, p_title, p_amount, p_eta, p_emergency, p_path);
  perform set_config('app.via_line', '', true);
  update expense_request set project_id = l.project_id, budget_line_id = p_line where id = rid;
  select id into qid from morningstar_quota where project_id = l.project_id and year = l.year;
  if qid is not null then perform attach_quota(rid, qid); end if;
  select * into r from expense_request where id = rid;
  if pj.kind = 'public' then
    perform notify_role('director', '待审批：' || req_msg(r));
  elsif r.status = 'pending' then
    mine := has_perm('request.confirm', pj.id);
    others := exists (select 1 from app_user u where u.active and u.id <> me and user_perm(u.id, 'request.confirm', pj.id));
    ln := case when ov > 0 then format('超出预算行「%s」%s 元', l.purpose, to_char(ov, 'FM999,999,999,990.00')) end;
    if others then st := 'confirm';
    elsif ov > 0 or not mine then st := 'director';
    else st := 'check';
    end if;
    update expense_request set step = st, over_amount = ov,
           self_confirmed = (mine and not others), confirmed_by = case when mine and not others then me end,
           confirmed_at = case when mine and not others then now() end
    where id = rid returning * into r;
    if st = 'confirm' then
      perform notify_user(u.id, '等你确认：' || req_msg(r) || coalesce('。' || ln, ''))
      from app_user u where u.active and u.id <> me and user_perm(u.id, 'request.confirm', pj.id);
    elsif st = 'director' then
      perform notify_role('director', case when ov > 0 then '超出预算，等你批：' else '待审批：' end || req_msg(r) || coalesce('。' || ln, ''));
    else
      perform notify_role('finance', '待核对：' || req_msg(r));
    end if;
  end if;
  return rid;
end $$;

-- 项目负责人或副手确认。自己提的不能自己确认。
create function confirm_request(p_req uuid, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r expense_request; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into r from expense_request where id = p_req for update;
  if not found then raise exception '申请不存在'; end if;
  if r.status <> 'pending' or r.step is distinct from 'confirm' then raise exception '这笔申请不在等项目负责人确认'; end if;
  if not has_perm('request.confirm', r.project_id) then raise exception '只有这个项目的负责人或副手能确认' using errcode = '42501'; end if;
  if r.requested_by = app_uid() then raise exception '自己提的申请要由负责人或副手里的另一位确认' using errcode = '42501'; end if;
  if p_ok then
    update expense_request set step = case when r.over_amount > 0 then 'director' else 'check' end,
           confirmed_by = app_uid(), confirmed_at = now(), updated_at = now() where id = p_req;
    perform log_event(p_req, 'confirm', case when r.over_amount > 0 then format('超出预算 %s 元', to_char(r.over_amount, 'FM999,999,999,990.00')) end);
  else
    if n is null then raise exception '不同意要写原因'; end if;
    update expense_request set status = 'rejected', return_note = n, confirmed_by = app_uid(), confirmed_at = now(), updated_at = now() where id = p_req;
    perform log_event(p_req, 'reject', n);
  end if;
end $$;

-- 中心负责人：老路上的直接批准；新路上只批超预算的，批了就把这一行的核定数调高到够用，再交财务岗核对。
create or replace function approve_request(p_req uuid) returns void language plpgsql security definer set search_path = public as $$
declare r expense_request; a numeric; l v_line; y budget_year; need numeric; s numeric;
begin
  perform need_role('director');
  select * into r from expense_request where id = p_req;
  perform lock_card(r.card_id);
  select * into r from expense_request where id = p_req for update;
  if r.status <> 'pending' then raise exception '该申请不在待审批状态'; end if;
  if r.step is not null and r.step <> 'director' then
    raise exception '这笔申请现在%，不用中心负责人批', case r.step when 'confirm' then '在等项目负责人确认' else '在等财务岗核对' end;
  end if;
  perform sod_self('request.approve', r.requested_by, '支出申请');
  if r.step is null then
    a := avail(r.card_id, r.subject_id);
    if r.amount > a then raise exception '无法批准：可用 %，不足 %', a, r.amount; end if;
    update expense_request set status = 'committed', approved_by = app_uid(), updated_at = now() where id = p_req;
    perform log_event(p_req, 'approve');
    return;
  end if;
  select * into l from v_line where id = r.budget_line_id;
  need := least(r.amount, greatest(l.used - coalesce(l.fixed, 0), 0));
  if need > 0 then
    y := lock_year(l.year);
    if y.stage <> 'issued' then raise exception '% 年度预算不在执行期，不能再批超预算的支出', l.year; end if;
    select coalesce(sum(fixed), 0) + need into s from v_line where year = l.year;
    if s > y.fixed_total then
      raise exception '无法批准：这笔超出预算 %，批了之后各项目核定数合计 % 超过年度总预算 %。先调减别的预算行，或者调高年度总预算', need, s, y.fixed_total;
    end if;
    update project_budget_line set fixed = coalesce(fixed, 0) + need where id = l.id;
    insert into budget_revision (line_id, old_amount, new_amount, note, revised_by)
    values (l.id, coalesce(l.fixed, 0), coalesce(l.fixed, 0) + need, format('超预算支出 %s 经中心负责人批准', coalesce(r.code, r.title)), app_uid());
    update budget_allocation set amount = amount + need where line_id = l.id and card_id = r.card_id and subject_id = r.subject_id;
    if not found then
      insert into budget_allocation (line_id, card_id, subject_id, amount) values (l.id, r.card_id, r.subject_id, need);
    end if;
  end if;
  update expense_request set step = 'check', approved_by = app_uid(), updated_at = now() where id = p_req;
  perform log_event(p_req, 'approve', case when need > 0 then format('超出预算 %s 元，已把这一行的核定数调高', to_char(need, 'FM999,999,999,990.00')) end);
end $$;

-- 中心负责人可以在任何一步驳回还没承诺的申请
create or replace function reject_request(p_req uuid, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  update expense_request set status = 'rejected', return_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
  where id = p_req and status = 'pending';
  if not found then raise exception '该申请不在待审批状态'; end if;
  perform log_event(p_req, 'reject', p_note);
end $$;

-- 财务岗核对：通过就承诺、开始办；不通过退回并写原因。
create function check_request(p_req uuid, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r expense_request; a numeric; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('request.process');
  select * into r from expense_request where id = p_req;
  if not found then raise exception '申请不存在'; end if;
  perform lock_card(r.card_id);
  select * into r from expense_request where id = p_req for update;
  if r.status <> 'pending' or r.step is distinct from 'check' then raise exception '这笔申请不在等财务岗核对'; end if;
  if p_ok then
    perform sod_self('request.process', r.requested_by, '支出申请');
    a := avail(r.card_id, r.subject_id);
    if r.amount > a then raise exception '无法通过：这笔落在的经费可用 %，不足 %。先做预算变更，或者退回', a, r.amount; end if;
    update expense_request set status = 'committed', checked_by = app_uid(), checked_at = now(), updated_at = now() where id = p_req;
    perform log_event(p_req, 'check');
  else
    if n is null then raise exception '退回要写原因'; end if;
    update expense_request set status = 'rejected', return_note = n, checked_by = app_uid(), checked_at = now(), updated_at = now() where id = p_req;
    perform log_event(p_req, 'reject', n);
  end if;
end $$;

-- 支出申请：带上停在哪一步、超多少、退回原因；经费卡只给看得到卡的人
create or replace view api.request as
  select r.id, r.code, case when can_see_card(r.card_id) then r.card_id end as card_id,
         r.subject_id, r.expense_type_id, r.title, r.amount, r.eta_date, r.emergency,
         r.status, r.requested_by, r.approved_by, r.created_at, r.updated_at,
         p.path, p.stage, p.stages, v.posted_on, v.amount as posted_amount, v.voucher_no,
         r.morningstar_quota_id, r.split_group, r.project_id, r.budget_line_id,
         r.step, r.over_amount, r.self_confirmed, r.return_note,
         j.name as project_name, bl.purpose as line_purpose,
         (select name from app_user where id = r.requested_by) as requester_name,
         (select name from app_user where id = r.confirmed_by) as confirmed_by_name,
         (select name from app_user where id = r.checked_by) as checked_by_name,
         (r.status = 'pending' and r.step = 'confirm' and r.requested_by is distinct from app_uid() and has_perm('request.confirm', r.project_id)) as can_confirm
  from expense_request r
  left join procurement p on p.request_id = r.id
  left join voucher v on v.request_id = r.id
  left join project j on j.id = r.project_id
  left join project_budget_line bl on bl.id = r.budget_line_id
  where r.requested_by = app_uid() or can_see_card(r.card_id)
     or exists (select 1 from morningstar_quota q where q.id = r.morningstar_quota_id and q.leader_id = app_uid())
     or (r.project_id is not null and (can_see_project(r.project_id) or has_perm('request.confirm', r.project_id)));

-- ====================================================================
-- 第 6 项：科目间调剂
-- ====================================================================
-- 项目负责人在自己项目的预算行之间调剂。全年自己调的累计不超过项目年度预算的 10% 时直接生效并留痕；超过的交中心负责人。
create table budget_shift (
  id           uuid primary key default gen_random_uuid(),
  year         int  not null references budget_year,
  project_id   uuid not null references project,
  from_line    uuid not null references project_budget_line,
  to_line      uuid not null references project_budget_line,
  amount       numeric(14,2) not null check (amount > 0),
  note         text not null,
  status       text not null check (status in ('applied','pending','rejected')),
  requested_by uuid references app_user,
  decided_by   uuid references app_user,
  decide_note  text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index on budget_shift (project_id, year);

create function apply_shift(p_shift uuid) returns void language plpgsql as $$
declare s budget_shift; f v_line; t v_line; over numeric; a record; cut numeric;
begin
  select * into s from budget_shift where id = p_shift;
  select * into f from v_line where id = s.from_line;
  select * into t from v_line where id = s.to_line;
  if f.id is null or t.id is null then raise exception '预算行不存在'; end if;
  if coalesce(f.fixed, 0) - f.used < s.amount then
    raise exception '调出的这一行核定 %，已用 %，只剩 %，不够调出 %', coalesce(f.fixed, 0), f.used, coalesce(f.fixed, 0) - f.used, s.amount;
  end if;
  -- 调出的一行多下达的部分收回，先收可结转的卡
  over := f.allocated - (f.fixed - s.amount);
  if over > 0 then
    for a in select x.id, x.amount, x.used from v_alloc x join fund_card k on k.id = x.card_id where x.line_id = f.id
             order by case k.end_rule when 'carry' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date) desc loop
      exit when over <= 0;
      cut := least(over, a.amount - a.used);
      if cut >= a.amount then delete from budget_allocation where id = a.id;
      elsif cut > 0 then update budget_allocation set amount = amount - cut where id = a.id;
      end if;
      over := over - greatest(cut, 0);
    end loop;
  end if;
  update project_budget_line set fixed = fixed - s.amount where id = f.id;
  update project_budget_line set fixed = coalesce(fixed, 0) + s.amount where id = t.id;
  insert into budget_revision (line_id, old_amount, new_amount, note, revised_by) values
    (f.id, f.fixed, f.fixed - s.amount, '科目间调剂，调出到「' || t.purpose || '」：' || s.note, s.requested_by),
    (t.id, coalesce(t.fixed, 0), coalesce(t.fixed, 0) + s.amount, '科目间调剂，从「' || f.purpose || '」调入：' || s.note, s.requested_by);
end $$;

create function shift_budget(p_from uuid, p_to uuid, p_amount numeric, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f v_line; t v_line; y budget_year; n text := nullif(btrim(coalesce(p_note, '')), ''); tot numeric; done numeric; sid uuid; st text; pn text;
begin
  select * into f from v_line where id = p_from;
  select * into t from v_line where id = p_to;
  if f.id is null or t.id is null then raise exception '预算行不存在'; end if;
  if p_from = p_to then raise exception '调出和调入不能是同一行'; end if;
  if f.project_id <> t.project_id or f.year <> t.year then raise exception '只能在同一个项目、同一年度的预算行之间调剂'; end if;
  if not has_perm('budget.project', f.project_id) then raise exception '只有项目负责人和副手能调剂本项目的预算' using errcode = '42501'; end if;
  y := lock_year(f.year);
  if y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前才能调剂'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if n is null then raise exception '请写明为什么调剂'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  if coalesce(f.fixed, 0) - f.used < p_amount then
    raise exception '调出的这一行核定 %，已用 %，只剩 %，不够调出 %', coalesce(f.fixed, 0), f.used, coalesce(f.fixed, 0) - f.used, p_amount;
  end if;
  if exists (select 1 from budget_shift where project_id = f.project_id and year = f.year and status = 'pending') then
    raise exception '这个项目已经有一笔调剂在等中心负责人批，批完再提';
  end if;
  select coalesce(sum(fixed), 0) into tot from v_line where project_id = f.project_id and year = f.year;
  select coalesce(sum(amount), 0) into done from budget_shift
  where project_id = f.project_id and year = f.year and status = 'applied' and decided_by is null;
  st := case when done + p_amount <= round(tot * 0.10, 2) then 'applied' else 'pending' end;
  insert into budget_shift (year, project_id, from_line, to_line, amount, note, status, requested_by)
  values (f.year, f.project_id, p_from, p_to, p_amount, n, st, app_uid()) returning id into sid;
  select name into pn from project where id = f.project_id;
  if st = 'applied' then
    perform apply_shift(sid);
    perform notify_role('finance', format('「%s」在预算行之间调剂了 %s 元，调入的部分等你下达到经费', pn, to_char(p_amount, 'FM999,999,999,990.00')));
  else
    perform notify_role('director', format('「%s」申请在预算行之间调剂 %s 元，全年累计超过年度预算的 10%%，等你批', pn, to_char(p_amount, 'FM999,999,999,990.00')));
  end if;
  return sid;
end $$;

create function decide_budget_shift(p_id uuid, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s budget_shift; y budget_year; n text := nullif(btrim(coalesce(p_note, '')), ''); pn text;
begin
  perform need_perm('budget.approve');
  select * into s from budget_shift where id = p_id for update;
  if not found or s.status <> 'pending' then raise exception '这笔调剂不存在，或者已经处理过'; end if;
  select name into pn from project where id = s.project_id;
  if p_ok then
    y := lock_year(s.year);
    if y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前才能调剂'; end if;
    perform apply_shift(p_id);
    update budget_shift set status = 'applied', decided_by = app_uid(), decide_note = n, decided_at = now() where id = p_id;
    perform notify_user(s.requested_by, '预算调剂已批准并生效');
    perform notify_role('finance', format('「%s」在预算行之间调剂了 %s 元，调入的部分等你下达到经费', pn, to_char(s.amount, 'FM999,999,999,990.00')));
  else
    if n is null then raise exception '不同意要写原因'; end if;
    update budget_shift set status = 'rejected', decided_by = app_uid(), decide_note = n, decided_at = now() where id = p_id;
    perform notify_user(s.requested_by, '预算调剂没有批准。原因：' || n);
  end if;
end $$;

create view api.budget_shift as
  select s.id, s.year, s.project_id, p.name as project_name, s.from_line, f.purpose as from_purpose, s.to_line, t.purpose as to_purpose,
         s.amount, s.note, s.status, (select name from app_user where id = s.requested_by) as requester_name,
         (select name from app_user where id = s.decided_by) as decided_by_name, s.decide_note, s.created_at, s.decided_at
  from budget_shift s join project p on p.id = s.project_id
  join project_budget_line f on f.id = s.from_line join project_budget_line t on t.id = s.to_line
  where can_see_project(s.project_id);

-- ====================================================================
-- 第 7 项：资产和额度的收口
-- ====================================================================
-- 入库记下是哪个项目的哪一行预算出的钱。设备买回来归中心，入公共设备库存。
alter table resource_stock add column project_id uuid references project, add column budget_line_id uuid references project_budget_line;
update resource_stock s set project_id = r.project_id, budget_line_id = r.budget_line_id
from expense_request r where r.id = s.expense_request_id and r.project_id is not null;

create function trg_stock_project() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select r.project_id, r.budget_line_id into new.project_id, new.budget_line_id from expense_request r where r.id = new.expense_request_id;
  return new;
end $$;
create trigger stock_project before insert on resource_stock for each row execute function trg_stock_project();

create or replace view api.resource_stock as
  select s.id, s.resource_id, r.kind, r.name as resource_name, r.unit, s.qty, s.unit_price, s.supplier, s.note, s.received_on,
         s.expense_request_id, (select name from app_user where id = s.created_by) as created_by_name,
         s.project_id, (select name from project where id = s.project_id) as project_name,
         (select purpose from project_budget_line where id = s.budget_line_id) as line_purpose
  from resource_stock s join resource r on r.id = s.resource_id
  where has_perm('read.resource');

-- 项目负责人看：本项目出钱买了哪些设备、现在在谁手里。设备归中心，不由项目分。
create view api.project_asset as
  select s.id, s.project_id, s.resource_id, r.name as resource_name, r.unit, s.qty, s.unit_price, s.received_on,
         (select purpose from project_budget_line where id = s.budget_line_id) as line_purpose,
         (select string_agg(u.name || case when a.quota is not null and a.quota <> 1 then ' ×' || trim_scale(a.quota) else '' end, '、' order by u.name)
          from resource_allocation a join app_user u on u.id = a.user_id
          where a.resource_id = s.resource_id and a.returned_on is null) as holders
  from resource_stock s join resource r on r.id = s.resource_id
  where r.kind = 'asset' and s.project_id is not null and can_see_project(s.project_id);

-- 项目负责人看：本项目名下的接口额度分给了谁、用了多少、何时到期。不带密钥。
create view api.project_allocation as
  select a.id, q.project_id, a.resource_id, r.name as resource_name, r.unit, a.user_id, u.name as user_name,
         a.quota, a.used, a.used_on, a.from_date, a.to_date, a.returned_on,
         (a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) as current
  from resource_allocation a join resource r on r.id = a.resource_id join resource_request q on q.id = a.request_id
  join app_user u on u.id = a.user_id
  where r.kind = 'api' and can_see_project(q.project_id);

-- 出钱买这种设备的项目，成员优先领用
create function asset_priority(p_resource uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from resource_stock s where s.resource_id = p_resource and s.project_id is not null and is_on_project(s.project_id, p_user))
$$;

create or replace view api.resource_request as
  select q.id, q.kind, q.resource_id, r.name as resource_name, r.unit, q.project_id, p.code as project_code, p.name as project_name,
         q.requested_by, u.name as requester_name, q.amount, q.period, q.purpose, q.usage_note, q.urgent, q.status, q.reviewed_at,
         (select name from app_user where id = q.reviewed_by) as reviewed_by_name, q.approved_amount, q.decided_at,
         (select name from app_user where id = q.decided_by) as decided_by_name, q.decide_note, q.fulfilled_at, q.created_at,
         ((p.owner_id is not null and p.owner_id = app_uid()) or has_scoped('resource.review', p.id)) as my_project,
         q.budget_line_id, bl.purpose as line_purpose, bl.plan_qty,
         (q.kind = 'asset' and q.resource_id is not null and asset_priority(q.resource_id, q.requested_by)) as priority
  from resource_request q join app_user u on u.id = q.requested_by
  left join resource r on r.id = q.resource_id left join project p on p.id = q.project_id
  left join project_budget_line bl on bl.id = q.budget_line_id
  where has_perm('read.resource') or q.requested_by = app_uid() or p.owner_id = app_uid() or has_scoped('resource.review', p.id);

-- 分发设备时：出钱项目的成员还有没发的申领，就不能先发给别人把库存发空
create or replace function fulfil_resource_request(p_id uuid, p_resource uuid default null, p_to date default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource_request; res resource; aid uuid; waiting numeric; out_ numeric; left_ numeric; qty numeric;
begin
  perform need_role('finance','director');
  select * into r from resource_request where id = p_id for update;
  if not found then raise exception '申请不存在'; end if;
  if r.status <> 'approved' then raise exception '批准之后才能分发'; end if;
  select * into res from resource where id = coalesce(p_resource, r.resource_id);
  if not found then raise exception '请选择从哪个资源分发'; end if;
  if res.kind <> r.kind then raise exception '资源类型和申请对不上'; end if;
  if res.kind = 'asset' and not asset_priority(res.id, r.requested_by) then
    select coalesce(sum(case when res.total is null then 1 else coalesce(q.approved_amount, q.amount) end), 0) into waiting
    from resource_request q
    where q.resource_id = res.id and q.id <> p_id and q.status in ('pending','reviewed','approved') and asset_priority(res.id, q.requested_by);
    if waiting > 0 then
      select coalesce(sum(coalesce(quota, 1)), 0) into out_ from resource_allocation where resource_id = res.id and returned_on is null;
      qty := case when res.total is null then 1 else r.approved_amount end;
      left_ := coalesce(res.total, 1) - out_ - qty;
      if left_ < waiting then
        raise exception '拦截：出钱买这批设备的项目还有 % 件申领没有发，他们优先领用。先发给他们，剩下的再发', waiting;
      end if;
    end if;
  end if;
  aid := allocate_resource(res.id, r.requested_by, case when res.kind = 'asset' and res.total is null then null else r.approved_amount end,
                           app_today(), p_to, coalesce(nullif(btrim(coalesce(p_note, '')), ''), '按申请分发'));
  update resource_allocation set request_id = p_id where id = aid;
  update resource_request set status = 'fulfilled', resource_id = res.id, fulfilled_at = now(), updated_at = now() where id = p_id;
  perform notify_user(r.requested_by, format('你申请的「%s」已经分发，到资源页面查看', res.name));
  return aid;
end $$;

-- 年末盘点和对账：每种资源一年记一次，账面数和实际数，对不上要写原因
create table year_check (
  id          uuid primary key default gen_random_uuid(),
  year        int  not null references budget_year,
  resource_id uuid not null references resource,
  book        numeric(14,2) not null,
  actual      numeric(14,2) not null,
  note        text,
  checked_by  uuid references app_user,
  checked_at  timestamptz not null default now(),
  unique (year, resource_id)
);

create function save_year_check(p_year int, p_resource uuid, p_actual numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r resource; y budget_year; bk numeric; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('resource.manage');
  select * into y from budget_year where year = p_year;
  if not found then raise exception '% 年度不存在', p_year; end if;
  if y.stage = 'closed' then raise exception '% 年度已经决算，盘点结果不能再改', p_year; end if;
  select * into r from resource where id = p_resource;
  if not found then raise exception '资源不存在'; end if;
  if p_actual is null or p_actual < 0 then raise exception '实际数不能为空，也不能是负数'; end if;
  bk := case when r.kind = 'api' then coalesce(r.balance, 0) else coalesce(r.total, 1) end;
  if p_actual <> bk and n is null then raise exception '实际数 % 和账面数 % 对不上，要写明原因', p_actual, bk; end if;
  if length(n) > 300 then raise exception '说明不超过 300 个字'; end if;
  if n ~ '[A-Za-z0-9_\-]{32,}' then raise exception '说明里不要填密钥'; end if;
  insert into year_check (year, resource_id, book, actual, note, checked_by) values (p_year, p_resource, bk, p_actual, n, app_uid())
  on conflict (year, resource_id) do update set book = excluded.book, actual = excluded.actual, note = excluded.note,
     checked_by = excluded.checked_by, checked_at = now();
end $$;

-- 每年每种在用的资源一行：盘没盘、差多少
create view api.year_check as
  select y.year, r.id as resource_id, r.kind, r.name as resource_name, r.unit,
         case when r.kind = 'api' then coalesce(r.balance, 0) else coalesce(r.total, 1) end as book_now,
         k.book, k.actual, k.actual - k.book as diff, k.note,
         (select name from app_user where id = k.checked_by) as checked_by_name, k.checked_at
  from budget_year y cross join resource r
  left join year_check k on k.year = y.year and k.resource_id = r.id
  where has_perm('read.resource') and y.stage in ('issued','closed') and (r.active or k.id is not null);

-- ====================================================================
-- 封表、留痕、授权
-- ====================================================================
select seal('project_member', 'project_cap', 'cap_request', 'budget_shift', 'year_check');
do $$ declare t text; begin
  foreach t in array array['project_member','project_cap','cap_request','budget_shift','year_check'] loop
    execute format('create trigger audit after insert or update or delete on %I for each row execute function trg_audit()', t);
  end loop;
end $$;

grant select on api.project_member, api.people_pick, api.project_cap, api.cap_request, api.budget_shift,
  api.project_asset, api.project_allocation, api.year_check to app_api;

select expose(
  'set_card_total(uuid, numeric, date, date)',
  'add_project_member(uuid, uuid)', 'remove_project_member(uuid, uuid)', 'recall_project_allocation(uuid)',
  'set_project_cap(int, uuid, numeric)', 'request_cap(int, uuid, numeric, text)', 'decide_cap_request(uuid, boolean, numeric, text)',
  'confirm_request(uuid, boolean, text)', 'check_request(uuid, boolean, text)',
  'shift_budget(uuid, uuid, numeric, text)', 'decide_budget_shift(uuid, boolean, text)',
  'save_year_check(int, uuid, numeric, text)');
do $$ declare f text; r text; begin
  foreach f in array array['is_on_project(uuid, uuid)', 'can_use_project(uuid)', 'member_holding(uuid, uuid)', 'cap_used(int, uuid)',
    'check_cap(int, uuid, numeric)', 'cap_tier_ok(numeric)', 'trg_year_caps()', 'trg_line_cap()', 'req_msg(expense_request)',
    'apply_shift(uuid)', 'trg_stock_project()', 'asset_priority(uuid, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;
-- 视图里用到的判断函数要让接口角色能调
grant execute on function is_on_project(uuid, uuid), can_use_project(uuid), member_holding(uuid, uuid), cap_used(int, uuid),
  asset_priority(uuid, uuid) to app_api;

drop function _pf(text, text, text);
