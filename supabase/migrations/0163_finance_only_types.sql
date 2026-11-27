-- 重新充值这类财务操作不对课题开放（黄济民 2026-11-28「重新充值这种财务操作不应该对课题开放？」）
--   中心的 API 账户只有一个，充值由财务岗从经费卡付款、到账后入库为额度；课题只申领额度，计入课题预算。
--   支出类型加「仅财务岗办理」标记，API 类型打上；成员、课题负责人从预算行提交这类支出时拦截，指向资源申领。
alter table expense_type add column finance_only boolean not null default false;
update expense_type set finance_only = true where name ~* '^api|api\s*充值|接口额度';

create or replace function set_type_finance_only(p_id uuid, p_on boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('rule.manage');
  update expense_type set finance_only = coalesce(p_on, false) where id = p_id;
  if not found then raise exception '支出类型不存在'; end if;
end $$;
insert into rbac_fn (fn, sig, perm) values ('set_type_finance_only', '*', 'rule.manage') on conflict do nothing;

create or replace view api.expense_type as
  select id, name, required_path, finance_only from expense_type where app_role() is not null;

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
