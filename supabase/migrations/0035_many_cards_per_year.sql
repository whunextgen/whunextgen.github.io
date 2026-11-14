-- 一个项目同一年度可以有多张经费卡（例如直接费、间接费各一张）。
-- 取消「同一项目同一年只有一张」的限制；经费卡可以有自己的名称，不再强制与项目同名；
-- 结转按卡号对应：上一年的卡结清后，结余带到下一年同卡号的卡上。

alter table fund_card drop constraint fund_card_project_year_key;
create index on fund_card (project_id, year);

-- 上一年结转的去处：同一项目下一年度同卡号的卡；没有同卡号的，且下一年度只有一张卡时，带到那一张
create function carry_target(p_card fund_card) returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from fund_card where project_id = p_card.project_id and year = p_card.year + 1 and status = 'active' and carried_in = 0 and card_no = p_card.card_no),
    (select min(id::text)::uuid from fund_card where project_id = p_card.project_id and year = p_card.year + 1 and status = 'active' and carried_in = 0
       having count(*) = 1 and (select count(*) from fund_card where project_id = p_card.project_id and year = p_card.year + 1) = 1))
$$;

create or replace function trg_card_carry() returns trigger language plpgsql security definer set search_path = public as $$
declare nx uuid;
begin
  if coalesce(new.carried_out, 0) > 0 then
    nx := carry_target(new);
    if nx is not null then perform carry_into(new.id, nx); end if;
  end if;
  return null;
end $$;

-- 在项目下开某一年的卡。同一年度可开多张，卡号在同一年度内不得重复；名称不填时取项目名称
drop function open_card(uuid, int, text, numeric, date, date, date);
create function open_card(p_project uuid, p_year int, p_card_no text, p_applied numeric, p_start date, p_cutoff date, p_settle date default null, p_name text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare p fund_project; no text := btrim(coalesce(p_card_no, '')); nm text := nullif(btrim(coalesce(p_name, '')), ''); cid uuid; c fund_card; prev fund_card;
begin
  perform need_perm('card.manage');
  select * into p from fund_project where id = p_project for update;
  if not found then raise exception '项目不存在'; end if;
  if p.status <> 'active' then raise exception '项目已结题，不得再开经费卡'; end if;
  if p_year is null or p_year not between 2000 and 2100 then raise exception '请填写年度'; end if;
  if (p.period_start is not null and p_year < extract(year from p.period_start)) or (p.period_end is not null and p_year > extract(year from p.period_end)) then
    raise exception '% 年不在该项目的期限内', p_year;
  end if;
  if no = '' then raise exception '请填写经费卡号'; end if;
  if length(no) > 40 then raise exception '经费卡号不得超过 40 个字符'; end if;
  if exists (select 1 from fund_card where card_no = no and year = p_year) then raise exception '% 年已有卡号为「%」的经费卡', p_year, no; end if;
  if length(nm) > 60 then raise exception '经费卡名称不得超过 60 个字'; end if;
  if p_applied is not null and p_applied < 0 then raise exception '申请数不得为负数'; end if;
  if p_start is null or p_cutoff is null then raise exception '请填写下达日和单据截止日'; end if;
  if extract(year from p_start) <> p_year then raise exception '下达日须在 % 年内', p_year; end if;
  if p_cutoff < p_start then raise exception '单据截止日不得早于下达日'; end if;
  if p_settle is not null and p_settle < p_cutoff then raise exception '结清日不得早于单据截止日'; end if;
  insert into fund_card (project_id, year, card_no, name, template_id, owner_id, fund_kind, start_date, cutoff_date, settle_date, end_rule, applied)
  values (p_project, p_year, no, coalesce(nm, p.name), p.template_id, p.owner_id, p.fund_kind, p_start, p_cutoff, p_settle, p.end_rule, p_applied) returning * into c;
  cid := c.id;
  insert into budget_line (card_id, subject_id, amount) select cid, s.id, 0 from template_subject s where s.template_id = p.template_id;
  -- 上一年已结清且有结转的卡，其结余的去处若正是这张新卡，带进来
  for prev in select * from fund_card where project_id = p_project and year = p_year - 1 and status = 'settled' and coalesce(carried_out, 0) > 0 order by card_no loop
    if carry_target(prev) = cid then perform carry_into(prev.id, cid); exit; end if;
  end loop;
  return cid;
end $$;

-- 把一张经费卡归到另一个项目下。卡的名称保留，负责人和经费性质随项目
create or replace function move_card(p_card uuid, p_project uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c fund_card; t fund_project; o fund_project; g numeric;
begin
  perform need_perm('card.manage');
  c := lock_card(p_card);
  select * into t from fund_project where id = p_project for update;
  if not found then raise exception '项目不存在'; end if;
  if t.id = c.project_id then raise exception '该经费卡已在这个项目下'; end if;
  if t.status <> 'active' then raise exception '项目已结题，不得归入经费卡'; end if;
  if t.auto then raise exception '目标是由经费卡自动生成的占位，请先将其补全为正式的项目'; end if;
  if t.template_id <> c.template_id then raise exception '该经费卡的科目模板与项目不一致，不得归入'; end if;
  if (t.period_start is not null and c.year < extract(year from t.period_start)) or (t.period_end is not null and c.year > extract(year from t.period_end)) then
    raise exception '该经费卡的年度 % 不在项目的期限内', c.year;
  end if;
  select * into o from fund_project where id = c.project_id for update;
  update fund_card set project_id = p_project, updated_at = now() where id = p_card;
  update fund_card set owner_id = t.owner_id, fund_kind = t.fund_kind where id = p_card and status = 'active';
  g := fund_granted(p_project);
  if t.quota is not null and g > t.quota then
    raise exception '归入后项目「%」历年下达数合计 % 超过项目额度 %', t.name, g, t.quota;
  end if;
  if o.auto and not exists (select 1 from fund_card where project_id = o.id) then
    delete from fund_project where id = o.id;
  end if;
end $$;

-- 建、改项目。负责人、经费性质以项目为准，在用的卡跟着改；卡的名称不动
create or replace function save_fund_project(p_id uuid, p_name text, p_source text, p_fund_kind text, p_owner uuid, p_quota numeric,
                                  p_start date, p_end date, p_template uuid, p_end_rule text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); v_note text := nullif(btrim(coalesce(p_note, '')), ''); src text := nullif(p_source, ''); kind text := nullif(p_fund_kind, '');
  p fund_project; pid uuid; g numeric;
begin
  perform need_perm('card.manage');
  if n = '' then raise exception '请填写项目名称'; end if;
  if length(n) > 60 then raise exception '项目名称不得超过 60 个字'; end if;
  if length(v_note) > 500 then raise exception '备注不得超过 500 个字'; end if;
  if src is not null and src not in ('school','national','provincial','enterprise','other') then raise exception '来源渠道须为学校、国家、省部、企业或其他'; end if;
  if kind is not null and kind not in ('vertical','fiscal','horizontal') then raise exception '经费性质须为纵向、财政或横向'; end if;
  if p_owner is not null and not exists (select 1 from app_user where id = p_owner and active) then raise exception '负责人不存在或已停用'; end if;
  if p_quota is not null and p_quota < 0 then raise exception '额度不得为负数'; end if;
  if p_start is not null and p_end is not null and p_end < p_start then raise exception '期限的结束日期不得早于开始日期'; end if;
  if not exists (select 1 from card_template where id = p_template) then raise exception '请选择科目模板'; end if;
  if p_end_rule is null or p_end_rule not in ('recall','carry','return') then raise exception '年底规则须为到期回收、结转或结余上缴'; end if;
  if p_id is null then
    insert into fund_project (name, source, fund_kind, owner_id, quota, period_start, period_end, template_id, end_rule, note)
    values (n, src, kind, p_owner, p_quota, p_start, p_end, p_template, p_end_rule, v_note) returning id into pid;
    return pid;
  end if;
  select * into p from fund_project where id = p_id for update;
  if not found then raise exception '项目不存在'; end if;
  if p.status <> 'active' then raise exception '项目已结题，不得修改'; end if;
  if p.template_id <> p_template and exists (select 1 from fund_card where project_id = p_id) then
    raise exception '该项目已开出经费卡，不得更换科目模板';
  end if;
  g := fund_granted(p_id);
  if p_quota is not null and g > p_quota then raise exception '历年下达数合计 % 已超过拟填的额度 %', g, p_quota; end if;
  if exists (select 1 from fund_card where project_id = p_id
             and ((p_start is not null and year < extract(year from p_start)) or (p_end is not null and year > extract(year from p_end)))) then
    raise exception '已有经费卡的年度不在该期限内';
  end if;
  update fund_project set name = n, source = src, fund_kind = kind, owner_id = p_owner, quota = p_quota, period_start = p_start, period_end = p_end,
         template_id = p_template, end_rule = p_end_rule, note = v_note, auto = false, updated_at = now() where id = p_id;
  -- 原来与项目同名的卡跟着改名，另起了名称的不动
  update fund_card set name = n, updated_at = now() where project_id = p_id and status = 'active' and name = p.name and name <> n;
  update fund_card set owner_id = p_owner, fund_kind = kind, updated_at = now()
  where project_id = p_id and status = 'active' and (owner_id, fund_kind) is distinct from (p_owner, kind);
  return p_id;
end $$;

select expose('open_card(uuid, int, text, numeric, date, date, date, text)');
revoke all on function carry_target(fund_card) from public;
