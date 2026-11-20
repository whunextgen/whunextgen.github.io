-- 代币试行（计划经济时期）：只记录，不铸造。
--   名义币按人发，每两周一次，按身份定量，代表时间；本人登记这两周的时间花在哪些研究单元上，研究单元负责人确认后计入池子。
--   实际币按课题、按档次发，代表资源使用权；本期只在档次上记数量，资源标价和扣减待存量资源盘清后再做。
--   成果只认外部可验收的四级：公开发布、完整发布、外部反响、同行认可；由研究单元负责人提交链接，助理核对。本期只登记。
--   只用名义币、实际币两个叫法。代币不是钱，不与经费卡和学校账目发生关系。

create table token_param (
  key text primary key check (key in ('nominal', 'phase')),
  value jsonb not null,
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now()
);
-- 各身份每两周的名义币；时期：plan 为计划经济时期
insert into token_param (key, value) values
  ('nominal', '{"postdoc": 80, "phd": 80, "ra": 80, "master": 50, "ri": 40, "visitor": 0}'),
  ('phase', '"plan"');

alter table budget_tier add column token_amount numeric check (token_amount >= 0);   -- 该档每个课题的实际币
alter table project add column pool_cap numeric check (pool_cap > 0);                -- 研究单元池子的上限，联席会议立项时核定

-- 两周一期，自 2026-11-16（周一）起算
create function token_period(p_day date) returns date language sql immutable as $$
  select date '2026-11-16' + (floor((p_day - date '2026-11-16') / 14.0)::int * 14)
$$;

create function token_nominal(p_user uuid) returns numeric language sql stable security definer set search_path = public as $$
  select (select (value ->> u.kind)::numeric from token_param where key = 'nominal') from app_user u where u.id = p_user and u.active and u.kind is not null
$$;

-- 两周登记：这一期的时间花在哪些研究单元上
create table time_log (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  user_id uuid not null references app_user(id),
  project_id uuid not null references project(id),
  percent int not null check (percent between 1 and 100),
  coins numeric not null check (coins >= 0),
  confirmed_by uuid references app_user(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (period_start, user_id, project_id)
);
alter table time_log enable row level security;

-- 成果：每个研究单元每一级一条
create table outcome (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id),
  level int not null check (level between 1 and 4),
  link text not null,
  venue text,
  note text,
  submitted_by uuid not null references app_user(id),
  submitted_at timestamptz not null default now(),
  checked_by uuid references app_user(id),
  checked_at timestamptz,
  rejected boolean not null default false,
  check_note text,
  unique (project_id, level)
);
alter table outcome enable row level security;

create trigger audit after insert or update or delete on time_log for each row execute function trg_audit();
create trigger audit after insert or update or delete on outcome for each row execute function trg_audit();
create trigger audit after insert or update or delete on token_param for each row execute function trg_audit();

-- 本人登记。p_items：[{"project_id": "...", "percent": 60}, ...]，合计不超过 100
create function save_time_log(p_period date, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare me uuid := app_uid(); nom numeric; cur date := token_period(app_today()); it jsonb; pid uuid; pc int; p project; total int := 0; n int := 0; seen uuid[] := '{}'; old time_log;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  nom := token_nominal(me);
  if nom is null then raise exception '本人身份尚未登记，暂不能登记时间。请先由财务岗登记身份'; end if;
  if p_period is null or p_period <> token_period(p_period) then raise exception '登记的期次有误'; end if;
  if not (p_period = cur or (p_period = cur - 14 and app_today() <= cur + 2)) then
    raise exception '仅可登记本期；上一期在结束后三日内可以补登';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then raise exception '登记内容格式有误'; end if;
  -- 未确认的先清掉，按这次提交的重记；已确认的不动
  delete from time_log where period_start = p_period and user_id = me and confirmed_at is null;
  select coalesce(sum(percent), 0) into total from time_log where period_start = p_period and user_id = me;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    begin
      pid := (it ->> 'project_id')::uuid; pc := (it ->> 'percent')::int;
    exception when others then raise exception '登记内容格式有误';
    end;
    if pc is null or pc = 0 then continue; end if;
    if pc < 0 or pc > 100 then raise exception '比例须在 1 到 100 之间'; end if;
    if pid = any(seen) then raise exception '同一个研究单元只能填一行'; end if;
    seen := seen || pid;
    select * into old from time_log where period_start = p_period and user_id = me and project_id = pid;
    if found then
      if old.percent <> pc then raise exception '该研究单元本期的登记已由负责人确认，不得修改'; end if;
      continue;
    end if;
    select * into p from project where id = pid;
    if not found or p.layer <> 'paper' then raise exception '时间只能登记在研究单元上'; end if;
    if not p.active or p.proposed then raise exception '研究单元「%」尚未成立或已停用', p.name; end if;
    if not is_on_project(pid) then raise exception '本人不在研究单元「%」的成员名单内', p.name; end if;
    total := total + pc;
    if total > 100 then raise exception '各研究单元的比例合计不得超过 100%%'; end if;
    insert into time_log (period_start, user_id, project_id, percent, coins) values (p_period, me, pid, pc, round(nom * pc / 100.0, 2));
    n := n + 1;
  end loop;
  return n;
end $$;

-- 研究单元负责人确认本单元这一期的登记。期满七日未确认的作废
create function confirm_time_logs(p_project uuid, p_period date) returns int
language plpgsql security definer set search_path = public as $$
declare p project; n int;
begin
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '研究单元不存在或尚未成立'; end if;
  if not (has_perm('budget.project', p_project) or has_perm('budget.setup')) then raise exception '仅研究单元负责人和副手可确认' using errcode = '42501'; end if;
  if app_today() > p_period + 14 + 7 then raise exception '该期已结束超过七日，未确认的登记已作废'; end if;
  update time_log set confirmed_by = app_uid(), confirmed_at = now() where project_id = p_project and period_start = p_period and confirmed_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception '该期没有待确认的登记'; end if;
  return n;
end $$;

-- 池子上限：按联席会议立项时核定的数登记
create function set_pool_cap(p_project uuid, p_cap numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (has_perm('budget.evaluate') or has_perm('budget.setup')) then raise exception '需要权限：录入联席会议的决定' using errcode = '42501'; end if;
  if not exists (select 1 from project where id = p_project and layer = 'paper') then raise exception '池子上限只对研究单元设定'; end if;
  if p_cap is not null and p_cap <= 0 then raise exception '上限须大于 0；不设上限请留空'; end if;
  update project set pool_cap = p_cap where id = p_project;
end $$;

-- 提交成果链接：研究单元负责人。被退回的可以改了再交
create function submit_outcome(p_project uuid, p_level int, p_link text, p_venue text default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; l text := btrim(coalesce(p_link, '')); o outcome; oid uuid;
begin
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '研究单元不存在或尚未成立'; end if;
  if not (has_perm('budget.project', p_project) or has_perm('budget.setup')) then raise exception '仅研究单元负责人和副手可提交成果' using errcode = '42501'; end if;
  if p_level is null or p_level not between 1 and 4 then raise exception '成果级别仅限一至四级'; end if;
  if l !~ '^https?://\S+$' or length(l) > 500 then raise exception '请填写可公开访问的链接'; end if;
  if p_level = 1 and l !~* 'arxiv\.org|openreview\.net' then raise exception '一级成果须为公开发布：请填写 arXiv 或公开投稿页的链接'; end if;
  if p_level > 1 and not exists (select 1 from outcome where project_id = p_project and level = 1 and not rejected) then
    raise exception '须先提交一级成果（公开发布）';
  end if;
  if length(coalesce(p_note, '')) > 500 or length(coalesce(p_venue, '')) > 120 then raise exception '说明不得超过 500 个字，去向不得超过 120 个字'; end if;
  select * into o from outcome where project_id = p_project and level = p_level for update;
  if found then
    if not o.rejected and o.checked_at is not null then raise exception '该级成果已核对通过，不得修改'; end if;
    update outcome set link = l, venue = nullif(btrim(coalesce(p_venue, '')), ''), note = nullif(btrim(coalesce(p_note, '')), ''),
           submitted_by = app_uid(), submitted_at = now(), checked_by = null, checked_at = null, rejected = false, check_note = null where id = o.id;
    oid := o.id;
  else
    insert into outcome (project_id, level, link, venue, note, submitted_by)
    values (p_project, p_level, l, nullif(btrim(coalesce(p_venue, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), app_uid()) returning id into oid;
  end if;
  perform notify_user(u.id, format('成果待核对：研究单元「%s」提交了%s成果', p.name, (array['一级', '二级', '三级', '四级'])[p_level]))
  from app_user u where u.active and u.id <> app_uid() and user_perm(u.id, 'budget.evaluate');
  return oid;
end $$;

-- 核对成果：只核对是否属实，不评价好坏
create function check_outcome(p_id uuid, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o outcome; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('budget.evaluate');
  select * into o from outcome where id = p_id for update;
  if not found then raise exception '成果记录不存在'; end if;
  if o.checked_at is not null then raise exception '该成果已核对过'; end if;
  if not coalesce(p_ok, false) and n is null then raise exception '不属实或不符合的，请写明原因'; end if;
  update outcome set checked_by = app_uid(), checked_at = now(), rejected = not coalesce(p_ok, false), check_note = n where id = p_id;
  perform notify_user(o.submitted_by, case when p_ok then '成果已核对通过' else '成果被退回：' || n end);
end $$;

create function set_token_param(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v text;
begin
  perform need_perm('budget.approve');
  if p_key = 'nominal' then
    if jsonb_typeof(p_value) <> 'object' then raise exception '各身份的名义币格式有误'; end if;
    for k, v in select * from jsonb_each_text(p_value) loop
      if k not in ('postdoc', 'phd', 'master', 'ra', 'ri', 'visitor') then raise exception '身份有误'; end if;
      if v !~ '^\d+(\.\d+)?$' or v::numeric > 1000 then raise exception '名义币须为 0 到 1000 之间的数'; end if;
    end loop;
  else
    raise exception '该参数不可在此修改';
  end if;
  update token_param set value = p_value, updated_by = app_uid(), updated_at = now() where key = p_key;
end $$;

create function set_tier_token(p_tier uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (has_perm('budget.setup') or has_perm('budget.approve')) then raise exception '需要权限：编制年度预算方案' using errcode = '42501'; end if;
  if p_amount is not null and p_amount < 0 then raise exception '实际币不得为负'; end if;
  update budget_tier set token_amount = p_amount where id = p_tier;
  if not found then raise exception '档次不存在'; end if;
end $$;

select expose('save_time_log(date, jsonb)', 'confirm_time_logs(uuid, date)', 'set_pool_cap(uuid, numeric)', 'submit_outcome(uuid, int, text, text, text)',
              'check_outcome(uuid, boolean, text)', 'set_token_param(text, jsonb)', 'set_tier_token(uuid, numeric)');

-- ---------- 视图 ----------
create view api.token_param as select key, value from token_param where app_role() is not null;
create view api.tier_token as select id as tier_id, year, token_amount from budget_tier where app_role() is not null;

-- 本人：身份、本期名义币、期次
create view api.token_me as
  select u.id as user_id, u.kind, token_nominal(u.id) as nominal, token_period(app_today()) as period_start, token_period(app_today()) + 13 as period_end,
         (app_today() <= token_period(app_today()) + 2) as prev_open
  from app_user u where u.id = app_uid();

-- 登记明细：本人、同一研究单元的成员、课题和研究单元的负责人、助理和财务岗看得到
create view api.time_log as
  select t.id, t.period_start, t.user_id, u.name as user_name, u.kind as user_kind, t.project_id, t.percent, t.coins,
         t.confirmed_at is not null as confirmed, (select name from app_user where id = t.confirmed_by) as confirmed_by_name,
         (t.confirmed_at is null and app_today() > t.period_start + 14 + 7) as lapsed
  from time_log t join app_user u on u.id = t.user_id
  where app_role() is not null and (t.user_id = app_uid() or is_on_project(t.project_id) or can_manage_project(t.project_id) or has_perm('budget.setup') or has_perm('budget.evaluate'));

-- 研究单元的池子：只计已确认的时间；本期只有时间，资源部分待标价后计入
create view api.unit_pool as
  select p.id as project_id, p.parent_id, p.pool_cap,
         coalesce((select sum(t.coins) from time_log t where t.project_id = p.id and t.confirmed_at is not null), 0) as coins,
         (select count(distinct t.user_id)::int from time_log t where t.project_id = p.id and t.confirmed_at is not null) as people,
         (select count(*)::int from time_log t where t.project_id = p.id and t.confirmed_at is null and app_today() <= t.period_start + 14 + 7) as pending,
         coalesce((select max(o.level) from outcome o where o.project_id = p.id and o.checked_at is not null and not o.rejected), 0) as level
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;

-- 各人在池子里的份额：范围同登记明细
create view api.unit_share as
  select t.project_id, t.user_id, u.name as user_name, u.kind as user_kind, sum(t.coins) as coins,
         sum(t.coins) / nullif((select sum(x.coins) from time_log x where x.project_id = t.project_id and x.confirmed_at is not null), 0) as share
  from time_log t join app_user u on u.id = t.user_id
  where t.confirmed_at is not null and app_role() is not null
    and (t.user_id = app_uid() or is_on_project(t.project_id) or can_manage_project(t.project_id) or has_perm('budget.setup') or has_perm('budget.evaluate'))
  group by t.project_id, t.user_id, u.name, u.kind;

-- 成果：链接本来就是公开的，已立项课题下的所有登录的人都能看
create view api.outcome as
  select o.id, o.project_id, o.level, o.link, o.venue, o.note, (select name from app_user where id = o.submitted_by) as submitted_by_name, o.submitted_at,
         case when o.rejected then 'rejected' when o.checked_at is not null then 'checked' else 'pending' end as status,
         (select name from app_user where id = o.checked_by) as checked_by_name, o.checked_at, o.check_note,
         has_perm('budget.evaluate') as can_check
  from outcome o where app_role() is not null and can_see_project(o.project_id);

grant select on api.token_param, api.tier_token, api.token_me, api.time_log, api.unit_pool, api.unit_share, api.outcome to app_api;
