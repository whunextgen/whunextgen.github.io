-- 一、结清后被学校回收的部分不再占项目额度。
-- 项目占用的额度 = 各卡下达数合计 − 已结清的卡被回收的金额。结转到下一年的部分仍算在原来那张卡的下达数里，不重复计。
create or replace function fund_granted(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(coalesce(c.granted, (select coalesce(sum(b.amount), 0) from budget_line b where b.card_id = c.id) - c.carried_in)
                      - case when c.status = 'settled' then coalesce(c.recalled, 0) else 0 end), 0)
  from fund_card c where c.project_id = p_project
$$;

-- 二、学校科目不分经费类别：同一支出性质只算一个科目。
-- 学校的科目编号形如「7201020202-3021101」，前半段是经费类别，后半段是支出性质；名称形如「非财政支出-国内差旅费」。
-- 中台的科目取后半段编号和后半段名称（3021101 国内差旅费）；每笔支出上仍保留学校的完整编号和名称。
create or replace function ledger_subject(p_template uuid, p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid; nm text := nullif(btrim(coalesce(p_name, '')), ''); cd text := nullif(btrim(coalesce(p_code, '')), '');
begin
  if nm is null and cd is null then
    select id into sid from template_subject where template_id = p_template and code = 'school';
    if sid is null then insert into template_subject (template_id, code, name, sort) values (p_template, 'school', '学校明细账（未注明科目）', 9990) returning id into sid; end if;
    return sid;
  end if;
  cd := regexp_replace(cd, '^.*-', ''); nm := regexp_replace(nm, '^[^-]*-', '');
  select id into sid from template_subject where template_id = p_template and code <> 'school'
    and (code = cd or school_name = nm or name = nm) order by (code = cd) desc nulls last, sort limit 1;
  if sid is not null then return sid; end if;
  insert into template_subject (template_id, code, name, school_name, sort)
  values (p_template, coalesce(cd, 'school-' || md5(nm)), coalesce(nm, cd), coalesce(nm, cd), 5000) returning id into sid;
  return sid;
end $$;

-- 已有的学校科目按后半段合并：支出、预算等改挂到合并后的科目上
do $$
declare o record; t uuid;
begin
  for o in select id, template_id, code, name from template_subject where code ~ '^[0-9]' and (code like '%-%' or name like '%-%') order by code loop
    select id into t from template_subject where template_id = o.template_id and id <> o.id and code = regexp_replace(o.code, '^.*-', '');
    if t is null then
      -- 还没有合并后的科目：把这一个改成合并后的编号和名称
      update template_subject set code = regexp_replace(o.code, '^.*-', ''), name = regexp_replace(o.name, '^[^-]*-', ''), school_name = regexp_replace(o.name, '^[^-]*-', '') where id = o.id;
      continue;
    end if;
    insert into budget_line (card_id, subject_id, amount) select card_id, t, amount from budget_line where subject_id = o.id
      on conflict (card_id, subject_id) do update set amount = budget_line.amount + excluded.amount;
    delete from budget_line where subject_id = o.id;
    -- 结清记录里按科目的行：同一次结清里合并成一行
    insert into settlement_line (settlement_id, subject_id, budget, actual, balance) select settlement_id, t, budget, actual, balance from settlement_line where subject_id = o.id
      on conflict (settlement_id, subject_id) do update set budget = settlement_line.budget + excluded.budget, actual = settlement_line.actual + excluded.actual, balance = settlement_line.balance + excluded.balance;
    delete from settlement_line where subject_id = o.id;
    -- 下达分配：同一预算行、同一张卡合并金额
    insert into budget_allocation (line_id, card_id, subject_id, amount) select line_id, card_id, t, amount from budget_allocation where subject_id = o.id
      on conflict (line_id, card_id, subject_id) do update set amount = budget_allocation.amount + excluded.amount;
    delete from budget_allocation where subject_id = o.id;
    -- 预算变更的行
    insert into budget_change_line (change_id, subject_id, delta) select change_id, t, delta from budget_change_line where subject_id = o.id
      on conflict (change_id, subject_id) do update set delta = budget_change_line.delta + excluded.delta;
    delete from budget_change_line where subject_id = o.id;
    -- 科目对应和比例上限的科目清单：已有的不重复加
    insert into category_subject (category_id, subject_id) select category_id, t from category_subject where subject_id = o.id on conflict do nothing;
    delete from category_subject where subject_id = o.id;
    insert into template_cap_subject (cap_id, subject_id) select cap_id, t from template_cap_subject where subject_id = o.id on conflict do nothing;
    delete from template_cap_subject where subject_id = o.id;
    update expense_request set subject_id = t where subject_id = o.id;
    delete from template_subject where id = o.id;
  end loop;
end $$;
