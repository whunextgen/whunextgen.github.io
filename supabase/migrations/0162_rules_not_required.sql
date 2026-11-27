-- 支出不再要求先有「能否列支」的答复（#173，王菲：每张经费卡由财务单独设置报销科目和金额，每笔支出由财务手动入账，
--   不需要在「采购与报销要求」里重复列举经费卡的支出类型和可列支范围）
--   原来：经费卡 × 支出类型没有答复的，一律不能提交、不能挪卡。现在：没有答复即可提交，由财务岗核对、分配经费卡时把关；
--   明确答复「不能列支」的仍然拦截；改挂经费卡时，目标卡学校退过单（有争议）的也不能改挂。
CREATE OR REPLACE FUNCTION public.submit_request(p_card uuid, p_subject uuid, p_type uuid, p_title text, p_amount numeric, p_eta date, p_emergency boolean DEFAULT false, p_path text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare c fund_card; v text; note text; t expense_type; a numeric; lim emergency_limit; used numeric; rid uuid;
begin
  perform need_role('finance','director','leader','member');
  if coalesce(current_setting('app.via_line', true), '') <> '1' and not can_see_card(p_card) then
    raise exception '拦截：支出须从研究单元预算行提交，不得直接选择经费卡';
  end if;
  c := lock_card(p_card);
  if app_today() < c.start_date then raise exception '拦截：% 尚未下达', c.card_no; end if;
  if p_eta > c.cutoff_date then raise exception '拦截：预计入账 % 晚于该经费卡单据截止 %', p_eta, c.cutoff_date; end if;
  if not exists (select 1 from template_subject where id = p_subject and template_id = c.template_id) then
    raise exception '拦截：该经费卡无此科目';
  end if;
  select * into t from expense_type where id = p_type;
  select r.verdict, r.note into v, note from v_reimb_rule r where r.card_id = p_card and r.expense_type_id = p_type;
  if v = 'no' then raise exception '拦截：% 不能列支「%」。%', c.card_no, t.name, coalesce(note, ''); end if;
  a := avail(p_card, p_subject);
  if p_amount > a then raise exception '拦截：可用 %，不足 %。请先办理预算变更或改用其他经费卡', a, p_amount; end if;
  if t.required_path is not null and p_path is distinct from t.required_path then
    raise exception '拦截：「%」须通过%办理', t.name, t.required_path;
  end if;
  if p_path = '直采' and p_amount > 50000 then raise exception '拦截：直采单件上限 5 万，请改用分散采购'; end if;
  if p_emergency then
    select * into lim from emergency_limit where year = extract(year from app_today());
    if not found then raise exception '拦截：本年度未设置紧急通道额度'; end if;
    if p_amount > lim.per_request then raise exception '拦截：紧急通道单笔上限 %', lim.per_request; end if;
    select coalesce(sum(amount), 0) into used from expense_request
      where emergency and status not in ('rejected','released')
        and extract(year from created_at) = lim.year;
    if used + p_amount > lim.per_year then raise exception '拦截：紧急通道全年额度已用尽'; end if;
  end if;
  insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, emergency, status, requested_by)
  values (p_card, p_subject, p_type, p_title, p_amount, p_eta, p_emergency,
          case when p_emergency then 'committed' else 'pending' end, app_uid())
  returning id into rid;
  if p_path is not null then
    insert into procurement (request_id, path, stages)
    values (rid, p_path, case p_path when '分散采购' then 6 else 4 end);
  end if;
  perform log_event(rid, 'submit', case when v = 'disputed' then '口径有争议，有退单风险' end);
  return rid;
end $$;

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

CREATE OR REPLACE FUNCTION public.move_request(p_req uuid, p_card uuid, p_subject uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare r expense_request; c fund_card; v text; a numeric; old_no text;
begin
  perform need_role('finance');
  select * into r from expense_request where id = p_req for update;
  if r.status <> 'returned' then raise exception '仅已退回的单据可变更经费卡'; end if;
  select card_no into old_no from fund_card where id = r.card_id;
  c := lock_card(p_card);
  if not exists (select 1 from template_subject where id = p_subject and template_id = c.template_id) then
    raise exception '目标经费卡无此科目';
  end if;
  select verdict into v from v_reimb_rule where card_id = p_card and expense_type_id = r.expense_type_id;
  if v in ('no','disputed') then raise exception '目标经费卡的报销答复记录不允许此类支出（不能列支或学校退过单）'; end if;
  if r.eta_date > c.cutoff_date then raise exception '预计入账晚于目标经费卡单据截止'; end if;
  a := avail(p_card, p_subject);
  if r.amount > a then raise exception '目标经费卡可用 %，不足 %', a, r.amount; end if;
  update expense_request set card_id = p_card, subject_id = p_subject, status = 'committed', updated_at = now() where id = p_req;
  perform log_event(p_req, 'move', old_no || ' → ' || c.card_no);
end $$;
