-- 经费卡主数据维护：科目模板、科目、比例上限、经费卡、考核节点、年初预算、紧急通道限额。
-- 之前这些只能直接改库；现在都走函数，财务岗和中心负责人在界面上维护，改动进审计日志。

-- 新函数统一用这个收口：收回默认权限，只授给接口角色
create function expose(variadic fns text[]) returns void language plpgsql as $$
declare f text; r text;
begin
  foreach f in array fns loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
    execute format('grant execute on function %s to app_api', f);
  end loop;
end $$;

-- 新表统一用这个收口：开行级权限、不建策略、收回默认权限
create function seal(variadic tbls text[]) returns void language plpgsql as $$
declare t text; r text;
begin
  foreach t in array tbls loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on table %I from %I', t, r); end if;
    end loop;
  end loop;
end $$;

do $$ declare f text; r text; begin
  foreach f in array array['expose(text[])', 'seal(text[])'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;

-- ---------- 科目模板 ----------
create function save_template(p_id uuid, p_code text, p_name text, p_locked boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare c text := btrim(coalesce(p_code, '')); n text := btrim(coalesce(p_name, '')); tid uuid;
begin
  perform need_role('finance','director');
  if c = '' then raise exception '请填写模板代码'; end if;
  if length(c) > 20 then raise exception '模板代码不能超过 20 个字符'; end if;
  if n = '' then raise exception '请填写模板名称'; end if;
  if length(n) > 40 then raise exception '模板名称不能超过 40 个字'; end if;
  if exists (select 1 from card_template where code = c and id is distinct from p_id) then
    raise exception '已经有代码为「%」的模板', c;
  end if;
  if p_id is null then
    insert into card_template (code, name, locked) values (c, n, coalesce(p_locked, false)) returning id into tid;
  else
    update card_template set code = c, name = n, locked = coalesce(p_locked, false) where id = p_id returning id into tid;
    if tid is null then raise exception '模板不存在'; end if;
  end if;
  return tid;
end $$;

-- 科目代码建好后不改：预算、支出和发放类型都按它对应
create function save_subject(p_id uuid, p_template uuid, p_code text, p_name text, p_school_name text default null, p_sort int default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c text := btrim(coalesce(p_code, '')); n text := btrim(coalesce(p_name, ''));
  sn text := nullif(btrim(coalesce(p_school_name, '')), ''); t card_template; sid uuid;
begin
  perform need_role('finance','director');
  if n = '' then raise exception '请填写科目名称'; end if;
  if length(n) > 40 then raise exception '科目名称不能超过 40 个字'; end if;
  if length(sn) > 60 then raise exception '学校侧科目名不能超过 60 个字'; end if;
  if p_id is null then
    select * into t from card_template where id = p_template;
    if not found then raise exception '模板不存在'; end if;
    if t.locked then raise exception '「%」科目锁定，先在模板上取消锁定再加科目', t.name; end if;
    if c = '' then raise exception '请填写科目代码'; end if;
    if c !~ '^[A-Za-z0-9_]{1,30}$' then raise exception '科目代码只用字母、数字和下划线，不超过 30 个字符'; end if;
    if exists (select 1 from template_subject where template_id = p_template and code = c) then
      raise exception '这个模板里已经有代码为「%」的科目', c;
    end if;
    insert into template_subject (template_id, code, name, school_name, sort)
    values (p_template, c, n, sn, coalesce(p_sort, (select coalesce(max(sort), -1) + 1 from template_subject where template_id = p_template)))
    returning id into sid;
  else
    update template_subject set name = n, school_name = sn, sort = coalesce(p_sort, sort) where id = p_id returning id into sid;
    if sid is null then raise exception '科目不存在'; end if;
  end if;
  return sid;
end $$;

create function delete_subject(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare s template_subject;
begin
  perform need_role('finance','director');
  select * into s from template_subject where id = p_id;
  if not found then raise exception '科目不存在'; end if;
  if exists (select 1 from card_template where id = s.template_id and locked) then raise exception '模板科目锁定，不能删科目'; end if;
  if exists (select 1 from budget_line where subject_id = p_id)
     or exists (select 1 from budget_change_line where subject_id = p_id)
     or exists (select 1 from expense_request where subject_id = p_id)
     or exists (select 1 from settlement_line where subject_id = p_id)
     or exists (select 1 from staff_assignment a join fund_card c on c.id = a.card_id join pay_type pt on pt.id = a.pay_type_id
                where c.template_id = s.template_id and pt.subject_code = s.code) then
    raise exception '「%」已经有预算、支出或人员费，不能删', s.name;
  end if;
  delete from template_subject where id = p_id;
end $$;

-- ---------- 比例上限 ----------
-- p_subjects: ["科目 id", ...]，这些科目的现行预算合计不超过经费总额的 p_max_ratio
create function save_cap(p_id uuid, p_template uuid, p_name text, p_max_ratio numeric, p_subjects jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); kid uuid; tid uuid := p_template;
begin
  perform need_role('finance','director');
  if n = '' then raise exception '请填写规则名称'; end if;
  if length(n) > 80 then raise exception '规则名称不能超过 80 个字'; end if;
  if p_max_ratio is null or p_max_ratio <= 0 or p_max_ratio > 1 then raise exception '上限比例要在 0 到 100%% 之间'; end if;
  if p_subjects is null or jsonb_typeof(p_subjects) <> 'array' or jsonb_array_length(p_subjects) = 0 then
    raise exception '至少选一个科目';
  end if;
  if p_id is not null then
    select template_id into tid from template_cap where id = p_id;
    if tid is null then raise exception '规则不存在'; end if;
  elsif not exists (select 1 from card_template where id = tid) then
    raise exception '模板不存在';
  end if;
  if exists (select 1 from jsonb_array_elements_text(p_subjects) e
             where not exists (select 1 from template_subject s where s.id = e::uuid and s.template_id = tid)) then
    raise exception '所选科目不属于这个模板';
  end if;
  if p_id is null then
    insert into template_cap (template_id, name, max_ratio) values (tid, n, p_max_ratio) returning id into kid;
  else
    update template_cap set name = n, max_ratio = p_max_ratio where id = p_id returning id into kid;
    delete from template_cap_subject where cap_id = kid;
  end if;
  insert into template_cap_subject (cap_id, subject_id) select distinct kid, e::uuid from jsonb_array_elements_text(p_subjects) e;
  return kid;
end $$;

create function delete_cap(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  delete from template_cap where id = p_id;
  if not found then raise exception '规则不存在'; end if;
end $$;

-- ---------- 经费卡 ----------
create function save_card(p_id uuid, p_card_no text, p_name text, p_template uuid, p_owner uuid, p_start date, p_cutoff date,
                          p_settle date, p_end_rule text, p_rule_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare no text := btrim(coalesce(p_card_no, '')); n text := btrim(coalesce(p_name, ''));
  note text := nullif(btrim(coalesce(p_rule_note, '')), ''); c fund_card; cid uuid; k int;
begin
  perform need_role('finance','director');
  if no = '' then raise exception '请填写经费卡号'; end if;
  if length(no) > 40 then raise exception '经费卡号不能超过 40 个字符'; end if;
  if n = '' then raise exception '请填写经费卡名称'; end if;
  if length(n) > 60 then raise exception '经费卡名称不能超过 60 个字'; end if;
  if length(note) > 500 then raise exception '备注不能超过 500 个字'; end if;
  if not exists (select 1 from card_template where id = p_template) then raise exception '请选择科目模板'; end if;
  if p_owner is not null and not exists (select 1 from app_user where id = p_owner and active) then raise exception '负责人不存在或已停用'; end if;
  if p_start is null or p_cutoff is null then raise exception '请填写下达日和单据截止日'; end if;
  if p_cutoff < p_start then raise exception '单据截止日不能早于下达日'; end if;
  if p_settle is not null and p_settle < p_cutoff then raise exception '结清日不能早于单据截止日'; end if;
  if p_end_rule is null or p_end_rule not in ('recall','carry','return') then raise exception '到期处理只能是到期回收、结转或结余上缴'; end if;
  if exists (select 1 from fund_card where card_no = no and id is distinct from p_id) then raise exception '已经有卡号为「%」的经费卡', no; end if;
  if p_id is null then
    insert into fund_card (card_no, name, template_id, owner_id, start_date, cutoff_date, settle_date, end_rule, rule_note)
    values (no, n, p_template, p_owner, p_start, p_cutoff, p_settle, p_end_rule, note) returning id into cid;
    -- 先按模板铺一遍金额为 0 的科目，卡才会出现在总览里，等着录年初预算
    insert into budget_line (card_id, subject_id, amount) select cid, s.id, 0 from template_subject s where s.template_id = p_template;
    return cid;
  end if;
  c := lock_card(p_id);
  if c.template_id <> p_template and (
       exists (select 1 from budget_line where card_id = p_id and amount > 0) or exists (select 1 from budget_change where card_id = p_id)
    or exists (select 1 from expense_request where card_id = p_id) or exists (select 1 from staff_assignment where card_id = p_id)) then
    raise exception '这张卡已有预算、支出或人员费，不能换科目模板';
  end if;
  select count(*) into k from expense_request
    where card_id = p_id and status in ('pending','committed','at_school','returned') and eta_date > p_cutoff;
  if k > 0 then raise exception '有 % 笔在途支出的预计入账晚于新的单据截止日，先处理这些支出', k; end if;
  if c.template_id <> p_template then
    delete from budget_line where card_id = p_id;
    insert into budget_line (card_id, subject_id, amount) select p_id, s.id, 0 from template_subject s where s.template_id = p_template;
  end if;
  update fund_card set card_no = no, name = n, template_id = p_template, owner_id = p_owner, start_date = p_start, cutoff_date = p_cutoff,
         settle_date = p_settle, end_rule = p_end_rule, rule_note = note, updated_at = now() where id = p_id;
  return p_id;
end $$;

-- ---------- 考核节点 ----------
-- 同一张卡同一天只有一个节点：已有就改比例和后果
create function set_node(p_card uuid, p_date date, p_ratio numeric, p_consequence text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c fund_card; q text := btrim(coalesce(p_consequence, '')); nid uuid;
begin
  perform need_role('finance','director');
  c := lock_card(p_card);
  if p_date is null then raise exception '请填写节点日'; end if;
  if p_date < c.start_date then raise exception '节点日不能早于下达日 %', c.start_date; end if;
  if p_ratio is null or p_ratio <= 0 or p_ratio > 1 then raise exception '要求比例要在 0 到 100%% 之间'; end if;
  if q = '' then raise exception '请填写达不到的后果，例如通报、回收、清零、结题'; end if;
  if length(q) > 40 then raise exception '后果不能超过 40 个字'; end if;
  insert into card_node (card_id, node_date, ratio, consequence) values (p_card, p_date, p_ratio, q)
  on conflict (card_id, node_date) do update set ratio = excluded.ratio, consequence = excluded.consequence
  returning id into nid;
  return nid;
end $$;

create function delete_node(p_node uuid) returns void language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  perform need_role('finance','director');
  select card_id into cid from card_node where id = p_node;
  if cid is null then raise exception '节点不存在'; end if;
  perform lock_card(cid);
  delete from card_node where id = p_node;
end $$;

-- ---------- 年初预算 ----------
-- p_lines: [{"subject_id": "...", "amount": 1000}]。只改列出的科目。
-- 第一次录入财务岗和中心负责人都可以；录入后再更正只有中心负责人可以，日常调整走预算变更。
create function set_budget(p_card uuid, p_lines jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare c fund_card; x record; n int;
begin
  perform need_role('finance','director');
  c := lock_card(p_card);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception '请至少填写一个科目的预算';
  end if;
  if app_role() <> 'director' and exists (select 1 from budget_line where card_id = p_card and amount > 0) then
    raise exception '年初预算已录入，更正需要中心负责人操作；日常调整请走预算变更';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
             where not exists (select 1 from template_subject s where s.id = (e->>'subject_id')::uuid and s.template_id = c.template_id)) then
    raise exception '科目不属于该卡的模板';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e where (e->>'amount') is null or (e->>'amount')::numeric < 0) then
    raise exception '预算金额不能为负';
  end if;
  if (select count(*) <> count(distinct e->>'subject_id') from jsonb_array_elements(p_lines) e) then
    raise exception '同一个科目填了两次';
  end if;
  insert into budget_line (card_id, subject_id, amount)
  select p_card, (e->>'subject_id')::uuid, round((e->>'amount')::numeric, 2) from jsonb_array_elements(p_lines) e
  on conflict (card_id, subject_id) do update set amount = excluded.amount;
  get diagnostics n = row_count;
  for x in select v.subject_name, v.avail from v_cell v
           where v.card_id = p_card and v.avail < 0
             and v.subject_id in (select (e->>'subject_id')::uuid from jsonb_array_elements(p_lines) e) loop
    raise exception '「%」的预算低于已承诺和已入账的合计，还差 %', x.subject_name, -x.avail;
  end loop;
  for x in select k.name from v_cap k where k.card_id = p_card and k.used > k.max_amount loop
    raise exception '违反模板规则：%', x.name;
  end loop;
  return n;
end $$;

-- ---------- 紧急通道限额 ----------
create function set_emergency_limit(p_year int, p_per_request numeric, p_per_year numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  if p_year is null or p_year < 2020 or p_year > 2100 then raise exception '请填写年度'; end if;
  if p_per_request is null or p_per_request <= 0 then raise exception '单笔上限必须大于 0'; end if;
  if p_per_year is null or p_per_year < p_per_request then raise exception '全年额度不能小于单笔上限'; end if;
  insert into emergency_limit (year, per_request, per_year) values (p_year, p_per_request, p_per_year)
  on conflict (year) do update set per_request = excluded.per_request, per_year = excluded.per_year;
end $$;

-- ---------- 审计与只读视图 ----------
do $$ declare t text; begin
  foreach t in array array['card_template','template_subject','template_cap','card_node'] loop
    execute format('create trigger audit after insert or update or delete on %I for each row execute function trg_audit()', t);
  end loop;
end $$;

create view api.template as
  select t.id, t.code, t.name, t.locked,
         (select count(*) from fund_card c where c.template_id = t.id)::int as cards
  from card_template t where is_staff();

create view api.template_cap as
  select k.id, k.template_id, k.name, k.max_ratio,
         coalesce((select jsonb_agg(ks.subject_id) from template_cap_subject ks where ks.cap_id = k.id), '[]'::jsonb) as subject_ids
  from template_cap k where is_staff();

grant select on api.template, api.template_cap to app_api;

select expose(
  'save_template(uuid, text, text, boolean)', 'save_subject(uuid, uuid, text, text, text, int)', 'delete_subject(uuid)',
  'save_cap(uuid, uuid, text, numeric, jsonb)', 'delete_cap(uuid)',
  'save_card(uuid, text, text, uuid, uuid, date, date, date, text, text)',
  'set_node(uuid, date, numeric, text)', 'delete_node(uuid)', 'set_budget(uuid, jsonb)',
  'set_emergency_limit(int, numeric, numeric)');
