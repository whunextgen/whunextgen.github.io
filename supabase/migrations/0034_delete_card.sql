-- 开错的经费卡、建错的项目可以删除：只限还没有任何预算、支出和记录的。
create function delete_card(p_card uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c fund_card; o fund_project;
begin
  perform need_perm('card.manage');
  select * into c from fund_card where id = p_card for update;
  if not found then raise exception '经费卡不存在'; end if;
  if c.status <> 'active' then raise exception '经费卡已结清，不得删除'; end if;
  if c.carried_in > 0 or exists (select 1 from budget_line where card_id = p_card and amount > 0) then
    raise exception '该经费卡已录入预算，不得删除；确属开错的，请先将各科目预算改为零';
  end if;
  if exists (select 1 from expense_request where card_id = p_card) or exists (select 1 from budget_allocation where card_id = p_card)
     or exists (select 1 from staff_assignment where card_id = p_card) or exists (select 1 from payroll_sheet where card_id = p_card)
     or exists (select 1 from budget_change where card_id = p_card) or exists (select 1 from fund_event where card_id = p_card)
     or exists (select 1 from reimb_ruling where card_id = p_card) or exists (select 1 from card_settlement where card_id = p_card)
     or exists (select 1 from task where card_id = p_card) then
    raise exception '该经费卡已有支出、下达、人员经费、到款或答复等记录，不得删除';
  end if;
  if exists (select 1 from rbac_grant where card_id = p_card and revoked_at is null) then
    raise exception '该经费卡上尚有未收回的授权，请先收回';
  end if;
  delete from rbac_grant where card_id = p_card;
  delete from card_node where card_id = p_card;
  delete from budget_line where card_id = p_card;
  select * into o from fund_project where id = c.project_id for update;
  delete from fund_card where id = p_card;
  if o.auto and not exists (select 1 from fund_card where project_id = o.id) then
    delete from fund_project where id = o.id;
  end if;
end $$;

create function delete_fund_project(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('card.manage');
  if not exists (select 1 from fund_project where id = p_id) then raise exception '项目不存在'; end if;
  if exists (select 1 from fund_card where project_id = p_id) then raise exception '该项目下已有经费卡，不得删除；请先删除或移出经费卡'; end if;
  delete from fund_project where id = p_id;
end $$;

select expose('delete_card(uuid)', 'delete_fund_project(uuid)');
