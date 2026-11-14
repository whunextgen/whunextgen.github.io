-- 横向经费到账前不得支出：学校不允许钱没到账就先报销。
-- 经费性质为横向的经费卡，待批、已承诺、已入账的支出连同人员经费，合计不得超过已到账金额；未填已到账的按零计。
-- 其他性质（纵向、财政）的经费卡不受此限，已到账仅作记录。
create function card_spent(p_card uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from expense_request where card_id = p_card and status not in ('released', 'rejected')), 0)
       + coalesce((select sum(amount) from v_flow where card_id = p_card and src = 'staff'), 0)
$$;

create function trg_received() returns trigger language plpgsql security definer set search_path = public as $$
declare c fund_card; used numeric; got numeric;
begin
  if new.card_id is null or new.status in ('released', 'rejected') then return null; end if;
  if tg_op = 'UPDATE' and new.card_id is not distinct from old.card_id and new.amount <= old.amount
     and old.status not in ('released', 'rejected') then return null; end if;
  select * into c from fund_card where id = new.card_id;
  if c.fund_kind is distinct from 'horizontal' then return null; end if;
  got := coalesce(c.received, 0);
  used := card_spent(c.id);
  if used > got then
    raise exception '拦截：横向经费到账前不得支出。该经费卡已到账 %，含本笔在内的申请、承诺和已入账合计 %，超出 %', got, used, used - got;
  end if;
  return null;
end $$;
create trigger received after insert or update of amount, card_id, status on expense_request for each row execute function trg_received();
revoke all on function trg_received() from public;
revoke all on function card_spent(uuid) from public;
