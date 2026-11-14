-- 现有的都是经费卡，不是经费项目。0031 给每张卡自动补的同名项目只是占位：
-- 标出来，等财务岗建好真正的经费项目后把卡归进去，或者把占位直接补全成项目。

alter table fund_project add column auto boolean not null default false;   -- 由经费卡自动生成的占位，还不是正式的经费项目
update fund_project p set auto = true
where p.source is null and p.quota is null and p.note is null
  and (select count(*) from fund_card c where c.project_id = p.id) = 1
  and exists (select 1 from fund_card c where c.project_id = p.id and c.name = p.name);

create or replace function trg_card_project() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.year := coalesce(new.year, extract(year from new.start_date)::int);
  if new.project_id is null then
    insert into fund_project (name, fund_kind, owner_id, template_id, end_rule, period_start, period_end, auto)
    values (new.name, new.fund_kind, new.owner_id, new.template_id, new.end_rule, new.start_date, new.cutoff_date, true)
    returning id into new.project_id;
  end if;
  return new;
end $$;

-- save_fund_project：备注的变量与列同名，修改时会报列名有歧义，改掉；占位项目一经修改即成为正式项目
do $do$
declare d text; d2 text; x text[]; pairs text[][] := array[
  array['note text := nullif(btrim(coalesce(p_note, '''')), '''');', 'v_note text := nullif(btrim(coalesce(p_note, '''')), '''');'],
  array['if length(note) > 500 then', 'if length(v_note) > 500 then'],
  array['p_template, p_end_rule, note) returning id into pid;', 'p_template, p_end_rule, v_note) returning id into pid;'],
  array['end_rule = p_end_rule, note = note, updated_at = now() where id = p_id;', 'end_rule = p_end_rule, note = v_note, auto = false, updated_at = now() where id = p_id;']];
begin
  d := pg_get_functiondef('public.save_fund_project(uuid, text, text, text, uuid, numeric, date, date, uuid, text, text)'::regprocedure);
  foreach x slice 1 in array pairs loop
    d2 := replace(d, x[1], x[2]);
    if d2 = d then raise exception 'save_fund_project：未找到 %', x[1]; end if;
    d := d2;
  end loop;
  execute d;
end $do$;

-- 把一张经费卡归到另一个经费项目下。原来的占位项目空了就删掉
create function move_card(p_card uuid, p_project uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c fund_card; t fund_project; o fund_project; g numeric;
begin
  perform need_perm('card.manage');
  c := lock_card(p_card);
  select * into t from fund_project where id = p_project for update;
  if not found then raise exception '经费项目不存在'; end if;
  if t.id = c.project_id then raise exception '该经费卡已在这个经费项目下'; end if;
  if t.status <> 'active' then raise exception '经费项目已结题，不得归入经费卡'; end if;
  if t.auto then raise exception '目标是由经费卡自动生成的占位，请先将其补全为正式的经费项目'; end if;
  if t.template_id <> c.template_id then raise exception '该经费卡的科目模板与经费项目不一致，不得归入'; end if;
  if exists (select 1 from fund_card where project_id = p_project and year = c.year) then
    raise exception '该经费项目 % 年已有经费卡，一个项目每年只有一张', c.year;
  end if;
  if (t.period_start is not null and c.year < extract(year from t.period_start)) or (t.period_end is not null and c.year > extract(year from t.period_end)) then
    raise exception '该经费卡的年度 % 不在经费项目的期限内', c.year;
  end if;
  select * into o from fund_project where id = c.project_id for update;
  update fund_card set project_id = p_project, updated_at = now() where id = p_card;
  -- 名称、负责人、经费性质以项目为准
  update fund_card set name = t.name, owner_id = t.owner_id, fund_kind = t.fund_kind where id = p_card and status = 'active';
  g := fund_granted(p_project);
  if t.quota is not null and g > t.quota then
    raise exception '归入后经费项目「%」历年下达数合计 % 超过项目额度 %', t.name, g, t.quota;
  end if;
  if o.auto and not exists (select 1 from fund_card where project_id = o.id) then
    delete from fund_project where id = o.id;
  end if;
end $$;

create or replace view api.fund_project as
  select p.id, p.name, p.source, p.fund_kind, p.owner_id, u.name as owner_name, p.quota, p.period_start, p.period_end,
         p.template_id, t.name as template_name, p.end_rule, p.note, p.status,
         fund_granted(p.id) as granted,
         (select coalesce(sum(c.recalled), 0) from fund_card c where c.project_id = p.id) as recalled,
         (select count(*) from fund_card c where c.project_id = p.id)::int as cards,
         p.auto
  from fund_project p join card_template t on t.id = p.template_id left join app_user u on u.id = p.owner_id
  where has_perm('read.finance') or has_perm('card.manage')
     or exists (select 1 from fund_card c where c.project_id = p.id and can_see_card(c.id));

select expose('move_card(uuid, uuid)');
