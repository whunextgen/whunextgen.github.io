-- 晨星额度：叠在经费卡之上的内部额度。每位负责人每年一个额度，支出申请可以挂到额度上。
-- 钱仍然从经费卡的科目里出，经费卡的全部拦截照旧；额度只多管三件事：
--   1. 挂在额度上的支出（在途 + 已入账）不超过额度；
--   2. 其中劳务类科目不超过额度 × 劳务上限比例（默认 30%）；
--   3. 季度执行：到当季末应累计入账 额度 × 当季序号 / 4，实际入账不到应执行数的 70% 标为落后。

-- 劳务类科目：有发放类型对应的科目，或科目名里带劳务、工资
create function is_labor_subject(p_subject uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from template_subject s where s.id = p_subject
                 and (s.name ~ '劳务|工资' or exists (select 1 from pay_type pt where pt.subject_code = s.code)))
$$;

create view v_quota as
  select q.id, q.leader_id, q.year, q.amount, q.labor_cap_ratio,
         coalesce(sum(u.amt), 0) as used,
         coalesce(sum(u.amt) filter (where u.posted), 0) as actual,
         coalesce(sum(u.amt) filter (where u.labor), 0) as labor_used,
         count(u.amt)::int as requests
  from morningstar_quota q
  left join lateral (
    select case when r.status = 'posted' then coalesce(v.amount, r.amount) else r.amount end as amt,
           r.status = 'posted' as posted, is_labor_subject(r.subject_id) as labor
    from expense_request r left join voucher v on v.request_id = r.id
    where r.morningstar_quota_id = q.id and r.status in ('pending','committed','at_school','returned','posted')
  ) u on true
  group by q.id;

create function check_quota(p_quota uuid) returns void language plpgsql as $$
declare q v_quota;
begin
  select * into q from v_quota where id = p_quota;
  if q.used > q.amount then raise exception '拦截：晨星额度不足，超出 %', q.used - q.amount; end if;
  if q.labor_used > round(q.amount * q.labor_cap_ratio, 2) then
    raise exception '拦截：晨星额度里劳务类支出超过上限 %，超出 %', round(q.amount * q.labor_cap_ratio, 2), q.labor_used - round(q.amount * q.labor_cap_ratio, 2);
  end if;
end $$;

create function save_quota(p_id uuid, p_leader uuid, p_year int, p_amount numeric, p_labor_ratio numeric default 0.3) returns uuid
language plpgsql security definer set search_path = public as $$
declare qid uuid;
begin
  perform need_role('director');
  if p_amount is null or p_amount <= 0 then raise exception '额度必须大于 0'; end if;
  if p_labor_ratio is null or p_labor_ratio < 0 or p_labor_ratio > 1 then raise exception '劳务上限比例要在 0 到 100%% 之间'; end if;
  if p_id is null then
    if p_year is null or p_year < 2020 or p_year > 2100 then raise exception '请填写年度'; end if;
    if not exists (select 1 from app_user where id = p_leader and active) then raise exception '负责人不存在或已停用'; end if;
    if exists (select 1 from morningstar_quota where leader_id = p_leader and year = p_year) then
      raise exception '这位负责人 % 年已经有额度，直接修改即可', p_year;
    end if;
    insert into morningstar_quota (leader_id, year, amount, labor_cap_ratio) values (p_leader, p_year, p_amount, p_labor_ratio) returning id into qid;
  else
    -- 负责人和年度定了就不改：已经挂上的支出按它算
    update morningstar_quota set amount = p_amount, labor_cap_ratio = p_labor_ratio where id = p_id returning id into qid;
    if qid is null then raise exception '额度不存在'; end if;
    perform check_quota(qid);
  end if;
  return qid;
end $$;

-- 把一笔申请挂到额度上（或取消挂接）。提交时由 submit_request_quota 调用；事后调整由财务岗或中心负责人做。
create function attach_quota(p_req uuid, p_quota uuid) returns void language plpgsql as $$
declare q morningstar_quota;
begin
  if p_quota is not null then
    select * into q from morningstar_quota where id = p_quota for update;
    if not found then raise exception '晨星额度不存在'; end if;
    if q.year <> extract(year from app_today()) then raise exception '拦截：这是 % 年的晨星额度，只能挂当年的支出', q.year; end if;
  end if;
  update expense_request set morningstar_quota_id = p_quota, updated_at = now() where id = p_req;
  if not found then raise exception '申请不存在'; end if;
  if p_quota is not null then perform check_quota(p_quota); end if;
end $$;

create function set_request_quota(p_req uuid, p_quota uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if exists (select 1 from expense_request where id = p_req and status in ('rejected','released')) then
    raise exception '这笔申请已作废，不用再挂额度';
  end if;
  perform attach_quota(p_req, p_quota);
end $$;

-- 提交支出申请并挂晨星额度。经费卡侧的拦截全部走 submit_request；额度不够时整笔不提交。
create function submit_request_quota(
  p_card uuid, p_subject uuid, p_type uuid, p_title text, p_amount numeric, p_eta date,
  p_emergency boolean default false, p_path text default null, p_quota uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  rid := submit_request(p_card, p_subject, p_type, p_title, p_amount, p_eta, p_emergency, p_path);
  if p_quota is not null then perform attach_quota(rid, p_quota); end if;
  return rid;
end $$;

-- 财务岗、中心负责人看全部；负责人看自己的
create view api.quota as
  select q.id, q.leader_id, u.name as leader_name, q.year, q.amount, q.labor_cap_ratio,
         q.used, q.actual, q.labor_used, q.requests,
         round(q.amount * q.labor_cap_ratio, 2) as labor_cap,
         x.quarter, round(q.amount * x.quarter / 4, 2) as due,
         (x.quarter > 0 and q.actual < round(q.amount * x.quarter / 4 * 0.7, 2)) as behind
  from v_quota q join app_user u on u.id = q.leader_id
  cross join lateral (select case when q.year < extract(year from app_today()) then 4
                                  when q.year > extract(year from app_today()) then 0
                                  else extract(quarter from app_today())::int end as quarter) x
  where is_staff() or q.leader_id = app_uid();

-- 提交申请时选额度用：所有登录用户能看到当年有哪些额度，但看不到金额
create view api.quota_pick as
  select q.id, u.name as leader_name, q.year
  from morningstar_quota q join app_user u on u.id = q.leader_id
  where app_role() is not null and q.year = extract(year from app_today());

create or replace view api.request as
  select r.id, r.code, r.card_id, r.subject_id, r.expense_type_id, r.title, r.amount, r.eta_date, r.emergency,
         r.status, r.requested_by, r.approved_by, r.created_at, r.updated_at,
         p.path, p.stage, p.stages, v.posted_on, v.amount as posted_amount, v.voucher_no,
         r.morningstar_quota_id
  from expense_request r
  left join procurement p on p.request_id = r.id
  left join voucher v on v.request_id = r.id
  where r.requested_by = app_uid() or can_see_card(r.card_id)
     or exists (select 1 from morningstar_quota q where q.id = r.morningstar_quota_id and q.leader_id = app_uid());

grant select on api.quota, api.quota_pick to app_api;
-- 视图里用到的函数按调用者的权限检查，所以 is_labor_subject 要授给接口角色（它只回答某个科目是不是劳务类）
select expose('is_labor_subject(uuid)', 'save_quota(uuid, uuid, int, numeric, numeric)', 'set_request_quota(uuid, uuid)',
              'submit_request_quota(uuid, uuid, uuid, text, numeric, date, boolean, text, uuid)');
do $$ declare f text; r text; begin
  foreach f in array array['check_quota(uuid)', 'attach_quota(uuid, uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;
