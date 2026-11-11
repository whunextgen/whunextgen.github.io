-- 业务动作。每个函数是一个事务：先锁经费卡，再校验，再写。
-- 所有占用预算的动作（批准、改卡、变更批复、人员改挂）都走这里，保证并发时不越过可用额度。

create function need_role(variadic roles text[]) returns void language plpgsql stable as $$
begin
  if app_role() is null or not (app_role() = any(roles)) then
    raise exception '当前角色不能执行此操作' using errcode = '42501';
  end if;
end $$;

create function app_today() returns date language sql stable as
$$ select coalesce(nullif(current_setting('app.today', true), '')::date, current_date) $$;

create function lock_card(p_card uuid) returns fund_card language plpgsql as $$
declare c fund_card;
begin
  select * into c from fund_card where id = p_card for update;
  if not found then raise exception '经费卡不存在'; end if;
  if c.status = 'settled' then raise exception '经费卡 % 已结清', c.card_no; end if;
  return c;
end $$;

create function avail(p_card uuid, p_subject uuid) returns numeric language sql stable as
$$ select avail from v_cell where card_id = p_card and subject_id = p_subject $$;

create function log_event(p_req uuid, p_kind text, p_note text default null) returns void language sql as
$$ insert into request_event (request_id, kind, note, actor) values (p_req, p_kind, p_note, app_uid()) $$;

-- ---------- 支出申请 ----------
create function submit_request(
  p_card uuid, p_subject uuid, p_type uuid, p_title text, p_amount numeric, p_eta date,
  p_emergency boolean default false, p_path text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare c fund_card; v text; note text; t expense_type; a numeric; lim emergency_limit; used numeric; rid uuid;
begin
  perform need_role('finance','director','leader','member');
  c := lock_card(p_card);
  if app_today() < c.start_date then raise exception '拦截：% 尚未下达', c.card_no; end if;
  if p_eta > c.cutoff_date then raise exception '拦截：预计入账 % 晚于该卡单据截止 %', p_eta, c.cutoff_date; end if;
  if not exists (select 1 from template_subject where id = p_subject and template_id = c.template_id) then
    raise exception '拦截：该卡没有这个科目';
  end if;
  select * into t from expense_type where id = p_type;
  select r.verdict, r.note into v, note from v_reimb_rule r where r.card_id = p_card and r.expense_type_id = p_type;
  if v is null then raise exception '拦截：% 能否列支「%」还没有答复，请先问财务并记录到规则表', c.card_no, t.name; end if;
  if v = 'no' then raise exception '拦截：% 不能列支「%」。%', c.card_no, t.name, coalesce(note, ''); end if;
  a := avail(p_card, p_subject);
  if p_amount > a then raise exception '拦截：可用 %，不足 %。请先做预算变更或改走其他卡', a, p_amount; end if;
  if t.required_path is not null and p_path is distinct from t.required_path then
    raise exception '拦截：「%」必须走%', t.name, t.required_path;
  end if;
  if p_path = '直采' and p_amount > 50000 then raise exception '拦截：直采单件上限 5 万，请走分散采购'; end if;
  if p_emergency then
    select * into lim from emergency_limit where year = extract(year from app_today());
    if not found then raise exception '拦截：本年度未设置紧急通道额度'; end if;
    if p_amount > lim.per_request then raise exception '拦截：紧急通道单笔上限 %', lim.per_request; end if;
    select coalesce(sum(amount), 0) into used from expense_request
      where emergency and status not in ('rejected','released')
        and extract(year from created_at) = lim.year;
    if used + p_amount > lim.per_year then raise exception '拦截：紧急通道全年额度已用完'; end if;
  end if;
  insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, emergency, status, requested_by)
  values (p_card, p_subject, p_type, p_title, p_amount, p_eta, p_emergency,
          case when p_emergency then 'committed' else 'pending' end, app_uid())
  returning id into rid;
  if p_path is not null then
    insert into procurement (request_id, path, stages)
    values (rid, p_path, case p_path when '分散采购' then 6 else 4 end);
  end if;
  perform log_event(rid, 'submit', case when v = 'disputed' then '口径有争议，有退单风险' end);
  return rid;
end $$;

create function approve_request(p_req uuid) returns void language plpgsql security definer set search_path = public as $$
declare r expense_request; a numeric;
begin
  perform need_role('director');
  select * into r from expense_request where id = p_req;
  perform lock_card(r.card_id);
  select * into r from expense_request where id = p_req for update;
  if r.status <> 'pending' then raise exception '该申请不在待审批状态'; end if;
  a := avail(r.card_id, r.subject_id);
  if r.amount > a then raise exception '无法批准：可用 %，不足 %', a, r.amount; end if;
  update expense_request set status = 'committed', approved_by = app_uid(), updated_at = now() where id = p_req;
  perform log_event(p_req, 'approve');
end $$;

create function reject_request(p_req uuid, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  update expense_request set status = 'rejected', updated_at = now() where id = p_req and status = 'pending';
  if not found then raise exception '该申请不在待审批状态'; end if;
  perform log_event(p_req, 'reject', p_note);
end $$;

create function send_to_school(p_req uuid) returns void language plpgsql security definer set search_path = public as $$
declare p procurement;
begin
  perform need_role('finance');
  select * into p from procurement where request_id = p_req;
  if found and p.stage < p.stages then raise exception '采购未验收贴码，不能提交学校'; end if;
  update expense_request set status = 'at_school', updated_at = now() where id = p_req and status in ('committed','returned');
  if not found then raise exception '该申请不能提交学校'; end if;
  perform log_event(p_req, 'to_school');
end $$;

-- 学校入账。实际入账金额可以小于申请金额，差额自动回到可用额度。
create function post_voucher(p_req uuid, p_posted_on date, p_amount numeric, p_voucher_no text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r expense_request;
begin
  perform need_role('finance');
  select * into r from expense_request where id = p_req;
  perform lock_card(r.card_id);
  select * into r from expense_request where id = p_req for update;
  if r.status <> 'at_school' then raise exception '该申请不在学校审核中'; end if;
  if p_amount > r.amount and p_amount - r.amount > avail(r.card_id, r.subject_id) then
    raise exception '入账金额超出可用额度';
  end if;
  insert into voucher (request_id, voucher_no, posted_on, amount) values (p_req, p_voucher_no, p_posted_on, p_amount);
  update expense_request set status = 'posted', updated_at = now() where id = p_req;
  perform log_event(p_req, 'post', p_amount::text);
end $$;

-- 学校退回。原因自动写入规则表。
create function school_return(p_req uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r expense_request;
begin
  perform need_role('finance');
  update expense_request set status = 'returned', updated_at = now() where id = p_req and status = 'at_school' returning * into r;
  if not found then raise exception '该申请不在学校审核中'; end if;
  perform log_event(p_req, 'return', p_reason);
  insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict, note, source)
  values (r.card_id, r.expense_type_id, app_today(), '学校退单', 'no', p_reason, 'request:' || p_req);
end $$;

-- 被退回的单据改走另一张卡
create function move_request(p_req uuid, p_card uuid, p_subject uuid) returns void language plpgsql security definer set search_path = public as $$
declare r expense_request; c fund_card; v text; a numeric; old_no text;
begin
  perform need_role('finance');
  select * into r from expense_request where id = p_req for update;
  if r.status <> 'returned' then raise exception '只有被退回的单据可以改卡'; end if;
  select card_no into old_no from fund_card where id = r.card_id;
  c := lock_card(p_card);
  if not exists (select 1 from template_subject where id = p_subject and template_id = c.template_id) then
    raise exception '目标卡没有这个科目';
  end if;
  select verdict into v from v_reimb_rule where card_id = p_card and expense_type_id = r.expense_type_id;
  if v is null or v not in ('yes','conditional') then raise exception '目标卡的规则不允许这类支出'; end if;
  if r.eta_date > c.cutoff_date then raise exception '预计入账晚于目标卡单据截止'; end if;
  a := avail(p_card, p_subject);
  if r.amount > a then raise exception '目标卡可用 %，不足 %', a, r.amount; end if;
  update expense_request set card_id = p_card, subject_id = p_subject, status = 'committed', updated_at = now() where id = p_req;
  perform log_event(p_req, 'move', old_no || ' → ' || c.card_no);
end $$;

create function release_request(p_req uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  update expense_request set status = 'released', updated_at = now() where id = p_req and status in ('committed','returned');
  if not found then raise exception '该申请不能释放'; end if;
  perform log_event(p_req, 'release');
end $$;

-- ---------- 采购 ----------
create function procurement_advance(p_req uuid) returns int language plpgsql security definer set search_path = public as $$
declare s int;
begin
  perform need_role('finance');
  update procurement set stage = stage + 1 where request_id = p_req and stage < stages returning stage into s;
  if not found then raise exception '采购已验收或不存在'; end if;
  insert into procurement_event (request_id, at, kind) values (p_req, app_today(), 'advance');
  return s;
end $$;

-- 废标或流标：退回挂网阶段，预计入账顺延
create function procurement_fail(p_req uuid, p_kind text, p_reason text, p_delay_days int default 30) returns date
language plpgsql security definer set search_path = public as $$
declare d date;
begin
  perform need_role('finance');
  if p_kind not in ('废标','流标') then raise exception '类型只能是废标或流标'; end if;
  update procurement set stage = case when path = '分散采购' then 2 else 0 end where request_id = p_req;
  if not found then raise exception '采购不存在'; end if;
  update expense_request set eta_date = eta_date + p_delay_days, updated_at = now() where id = p_req returning eta_date into d;
  insert into procurement_event (request_id, at, kind, note) values (p_req, app_today(), p_kind, p_reason);
  return d;
end $$;

-- ---------- 预算变更 ----------
-- p_lines: [{"subject_id": "...", "delta": -1000}, {"subject_id": "...", "delta": 1000}]
create function check_change(p_change uuid) returns void language plpgsql as $$
declare ch budget_change; t card_template; x record;
begin
  select * into ch from budget_change where id = p_change;
  select tp.* into t from card_template tp join fund_card c on c.template_id = tp.id where c.id = ch.card_id;
  if t.locked then raise exception '该卡科目锁定，不能变更预算'; end if;
  if (select coalesce(sum(delta), 0) from budget_change_line where change_id = p_change) <> 0 then
    raise exception '调出与调入金额不相等';
  end if;
  for x in select l.subject_id, l.delta, s.name, avail(ch.card_id, l.subject_id) as a
           from budget_change_line l join template_subject s on s.id = l.subject_id
           where l.change_id = p_change and l.delta < 0 loop
    if -x.delta > x.a then raise exception '调出科目可用额度不足：% 可用 %', x.name, x.a; end if;
  end loop;
  for x in
    select k.name, k.max_ratio, t2.total,
           sum(b.cur + coalesce(l.delta, 0)) filter (where ks.subject_id is not null) as used
    from template_cap k
    join v_budget b on b.card_id = ch.card_id
    left join template_cap_subject ks on ks.cap_id = k.id and ks.subject_id = b.subject_id
    left join budget_change_line l on l.change_id = p_change and l.subject_id = b.subject_id
    cross join (select sum(cur) as total from v_budget where card_id = ch.card_id) t2
    where k.template_id = t.id
    group by k.id, t2.total
  loop
    if coalesce(x.used, 0) > x.total * x.max_ratio then raise exception '变更后违反模板规则：%', x.name; end if;
  end loop;
end $$;

create function create_change(p_card uuid, p_reason text, p_lines jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare cid uuid; c fund_card;
begin
  perform need_role('finance','director');
  c := lock_card(p_card);
  insert into budget_change (card_id, reason, requested_by) values (p_card, p_reason, app_uid()) returning id into cid;
  insert into budget_change_line (change_id, subject_id, delta)
  select cid, (e->>'subject_id')::uuid, (e->>'delta')::numeric from jsonb_array_elements(p_lines) e;
  if exists (select 1 from budget_change_line l join template_subject s on s.id = l.subject_id
             where l.change_id = cid and s.template_id <> c.template_id) then
    raise exception '科目不属于该卡的模板';
  end if;
  perform check_change(cid);
  return cid;
end $$;

create function confirm_change(p_change uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  update budget_change set status = 'filed', confirmed_by = app_uid() where id = p_change and status = 'pending';
  if not found then raise exception '该变更不在待确认状态'; end if;
end $$;

create function reject_change(p_change uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  update budget_change set status = 'rejected' where id = p_change and status in ('pending','filed');
  if not found then raise exception '该变更不能驳回'; end if;
end $$;

-- 录入发规办批复。生效前在锁内重验一次。
create function approve_change(p_change uuid, p_on date default null) returns void
language plpgsql security definer set search_path = public as $$
declare ch budget_change;
begin
  perform need_role('finance');
  select * into ch from budget_change where id = p_change;
  perform lock_card(ch.card_id);
  select * into ch from budget_change where id = p_change for update;
  if ch.status <> 'filed' then raise exception '该变更尚未报发规办'; end if;
  perform check_change(p_change);
  update budget_change set status = 'approved', approved_on = coalesce(p_on, app_today()) where id = p_change;
end $$;

-- ---------- 人员费 ----------
-- 把一个人某发放类型在一段月份里的排布改挂到另一张卡。已进发放表的月份不动。
create function reassign_staff(p_person uuid, p_pay_type uuid, p_from date, p_to date, p_card uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c fund_card; pt pay_type; sid uuid; n int; a numeric;
begin
  perform need_role('director');
  c := lock_card(p_card);
  select * into pt from pay_type where id = p_pay_type;
  select id into sid from template_subject where template_id = c.template_id and code = pt.subject_code;
  if sid is null then raise exception '目标卡没有对应科目'; end if;
  if exists (select 1 from staff_assignment
             where person_id = p_person and pay_type_id = p_pay_type and month between p_from and p_to
               and sheet_id is null and card_id <> p_card
               and not (pay_date(month) between c.start_date and c.cutoff_date)) then
    raise exception '部分月份的发放日不在目标卡有效期内';
  end if;
  update staff_assignment set card_id = p_card
  where person_id = p_person and pay_type_id = p_pay_type and month between p_from and p_to
    and sheet_id is null and card_id <> p_card;
  get diagnostics n = row_count;
  a := avail(p_card, sid);
  if a < 0 then raise exception '目标卡该科目超出现行预算 %，请先做预算变更', -a; end if;
  return n;
end $$;

-- 生成某月发放表：按发放类型 × 经费卡分表，只收发放日在卡有效期内的排布。
create function build_payroll(p_month date) returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform need_role('finance');
  insert into payroll_sheet (month, pay_type_id, card_id)
  select distinct a.month, a.pay_type_id, a.card_id
  from staff_assignment a join fund_card c on c.id = a.card_id
  where a.month = p_month and a.sheet_id is null and c.status = 'active'
    and pay_date(a.month) between c.start_date and c.cutoff_date
  on conflict (month, pay_type_id, card_id) do nothing;
  update staff_assignment a set sheet_id = ps.id
  from payroll_sheet ps, fund_card c
  where a.month = p_month and a.sheet_id is null
    and ps.month = a.month and ps.pay_type_id = a.pay_type_id and ps.card_id = a.card_id and ps.status = 'draft'
    and c.id = a.card_id and pay_date(a.month) between c.start_date and c.cutoff_date;
  get diagnostics n = row_count;
  return n;
end $$;

create function post_payroll(p_sheet uuid, p_on date) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance');
  update payroll_sheet set status = 'posted', posted_on = p_on where id = p_sheet and status <> 'posted';
  if not found then raise exception '发放表不存在或已入账'; end if;
end $$;

-- ---------- 结清 ----------
create function settle_card(p_card uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare c fund_card; sid uuid; n int;
begin
  perform need_role('director');
  c := lock_card(p_card);
  if c.settle_date is null then raise exception '跨年卡没有结清日，本年度只做小结'; end if;
  if app_today() < c.settle_date then raise exception '未到结清日 %', c.settle_date; end if;
  select count(*) into n from expense_request where card_id = p_card and status in ('pending','committed','at_school','returned');
  if n > 0 then raise exception '还有 % 笔支出未结', n; end if;
  select count(*) into n from budget_change where card_id = p_card and status in ('pending','filed');
  if n > 0 then raise exception '还有 % 笔预算变更在途', n; end if;
  select count(*) into n from v_flow where card_id = p_card and kind = 'commit';
  if n > 0 then raise exception '还有 % 笔人员费未入账', n; end if;
  insert into card_settlement (card_id, settled_on, confirmed_by) values (p_card, app_today(), app_uid()) returning id into sid;
  insert into settlement_line (settlement_id, subject_id, budget, actual, balance)
  select sid, subject_id, cur, actual, cur - actual from v_cell where card_id = p_card;
  update fund_card set status = 'settled', updated_at = now() where id = p_card;
  return sid;
end $$;
