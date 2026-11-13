-- 下达之后跨项目调预算：大项目负责人在同一个大项目的各论文项目（以及大项目自己的预算行）之间挪。
-- 大项目连同论文项目的合计不变，所以不碰上限；直接生效，两行各留一笔版本记录。
-- 项目内各行之间的调剂照旧（10% 以内负责人自己定，超过的交中心负责人），跨项目的不算进那 10%。

alter table budget_shift add column to_project uuid references project;

create or replace function apply_shift(p_shift uuid) returns void language plpgsql as $$
declare s budget_shift; f v_line; t v_line; over numeric; a record; cut numeric; fn text; tn text; word text;
begin
  select * into s from budget_shift where id = p_shift;
  select * into f from v_line where id = s.from_line;
  select * into t from v_line where id = s.to_line;
  if f.id is null or t.id is null then raise exception '预算行不存在'; end if;
  if coalesce(f.fixed, 0) - f.used < s.amount then
    raise exception '调出的这一行核定 %，已用 %，只剩 %，不够调出 %', coalesce(f.fixed, 0), f.used, coalesce(f.fixed, 0) - f.used, s.amount;
  end if;
  -- 调出的一行多下达的部分收回，先收可结转的卡
  over := f.allocated - (f.fixed - s.amount);
  if over > 0 then
    for a in select x.id, x.amount, x.used from v_alloc x join fund_card k on k.id = x.card_id where x.line_id = f.id
             order by case k.end_rule when 'carry' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date) desc loop
      exit when over <= 0;
      cut := least(over, a.amount - a.used);
      if cut >= a.amount then delete from budget_allocation where id = a.id;
      elsif cut > 0 then update budget_allocation set amount = amount - cut where id = a.id;
      end if;
      over := over - greatest(cut, 0);
    end loop;
  end if;
  update project_budget_line set fixed = fixed - s.amount where id = f.id;
  update project_budget_line set fixed = coalesce(fixed, 0) + s.amount where id = t.id;
  if s.to_project is null then
    word := '科目间调剂'; fn := f.purpose; tn := t.purpose;
  else
    word := '跨项目调剂';
    select name || ' · ' || f.purpose into fn from project where id = f.project_id;
    select name || ' · ' || t.purpose into tn from project where id = t.project_id;
  end if;
  insert into budget_revision (line_id, old_amount, new_amount, note, revised_by) values
    (f.id, f.fixed, f.fixed - s.amount, word || '，调出到「' || tn || '」：' || s.note, s.requested_by),
    (t.id, coalesce(t.fixed, 0), coalesce(t.fixed, 0) + s.amount, word || '，从「' || fn || '」调入：' || s.note, s.requested_by);
end $$;

-- 项目内调剂：和原来一样，只是累计 10% 不把跨项目的算进去
create or replace function shift_budget(p_from uuid, p_to uuid, p_amount numeric, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f v_line; t v_line; y budget_year; n text := nullif(btrim(coalesce(p_note, '')), ''); tot numeric; done numeric; sid uuid; st text; pn text;
begin
  select * into f from v_line where id = p_from;
  select * into t from v_line where id = p_to;
  if f.id is null or t.id is null then raise exception '预算行不存在'; end if;
  if p_from = p_to then raise exception '调出和调入不能是同一行'; end if;
  if f.project_id <> t.project_id or f.year <> t.year then raise exception '只能在同一个项目、同一年度的预算行之间调剂'; end if;
  if not has_perm('budget.project', f.project_id) then raise exception '只有项目负责人和副手能调剂本项目的预算' using errcode = '42501'; end if;
  y := lock_year(f.year);
  if y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前才能调剂'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if n is null then raise exception '请写明为什么调剂'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  if coalesce(f.fixed, 0) - f.used < p_amount then
    raise exception '调出的这一行核定 %，已用 %，只剩 %，不够调出 %', coalesce(f.fixed, 0), f.used, coalesce(f.fixed, 0) - f.used, p_amount;
  end if;
  if exists (select 1 from budget_shift where project_id = f.project_id and year = f.year and status = 'pending') then
    raise exception '这个项目已经有一笔调剂在等中心负责人批，批完再提';
  end if;
  select coalesce(sum(fixed), 0) into tot from v_line where project_id = f.project_id and year = f.year;
  select coalesce(sum(amount), 0) into done from budget_shift
  where project_id = f.project_id and year = f.year and status = 'applied' and decided_by is null and to_project is null;
  st := case when done + p_amount <= round(tot * 0.10, 2) then 'applied' else 'pending' end;
  insert into budget_shift (year, project_id, from_line, to_line, amount, note, status, requested_by)
  values (f.year, f.project_id, p_from, p_to, p_amount, n, st, app_uid()) returning id into sid;
  select name into pn from project where id = f.project_id;
  if st = 'applied' then
    perform apply_shift(sid);
    perform notify_role('finance', format('「%s」在预算行之间调剂了 %s 元，调入的部分等你下达到经费', pn, to_char(p_amount, 'FM999,999,999,990.00')));
  else
    perform notify_role('director', format('「%s」申请在预算行之间调剂 %s 元，全年累计超过年度预算的 10%%，等你批', pn, to_char(p_amount, 'FM999,999,999,990.00')));
  end if;
  return sid;
end $$;

-- 跨项目调剂：两行要在同一个大项目名下（论文项目之间，或者论文项目和大项目自己的预算行之间），由大项目负责人或副手调
create function move_budget(p_from uuid, p_to uuid, p_amount numeric, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare f v_line; t v_line; fp project; tp project; root uuid; y budget_year; n text := nullif(btrim(coalesce(p_note, '')), ''); sid uuid; amt text;
begin
  select * into f from v_line where id = p_from;
  select * into t from v_line where id = p_to;
  if f.id is null or t.id is null then raise exception '预算行不存在'; end if;
  select * into fp from project where id = f.project_id;
  select * into tp from project where id = t.project_id;
  if f.project_id = t.project_id then raise exception '这两行在同一个项目里，用项目内的调剂'; end if;
  root := coalesce(fp.parent_id, fp.id);
  if root <> coalesce(tp.parent_id, tp.id) or f.year <> t.year then raise exception '只能在同一个大项目、同一年度的预算行之间调'; end if;
  if not has_perm('budget.project', root) then raise exception '只有大项目负责人和副手能在论文项目之间调预算' using errcode = '42501'; end if;
  if not fp.active or not tp.active then raise exception '停用的项目不能调'; end if;
  y := lock_year(f.year);
  if y.stage <> 'issued' then raise exception '预算下达之后、年度决算之前才能调剂'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额要大于 0'; end if;
  if n is null then raise exception '请写明为什么调剂'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  if coalesce(f.fixed, 0) - f.used < p_amount then
    raise exception '调出的这一行核定 %，已用 %，只剩 %，不够调出 %', coalesce(f.fixed, 0), f.used, coalesce(f.fixed, 0) - f.used, p_amount;
  end if;
  insert into budget_shift (year, project_id, to_project, from_line, to_line, amount, note, status, requested_by)
  values (f.year, f.project_id, t.project_id, p_from, p_to, p_amount, n, 'applied', app_uid()) returning id into sid;
  perform apply_shift(sid);
  amt := to_char(p_amount, 'FM999,999,999,990.00');
  perform notify_role('finance', format('大项目负责人把 %s 元从「%s」调到「%s」，调入的部分等你下达到经费', amt, fp.name, tp.name));
  if fp.owner_id is not null and fp.owner_id <> app_uid() then
    perform notify_user(fp.owner_id, format('大项目负责人从「%s」的「%s」调出 %s 元到「%s」。原因：%s', fp.name, f.purpose, amt, tp.name, n));
  end if;
  if tp.owner_id is not null and tp.owner_id <> app_uid() and tp.owner_id is distinct from fp.owner_id then
    perform notify_user(tp.owner_id, format('大项目负责人从「%s」调入 %s 元到「%s」的「%s」。原因：%s', fp.name, amt, tp.name, t.purpose, n));
  end if;
  return sid;
end $$;

create or replace view api.budget_shift as
  select s.id, s.year, s.project_id, p.name as project_name, s.from_line, f.purpose as from_purpose, s.to_line, t.purpose as to_purpose,
         s.amount, s.note, s.status, (select name from app_user where id = s.requested_by) as requester_name,
         (select name from app_user where id = s.decided_by) as decided_by_name, s.decide_note, s.created_at, s.decided_at,
         s.to_project as to_project_id, (select name from project where id = s.to_project) as to_project_name
  from budget_shift s join project p on p.id = s.project_id
  join project_budget_line f on f.id = s.from_line join project_budget_line t on t.id = s.to_line
  where can_see_project(s.project_id) or (s.to_project is not null and can_see_project(s.to_project));

select expose('move_budget(uuid, uuid, numeric, text)');
