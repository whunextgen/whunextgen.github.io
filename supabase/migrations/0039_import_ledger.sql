-- 在经费卡上直接导入学校财务系统导出的「项目收支明细账」，用它更新这张卡。
-- 明细账是学校已经记账的事实：收入行即当年下达并到账的金额，支出行即已入账的支出，末行余额即学校余额。
-- 导入时不按科目可用额拦截（已入账的不能不认），重复导入不重复写入。

alter table expense_request
  add column school_code text,     -- 学校科目编号，如 7201020202-3021101
  add column school_name text;     -- 学校科目名称，如 非财政支出-国内差旅费

-- 填了下达数的经费卡：现行预算和可用按下达数（连同上年结转和预算变更）算；assigned 是已分到各科目的合计
create or replace view api.card as
  select v.card_id, v.card_no, v.name, v.status, v.start_date, v.cutoff_date, v.settle_date, v.end_rule,
         v.orig, v.adj,
         case when c.granted is not null then c.granted + c.carried_in + v.adj else v.cur end as cur,
         v.commit, v.actual,
         case when c.granted is not null then c.granted + c.carried_in + v.adj - v.commit - v.actual else v.avail end as avail,
         c.template_id, t.name as template_name, t.locked, c.owner_id, c.rule_note,
         c.school_balance, c.school_frozen, c.school_available, c.school_synced_at, c.fund_kind, c.received, c.priority,
         c.total_amount, c.period_start, c.period_end,
         c.project_id, c.year, c.applied, c.carried_in, c.recalled, c.carried_out, c.granted,
         v.cur as assigned
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

-- 结清时的结余：填了下达数的卡按 下达数 + 上年结转 − 已入账 算，没填的仍按各科目结余之和
create or replace function trg_card_settled() returns trigger language plpgsql security definer set search_path = public as $$
declare s numeric;
begin
  if new.granted is not null then
    select greatest(new.granted + new.carried_in - coalesce(sum(l.actual), 0), 0) into s
    from settlement_line l join card_settlement t on t.id = l.settlement_id where t.card_id = new.id;
  else
    select coalesce(sum(greatest(l.balance, 0)), 0) into s
    from settlement_line l join card_settlement t on t.id = l.settlement_id where t.card_id = new.id;
  end if;
  if new.end_rule = 'carry' then new.carried_out := s; new.recalled := 0;
  else new.recalled := s; new.carried_out := 0; end if;
  return new;
end $$;

-- 结转带入下一年的卡：金额取上一年卡记下的结转数；下一年的卡没填下达数的，再按科目把结余加到明细上
create or replace function carry_into(p_prev uuid, p_next uuid) returns void language plpgsql security definer set search_path = public as $$
declare s numeric;
begin
  select carried_out into s from fund_card where id = p_prev;
  if s is null then
    select coalesce(sum(greatest(l.balance, 0)), 0) into s
    from settlement_line l join card_settlement t on t.id = l.settlement_id where t.card_id = p_prev;
  end if;
  if coalesce(s, 0) <= 0 then return; end if;
  update fund_card set carried_in = s, updated_at = now() where id = p_next;
  if (select granted from fund_card where id = p_next) is null then
    insert into budget_line (card_id, subject_id, amount)
    select p_next, l.subject_id, l.balance from settlement_line l join card_settlement t on t.id = l.settlement_id
    where t.card_id = p_prev and l.balance > 0
    on conflict (card_id, subject_id) do update set amount = budget_line.amount + excluded.amount;
  end if;
end $$;

-- 导入明细账。p_rows 是支出行：[{posted_on, voucher_no, title, amount, school_code, school_name}]；
-- p_income 是收入合计（写入当年下达数和已到账），p_balance 是期末余额（写入学校余额）；二者为空则不改。
-- 支出行按学校科目名称或编号对到这张卡的科目，对不上的记到 p_default_subject。
-- 已导入过的行（凭证编号、金额、摘要、日期都相同）跳过；同一份文件里确有完全相同的两行时，两行都保留。
create function import_ledger(p_card uuid, p_rows jsonb, p_income numeric, p_balance numeric, p_type uuid, p_default_subject uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c fund_card; e jsonb; k text; sid uuid; rid uuid; added int := 0; skipped int := 0; total numeric := 0; lines numeric;
  seen jsonb := '{}'::jsonb; have jsonb; d date; a numeric; ti text; vn text; sc text; sn text;
begin
  if not (has_perm('ledger.post') or has_perm('card.manage')) then raise exception '当前角色无权导入明细账' using errcode = '42501'; end if;
  c := lock_card(p_card);
  if c.status <> 'active' then raise exception '经费卡已结清，不得导入明细账'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception '明细账内容为空'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception '一次最多导入 2000 行，请分段导入'; end if;
  if jsonb_array_length(p_rows) > 0 and not exists (select 1 from expense_type where id = p_type) then raise exception '请选择支出类型'; end if;
  if p_default_subject is not null and not exists (select 1 from template_subject where id = p_default_subject and template_id = c.template_id) then
    raise exception '所选科目不属于该经费卡';
  end if;
  -- 这张卡上已入账的支出，按“凭证编号|金额|日期|摘要”计数
  select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb) into have from (
    select coalesce(v.voucher_no, '') || '|' || v.amount::text || '|' || v.posted_on::text || '|' || r.title as k, count(*) as n
    from expense_request r join voucher v on v.request_id = r.id where r.card_id = p_card and r.status = 'posted' group by 1) x;
  for e in select * from jsonb_array_elements(p_rows) loop
    d := (e->>'posted_on')::date; a := round((e->>'amount')::numeric, 2); ti := left(btrim(coalesce(e->>'title', '')), 300);
    vn := nullif(btrim(coalesce(e->>'voucher_no', '')), ''); sc := nullif(btrim(coalesce(e->>'school_code', '')), ''); sn := nullif(btrim(coalesce(e->>'school_name', '')), '');
    if d is null or a is null or a <= 0 or ti = '' then raise exception '明细账第 % 行缺少日期、金额或摘要', added + skipped + 1; end if;
    k := coalesce(vn, '') || '|' || a::text || '|' || d::text || '|' || ti;
    seen := jsonb_set(seen, array[k], to_jsonb(coalesce((seen->>k)::int, 0) + 1));
    if (seen->>k)::int <= coalesce((have->>k)::int, 0) then skipped := skipped + 1; continue; end if;
    select s.id into sid from template_subject s where s.template_id = c.template_id
      and (s.school_name = sn or s.name = sn or s.code = sc or (sn is not null and sn like '%-' || s.name)) order by (s.school_name = sn) desc nulls last, s.sort limit 1;
    sid := coalesce(sid, p_default_subject);
    if sid is null then raise exception '学校科目「%」未对应到该经费卡的科目，请选择未对应科目的归属', coalesce(sn, sc, ''); end if;
    insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by, school_code, school_name)
    values (p_card, sid, p_type, ti, a, d, 'posted', app_uid(), app_uid(), sc, sn) returning id into rid;
    insert into voucher (request_id, voucher_no, posted_on, amount) values (rid, vn, d, a);
    perform log_event(rid, 'post', '导入明细账：学校已入账 ' || a);
    added := added + 1; total := total + a;
  end loop;
  if p_income is not null and p_income > 0 then
    select coalesce(sum(amount), 0) into lines from budget_line where card_id = p_card;
    if lines > p_income + c.carried_in then
      raise exception '明细账收入合计 % 小于该经费卡已录入各科目的明细合计 %，请先核对各科目明细', p_income, lines - c.carried_in;
    end if;
    update fund_card set granted = p_income, received = p_income, updated_at = now() where id = p_card;
  end if;
  if p_balance is not null and p_balance >= 0 then
    update fund_card set school_balance = p_balance, school_frozen = coalesce(school_frozen, 0),
           school_available = p_balance - coalesce(school_frozen, 0), school_synced_at = now(), updated_at = now() where id = p_card;
  end if;
  return jsonb_build_object('added', added, 'skipped', skipped, 'amount', total);
end $$;

-- 一张卡上已入账支出按学校科目的汇总
create view api.card_school_subject as
  select r.card_id, coalesce(r.school_name, '（未注明学校科目）') as school_name, max(r.school_code) as school_code, count(*)::int as n, sum(v.amount) as amount
  from expense_request r join voucher v on v.request_id = r.id
  where r.status = 'posted' and can_see_card(r.card_id) group by r.card_id, coalesce(r.school_name, '（未注明学校科目）');
grant select on api.card_school_subject to app_api;

select expose('import_ledger(uuid, jsonb, numeric, numeric, uuid, uuid)');
