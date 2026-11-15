-- 经费卡的明细按任务书的预算科目编，科目由财务岗在卡上自己增、改、删。
--   任务书预算表里的科目（设备费、材料费、差旅费……）和学校明细账里的科目（国内差旅费、工作盒饭……）名称不一样，
--   明细是按前者编的预算，执行是后者的入账记录。每个预算科目指定对应哪些学校科目，
--   对应之后，这些学校科目下的入账支出记在预算科目下，执行仍以学校明细账为准。
--   预算科目是某一张卡自己的（card_id 不为空），不出现在其他卡上；学校科目仍按模板共用。

alter table template_subject add column card_id uuid references fund_card on delete cascade;
create index on template_subject (card_id) where card_id is not null;

-- 某张卡自己的预算科目只能用在这张卡上
create function trg_subject_card() returns trigger language plpgsql as $$
declare cid uuid;
begin
  select card_id into cid from template_subject where id = new.subject_id;
  if cid is not null and cid <> new.card_id then raise exception '该预算科目属于另一张经费卡'; end if;
  return new;
end $$;
create trigger subject_card before insert or update of subject_id, card_id on budget_line       for each row execute function trg_subject_card();
create trigger subject_card before insert or update of subject_id, card_id on expense_request   for each row execute function trg_subject_card();
create trigger subject_card before insert or update of subject_id, card_id on budget_allocation for each row execute function trg_subject_card();

-- 学校科目对应到本卡的哪个预算科目
create table card_subject_map (
  card_id           uuid not null references fund_card on delete cascade,
  ledger_subject_id uuid not null references template_subject on delete cascade,
  subject_id        uuid not null references template_subject on delete cascade,
  primary key (card_id, ledger_subject_id)
);
select seal('card_subject_map');

-- 按学校的编号和名称找学校科目（只找，不新增）；不会找到某张卡自编的预算科目
create function find_ledger_subject(p_template uuid, p_code text, p_name text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare sid uuid; nm text := nullif(btrim(coalesce(p_name, '')), ''); cd text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if nm is null and cd is null then
    select id into sid from template_subject where template_id = p_template and code = 'school' and card_id is null;
    return sid;
  end if;
  cd := regexp_replace(cd, '^.*-', ''); nm := regexp_replace(nm, '^[^-]*-', '');
  select id into sid from template_subject where template_id = p_template and card_id is null and code <> 'school'
    and (code = cd or school_name = nm or name = nm) order by (code = cd) desc nulls last, sort limit 1;
  return sid;
end $$;
revoke all on function find_ledger_subject(uuid, text, text) from public;

create or replace function ledger_subject(p_template uuid, p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid := find_ledger_subject(p_template, p_code, p_name); nm text := nullif(btrim(coalesce(p_name, '')), ''); cd text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if sid is not null then return sid; end if;
  if nm is null and cd is null then
    insert into template_subject (template_id, code, name, sort) values (p_template, 'school', '学校明细账（未注明科目）', 9990) returning id into sid;
    return sid;
  end if;
  cd := regexp_replace(cd, '^.*-', ''); nm := regexp_replace(nm, '^[^-]*-', '');
  insert into template_subject (template_id, code, name, school_name, sort)
  values (p_template, coalesce(cd, 'school-' || md5(nm)), coalesce(nm, cd), coalesce(nm, cd), 5000) returning id into sid;
  return sid;
end $$;

-- 导入明细账：学校科目已对应到本卡预算科目的，支出记在预算科目下
do $$
declare d text := pg_get_functiondef('public.import_ledger(uuid, jsonb, jsonb, numeric, numeric, boolean)'::regprocedure); n text;
begin
  n := replace(d, 'sid := ledger_subject(c.template_id, sc, sn);',
    'sid := ledger_subject(c.template_id, sc, sn);
    sid := coalesce((select m.subject_id from card_subject_map m where m.card_id = p_card and m.ledger_subject_id = sid), sid);');
  if n = d then raise exception '导入明细账：未找到确定科目的位置'; end if;
  execute n;
end $$;

-- 新增或改名本卡的预算科目
create function save_card_subject(p_id uuid, p_card uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c fund_card; n text := btrim(coalesce(p_name, '')); sid uuid; cid uuid := p_card;
begin
  perform need_perm('card.manage');
  if p_id is not null then
    select card_id into cid from template_subject where id = p_id and card_id is not null;
    if not found then raise exception '预算科目不存在'; end if;
  end if;
  c := lock_card(cid);
  if n = '' or length(n) > 40 then raise exception '请填写预算科目名称（不超过 40 字）'; end if;
  if exists (select 1 from template_subject where card_id = cid and name = n and id is distinct from p_id) then raise exception '该经费卡已有同名的预算科目'; end if;
  if p_id is not null then
    update template_subject set name = n where id = p_id;
    return p_id;
  end if;
  insert into template_subject (template_id, code, name, sort, card_id)
  values (c.template_id, 'item-' || replace(gen_random_uuid()::text, '-', ''), n,
          (select coalesce(max(sort), 100) + 1 from template_subject where card_id = cid), cid) returning id into sid;
  insert into budget_line (card_id, subject_id, amount) values (cid, sid, 0);
  return sid;
end $$;

-- 删除本卡的预算科目：没有金额、没有支出、没有对应的学校科目才能删
create function delete_card_subject(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  perform need_perm('card.manage');
  select card_id into cid from template_subject where id = p_id and card_id is not null;
  if not found then raise exception '预算科目不存在'; end if;
  perform lock_card(cid);
  if exists (select 1 from card_subject_map where subject_id = p_id) then raise exception '该预算科目已对应学校科目，请先取消对应'; end if;
  if exists (select 1 from budget_line where subject_id = p_id and amount > 0) then raise exception '该预算科目已录有金额，请先更正为零'; end if;
  if exists (select 1 from expense_request where subject_id = p_id) or exists (select 1 from budget_allocation where subject_id = p_id) then
    raise exception '该预算科目已有记录，不能删除';
  end if;
  begin
    delete from budget_line where subject_id = p_id;
    delete from template_subject where id = p_id;
  exception when foreign_key_violation then raise exception '该预算科目已有记录，不能删除';
  end;
end $$;

-- 把一个学校科目对应到本卡的某个预算科目（p_subject 为空是取消对应）。
-- 该学校科目下从明细账导入的支出随之改记到预算科目下（取消时改回学校科目）；返回改记的笔数
create function map_school_subject(p_card uuid, p_ledger uuid, p_subject uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c fund_card; target uuid := coalesce(p_subject, p_ledger); n int;
begin
  perform need_perm('card.manage');
  c := lock_card(p_card);
  if not exists (select 1 from template_subject where id = p_ledger and template_id = c.template_id and card_id is null and code <> 'school') then raise exception '学校科目不存在'; end if;
  if p_subject is not null then
    if not exists (select 1 from template_subject where id = p_subject and card_id = p_card) then raise exception '预算科目不属于该经费卡'; end if;
    if exists (select 1 from budget_line where card_id = p_card and subject_id = p_ledger and amount > 0) then raise exception '该学校科目上已录有明细金额，请先更正为零，再对应到预算科目'; end if;
  end if;
  insert into budget_line (card_id, subject_id, amount) values (p_card, target, 0) on conflict (card_id, subject_id) do nothing;
  update expense_request e set subject_id = target
  where e.card_id = p_card and e.school_name is not null and e.subject_id <> target
    and find_ledger_subject(c.template_id, e.school_code, e.school_name) = p_ledger;
  get diagnostics n = row_count;
  if p_subject is null then delete from card_subject_map where card_id = p_card and ledger_subject_id = p_ledger;
  else
    insert into card_subject_map (card_id, ledger_subject_id, subject_id) values (p_card, p_ledger, p_subject)
    on conflict (card_id, ledger_subject_id) do update set subject_id = excluded.subject_id;
  end if;
  return n;
end $$;
select expose('save_card_subject(uuid, uuid, text)', 'delete_card_subject(uuid)', 'map_school_subject(uuid, uuid, uuid)');

create or replace view api.subject as
  select s.id, s.template_id, s.code, s.name, s.school_name, s.sort, s.card_id
  from template_subject s where app_role() is not null;

create view api.card_subject_map as
  select m.card_id, m.ledger_subject_id, l.code as ledger_code, l.name as ledger_name, m.subject_id
  from card_subject_map m join template_subject l on l.id = m.ledger_subject_id where can_see_card(m.card_id);
grant select on api.card_subject_map to app_api;
