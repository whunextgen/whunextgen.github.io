-- 经费卡的科目改用学校明细账的科目。
-- 导入明细账时，每笔支出记在学校的科目上（科目编号、科目名称照学校的），学校有而中台没有的科目自动新增；
-- 不再把对不上的支出统一放进「学校明细账」一项。已经导入的支出一并改挂到学校科目上。

create function ledger_subject(p_template uuid, p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid; nm text := nullif(btrim(coalesce(p_name, '')), ''); cd text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if nm is null and cd is null then
    select id into sid from template_subject where template_id = p_template and code = 'school';
    if sid is null then insert into template_subject (template_id, code, name, sort) values (p_template, 'school', '学校明细账（未注明科目）', 9990) returning id into sid; end if;
    return sid;
  end if;
  select id into sid from template_subject where template_id = p_template and code <> 'school'
    and (code = cd or school_name = nm or name = nm) order by (code = cd) desc nulls last, sort limit 1;
  if sid is not null then return sid; end if;
  insert into template_subject (template_id, code, name, school_name, sort)
  values (p_template, coalesce(cd, 'school-' || md5(nm)), coalesce(nm, cd), coalesce(nm, cd), 5000) returning id into sid;
  return sid;
end $$;
revoke all on function ledger_subject(uuid, text, text) from public;

create or replace function import_ledger(p_card uuid, p_rows jsonb, p_incomes jsonb, p_opening numeric, p_balance numeric, p_pooled boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c fund_card; e jsonb; k text; sid uuid; tid uuid; rid uuid; added int := 0; skipped int := 0; total numeric := 0; inc int := 0; lines numeric; isum numeric;
  seen jsonb := '{}'::jsonb; have jsonb; d date; a numeric; ti text; vn text; sc text; sn text;
begin
  if not (has_perm('ledger.post') or has_perm('card.manage')) then raise exception '当前角色无权导入明细账' using errcode = '42501'; end if;
  c := lock_card(p_card);
  if c.status <> 'active' then raise exception '经费卡已结清，不得导入明细账'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception '明细账内容为空'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception '一次最多导入 2000 行，请分段导入'; end if;
  if p_incomes is not null and jsonb_typeof(p_incomes) <> 'array' then raise exception '收入明细格式不对'; end if;
  if jsonb_array_length(p_rows) > 0 then
    select id into tid from expense_type where name = '学校明细账';
    if tid is null then insert into expense_type (name) values ('学校明细账') returning id into tid; end if;
  end if;
  if p_pooled is not null then update fund_card set pooled = p_pooled, updated_at = now() where id = p_card; end if;
  -- 支出：已导入过的行（凭证编号、金额、日期、摘要都相同）跳过
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
    -- 科目用学校明细账里的科目：按编号或名称找，没有就按学校的编号和名称新增
    sid := ledger_subject(c.template_id, sc, sn);
    insert into budget_line (card_id, subject_id, amount) values (p_card, sid, 0) on conflict (card_id, subject_id) do nothing;
    insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by, school_code, school_name)
    values (p_card, sid, tid, ti, a, d, 'posted', app_uid(), app_uid(), sc, coalesce(sn, '（未注明学校科目）')) returning id into rid;
    insert into voucher (request_id, voucher_no, posted_on, amount) values (rid, vn, d, a);
    perform log_event(rid, 'post', '导入明细账：学校已入账 ' || a);
    added := added + 1; total := total + a;
  end loop;
  -- 收入：同样按凭证编号、金额、日期、摘要去重，逐笔保存
  if p_incomes is not null then
    seen := '{}'::jsonb;
    select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb) into have from (
      select coalesce(voucher_no, '') || '|' || amount::text || '|' || posted_on::text || '|' || title as k, count(*) as n from card_income where card_id = p_card group by 1) x;
    for e in select * from jsonb_array_elements(p_incomes) loop
      d := (e->>'posted_on')::date; a := round((e->>'amount')::numeric, 2); ti := left(btrim(coalesce(e->>'title', '')), 300); vn := nullif(btrim(coalesce(e->>'voucher_no', '')), '');
      if d is null or a is null or a <= 0 or ti = '' then raise exception '收入明细缺少日期、金额或摘要'; end if;
      k := coalesce(vn, '') || '|' || a::text || '|' || d::text || '|' || ti;
      seen := jsonb_set(seen, array[k], to_jsonb(coalesce((seen->>k)::int, 0) + 1));
      if (seen->>k)::int <= coalesce((have->>k)::int, 0) then continue; end if;
      insert into card_income (card_id, posted_on, voucher_no, title, amount, school_code, school_name, created_by)
      values (p_card, d, vn, ti, a, nullif(btrim(coalesce(e->>'school_code', '')), ''), nullif(btrim(coalesce(e->>'school_name', '')), ''), app_uid());
      inc := inc + 1;
    end loop;
    select coalesce(sum(amount), 0) into isum from card_income where card_id = p_card;
    if p_opening is not null and p_opening >= 0 then update fund_card set carried_in = p_opening, updated_at = now() where id = p_card; end if;
    select * into c from fund_card where id = p_card;
    select coalesce(sum(amount), 0) into lines from budget_line where card_id = p_card;
    if isum > 0 or c.granted is not null then
      if lines > isum + c.carried_in and not c.pooled then
        raise exception '明细账收入合计 % 连同年初余额 % 小于该经费卡已录入各科目的明细合计 %，请先核对各科目明细', isum, c.carried_in, lines;
      end if;
      update fund_card set granted = isum, received = isum, updated_at = now() where id = p_card;
    end if;
  end if;
  if p_balance is not null and p_balance >= 0 then
    update fund_card set school_balance = p_balance, school_frozen = coalesce(school_frozen, 0),
           school_available = p_balance - coalesce(school_frozen, 0), school_synced_at = now(), updated_at = now() where id = p_card;
  end if;
  return jsonb_build_object('added', added, 'skipped', skipped, 'amount', total, 'incomes', inc);
end $$;

-- 已经导入的支出：从「学校明细账」一项改挂到各自的学校科目上
do $$ declare r record; sid uuid; begin
  for r in select e.id, e.card_id, c.template_id, e.school_code, e.school_name
           from expense_request e join fund_card c on c.id = e.card_id join template_subject s on s.id = e.subject_id
           where s.code = 'school' and e.school_name is not null and e.school_name <> '（未注明学校科目）' loop
    sid := ledger_subject(r.template_id, r.school_code, r.school_name);
    insert into budget_line (card_id, subject_id, amount) values (r.card_id, sid, 0) on conflict (card_id, subject_id) do nothing;
    update expense_request set subject_id = sid where id = r.id;
  end loop;
end $$;

-- 更正各科目预算时，只拦“把某个科目的预算调低到已入账以下”。
-- 学校科目上本来就先有支出、后补预算；原来的校验会因为别的科目还没补预算而拦住整次更正。
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.set_budget(uuid, jsonb)'::regprocedure);
  d2 := replace(d, 'declare c fund_card; x record; n int;', 'declare c fund_card; x record; n int; old jsonb;');
  if d2 = d then raise exception 'set_budget：未找到变量声明'; end if;
  d := d2;
  d2 := replace(d, 'insert into budget_line (card_id, subject_id, amount)',
    'select coalesce(jsonb_object_agg(subject_id::text, amount), ''{}''::jsonb) into old from budget_line where card_id = p_card;
  insert into budget_line (card_id, subject_id, amount)');
  if d2 = d then raise exception 'set_budget：未找到写入预算的语句'; end if;
  d := d2;
  d2 := replace(d, 'and not c.pooled and v.subject_code <> ''school''', 'and not c.pooled and v.subject_code <> ''school'' and v.orig < coalesce((old->>v.subject_id::text)::numeric, 0)');
  if d2 = d then raise exception 'set_budget：未找到预算不低于已入账的校验'; end if;
  execute d2;
end $do$;
