-- 经费卡明细列到每一笔，已入账的支出可以修改、冲销（#174，王菲：「每一项执行科目下还需要有每一笔支出明细…每一条明细需要有修改、删除的通道」）
--   按财务原则（黄济民 2026-11-28 定）：错账冲销并留痕，不真删除。
--   冲销：已入账的一笔作废，不再计入已入账和可用额；须写原因，记录保留，在支出的经办记录里可查。
--   修改：已入账的一笔改摘要或金额（录错的）；须写原因，原值和新值记入经办记录。金额以学校凭证为准，有凭证的同时改凭证金额。

create or replace function void_posted(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r expense_request; n text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not (has_perm('ledger.post') or has_perm('card.manage')) then raise exception '当前角色无权冲销' using errcode = '42501'; end if;
  select * into r from expense_request where id = p_id for update;
  if not found then raise exception '支出不存在'; end if;
  if r.status <> 'posted' then raise exception '只有已入账的支出可以冲销；未入账的请退回或撤回'; end if;
  if n is null then raise exception '请写明冲销原因，比如「与学校明细账某笔重复」'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  if r.card_id is not null then perform lock_card(r.card_id); end if;
  update expense_request set status = 'released', updated_at = now() where id = p_id;
  perform log_event(p_id, 'release', format('冲销：%s（原入账 %s）', n, coalesce((select amount from voucher where request_id = p_id), r.amount)));
end $$;

create or replace function edit_posted(p_id uuid, p_title text, p_amount numeric, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare r expense_request; n text := nullif(btrim(coalesce(p_reason, '')), ''); t text := nullif(btrim(coalesce(p_title, '')), ''); va numeric; changes text[] := '{}';
begin
  if not (has_perm('ledger.post') or has_perm('card.manage')) then raise exception '当前角色无权修改已入账的支出' using errcode = '42501'; end if;
  select * into r from expense_request where id = p_id for update;
  if not found then raise exception '支出不存在'; end if;
  if r.status <> 'posted' then raise exception '只有已入账的支出在这里修改；未入账的请在支出申请里处理'; end if;
  if n is null then raise exception '请写明修改原因'; end if;
  if length(n) > 300 then raise exception '原因不超过 300 个字'; end if;
  if t is null then raise exception '请填写摘要'; end if;
  if length(t) > 200 then raise exception '摘要不超过 200 个字'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额须大于 0'; end if;
  if r.card_id is not null then perform lock_card(r.card_id); end if;
  select amount into va from voucher where request_id = p_id;
  if t is distinct from r.title then changes := changes || format('摘要「%s」改为「%s」', r.title, t); end if;
  if p_amount <> coalesce(va, r.amount) then changes := changes || format('金额 %s 改为 %s', coalesce(va, r.amount), p_amount); end if;
  if cardinality(changes) = 0 then raise exception '没有改动'; end if;
  update expense_request set title = t, amount = p_amount, updated_at = now() where id = p_id;
  update voucher set amount = p_amount where request_id = p_id;
  perform log_event(p_id, 'edit', format('修改：%s。原因：%s', array_to_string(changes, '；'), n));
end $$;

insert into rbac_fn (fn, sig, perm) values ('void_posted', '*', 'ledger.post'), ('edit_posted', '*', 'ledger.post') on conflict do nothing;

create or replace view api.request as
SELECT r.id,
    r.code,
        CASE
            WHEN can_see_card(r.card_id) THEN r.card_id
            ELSE NULL::uuid
        END AS card_id,
    r.subject_id,
    r.expense_type_id,
    r.title,
    r.amount,
    r.eta_date,
    r.emergency,
    r.status,
    r.requested_by,
    r.approved_by,
    r.created_at,
    r.updated_at,
    p.path,
    p.stage,
    p.stages,
    v.posted_on,
    v.amount AS posted_amount,
    v.voucher_no,
    r.morningstar_quota_id,
    r.split_group,
    r.project_id,
    r.budget_line_id,
    r.step,
    r.over_amount,
    r.self_confirmed,
    r.return_note,
    j.name AS project_name,
    bl.purpose AS line_purpose,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = r.requested_by)) AS requester_name,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = r.confirmed_by)) AS confirmed_by_name,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = r.checked_by)) AS checked_by_name,
    ((r.status = 'pending'::text) AND (r.step = 'confirm'::text) AND (r.requested_by IS DISTINCT FROM app_uid()) AND has_perm('request.confirm'::text, r.project_id)) AS can_confirm,
    r.school_name,
    r.school_code
   FROM ((((expense_request r
     LEFT JOIN procurement p ON ((p.request_id = r.id)))
     LEFT JOIN voucher v ON ((v.request_id = r.id)))
     LEFT JOIN project j ON ((j.id = r.project_id)))
     LEFT JOIN project_budget_line bl ON ((bl.id = r.budget_line_id)))
  WHERE ((r.requested_by = app_uid()) OR can_see_card(r.card_id) OR (EXISTS ( SELECT 1
           FROM morningstar_quota q
          WHERE ((q.id = r.morningstar_quota_id) AND (q.leader_id = app_uid())))) OR ((r.project_id IS NOT NULL) AND (can_manage_project(r.project_id) OR has_perm('request.confirm'::text, r.project_id))));
