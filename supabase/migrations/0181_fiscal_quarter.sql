-- 0181 中心季度按年度预算的年度编号：11–1 月是下一年度第 1 季度（2026-11 至 2027-01 为 2027 年第 1 季度），课题预算兑换只能用这一年度的预算；代币函数里的提示改成名义币
create or replace function coin_fy(d date) returns int language sql immutable as $$ select extract(year from (center_quarter(d) + interval '2 months'))::int $$;
create or replace function coin_fq(d date) returns int language sql immutable as $$ select (((extract(month from center_quarter(d))::int + 1) % 12) / 3) + 1 $$;

CREATE OR REPLACE FUNCTION public.buy_api_quota(p_project uuid, p_coins numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q coin_quarter; p project; r resource; fx numeric; amt numeric; used_q numeric; cap numeric; room numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = center_quarter(app_today()) for update;
  if not found then raise exception '本季度的兑换比例尚未公布，请等财务岗公布'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception 'API 额度由研究单元换'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  select * into r from resource where unit_key and kind = 'api' and active;
  if not found then raise exception '财务岗尚未指定研究单元的 key 开在哪个接口资源上，请等财务岗在「资产盘点 › 研究单元 API key」登记'; end if;
  if p_coins is null or p_coins <= 0 or p_coins <> round(p_coins, 2) then raise exception '换出的名义币须大于 0，最多两位小数'; end if;
  if unit_coin_balance(p_project) < p_coins then raise exception '研究单元的名义币不足：需要 %，账上 %', p_coins, unit_coin_balance(p_project); end if;
  fx := unit_key_fx(r);
  amt := round(p_coins * q.api_rate / fx, 2);
  if amt <= 0 then raise exception '换得的额度不足 0.01 %', r.unit; end if;
  select coalesce(sum(quota), 0) into used_q from api_grant where q_start = q.q_start;
  -- 本季度可换的 API 额度就是公布的总额对应的额度：财务岗本季度按总额直接充值（谢倩倩老师兜底），库存只做登记和对账（0175）
  cap := round(q.total / fx, 2);
  room := cap - used_q;
  if amt > room then
    raise exception '本季度全中心可换 API 额度 % %（总额 % 元折算），已换 %，剩余 %，最多还能用 % 名义币换；这次要换 %（换满即止）',
      cap, r.unit, q.total, used_q, greatest(room, 0), greatest(floor(room * fx / q.api_rate * 100) / 100, 0), amt;
  end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'api', -p_coins, app_uid(), format('换 %s %s API 额度', amt, r.unit));
  insert into api_grant (project_id, quota, coins, rate, q_start, bought_by, resource_id, fx_rate)
  values (p_project, amt, p_coins, q.api_rate, q.q_start, app_uid(), r.id, case when r.unit not in ('元', 'CNY', '人民币') then r.fx_rate end) returning api_grant.id into v_id;
  perform notify_role('finance', format('研究单元「%s」用名义币换了 %s %s API 额度（%s），请计入这个研究单元的 API key%s', p.name, amt, r.unit, r.name,
    case when exists (select 1 from secret where owner_kind = 'unit' and owner_id = p_project) then ''
         else '。这个研究单元还没有 key，请在「资产盘点 › 研究单元 API key」加密保存' end));
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.buy_compute(p_project uuid, p_hours numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare price numeric := nullif((select value #>> '{}' from token_param where key = 'price'), '')::numeric; p project; need numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if price is null or price <= 0 then raise exception '卡时的标价尚未公布'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '卡时由研究单元换'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  if p_hours is null or p_hours <= 0 or p_hours <> round(p_hours) then raise exception '卡时须为正整数'; end if;
  need := p_hours * price;
  if unit_coin_balance(p_project) < need then raise exception '研究单元的名义币不足：需要 %，账上 %', need, unit_coin_balance(p_project); end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'compute', -need, app_uid(), format('换 %s 卡时', p_hours));
  insert into compute_grant (project_id, hours, coins, bought_by) values (p_project, p_hours, need, app_uid()) returning compute_grant.id into v_id;
  return v_id;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_unit_coin_take()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare need numeric; r record; take numeric;
begin
  if new.amount > 0 then
    new.remain := coalesce(new.remain, new.amount);
    return new;
  end if;
  if new.kind = 'expire' then return new; end if;
  need := -new.amount;
  for r in select id, remain from unit_coin where project_id = new.project_id and remain > 0 and (expires_on is null or expires_on >= app_today())
           order by expires_on nulls last, created_at for update loop
    take := least(r.remain, need);
    update unit_coin set remain = remain - take where id = r.id;
    need := need - take;
    exit when need <= 0;
  end loop;
  if need > 0 then raise exception '研究单元的名义币不足（有一部分已过期）'; end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.set_secret(p_kind text, p_id uuid, p_cipher text, p_hint text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare un project; fresh boolean;
begin
  perform need_role('finance','director');
  if p_kind = 'resource' then
    if not exists (select 1 from resource where id = p_id) then raise exception '资源不存在'; end if;
  elsif p_kind = 'allocation' then
    if not exists (select 1 from resource_allocation where id = p_id and returned_on is null) then raise exception '分配记录不存在或已经收回'; end if;
  elsif p_kind = 'unit' then
    select * into un from project where id = p_id;
    if not found or un.layer <> 'paper' or not un.active or un.proposed then raise exception '研究单元不存在或未成立'; end if;
  else raise exception '无效对象';
  end if;
  if p_cipher is null or p_cipher = '' then
    delete from secret where owner_kind = p_kind and owner_id = p_id;
    return;
  end if;
  if p_cipher !~ '^v1\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$' then raise exception '密钥未经加密，拒绝保存'; end if;
  if length(p_hint) > 40 then raise exception '掩码过长'; end if;
  fresh := not exists (select 1 from secret where owner_kind = p_kind and owner_id = p_id);
  insert into secret (owner_kind, owner_id, cipher, hint, set_by) values (p_kind, p_id, p_cipher, p_hint, app_uid())
  on conflict (owner_kind, owner_id) do update set cipher = excluded.cipher, hint = excluded.hint, set_by = excluded.set_by, set_at = now();
  if p_kind = 'unit' then
    delete from unit_key_due where project_id = p_id;
    perform notify_user(x.u, format('研究单元「%s」的 API key %s，名单内成员在研究单元页「池子与成果 › 名义币」取用，每次取用均有记录', un.name, case when fresh then '已发放' else '已更换，旧 key 作废' end))
    from (select un.owner_id as u where un.owner_id is not null
          union select m.user_id from project_member m where m.project_id = p_id and m.left_on is null) x;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.submit_project_request(p_line uuid, p_type uuid, p_title text, p_amount numeric, p_eta date, p_emergency boolean DEFAULT false, p_path text DEFAULT NULL::text, p_unit uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare wm text := ''; tgt uuid; l v_line; y budget_year; c record; v text; why text := ''; rid uuid; pick record; qid uuid; tn text;
  pj project; ov numeric := 0; st text; me uuid := app_uid(); mine boolean; others boolean; r expense_request; ln text;
begin
  perform need_role('finance','director','leader','member');
  if exists (select 1 from project_budget_line bpl join budget_category bc on bc.id = bpl.category_id where bpl.id = p_line and bc.coin) then
    raise exception '拦截：「算力与模型接口」科目用于兑换名义币，不走支出申请。请由课题负责人在课题页把这一科目的预算兑换成名义币，记入研究单元的账上，再换 API 额度或 GPU 卡时';
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
end $function$;

CREATE OR REPLACE FUNCTION public.invest_coins(p_project uuid, p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p project; left_n numeric; r record; take numeric; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '代币只能投给已成立的研究单元'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '投入的数目须大于 0'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  if coin_balance(app_uid()) < p_amount then raise exception '代币不足：余额 %', coin_balance(app_uid()); end if;
  left_n := p_amount;
  for r in select id, remain, expires_on from coin_ledger where user_id = app_uid() and remain > 0 and (expires_on is null or expires_on >= app_today())
           order by expires_on nulls last, created_at for update loop
    take := least(r.remain, left_n);
    update coin_ledger set remain = remain - take where id = r.id;
    -- 投入研究单元的一律成为名义币：名义币沿用原到期日，实际币（不过期）投入时到当季最后一天作废
    insert into unit_coin (project_id, kind, amount, user_id, note, remain, expires_on) values (p_project, 'invest', take, app_uid(), nt, take, coalesce(r.expires_on, coin_quarter_end(app_today())));
    left_n := left_n - take;
    exit when left_n <= 0;
  end loop;
  insert into coin_ledger (user_id, kind, amount, project_id, note) values (app_uid(), 'invest', -p_amount, p_project, coalesce(nt, format('投给研究单元「%s」', p.name)));
  perform notify_user(p.owner_id, format('代币投入：%s 向研究单元「%s」投入 %s 币%s', (select name from app_user where id = app_uid()), p.name, p_amount, case when nt is null then '' else '。' || nt end));
end $function$;

CREATE OR REPLACE FUNCTION public.exchange_budget(p_line uuid, p_unit uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q coin_quarter; pl project_budget_line; topic uuid; u project; used_q numeric; room numeric; c numeric;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = center_quarter(app_today()) for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，请等财务岗公布'; end if;
  select l.* into pl from project_budget_line l where l.id = p_line for update;
  if not found then raise exception '预算行不存在'; end if;
  if (select b.year from project_budget b where b.id = pl.budget_id) <> coin_fy(q.q_start) then
    raise exception '本季度是 % 年度第 % 季度，只能兑换 % 年度的预算', coin_fy(q.q_start), coin_fq(q.q_start), coin_fy(q.q_start);
  end if;
  if not exists (select 1 from budget_category bc where bc.id = pl.category_id and bc.coin) then raise exception '只有「算力与模型接口」科目的预算可以兑换名义币'; end if;
  select b.project_id into topic from project_budget b where b.id = pl.budget_id;
  if not (can_manage_project(topic) or has_perm('budget.issue')) then raise exception '由课题负责人办理' using errcode = '42501'; end if;
  if not line_live(p_line) or coalesce(pl.fixed, 0) <= 0 then raise exception '这一行预算尚未下达，不能兑换'; end if;
  select * into u from project where id = p_unit;
  if not found or u.layer <> 'paper' or not u.active or u.proposed or (u.parent_id is distinct from topic and u.id <> topic) then
    raise exception '名义币记入本课题下已成立的研究单元';
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
  insert into unit_coin (project_id, kind, amount, user_id, expires_on, note) values (p_unit, 'budget', c, app_uid(), coin_quarter_end(app_today()), format('课题预算兑换：%s 元 × %s', p_amount, q.rate));
  if u.owner_id is not null and u.owner_id <> app_uid() then
    perform notify_user(u.owner_id, format('研究单元「%s」收到课题预算兑换的 %s 名义币（季末作废），可用来换 API 额度或 GPU 卡时', u.name, c));
  end if;
  return c;
end $function$;

