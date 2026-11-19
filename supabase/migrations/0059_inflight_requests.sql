-- 在途支出：已经发生、学校尚未入账的钱，在中台里要有一笔带状态的支出申请。
-- 一、财务岗可以把已发生的支出补登为在途（已批准待提交学校，或已提交学校），计入经费卡的在途金额。
--     只用于补登；此后的支出仍须先提交支出申请。
-- 二、导入学校明细账时，先按金额对应同一张卡上在途的支出申请，对上的转为已入账，
--     不再另记一笔。原来的做法是每一行都新记一笔已入账，在途的申请永远留在在途，同一笔钱算两次。

alter table voucher add column ledger_title text;   -- 对应上的明细账摘要；重复导入时按它去重

create function register_inflight(p_card uuid, p_title text, p_amount numeric, p_spent_on date, p_state text,
  p_subject uuid default null, p_user uuid default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c fund_card; t text := btrim(coalesce(p_title, '')); n text := nullif(btrim(coalesce(p_note, '')), '');
  sid uuid; tid uuid; rid uuid; who uuid := coalesce(p_user, app_uid());
begin
  if not (has_perm('request.process') or has_perm('ledger.post')) then raise exception '当前角色无权补登在途支出' using errcode = '42501'; end if;
  c := lock_card(p_card);
  if t = '' then raise exception '请填写事项'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额须大于 0'; end if;
  if p_state is null or p_state not in ('committed', 'at_school') then raise exception '当前状态只能是已批准待提交学校或已提交学校'; end if;
  if p_spent_on is null or p_spent_on > app_today() then raise exception '发生日期不得为空，且不得晚于当日'; end if;
  if not exists (select 1 from app_user where id = who and active) then raise exception '申请人不存在或已停用'; end if;
  if p_subject is not null then
    if not exists (select 1 from template_subject where id = p_subject and template_id = c.template_id and (card_id is null or card_id = p_card)) then
      raise exception '该经费卡无此科目';
    end if;
    sid := p_subject;
  else
    sid := ledger_subject(c.template_id, null, null);   -- 科目待学校入账后按明细账确定
  end if;
  insert into budget_line (card_id, subject_id, amount) values (p_card, sid, 0) on conflict (card_id, subject_id) do nothing;
  select id into tid from expense_type where name = '在途补登';
  if tid is null then insert into expense_type (name) values ('在途补登') returning id into tid; end if;
  insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by)
  values (p_card, sid, tid, t, round(p_amount, 2), app_today(), p_state, who, app_uid()) returning id into rid;
  perform log_event(rid, 'backfill', '补登在途支出，发生于 ' || p_spent_on || coalesce('。' || n, ''));
  if p_state = 'at_school' then perform log_event(rid, 'to_school', '补登时已提交学校'); end if;
  return rid;
end $$;
revoke all on function register_inflight(uuid, text, numeric, date, text, uuid, uuid, text) from public;
grant execute on function register_inflight(uuid, text, numeric, date, text, uuid, uuid, text) to app_api;

do $$
declare d text := pg_get_functiondef('public.import_ledger(uuid, jsonb, jsonb, numeric, numeric, boolean)'::regprocedure); n text; m text;
begin
  n := replace(d, 'inc int := 0;', 'inc int := 0; mid uuid; matched int := 0;');
  if n = d then raise exception '未找到导入明细账的变量声明'; end if;
  m := replace(n, $o$v.posted_on::text || '|' || r.title as k$o$, $o$v.posted_on::text || '|' || coalesce(v.ledger_title, r.title) as k$o$);
  if m = n then raise exception '未找到导入明细账的去重位置'; end if;
  n := replace(m, 'insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by, school_code, school_name)',
    $new$-- 同一张卡上金额相同的在途申请：转为已入账，不另记一笔。先对已提交学校的，再对已批准待提交的，各按提交先后
    select r.id into mid from expense_request r
     where r.card_id = p_card and r.status in ('at_school', 'committed') and r.amount = a
     order by (r.status = 'at_school') desc, r.created_at, r.id limit 1;
    if mid is not null then
      update expense_request set status = 'posted', subject_id = case when budget_line_id is null then sid else subject_id end,
             school_code = sc, school_name = coalesce(sn, '（未注明学校科目）'), updated_at = now() where id = mid;
      insert into voucher (request_id, voucher_no, posted_on, amount, ledger_title) values (mid, vn, d, a, ti);
      perform log_event(mid, 'post', '导入明细账：学校已入账 ' || a || '，明细账摘要「' || ti || '」');
      matched := matched + 1; total := total + a;
      continue;
    end if;
    insert into expense_request (card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by, approved_by, school_code, school_name)$new$);
  if n = m then raise exception '未找到导入明细账的写入位置'; end if;
  m := replace(n, $o$jsonb_build_object('added', added,$o$, $o$jsonb_build_object('matched', matched, 'added', added,$o$);
  if m = n then raise exception '未找到导入明细账的返回位置'; end if;
  execute m;
end $$;
