-- 经费项目与经费卡分开。
-- 经费项目：学校、国家等渠道批下来的一个项目，记额度和期限。
-- 经费卡：一个经费项目某一年下来的经费，每年一张；当年能用多少只看当年这张卡。
-- 原来卡上的总金额、执行年限、经费性质归到项目上；卡上加所属项目、年度、申请数、结转和回收。

create table fund_project (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  source       text check (source in ('school','national','provincial','enterprise','other')),   -- 来源渠道
  fund_kind    text check (fund_kind in ('vertical','fiscal','horizontal')),
  owner_id     uuid references app_user,
  quota        numeric(14,2) check (quota is null or quota >= 0),                                -- 额度：批下来的总数
  period_start date,
  period_end   date,
  template_id  uuid not null references card_template,
  end_rule     text not null default 'recall' check (end_rule in ('recall','carry','return')),   -- 各年的卡默认的年底规则
  note         text,
  status       text not null default 'active' check (status in ('active','closed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (period_start is null or period_end is null or period_end >= period_start)
);
select seal('fund_project');
create trigger audit after insert or update or delete on fund_project for each row execute function trg_audit();

alter table fund_card
  add column project_id  uuid references fund_project,
  add column year        int,
  add column applied     numeric(14,2) check (applied is null or applied >= 0),        -- 当年申请数
  add column carried_in  numeric(14,2) not null default 0 check (carried_in >= 0),     -- 上年结转进来的
  add column recalled    numeric(14,2),                                                -- 结清时被回收的
  add column carried_out numeric(14,2);                                                -- 结清时结转到下一年的

-- 现有的卡：每张生成一个经费项目，年度取下达日所在年
do $$ declare c fund_card; pid uuid; begin
  for c in select * from fund_card order by created_at, id loop
    insert into fund_project (name, fund_kind, owner_id, quota, period_start, period_end, template_id, end_rule)
    values (c.name, c.fund_kind, c.owner_id, c.total_amount, coalesce(c.period_start, c.start_date), coalesce(c.period_end, c.cutoff_date), c.template_id, c.end_rule)
    returning id into pid;
    update fund_card set project_id = pid, year = extract(year from c.start_date)::int where id = c.id;
  end loop;
end $$;
-- 原来拿整段期限当一年用的跨年卡：日期不在这里改，项目期限已取自它的起止日；
-- 单据截止日由财务岗在页面上收到当年，后面年份的卡届时另开

alter table fund_card alter column project_id set not null, alter column year set not null;
alter table fund_card drop constraint fund_card_card_no_key;
alter table fund_card add constraint fund_card_no_year_key unique (card_no, year);
alter table fund_card add constraint fund_card_project_year_key unique (project_id, year);
create index on fund_card (project_id);

-- 不经经费项目直接建的卡（旧入口）：自动补一个同名项目，年度取下达日所在年
create function trg_card_project() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.year := coalesce(new.year, extract(year from new.start_date)::int);
  if new.project_id is null then
    insert into fund_project (name, fund_kind, owner_id, template_id, end_rule, period_start, period_end)
    values (new.name, new.fund_kind, new.owner_id, new.template_id, new.end_rule, new.start_date, new.cutoff_date)
    returning id into new.project_id;
  end if;
  return new;
end $$;
create trigger card_project before insert on fund_card for each row execute function trg_card_project();

-- 一个项目历年下达数合计：各年卡的年初预算合计，减去结转进来的（结转的钱上一年已经算过）
create function fund_granted(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(b.amount) from budget_line b join fund_card c on c.id = b.card_id where c.project_id = p_project), 0)
       - coalesce((select sum(c.carried_in) from fund_card c where c.project_id = p_project), 0)
$$;

-- 规则：历年下达数合计不超过项目额度。只在调高某个科目的预算时检查
create function trg_quota() returns trigger language plpgsql security definer set search_path = public as $$
declare p fund_project; g numeric;
begin
  if tg_op = 'UPDATE' and new.amount <= old.amount then return null; end if;
  select f.* into p from fund_project f join fund_card c on c.project_id = f.id where c.id = new.card_id;
  if p.quota is null then return null; end if;
  g := fund_granted(p.id);
  if g > p.quota then
    raise exception '经费项目「%」历年下达数合计 % 超过项目额度 %，请核对下达数或先调整项目额度', p.name, g, p.quota;
  end if;
  return null;
end $$;
create trigger quota after insert or update of amount on budget_line for each row execute function trg_quota();

-- 规则：研究项目的年度预算只能下达到同一年度的卡上
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.auto_allocate(int)'::regprocedure);
  d2 := replace(d, 'k.start_date <= make_date(p_year, 12, 31) and k.cutoff_date >= make_date(p_year, 1, 1)', 'k.year = p_year');
  if d2 = d then raise exception 'auto_allocate：未找到按日期筛选经费卡的语句'; end if;
  execute d2;

  d := pg_get_functiondef('public.allocate_line(uuid, jsonb)'::regprocedure);
  d2 := replace(d, 'select c.card_no, c.status, c.start_date, c.cutoff_date,', 'select c.card_no, c.status, c.start_date, c.cutoff_date, c.year as card_year,');
  if d2 = d then raise exception 'allocate_line：未找到取经费卡的语句'; end if;
  d := d2;
  d2 := replace(d, 'if x.start_date > make_date(l.year, 12, 31) or x.cutoff_date < make_date(l.year, 1, 1) then', 'if x.card_year <> l.year then');
  if d2 = d then raise exception 'allocate_line：未找到按日期判断的语句'; end if;
  execute d2;

  -- 卡号在不同年度可以相同（一张卡用到底的项目），同一年度内不得重复
  d := pg_get_functiondef('public.save_card(uuid, text, text, uuid, uuid, date, date, date, text, text)'::regprocedure);
  d2 := replace(d, 'where card_no = no and id is distinct from p_id)',
    'where card_no = no and id is distinct from p_id and year = coalesce((select k.year from fund_card k where k.id = p_id), extract(year from p_start)::int))');
  if d2 = d then raise exception 'save_card：未找到卡号查重的语句'; end if;
  execute d2;

  -- 年初预算只有上年结转进来的那部分时，仍算尚未录入，财务岗可以录
  d := pg_get_functiondef('public.set_budget(uuid, jsonb)'::regprocedure);
  d2 := replace(d, 'exists (select 1 from budget_line where card_id = p_card and amount > 0)',
    '(select coalesce(sum(amount), 0) from budget_line where card_id = p_card) > (select carried_in from fund_card where id = p_card)');
  if d2 = d then raise exception 'set_budget：未找到是否已录入的判断'; end if;
  execute d2;
end $do$;

-- 把上一年卡结清时结转的结余，按科目加到下一年卡的预算上
create function carry_into(p_prev uuid, p_next uuid) returns void language plpgsql security definer set search_path = public as $$
declare s numeric;
begin
  select coalesce(sum(greatest(l.balance, 0)), 0) into s
  from settlement_line l join card_settlement t on t.id = l.settlement_id where t.card_id = p_prev;
  if s <= 0 then return; end if;
  update fund_card set carried_in = s, updated_at = now() where id = p_next;
  insert into budget_line (card_id, subject_id, amount)
  select p_next, l.subject_id, l.balance from settlement_line l join card_settlement t on t.id = l.settlement_id
  where t.card_id = p_prev and l.balance > 0
  on conflict (card_id, subject_id) do update set amount = budget_line.amount + excluded.amount;
end $$;

-- 结清时记下结余去向：结转的记结转数并带到下一年的卡，其余记回收数
create function trg_card_settled() returns trigger language plpgsql security definer set search_path = public as $$
declare s numeric;
begin
  select coalesce(sum(greatest(l.balance, 0)), 0) into s
  from settlement_line l join card_settlement t on t.id = l.settlement_id where t.card_id = new.id;
  if new.end_rule = 'carry' then new.carried_out := s; new.recalled := 0;
  else new.recalled := s; new.carried_out := 0; end if;
  return new;
end $$;
create trigger card_settled before update on fund_card for each row
  when (old.status = 'active' and new.status = 'settled') execute function trg_card_settled();

create function trg_card_carry() returns trigger language plpgsql security definer set search_path = public as $$
declare nx uuid;
begin
  if coalesce(new.carried_out, 0) > 0 then
    select id into nx from fund_card where project_id = new.project_id and year = new.year + 1 and status = 'active' and carried_in = 0;
    if nx is not null then perform carry_into(new.id, nx); end if;
  end if;
  return null;
end $$;
create trigger card_carry after update on fund_card for each row
  when (old.status = 'active' and new.status = 'settled') execute function trg_card_carry();

-- 建、改经费项目
create function save_fund_project(p_id uuid, p_name text, p_source text, p_fund_kind text, p_owner uuid, p_quota numeric,
                                  p_start date, p_end date, p_template uuid, p_end_rule text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); note text := nullif(btrim(coalesce(p_note, '')), ''); src text := nullif(p_source, ''); kind text := nullif(p_fund_kind, '');
  p fund_project; pid uuid; g numeric;
begin
  perform need_perm('card.manage');
  if n = '' then raise exception '请填写经费项目名称'; end if;
  if length(n) > 60 then raise exception '经费项目名称不得超过 60 个字'; end if;
  if length(note) > 500 then raise exception '备注不得超过 500 个字'; end if;
  if src is not null and src not in ('school','national','provincial','enterprise','other') then raise exception '来源渠道须为学校、国家、省部、企业或其他'; end if;
  if kind is not null and kind not in ('vertical','fiscal','horizontal') then raise exception '经费性质须为纵向、财政或横向'; end if;
  if p_owner is not null and not exists (select 1 from app_user where id = p_owner and active) then raise exception '负责人不存在或已停用'; end if;
  if p_quota is not null and p_quota < 0 then raise exception '额度不得为负数'; end if;
  if p_start is not null and p_end is not null and p_end < p_start then raise exception '期限的结束日期不得早于开始日期'; end if;
  if not exists (select 1 from card_template where id = p_template) then raise exception '请选择科目模板'; end if;
  if p_end_rule is null or p_end_rule not in ('recall','carry','return') then raise exception '年底规则须为到期回收、结转或结余上缴'; end if;
  if p_id is null then
    insert into fund_project (name, source, fund_kind, owner_id, quota, period_start, period_end, template_id, end_rule, note)
    values (n, src, kind, p_owner, p_quota, p_start, p_end, p_template, p_end_rule, note) returning id into pid;
    return pid;
  end if;
  select * into p from fund_project where id = p_id for update;
  if not found then raise exception '经费项目不存在'; end if;
  if p.status <> 'active' then raise exception '经费项目已结题，不得修改'; end if;
  if p.template_id <> p_template and exists (select 1 from fund_card where project_id = p_id) then
    raise exception '该经费项目已开出经费卡，不得更换科目模板';
  end if;
  g := fund_granted(p_id);
  if p_quota is not null and g > p_quota then raise exception '历年下达数合计 % 已超过拟填的额度 %', g, p_quota; end if;
  if exists (select 1 from fund_card where project_id = p_id
             and ((p_start is not null and year < extract(year from p_start)) or (p_end is not null and year > extract(year from p_end)))) then
    raise exception '已有经费卡的年度不在该期限内';
  end if;
  update fund_project set name = n, source = src, fund_kind = kind, owner_id = p_owner, quota = p_quota, period_start = p_start, period_end = p_end,
         template_id = p_template, end_rule = p_end_rule, note = note, updated_at = now() where id = p_id;
  -- 名称、负责人、经费性质以项目为准，在用的卡跟着改
  update fund_card set name = n, owner_id = p_owner, fund_kind = kind, updated_at = now()
  where project_id = p_id and status = 'active' and (name, owner_id, fund_kind) is distinct from (n, p_owner, kind);
  return p_id;
end $$;

-- 在经费项目下开某一年的卡
create function open_card(p_project uuid, p_year int, p_card_no text, p_applied numeric, p_start date, p_cutoff date, p_settle date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare p fund_project; no text := btrim(coalesce(p_card_no, '')); cid uuid; prev fund_card;
begin
  perform need_perm('card.manage');
  select * into p from fund_project where id = p_project for update;
  if not found then raise exception '经费项目不存在'; end if;
  if p.status <> 'active' then raise exception '经费项目已结题，不得再开经费卡'; end if;
  if p_year is null or p_year not between 2000 and 2100 then raise exception '请填写年度'; end if;
  if (p.period_start is not null and p_year < extract(year from p.period_start)) or (p.period_end is not null and p_year > extract(year from p.period_end)) then
    raise exception '% 年不在该经费项目的期限内', p_year;
  end if;
  if exists (select 1 from fund_card where project_id = p_project and year = p_year) then raise exception '该经费项目 % 年的经费卡已开出', p_year; end if;
  if no = '' then raise exception '请填写经费卡号'; end if;
  if length(no) > 40 then raise exception '经费卡号不得超过 40 个字符'; end if;
  if exists (select 1 from fund_card where card_no = no and year = p_year) then raise exception '% 年已有卡号为「%」的经费卡', p_year, no; end if;
  if p_applied is not null and p_applied < 0 then raise exception '申请数不得为负数'; end if;
  if p_start is null or p_cutoff is null then raise exception '请填写下达日和单据截止日'; end if;
  if extract(year from p_start) <> p_year then raise exception '下达日须在 % 年内', p_year; end if;
  if p_cutoff < p_start then raise exception '单据截止日不得早于下达日'; end if;
  if p_settle is not null and p_settle < p_cutoff then raise exception '结清日不得早于单据截止日'; end if;
  insert into fund_card (project_id, year, card_no, name, template_id, owner_id, fund_kind, start_date, cutoff_date, settle_date, end_rule, applied)
  values (p_project, p_year, no, p.name, p.template_id, p.owner_id, p.fund_kind, p_start, p_cutoff, p_settle, p.end_rule, p_applied) returning id into cid;
  insert into budget_line (card_id, subject_id, amount) select cid, s.id, 0 from template_subject s where s.template_id = p.template_id;
  -- 上一年的卡已结清且有结转的，结余带进来
  select * into prev from fund_card where project_id = p_project and year = p_year - 1 and status = 'settled' and coalesce(carried_out, 0) > 0;
  if found then perform carry_into(prev.id, cid); end if;
  return cid;
end $$;

create function set_card_applied(p_card uuid, p_applied numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('card.manage');
  if p_applied is not null and p_applied < 0 then raise exception '申请数不得为负数'; end if;
  update fund_card set applied = p_applied, updated_at = now() where id = p_card and status = 'active';
  if not found then raise exception '经费卡不存在或已结清'; end if;
end $$;

-- 结题：各年的卡都结清之后
create function close_fund_project(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p fund_project; k int;
begin
  perform need_perm('card.manage');
  select * into p from fund_project where id = p_id for update;
  if not found then raise exception '经费项目不存在'; end if;
  if p.status <> 'active' then raise exception '经费项目已结题'; end if;
  select count(*) into k from fund_card where project_id = p_id and status = 'active';
  if k > 0 then raise exception '尚有 % 张经费卡未结清，不得结题', k; end if;
  update fund_project set status = 'closed', updated_at = now() where id = p_id;
end $$;

-- 视图
create view api.fund_project as
  select p.id, p.name, p.source, p.fund_kind, p.owner_id, u.name as owner_name, p.quota, p.period_start, p.period_end,
         p.template_id, t.name as template_name, p.end_rule, p.note, p.status,
         fund_granted(p.id) as granted,
         (select coalesce(sum(c.recalled), 0) from fund_card c where c.project_id = p.id) as recalled,
         (select count(*) from fund_card c where c.project_id = p.id)::int as cards
  from fund_project p join card_template t on t.id = p.template_id left join app_user u on u.id = p.owner_id
  where has_perm('read.finance') or has_perm('card.manage')
     or exists (select 1 from fund_card c where c.project_id = p.id and can_see_card(c.id));

create or replace view api.card as
  select v.card_id, v.card_no, v.name, v.status, v.start_date, v.cutoff_date, v.settle_date, v.end_rule,
         v.orig, v.adj, v.cur, v.commit, v.actual, v.avail,
         c.template_id, t.name as template_name, t.locked, c.owner_id, c.rule_note,
         c.school_balance, c.school_frozen, c.school_available, c.school_synced_at, c.fund_kind, c.received, c.priority,
         c.total_amount, c.period_start, c.period_end,
         c.project_id, c.year, c.applied, c.carried_in, c.recalled, c.carried_out
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

create or replace view api.card_pick as
  select c.id, c.card_no, c.name, c.template_id, c.start_date, c.cutoff_date, c.status, c.year
  from fund_card c where can_see_card(c.id);

grant select on api.fund_project to app_api;
-- 视图里用到的函数按查询者的身份检查权限
revoke all on function fund_granted(uuid) from public;
grant execute on function fund_granted(uuid) to app_api;

select expose(
  'save_fund_project(uuid, text, text, text, uuid, numeric, date, date, uuid, text, text)',
  'open_card(uuid, int, text, numeric, date, date, date)',
  'set_card_applied(uuid, numeric)',
  'close_fund_project(uuid)');
do $$ declare f text; begin
  foreach f in array array['trg_card_project()', 'trg_quota()', 'carry_into(uuid, uuid)', 'trg_card_settled()', 'trg_card_carry()'] loop
    execute format('revoke all on function %s from public', f);
  end loop;
end $$;
