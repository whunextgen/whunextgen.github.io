-- 只控总额的经费卡。学校对有些经费卡只管总额，不按科目控制（明细账里「额度控制分类」为空）；
-- 这类卡的支出只与卡的总额核对，不再与某个科目的余额核对。按科目控制的卡不变。
-- 导入明细账时不再要求把学校科目归到本卡的科目上：对得上的自动对应，对不上的记在「学校明细账」这一项下，学校科目照样保留在每笔支出上。

alter table fund_card add column pooled boolean not null default false;   -- 只控总额，不按科目控制

-- 某张卡某个科目还能花多少。只控总额的卡：整张卡的总额减去已承诺和已入账，与科目无关
create or replace function avail(p_card uuid, p_subject uuid) returns numeric language sql stable as $$
  select case when c.pooled then
      (select case when c.granted is not null then c.granted + c.carried_in + coalesce(sum(x.adj), 0) else coalesce(sum(x.cur), 0) end
              - coalesce(sum(x.commit), 0) - coalesce(sum(x.actual), 0) from v_cell x where x.card_id = c.id)
    else (select avail from v_cell where card_id = p_card and subject_id = p_subject) end
  from fund_card c where c.id = p_card
$$;

create function set_card_pooled(p_card uuid, p_pooled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('card.manage');
  update fund_card set pooled = coalesce(p_pooled, false), updated_at = now() where id = p_card and status = 'active';
  if not found then raise exception '经费卡不存在或已结清'; end if;
end $$;

-- 导入明细账（替换原来的版本）：不再需要指定归入的科目和支出类型
drop function import_ledger(uuid, jsonb, numeric, numeric, uuid, uuid);
create function import_ledger(p_card uuid, p_rows jsonb, p_income numeric, p_balance numeric, p_type uuid default null, p_pooled boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c fund_card; e jsonb; k text; sid uuid; other uuid; tid uuid := p_type; rid uuid; added int := 0; skipped int := 0; total numeric := 0; lines numeric;
  seen jsonb := '{}'::jsonb; have jsonb; d date; a numeric; ti text; vn text; sc text; sn text;
begin
  if not (has_perm('ledger.post') or has_perm('card.manage')) then raise exception '当前角色无权导入明细账' using errcode = '42501'; end if;
  c := lock_card(p_card);
  if c.status <> 'active' then raise exception '经费卡已结清，不得导入明细账'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception '明细账内容为空'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception '一次最多导入 2000 行，请分段导入'; end if;
  if tid is not null and not exists (select 1 from expense_type where id = tid) then raise exception '支出类型不存在'; end if;
  if tid is null and jsonb_array_length(p_rows) > 0 then
    select id into tid from expense_type where name = '学校明细账';
    if tid is null then insert into expense_type (name) values ('学校明细账') returning id into tid; end if;
  end if;
  if p_pooled is not null then update fund_card set pooled = p_pooled, updated_at = now() where id = p_card; end if;
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
    sid := null;
    select s.id into sid from template_subject s where s.template_id = c.template_id and s.code <> 'school'
      and (s.school_name = sn or s.name = sn or s.code = sc or (sn is not null and sn like '%-' || s.name)) order by (s.school_name = sn) desc nulls last, s.sort limit 1;
    if sid is null then
      -- 对不上本卡科目的，记在「学校明细账」这一项下；学校科目的编号和名称保存在这笔支出上
      if other is null then
        select id into other from template_subject where template_id = c.template_id and code = 'school';
        if other is null then insert into template_subject (template_id, code, name, sort) values (c.template_id, 'school', '学校明细账', 9990) returning id into other; end if;
      end if;
      sid := other;
    end if;
    insert into budget_line (card_id, subject_id, amount) values (p_card, sid, 0) on conflict (card_id, subject_id) do nothing;
    insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by, school_code, school_name)
    values (p_card, sid, tid, ti, a, d, 'posted', app_uid(), app_uid(), sc, sn) returning id into rid;
    insert into voucher (request_id, voucher_no, posted_on, amount) values (rid, vn, d, a);
    perform log_event(rid, 'post', '导入明细账：学校已入账 ' || a);
    added := added + 1; total := total + a;
  end loop;
  if p_income is not null and p_income > 0 then
    select coalesce(sum(amount), 0) into lines from budget_line where card_id = p_card;
    if lines > p_income + c.carried_in and not coalesce(p_pooled, c.pooled) then
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
         v.cur as assigned, c.pooled
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

select expose('import_ledger(uuid, jsonb, numeric, numeric, uuid, boolean)', 'set_card_pooled(uuid, boolean)');
