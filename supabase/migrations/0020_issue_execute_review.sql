-- 年度预算的后半程：把预算、执行、决算接成一条线。
--   03 下达      核定数逐行对到经费卡的学校科目上，到期回收的卡先填满
--   04 申请      提交支出时只选项目和预算行，系统在这一行下达到的卡里挑一张放得下的
--   07 复盘结清  每三个月按项目复盘；复盘时可以调整核定数；年末年度决算，未用的预算不结转
-- 晨星额度并进来：每个额度对应一个独立研究线项目，额度是这个项目当年预算的上限，劳务上限照旧。

-- ---------- 表 ----------
-- 中心预算科目对应哪些学校科目（一个预算科目在不同模板里各对应一个或几个学校科目）
create table category_subject (
  category_id uuid not null references budget_category on delete cascade,
  subject_id  uuid not null references template_subject on delete cascade,
  primary key (category_id, subject_id)
);

-- 下达：一行预算的核定数分到哪张卡的哪个科目
create table budget_allocation (
  id         uuid primary key default gen_random_uuid(),
  line_id    uuid not null references project_budget_line on delete cascade,
  card_id    uuid not null references fund_card,
  subject_id uuid not null references template_subject,
  amount     numeric(14,2) not null check (amount > 0),
  unique (line_id, card_id, subject_id)
);
create index on budget_allocation (card_id, subject_id);

-- 复盘时对核定数的调整，留痕
create table budget_revision (
  id         uuid primary key default gen_random_uuid(),
  line_id    uuid not null references project_budget_line on delete cascade,
  old_amount numeric(14,2) not null,
  new_amount numeric(14,2) not null,
  note       text not null,
  revised_by uuid references app_user,
  revised_at timestamptz not null default now()
);

-- 每三个月一次的复盘结论，按项目记
create table budget_review (
  id          uuid primary key default gen_random_uuid(),
  year        int not null references budget_year,
  quarter     int not null check (quarter between 1 and 4),
  project_id  uuid not null references project,
  note        text not null,
  reviewed_by uuid references app_user,
  reviewed_at timestamptz not null default now(),
  unique (year, quarter, project_id)
);

alter table expense_request add column project_id uuid references project,
                            add column budget_line_id uuid references project_budget_line;
create index on expense_request (budget_line_id);

alter table budget_year drop constraint budget_year_stage_check;
alter table budget_year add constraint budget_year_stage_check
  check (stage in ('declare','summary','approved','applied','granted','fixed','issued','closed'));
alter table budget_year add column issued_by uuid references app_user, add column issued_at timestamptz,
                        add column closed_by uuid references app_user, add column closed_at timestamptz;

alter table project add column labor_cap_ratio numeric(5,4) check (labor_cap_ratio between 0 and 1);
alter table morningstar_quota add column project_id uuid references project;

select seal('category_subject', 'budget_allocation', 'budget_revision', 'budget_review');
do $$ declare t text; begin
  foreach t in array array['category_subject','budget_allocation','budget_revision','budget_review'] loop
    execute format('create trigger audit after insert or update or delete on %I for each row execute function trg_audit()', t);
  end loop;
end $$;

-- ---------- 口径 ----------
-- 挂在预算行上的支出：在途（含待批）和已入账
create view v_line_use as
  select r.budget_line_id as line_id, r.card_id, r.subject_id,
         case when r.status = 'posted' then coalesce(v.amount, r.amount) else r.amount end as amt,
         r.status = 'posted' as posted, r.status = 'pending' as pending, v.posted_on
  from expense_request r left join voucher v on v.request_id = r.id
  where r.budget_line_id is not null and r.status in ('pending','committed','at_school','returned','posted');

create view v_alloc as
  select a.id, a.line_id, a.card_id, a.subject_id, a.amount,
         coalesce(sum(u.amt), 0) as used, coalesce(sum(u.amt) filter (where u.posted), 0) as actual
  from budget_allocation a
  left join v_line_use u on u.line_id = a.line_id and u.card_id = a.card_id and u.subject_id = a.subject_id
  group by a.id;

create view v_line as
  select l.id, b.year, b.project_id, l.category_id, l.purpose, l.q1, l.q2, l.q3, l.q4, l.fixed,
         coalesce((select sum(amount) from budget_allocation a where a.line_id = l.id), 0) as allocated,
         coalesce(u.used, 0) as used, coalesce(u.actual, 0) as actual, coalesce(u.pending, 0) as pending,
         coalesce(u.a1, 0) as a1, coalesce(u.a2, 0) as a2, coalesce(u.a3, 0) as a3, coalesce(u.a4, 0) as a4
  from project_budget_line l join project_budget b on b.id = l.budget_id
  left join (
    select line_id, sum(amt) as used, sum(amt) filter (where posted) as actual, sum(amt) filter (where pending) as pending,
           sum(amt) filter (where posted and extract(quarter from posted_on) = 1) as a1,
           sum(amt) filter (where posted and extract(quarter from posted_on) = 2) as a2,
           sum(amt) filter (where posted and extract(quarter from posted_on) = 3) as a3,
           sum(amt) filter (where posted and extract(quarter from posted_on) = 4) as a4
    from v_line_use group by 1
  ) u on u.line_id = l.id
  where b.status = 'submitted';

-- 一张卡一个科目上：已下达还没用掉的预算，不能超过这一格的可用额
create function check_cell_alloc(p_card uuid, p_subject uuid) returns void language plpgsql as $$
declare rest numeric; a numeric; n text;
begin
  select coalesce(sum(greatest(x.amount - x.used, 0)), 0) into rest
  from v_alloc x join project_budget_line l on l.id = x.line_id join project_budget b on b.id = l.budget_id
  join budget_year y on y.year = b.year
  where x.card_id = p_card and x.subject_id = p_subject and y.stage <> 'closed';
  a := coalesce(avail(p_card, p_subject), 0);
  if rest > a then
    select c.card_no || ' ' || s.name into n from fund_card c, template_subject s where c.id = p_card and s.id = p_subject;
    raise exception '% 可用 %，下达到这里还没用掉的预算合计 %，超出 %', n, a, rest, rest - a;
  end if;
end $$;

-- ---------- 科目对应 ----------
-- p_subjects: ["学校科目 id", ...]，整体替换
create function set_category_subjects(p_category uuid, p_subjects jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform need_role('finance','director');
  if not exists (select 1 from budget_category where id = p_category) then raise exception '预算科目不存在'; end if;
  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' then raise exception '请选择对应的学校科目'; end if;
  if exists (select 1 from jsonb_array_elements_text(p_subjects) e where not exists (select 1 from template_subject s where s.id = e::uuid)) then
    raise exception '学校科目不存在';
  end if;
  delete from category_subject where category_id = p_category;
  insert into category_subject (category_id, subject_id) select distinct p_category, e::uuid from jsonb_array_elements_text(p_subjects) e;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- 03 下达 ----------
-- p_parts: [{"card_id": "...", "subject_id": "...", "amount": 1000}]，整体替换这一行的下达
create function allocate_line(p_line uuid, p_parts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare l v_line; y budget_year; x record; s numeric;
begin
  perform need_role('finance','director');
  select * into l from v_line where id = p_line;
  if not found then raise exception '这一行不存在，或者所在项目的预算没有提交'; end if;
  y := lock_year(l.year);
  if y.stage not in ('fixed','issued') then raise exception '年度总预算确定之后才能下达'; end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then raise exception '请填写下达到哪张卡'; end if;
  if exists (select 1 from jsonb_array_elements(p_parts) e where (e->>'amount') is null or (e->>'amount')::numeric <= 0) then
    raise exception '下达金额要大于 0；不下达的卡不用列';
  end if;
  if (select count(*) <> count(distinct (e->>'card_id') || (e->>'subject_id')) from jsonb_array_elements(p_parts) e) then
    raise exception '同一张卡的同一个科目列了两次';
  end if;
  select coalesce(sum((e->>'amount')::numeric), 0) into s from jsonb_array_elements(p_parts) e;
  if s > coalesce(l.fixed, 0) then raise exception '下达合计 % 超过这一行的核定数 %', s, coalesce(l.fixed, 0); end if;
  for x in select c.card_no, c.status, c.start_date, c.cutoff_date, (e->>'card_id')::uuid as card_id, (e->>'subject_id')::uuid as subject_id,
                  exists (select 1 from template_subject t where t.id = (e->>'subject_id')::uuid and t.template_id = c.template_id) as fits
           from jsonb_array_elements(p_parts) e left join fund_card c on c.id = (e->>'card_id')::uuid loop
    if x.card_no is null then raise exception '经费卡不存在'; end if;
    if x.status <> 'active' then raise exception '% 已经结清，不能下达', x.card_no; end if;
    if not x.fits then raise exception '% 没有这个科目', x.card_no; end if;
    if x.start_date > make_date(l.year, 12, 31) or x.cutoff_date < make_date(l.year, 1, 1) then
      raise exception '% 的有效期不在 % 年内', x.card_no, l.year;
    end if;
    perform lock_card(x.card_id);
  end loop;
  -- 已经有支出的格子不能撤，也不能减到已用以下
  for x in select c.card_no, a.used, coalesce((select (e->>'amount')::numeric from jsonb_array_elements(p_parts) e
                    where (e->>'card_id')::uuid = a.card_id and (e->>'subject_id')::uuid = a.subject_id), 0) as want
           from v_alloc a join fund_card c on c.id = a.card_id where a.line_id = p_line and a.used > 0 loop
    if x.want < x.used then raise exception '% 上这一行已经用了 %，下达不能低于它', x.card_no, x.used; end if;
  end loop;
  delete from budget_allocation a where a.line_id = p_line
    and not exists (select 1 from jsonb_array_elements(p_parts) e where (e->>'card_id')::uuid = a.card_id and (e->>'subject_id')::uuid = a.subject_id);
  insert into budget_allocation (line_id, card_id, subject_id, amount)
  select p_line, (e->>'card_id')::uuid, (e->>'subject_id')::uuid, round((e->>'amount')::numeric, 2) from jsonb_array_elements(p_parts) e
  on conflict (line_id, card_id, subject_id) do update set amount = excluded.amount;
  for x in select (e->>'card_id')::uuid as card_id, (e->>'subject_id')::uuid as subject_id from jsonb_array_elements(p_parts) e loop
    perform check_cell_alloc(x.card_id, x.subject_id);
  end loop;
end $$;

-- 按科目对应自动下达还没下达完的行。先填到期回收的卡（结清日早的在前），再填要退回的，最后是可结转的。
-- 返回这次下达完整的行数；放不下的行留给财务岗手工处理。
create function auto_allocate(p_year int) returns int
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
             order by case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no, s.sort loop
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

-- 推进年度预算的阶段。在 0019 的基础上加：
--   reopen   已确定 → 已批复（中心负责人；还没有下达时才行）
--   issue    财务岗下达：每一行核定数都对到了经费卡
--   final    中心负责人做年度决算：年度过完、没有待批的支出；未用的预算不结转
create or replace function advance_budget_year(p_year int, p_action text, p_amount numeric default null, p_on date default null) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; s numeric; n int;
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
    elsif y.stage = 'fixed' then
      perform need_role('director');
      if exists (select 1 from v_line where year = p_year and allocated > 0) then raise exception '已经有预算行下达到经费卡，先撤掉下达再退回'; end if;
      update budget_year set stage = 'granted', fixed_total = null, fixed_by = null, fixed_at = null where year = p_year;
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
  elsif p_action = 'issue' then
    perform need_role('finance','director');
    if y.stage <> 'fixed' then raise exception '年度总预算确定之后才能下达'; end if;
    select count(*), coalesce(sum(fixed - allocated), 0) into n, s from v_line where year = p_year and coalesce(fixed, 0) > allocated;
    if n > 0 then raise exception '还有 % 行核定数没有对到经费卡，合计 %', n, s; end if;
    update budget_year set stage = 'issued', issued_by = app_uid(), issued_at = now() where year = p_year;
  elsif p_action = 'final' then
    perform need_role('director');
    if y.stage <> 'issued' then raise exception '预算下达并执行之后才能做年度决算'; end if;
    if app_today() <= make_date(p_year, 12, 31) then raise exception '% 年还没有过完，过完再做年度决算', p_year; end if;
    select count(*) into n from v_line_use u join v_line l on l.id = u.line_id where l.year = p_year and u.pending;
    if n > 0 then raise exception '还有 % 笔支出申请没有批，先批准或驳回', n; end if;
    update budget_year set stage = 'closed', closed_by = app_uid(), closed_at = now() where year = p_year;
  else
    raise exception '不认识的操作';
  end if;
end $$;

-- ---------- 04 申请：按项目提交支出 ----------
-- 只选预算行，系统在这一行下达到的卡里挑第一张放得下的：先回收卡，结清日早的在前。
-- 经费卡侧的全部拦截照旧走 submit_request。
create function submit_project_request(
  p_line uuid, p_type uuid, p_title text, p_amount numeric, p_eta date,
  p_emergency boolean default false, p_path text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare l v_line; y budget_year; c record; v text; why text := ''; rid uuid; pick record; qid uuid; tn text;
begin
  perform need_role('finance','director','leader','member');
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在'; end if;
  select * into y from budget_year where year = l.year;
  if y.stage = 'closed' then raise exception '拦截：% 年度已经决算，不能再支出', l.year; end if;
  if y.stage <> 'issued' then raise exception '拦截：% 年度预算还没有下达，下达后才能支出', l.year; end if;
  if l.year <> extract(year from app_today()) then raise exception '拦截：这是 % 年的预算，只能在当年支出', l.year; end if;
  if not exists (select 1 from project where id = l.project_id and active) then raise exception '拦截：项目已经停用'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if l.used + p_amount > coalesce(l.fixed, 0) then
    raise exception '拦截：这一行预算核定 %，已用 %，剩 %，不够 %。要追加请在季度复盘时提出', l.fixed, l.used, l.fixed - l.used, p_amount;
  end if;
  select name into tn from expense_type where id = p_type;
  for c in select a.card_id, a.subject_id, a.amount - a.used as rest, k.card_no, k.start_date, k.cutoff_date, k.status
           from v_alloc a join fund_card k on k.id = a.card_id
           where a.line_id = p_line
           order by case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no loop
    select r.verdict into v from v_reimb_rule r where r.card_id = c.card_id and r.expense_type_id = p_type;
    if c.status <> 'active' then why := why || c.card_no || ' 已结清；';
    elsif c.rest < p_amount then why := why || c.card_no || ' 下达的预算只剩 ' || c.rest || '；';
    elsif app_today() < c.start_date then why := why || c.card_no || ' ' || c.start_date || ' 才下达；';
    elsif p_eta > c.cutoff_date then why := why || c.card_no || ' 单据 ' || c.cutoff_date || ' 截止；';
    elsif v is null then why := why || c.card_no || ' 能否列支「' || coalesce(tn, '') || '」还没有答复；';
    elsif v = 'no' then why := why || c.card_no || ' 不能列支「' || coalesce(tn, '') || '」；';
    elsif coalesce(avail(c.card_id, c.subject_id), 0) < p_amount then why := why || c.card_no || ' 这个科目可用额不够；';
    else pick := c; exit;
    end if;
  end loop;
  if pick is null then
    if why = '' then raise exception '拦截：这一行预算还没有下达到经费卡，请联系财务岗'; end if;
    raise exception '拦截：这一行预算下达到的经费卡都放不下这笔。%', why;
  end if;
  rid := submit_request(pick.card_id, pick.subject_id, p_type, p_title, p_amount, p_eta, p_emergency, p_path);
  update expense_request set project_id = l.project_id, budget_line_id = p_line where id = rid;
  select id into qid from morningstar_quota where project_id = l.project_id and year = l.year;
  if qid is not null then perform attach_quota(rid, qid); end if;
  return rid;
end $$;

-- 财务岗把一笔已有的支出挂到预算行上（或取消）。用于年中才下达、之前按卡提交的支出。
create function set_request_line(p_req uuid, p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r expense_request; l v_line;
begin
  perform need_role('finance','director');
  select * into r from expense_request where id = p_req for update;
  if not found then raise exception '申请不存在'; end if;
  if r.status in ('rejected','released') then raise exception '这笔申请已作废'; end if;
  if p_line is null then
    update expense_request set budget_line_id = null, project_id = null, updated_at = now() where id = p_req;
    return;
  end if;
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在'; end if;
  if exists (select 1 from budget_year where year = l.year and stage = 'closed') then raise exception '% 年度已经决算', l.year; end if;
  update expense_request set budget_line_id = p_line, project_id = l.project_id, updated_at = now() where id = p_req;
  select * into l from v_line where id = p_line;
  if l.used > coalesce(l.fixed, 0) then raise exception '挂上之后这一行超出核定数 %', l.used - coalesce(l.fixed, 0); end if;
end $$;

-- ---------- 07 复盘 ----------
create function review_project(p_year int, p_quarter int, p_project uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare y budget_year; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director');
  y := lock_year(p_year);
  if y.stage not in ('issued','closed') then raise exception '预算下达之后才有复盘'; end if;
  if p_quarter is null or p_quarter not between 1 and 4 then raise exception '请选择是第几个预算期'; end if;
  if n is null then raise exception '请写复盘结论'; end if;
  if not exists (select 1 from project_budget where year = p_year and project_id = p_project and status = 'submitted') then
    raise exception '这个项目这一年没有预算';
  end if;
  insert into budget_review (year, quarter, project_id, note, reviewed_by) values (p_year, p_quarter, p_project, n, app_uid())
  on conflict (year, quarter, project_id) do update set note = excluded.note, reviewed_by = excluded.reviewed_by, reviewed_at = now();
end $$;

-- 复盘时调整一行的核定数。调减：不能低于已用，多下达的部分自动收回（先收可结转的卡，回收卡最后动）。
-- 调增：各项目核定数合计不能超过年度总预算，增加的部分要再下达。
create function revise_fixed(p_line uuid, p_amount numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare l v_line; y budget_year; s numeric; over numeric; a record; cut numeric; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('director');
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在'; end if;
  y := lock_year(l.year);
  if y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前才能调整核定数'; end if;
  if p_amount is null or p_amount < 0 then raise exception '金额不能为空，也不能是负数'; end if;
  if n is null then raise exception '请写明调整原因'; end if;
  if p_amount = l.fixed then raise exception '金额没有变'; end if;
  if p_amount < l.used then raise exception '这一行已经用了 %，核定数不能低于它', l.used; end if;
  select coalesce(sum(fixed), 0) - l.fixed + p_amount into s from v_line where year = l.year;
  if s > y.fixed_total then raise exception '调整后各项目核定数合计 % 超过年度总预算 %', s, y.fixed_total; end if;
  over := l.allocated - p_amount;
  if over > 0 then
    for a in select x.id, x.amount, x.used from v_alloc x join fund_card k on k.id = x.card_id where x.line_id = p_line
             order by case k.end_rule when 'carry' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date) desc loop
      exit when over <= 0;
      cut := least(over, a.amount - a.used);
      if cut >= a.amount then delete from budget_allocation where id = a.id;
      elsif cut > 0 then update budget_allocation set amount = amount - cut where id = a.id;
      end if;
      over := over - greatest(cut, 0);
    end loop;
  end if;
  update project_budget_line set fixed = p_amount where id = p_line;
  insert into budget_revision (line_id, old_amount, new_amount, note, revised_by) values (p_line, l.fixed, p_amount, n, app_uid());
end $$;

-- ---------- 晨星额度并入项目预算 ----------
-- 给额度建一个独立研究线项目（同一位负责人已经有的就沿用），额度成为这个项目当年预算的上限。
create function quota_to_project(p_quota uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare q morningstar_quota; pid uuid; nm text; k int;
begin
  perform need_role('finance','director');
  select * into q from morningstar_quota where id = p_quota for update;
  if not found then raise exception '晨星额度不存在'; end if;
  if q.project_id is not null then raise exception '这个额度已经对应到项目了'; end if;
  select project_id into pid from morningstar_quota where leader_id = q.leader_id and project_id is not null order by year desc limit 1;
  if pid is null then
    select name into nm from app_user where id = q.leader_id;
    select count(*) + 1 into k from project where code like 'CX-%';
    while exists (select 1 from project where code = 'CX-' || lpad(k::text, 2, '0')) loop k := k + 1; end loop;
    insert into project (code, name, kind, owner_id, labor_cap_ratio)
    values ('CX-' || lpad(k::text, 2, '0'), '晨星 · ' || nm, 'line', q.leader_id, q.labor_cap_ratio) returning id into pid;
  else
    update project set labor_cap_ratio = q.labor_cap_ratio where id = pid;
  end if;
  update morningstar_quota set project_id = pid where id = p_quota;
  update expense_request set project_id = pid where morningstar_quota_id = p_quota and project_id is null;
  return pid;
end $$;

-- 新一年的额度自动沿用这位负责人已有的项目
create function trg_quota_project() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.project_id is null then
    select project_id into new.project_id from morningstar_quota where leader_id = new.leader_id and project_id is not null order by year desc limit 1;
  end if;
  return new;
end $$;
create trigger quota_project before insert on morningstar_quota for each row execute function trg_quota_project();

-- 提交年度预算时：有晨星额度的项目不能超过额度；设了劳务上限的项目，劳务类不能超过上限
create function trg_budget_submit() returns trigger language plpgsql security definer set search_path = public as $$
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
  end if;
  return new;
end $$;
create trigger budget_submit before update on project_budget for each row execute function trg_budget_submit();

-- ---------- 只读视图 ----------
create view api.category_subject as
  select m.category_id, m.subject_id from category_subject m where is_staff();

create view api.budget_alloc as
  select a.id, a.line_id, l.year, l.project_id, a.card_id, k.card_no, k.name as card_name, k.end_rule,
         coalesce(k.settle_date, k.cutoff_date) as card_end, a.subject_id, s.name as subject_name, a.amount, a.used, a.actual
  from v_alloc a join v_line l on l.id = a.line_id join fund_card k on k.id = a.card_id join template_subject s on s.id = a.subject_id
  where can_edit_project(l.project_id);

create view api.line_exec as
  select l.* from v_line l where can_edit_project(l.project_id);

-- 提交支出时选预算行用：所有登录用户能看到当年已下达的项目和预算行，看不到金额
create view api.line_pick as
  select l.id, l.project_id, p.code as project_code, p.name as project_name, l.category_id, c.name as category_name, l.purpose
  from v_line l join project p on p.id = l.project_id join budget_category c on c.id = l.category_id
  join budget_year y on y.year = l.year
  where app_role() is not null and p.active and y.stage = 'issued' and l.year = extract(year from app_today())
    and coalesce(l.fixed, 0) > 0;

create view api.budget_revision as
  select r.id, r.line_id, l.year, l.project_id, l.purpose, r.old_amount, r.new_amount, r.note, u.name as revised_by_name, r.revised_at
  from budget_revision r join v_line l on l.id = r.line_id left join app_user u on u.id = r.revised_by
  where can_edit_project(l.project_id);

create view api.budget_review as
  select r.id, r.year, r.quarter, r.project_id, r.note, u.name as reviewed_by_name, r.reviewed_at
  from budget_review r left join app_user u on u.id = r.reviewed_by
  where can_edit_project(r.project_id);

create or replace view api.budget_year as
  select y.year, y.due_date, y.stage, y.applied_on, y.granted_on, y.approved_at, a.name as approved_by_name,
         case when is_staff() then y.granted_amount end as granted_amount,
         case when is_staff() then y.fixed_total end as fixed_total,
         y.issued_at, y.closed_at
  from budget_year y left join app_user a on a.id = y.approved_by
  where app_role() is not null;

create or replace view api.project as
  select p.id, p.code, p.name, p.kind, p.owner_id, u.name as owner_name, p.active,
         (is_staff() or p.owner_id = app_uid()) as mine, p.labor_cap_ratio
  from project p left join app_user u on u.id = p.owner_id
  where app_role() is not null and (p.active or is_staff());

create or replace view api.quota as
  select q.id, q.leader_id, u.name as leader_name, q.year, q.amount, q.labor_cap_ratio,
         q.used, q.actual, q.labor_used, q.requests,
         round(q.amount * q.labor_cap_ratio, 2) as labor_cap,
         x.quarter, round(q.amount * x.quarter / 4, 2) as due,
         (x.quarter > 0 and q.actual < round(q.amount * x.quarter / 4 * 0.7, 2)) as behind,
         m.project_id
  from v_quota q join app_user u on u.id = q.leader_id join morningstar_quota m on m.id = q.id
  cross join lateral (select case when q.year < extract(year from app_today()) then 4
                                  when q.year > extract(year from app_today()) then 0
                                  else extract(quarter from app_today())::int end as quarter) x
  where is_staff() or q.leader_id = app_uid();

-- 支出申请带上项目和预算行；项目负责人能看到自己项目的支出
create or replace view api.request as
  select r.id, r.code, r.card_id, r.subject_id, r.expense_type_id, r.title, r.amount, r.eta_date, r.emergency,
         r.status, r.requested_by, r.approved_by, r.created_at, r.updated_at,
         p.path, p.stage, p.stages, v.posted_on, v.amount as posted_amount, v.voucher_no,
         r.morningstar_quota_id, r.split_group, r.project_id, r.budget_line_id
  from expense_request r
  left join procurement p on p.request_id = r.id
  left join voucher v on v.request_id = r.id
  where r.requested_by = app_uid() or can_see_card(r.card_id)
     or exists (select 1 from morningstar_quota q where q.id = r.morningstar_quota_id and q.leader_id = app_uid())
     or exists (select 1 from project j where j.id = r.project_id and j.owner_id = app_uid());

grant select on api.category_subject, api.budget_alloc, api.line_exec, api.line_pick, api.budget_revision, api.budget_review to app_api;

select expose(
  'set_category_subjects(uuid, jsonb)', 'allocate_line(uuid, jsonb)', 'auto_allocate(int)',
  'submit_project_request(uuid, uuid, text, numeric, date, boolean, text)', 'set_request_line(uuid, uuid)',
  'review_project(int, int, uuid, text)', 'revise_fixed(uuid, numeric, text)', 'quota_to_project(uuid)');
do $$ declare f text; r text; begin
  foreach f in array array['check_cell_alloc(uuid, uuid)', 'trg_quota_project()', 'trg_budget_submit()'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;
