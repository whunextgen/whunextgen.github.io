-- 学校余额按明细来核对。
-- 导入明细账时把收入行也逐笔保存，年初余额记为上年结转；经费卡上的数由明细得出：
--   上年结转 + 收入合计 − 明细账里的支出合计 = 按明细算的余额，与学校余额核对。
-- 中台里有、明细账里没有的已入账支出（旧门户迁来的汇总记录等）单独列出，可以作废，免得重复计算。

create table card_income (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references fund_card,
  posted_on   date not null,
  voucher_no  text,
  title       text not null,
  amount      numeric(14,2) not null check (amount > 0),
  school_code text,
  school_name text,
  created_by  uuid references app_user,
  created_at  timestamptz not null default now()
);
create index on card_income (card_id);
select seal('card_income');
create trigger audit after insert or update or delete on card_income for each row execute function trg_audit();

-- 有收入明细的经费卡不能删除
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.delete_card(uuid)'::regprocedure);
  d2 := replace(d, 'or exists (select 1 from task where card_id = p_card) then', 'or exists (select 1 from task where card_id = p_card) or exists (select 1 from card_income where card_id = p_card) then');
  if d2 = d then raise exception 'delete_card：未找到记录判断'; end if;
  execute d2;
end $do$;

-- 导入明细账（替换原来的版本）：支出行、收入行、年初余额、期末余额
drop function import_ledger(uuid, jsonb, numeric, numeric, uuid, boolean);
create function import_ledger(p_card uuid, p_rows jsonb, p_incomes jsonb, p_opening numeric, p_balance numeric, p_pooled boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c fund_card; e jsonb; k text; sid uuid; other uuid; tid uuid; rid uuid; added int := 0; skipped int := 0; total numeric := 0; inc int := 0; lines numeric; isum numeric;
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
    sid := null;
    select s.id into sid from template_subject s where s.template_id = c.template_id and s.code <> 'school'
      and (s.school_name = sn or s.name = sn or s.code = sc or (sn is not null and sn like '%-' || s.name)) order by (s.school_name = sn) desc nulls last, s.sort limit 1;
    if sid is null then
      if other is null then
        select id into other from template_subject where template_id = c.template_id and code = 'school';
        if other is null then insert into template_subject (template_id, code, name, sort) values (c.template_id, 'school', '学校明细账', 9990) returning id into other; end if;
      end if;
      sid := other;
    end if;
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

-- 把这张卡上“中台有、明细账没有”的已入账支出作废（不再计入已入账），留痕
create function void_stray_posted(p_card uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not (has_perm('ledger.post') or has_perm('card.manage')) then raise exception '当前角色无权作废' using errcode = '42501'; end if;
  perform lock_card(p_card);
  if not exists (select 1 from expense_request where card_id = p_card and status = 'posted' and school_name is not null) then
    raise exception '该经费卡尚未导入明细账，无从核对';
  end if;
  for r in select id, amount from expense_request where card_id = p_card and status = 'posted' and school_name is null loop
    update expense_request set status = 'released', updated_at = now() where id = r.id;
    perform log_event(r.id, 'release', '按学校明细账核对：明细账中无此笔，作废，不再计入已入账 ' || r.amount);
    n := n + 1;
  end loop;
  return n;
end $$;

create view api.card_income as
  select i.id, i.card_id, i.posted_on, i.voucher_no, i.title, i.amount, i.school_code, i.school_name from card_income i where can_see_card(i.card_id);
grant select on api.card_income to app_api;

-- 经费卡视图加上按明细核对用的数：收入合计、明细账里的支出合计、明细账之外的已入账支出
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
         v.cur as assigned, c.pooled,
         (select coalesce(sum(i.amount), 0) from card_income i where i.card_id = c.id) as income,
         (select coalesce(sum(vv.amount), 0) from expense_request r join voucher vv on vv.request_id = r.id where r.card_id = c.id and r.status = 'posted' and r.school_name is not null) as ledger_actual,
         (select count(*)::int from expense_request r where r.card_id = c.id and r.status = 'posted' and r.school_name is null) as stray_n,
         (select coalesce(sum(vv.amount), 0) from expense_request r join voucher vv on vv.request_id = r.id where r.card_id = c.id and r.status = 'posted' and r.school_name is null) as stray_amount
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

select expose('import_ledger(uuid, jsonb, jsonb, numeric, numeric, boolean)', 'void_stray_posted(uuid)');
