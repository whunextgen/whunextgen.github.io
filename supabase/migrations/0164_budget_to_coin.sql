-- 课题预算兑换实际币（黄济民 2026-11-28 定的执行细则：API 和 GPU 归代币治理；预算按季度限额兑换实际币，兑满即止）
--   一、季度公布：每季度开始时财务岗公布本季度全中心可兑换总额（等于下季度 API 充值能经学校报销的金额）和兑换比例
--       （1 元预算兑多少实际币、1 实际币兑多少元 API 额度、1 卡时多少实际币）；公布后有人兑换了，比例就不能再改。
--   二、兑换：课题负责人把「算力与模型接口」科目的预算兑换成实际币，记入本课题下某个研究单元的账上（unit_coin，kind = budget），
--       只能单向；兑换额计入这一预算行的已用（v_line_use 并入兑换记录）；全中心本季度兑满即止。
--   三、「算力与模型接口」科目不再走支出申请；财务岗充值 API 用中心的经费卡直接办，不挂课题预算行。
--   实际币换 API key 的系统由况紫嫣另做；本迁移只做预算到实际币这一段，GPU 卡时标价同步写入 token_param.price。

alter table budget_category add column coin boolean not null default false;
update budget_category set coin = true where name = '算力与模型接口';

alter table unit_coin drop constraint unit_coin_kind_check;
alter table unit_coin add constraint unit_coin_kind_check check (kind in ('invest','compute','budget'));

create table coin_quarter (
  q_start      date primary key check (q_start = date_trunc('quarter', q_start)::date),
  total        numeric(14,2) not null check (total >= 0),       -- 本季度全中心可兑换的预算总额（元）
  rate         numeric(12,4) not null check (rate > 0),         -- 1 元预算兑多少实际币
  api_rate     numeric(12,4) not null check (api_rate > 0),     -- 1 实际币兑多少元 API 额度
  gpu_price    numeric(12,4) not null check (gpu_price > 0),    -- 1 卡时多少实际币
  note         text check (note is null or length(note) <= 300),
  published_by uuid references app_user,
  published_at timestamptz not null default now()
);
create table budget_coin_exchange (
  id         uuid primary key default gen_random_uuid(),
  q_start    date not null references coin_quarter,
  line_id    uuid not null references project_budget_line,
  topic_id   uuid not null references project,
  unit_id    uuid not null references project,
  amount     numeric(14,2) not null check (amount > 0),         -- 兑掉的预算（元）
  coins      numeric(14,2) not null check (coins > 0),
  rate       numeric(12,4) not null,
  by_user    uuid not null references app_user,
  at         timestamptz not null default now()
);
create index on budget_coin_exchange (line_id);
create index on budget_coin_exchange (q_start);
select seal('coin_quarter', 'budget_coin_exchange');
create trigger audit after insert or update or delete on coin_quarter for each row execute function trg_audit();
create trigger audit after insert or update or delete on budget_coin_exchange for each row execute function trg_audit();

-- 兑换计入预算行的已用：并入 v_line_use（没有经费卡，按已入账计，入账日为兑换日）
create or replace view v_line_use as
SELECT r.budget_line_id AS line_id,
    r.card_id,
    r.subject_id,
        CASE
            WHEN (r.status = 'posted'::text) THEN COALESCE(v.amount, r.amount)
            ELSE r.amount
        END AS amt,
    (r.status = 'posted'::text) AS posted,
    (r.status = 'pending'::text) AS pending,
    v.posted_on
   FROM (expense_request r
     LEFT JOIN voucher v ON ((v.request_id = r.id)))
  WHERE ((r.budget_line_id IS NOT NULL) AND (r.status = ANY (ARRAY['pending'::text, 'committed'::text, 'at_school'::text, 'returned'::text, 'posted'::text])))
UNION ALL
 SELECT x.line_id, NULL::uuid AS card_id, NULL::uuid AS subject_id, x.amount AS amt, true AS posted, false AS pending, (x.at AT TIME ZONE 'Asia/Shanghai')::date AS posted_on
   FROM budget_coin_exchange x;

create or replace function publish_coin_quarter(p_total numeric, p_rate numeric, p_api_rate numeric, p_gpu_price numeric, p_note text default null) returns date
language plpgsql security definer set search_path = public as $$
declare q date := date_trunc('quarter', app_today())::date; old coin_quarter; n text := nullif(btrim(coalesce(p_note, '')), ''); used numeric;
begin
  perform need_perm('budget.issue');
  if p_total is null or p_total < 0 then raise exception '可兑换总额不能为负'; end if;
  if coalesce(p_rate, 0) <= 0 or coalesce(p_api_rate, 0) <= 0 or coalesce(p_gpu_price, 0) <= 0 then raise exception '三个兑换比例都须大于 0'; end if;
  if length(n) > 300 then raise exception '说明不超过 300 个字'; end if;
  select * into old from coin_quarter where q_start = q for update;
  if found then
    select coalesce(sum(amount), 0) into used from budget_coin_exchange where q_start = q;
    if used > 0 and (p_rate <> old.rate or p_api_rate <> old.api_rate or p_gpu_price <> old.gpu_price) then
      raise exception '本季度已有兑换，兑换比例不能再改；比例下季度重新公布';
    end if;
    if p_total < used then raise exception '本季度已兑换 %，总额不能低于该数', used; end if;
    update coin_quarter set total = p_total, rate = p_rate, api_rate = p_api_rate, gpu_price = p_gpu_price, note = coalesce(n, note), published_by = app_uid(), published_at = now() where q_start = q;
  else
    insert into coin_quarter (q_start, total, rate, api_rate, gpu_price, note, published_by) values (q, p_total, p_rate, p_api_rate, p_gpu_price, n, app_uid());
  end if;
  -- 卡时标价跟着季度公布走（研究单元换卡时 buy_compute 读 token_param.price）
  insert into token_param (key, value) values ('price', to_jsonb(p_gpu_price)) on conflict (key) do update set value = excluded.value;
  return q;
end $$;

create or replace function exchange_budget(p_line uuid, p_unit uuid, p_amount numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare q coin_quarter; pl project_budget_line; topic uuid; u project; used_q numeric; room numeric; c numeric;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = date_trunc('quarter', app_today())::date for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，请等财务岗公布'; end if;
  select l.* into pl from project_budget_line l where l.id = p_line for update;
  if not found then raise exception '预算行不存在'; end if;
  if not exists (select 1 from budget_category bc where bc.id = pl.category_id and bc.coin) then raise exception '只有「算力与模型接口」科目的预算可以兑换实际币'; end if;
  select b.project_id into topic from project_budget b where b.id = pl.budget_id;
  if not (can_manage_project(topic) or has_perm('budget.issue')) then raise exception '由课题负责人办理' using errcode = '42501'; end if;
  if not line_live(p_line) or coalesce(pl.fixed, 0) <= 0 then raise exception '这一行预算尚未下达，不能兑换'; end if;
  select * into u from project where id = p_unit;
  if not found or u.layer <> 'paper' or not u.active or u.proposed or (u.parent_id is distinct from topic and u.id <> topic) then
    raise exception '实际币记入本课题下已成立的研究单元';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception '兑换的预算须大于 0'; end if;
  select coalesce(sum(amt), 0) into room from v_line_use where line_id = p_line;
  room := coalesce(pl.fixed, 0) - room;
  if p_amount > room then raise exception '这一行核定 %，已用和已兑换 %，最多还能兑 %', pl.fixed, pl.fixed - room, greatest(room, 0); end if;
  select coalesce(sum(amount), 0) into used_q from budget_coin_exchange where q_start = q.q_start;
  if used_q + p_amount > q.total then
    raise exception '本季度全中心可兑换 %，已兑 %，剩余 %，不够兑 %（兑满即止）', q.total, used_q, greatest(q.total - used_q, 0), p_amount;
  end if;
  c := round(p_amount * q.rate, 2);
  insert into budget_coin_exchange (q_start, line_id, topic_id, unit_id, amount, coins, rate, by_user) values (q.q_start, p_line, topic, p_unit, p_amount, c, q.rate, app_uid());
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_unit, 'budget', c, app_uid(), format('课题预算兑换：%s 元 × %s', p_amount, q.rate));
  if u.owner_id is not null and u.owner_id <> app_uid() then
    perform notify_user(u.owner_id, format('研究单元「%s」收到课题预算兑换的 %s 实际币，可用来换 API 额度或 GPU 卡时', u.name, c));
  end if;
  return c;
end $$;

insert into rbac_fn (fn, sig, perm) values ('publish_coin_quarter', '*', 'budget.issue') on conflict do nothing;

-- 本季度公布的数和剩余，所有登录的人可见（况紫嫣的兑换 API key 系统读 api_rate）
create view api.coin_quarter as
  select q.q_start, q.total, q.rate, q.api_rate, q.gpu_price, q.note, q.published_at, (select name from app_user where id = q.published_by) as published_by_name,
         coalesce((select sum(x.amount) from budget_coin_exchange x where x.q_start = q.q_start), 0) as exchanged,
         q.q_start = date_trunc('quarter', app_today())::date as current
  from coin_quarter q where app_role() is not null;
create view api.budget_coin_exchange as
  select x.id, x.q_start, x.line_id, l.purpose as line_purpose, x.topic_id, t.code as topic_code, t.name as topic_name, x.unit_id, un.code as unit_code, un.name as unit_name,
         x.amount, x.coins, x.rate, (select name from app_user where id = x.by_user) as by_name, x.at
  from budget_coin_exchange x join project_budget_line l on l.id = x.line_id join project t on t.id = x.topic_id join project un on un.id = x.unit_id
  where app_role() is not null and (has_perm('read.finance') or can_see_project(x.topic_id) or can_see_project(x.unit_id));
create or replace view api.budget_category as
  select id, code, name, labor, sort, active, coin from budget_category where app_role() is not null and (active or has_perm('budget.setup'));
grant select on api.coin_quarter, api.budget_coin_exchange to app_api;

CREATE OR REPLACE FUNCTION public.submit_project_request(p_line uuid, p_type uuid, p_title text, p_amount numeric, p_eta date, p_emergency boolean DEFAULT false, p_path text DEFAULT NULL::text, p_unit uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare wm text := ''; tgt uuid; l v_line; y budget_year; c record; v text; why text := ''; rid uuid; pick record; qid uuid; tn text;
  pj project; ov numeric := 0; st text; me uuid := app_uid(); mine boolean; others boolean; r expense_request; ln text;
begin
  perform need_role('finance','director','leader','member');
  if exists (select 1 from project_budget_line bpl join budget_category bc on bc.id = bpl.category_id where bpl.id = p_line and bc.coin) then
    raise exception '拦截：「算力与模型接口」科目用于兑换实际币，不走支出申请。请由课题负责人在课题页把这一科目的预算兑换成实际币，记入研究单元的账上，再换 API 额度或 GPU 卡时';
  end if;
  if coalesce((select finance_only from expense_type where id = p_type), false) and not (has_perm('ledger.post') or has_perm('card.manage')) then
    raise exception '拦截：「%」由财务岗统一办理，课题不提交这类支出。使用接口额度请到「资源申领」申请，计入课题预算、不动经费卡', (select name from expense_type where id = p_type);
  end if;
  select * into l from v_line where id = p_line;
  if not found then raise exception '预算行不存在'; end if;
  select * into y from budget_year where year = l.year;
  if y.stage = 'closed' then raise exception '拦截：% 年度已决算，不得再支出', l.year; end if;
  if not line_live(l.id) then
    if y.stage <> 'issued' then raise exception '拦截：% 年度预算尚未下达到这个课题，财务岗审核下达后方可支出', l.year; end if;
    raise exception '拦截：该预算属 % 年度，仅可在当年支出', l.year;
  end if;
  select * into pj from project where id = l.project_id;
  if not pj.active then raise exception '拦截：研究单元已停用'; end if;
  tgt := request_owner(pj.id, p_unit);
  if p_amount is null or p_amount <= 0 then raise exception '金额须大于 0'; end if;
  if l.used + p_amount > coalesce(l.fixed, 0) then
    if pj.kind = 'public' then
      raise exception '拦截：该预算行核定 %，已用 %，剩余 %，不足 %。如需追加请在季度复盘时提出', l.fixed, l.used, l.fixed - l.used, p_amount;
    end if;
    if p_emergency then raise exception '拦截：超出预算的支出不得使用紧急通道'; end if;
    ov := l.used + p_amount - coalesce(l.fixed, 0);
  end if;
  select name into tn from expense_type where id = p_type;
  for c in select a.card_id, a.subject_id, a.amount - a.used as rest, k.card_no, k.start_date, k.cutoff_date, k.status
           from v_alloc a join fund_card k on k.id = a.card_id
           where a.line_id = p_line
           order by case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no loop
    select x.verdict into v from v_reimb_rule x where x.card_id = c.card_id and x.expense_type_id = p_type;
    if c.status <> 'active' then why := why || c.card_no || ' 已结清；'; wm := wm || '经费卡已结清；';
    elsif ov = 0 and c.rest < p_amount then why := why || c.card_no || ' 下达的预算仅剩 ' || c.rest || '；'; wm := wm || '下达到经费卡的预算仅剩 ' || c.rest || ' 元；';
    elsif app_today() < c.start_date then why := why || c.card_no || ' ' || c.start_date || ' 方下达；'; wm := wm || '经费卡 ' || c.start_date || ' 才生效；';
    elsif p_eta > c.cutoff_date then why := why || c.card_no || ' 单据 ' || c.cutoff_date || ' 截止；'; wm := wm || '预计入账日晚于经费卡的单据截止日 ' || c.cutoff_date || '；';
    elsif v = 'no' then why := why || c.card_no || ' 不能列支「' || coalesce(tn, '') || '」；'; wm := wm || '下达的经费卡不能列支「' || coalesce(tn, '') || '」；';
    elsif coalesce(avail(c.card_id, c.subject_id), 0) < p_amount then why := why || c.card_no || ' 该科目可用额度不足；'; wm := wm || '经费卡该科目可用额度不足；';
    else pick := c; exit;
    end if;
  end loop;
  if pick is null then
    if why = '' then raise exception '拦截：该预算行尚未下达至经费卡，请联系财务岗'; end if;
    -- 经费卡的细节只说给看得到卡的人
    if not has_perm('read.finance') then raise exception '拦截：这笔支出暂时不能列支。%请联系财务岗', wm; end if;
    raise exception '拦截：该预算行下达的经费卡均无法列支该笔支出。%', why;
  end if;
  perform set_config('app.via_line', '1', true);
  rid := submit_request(pick.card_id, pick.subject_id, p_type, p_title, p_amount, p_eta, p_emergency, p_path);
  perform set_config('app.via_line', '', true);
  update expense_request set project_id = tgt, budget_line_id = p_line where id = rid;
  select id into qid from morningstar_quota where project_id = l.project_id and year = l.year;
  if qid is not null then perform attach_quota(rid, qid); end if;
  select * into r from expense_request where id = rid;
  if pj.kind = 'public' then
    perform notify_role('director', '待审批：' || req_msg(r));
  elsif r.status = 'pending' then
    mine := has_perm('request.confirm', tgt);
    others := exists (select 1 from app_user u where u.active and u.id <> me and user_perm(u.id, 'request.confirm', tgt));
    ln := case when ov > 0 then format('超出预算行「%s」%s 元', l.purpose, to_char(ov, 'FM999,999,999,990.00')) end;
    if others then st := 'confirm';
    elsif ov > 0 or not mine then st := 'director';
    else st := 'check';
    end if;
    update expense_request set step = st, over_amount = ov,
           self_confirmed = (mine and not others), confirmed_by = case when mine and not others then me end,
           confirmed_at = case when mine and not others then now() end
    where id = rid returning * into r;
    if st = 'confirm' then
      perform notify_user(u.id, '待确认：' || req_msg(r) || coalesce('。' || ln, ''))
      from app_user u where u.active and u.id <> me and user_perm(u.id, 'request.confirm', tgt);
    elsif st = 'director' then
      perform notify_role('director', case when ov > 0 then '超出预算，待审批：' else '待审批：' end || req_msg(r) || coalesce('。' || ln, ''));
    else
      perform notify_role('finance', '待核对：' || req_msg(r));
    end if;
  end if;
  return rid;
end $$;
