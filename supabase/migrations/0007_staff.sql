-- 人员费维护：人员、发放类型、按月排布。改挂和发放表的函数在 0003。
create function save_person(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); pid uuid;
begin
  perform need_role('finance','director');
  if n = '' then raise exception '请填写姓名'; end if;
  if length(n) > 40 then raise exception '姓名不能超过 40 个字'; end if;
  if exists (select 1 from person where name = n and id is distinct from p_id) then
    raise exception '已经有叫「%」的人员，同名请加备注区分', n;
  end if;
  if p_id is null then
    insert into person (name) values (n) returning id into pid;
  else
    update person set name = n where id = p_id returning id into pid;
    if pid is null then raise exception '人员不存在'; end if;
  end if;
  return pid;
end $$;

create function save_pay_type(p_id uuid, p_name text, p_subject_code text, p_monthly_cap numeric default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); tid uuid;
begin
  perform need_role('finance','director');
  if n = '' then raise exception '请填写发放类型名称'; end if;
  if length(n) > 40 then raise exception '名称不能超过 40 个字'; end if;
  if not exists (select 1 from template_subject where code = p_subject_code) then raise exception '请选择对应的科目'; end if;
  if p_monthly_cap is not null and p_monthly_cap <= 0 then raise exception '每月上限必须大于 0，没有上限就不填'; end if;
  if exists (select 1 from pay_type where name = n and id is distinct from p_id) then
    raise exception '已经有叫「%」的发放类型', n;
  end if;
  if p_id is null then
    insert into pay_type (name, subject_code, monthly_cap) values (n, p_subject_code, p_monthly_cap) returning id into tid;
  else
    if exists (select 1 from pay_type where id = p_id and subject_code <> p_subject_code)
       and exists (select 1 from staff_assignment where pay_type_id = p_id) then
      raise exception '这个发放类型已有排布，不能再改科目';
    end if;
    update pay_type set name = n, subject_code = p_subject_code, monthly_cap = p_monthly_cap where id = p_id returning id into tid;
    if tid is null then raise exception '发放类型不存在'; end if;
  end if;
  return tid;
end $$;

-- 排布：把某人某发放类型在一段月份里挂到一张卡上，每月同一金额。金额不填或为 0 表示撤掉这段排布。
-- 已进发放表的月份不能动。发放日不在卡有效期内的月份允许排，但会被标为空档，且不占该卡承诺。
create function set_staff(p_person uuid, p_pay_type uuid, p_from date, p_to date, p_card uuid, p_amount numeric) returns int
language plpgsql security definer set search_path = public as $$
declare c fund_card; pt pay_type; sid uuid; n int; a numeric;
  f date := date_trunc('month', p_from)::date; t date := date_trunc('month', coalesce(p_to, p_from))::date;
begin
  perform need_role('finance','director');
  if not exists (select 1 from person where id = p_person) then raise exception '人员不存在'; end if;
  select * into pt from pay_type where id = p_pay_type;
  if not found then raise exception '发放类型不存在'; end if;
  if f is null then raise exception '请填写起始月份'; end if;
  if t < f then raise exception '结束月份不能早于起始月份'; end if;
  if t > f + interval '35 months' then raise exception '一次最多排 36 个月'; end if;
  if exists (select 1 from staff_assignment where person_id = p_person and pay_type_id = p_pay_type
             and month between f and t and sheet_id is not null) then
    raise exception '其中有月份已进发放表，不能再改';
  end if;
  if coalesce(p_amount, 0) = 0 then
    delete from staff_assignment where person_id = p_person and pay_type_id = p_pay_type and month between f and t;
    get diagnostics n = row_count;
    return n;
  end if;
  if p_amount < 0 then raise exception '金额必须大于 0'; end if;
  if pt.monthly_cap is not null and p_amount > pt.monthly_cap then raise exception '超过「%」每月上限 %', pt.name, pt.monthly_cap; end if;
  c := lock_card(p_card);
  select id into sid from template_subject where template_id = c.template_id and code = pt.subject_code;
  if sid is null then raise exception '这张卡没有对应科目'; end if;
  insert into staff_assignment (person_id, pay_type_id, month, card_id, amount)
  select p_person, p_pay_type, m::date, p_card, p_amount from generate_series(f, t, interval '1 month') m
  on conflict (person_id, pay_type_id, month) do update set card_id = excluded.card_id, amount = excluded.amount;
  get diagnostics n = row_count;
  a := avail(p_card, sid);
  if a < 0 then raise exception '这张卡该科目超出现行预算 %，请先做预算变更', -a; end if;
  return n;
end $$;

create trigger audit after insert or update or delete on person for each row execute function trg_audit();
create trigger audit after insert or update or delete on pay_type for each row execute function trg_audit();

do $$ declare f text; r text; begin
  foreach f in array array['save_person(uuid, text)', 'save_pay_type(uuid, text, text, numeric)', 'set_staff(uuid, uuid, date, date, uuid, numeric)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    execute format('grant execute on function %s to app_api', f);
  end loop;
end $$;
