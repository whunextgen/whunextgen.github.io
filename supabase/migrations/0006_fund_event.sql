-- 学校侧进度：逐笔登记下达、到账、认领、预借票、核销、冻结、回收；写了待办的记录在办结前算待办。
create function add_fund_event(p_card uuid, p_kind text, p_date date, p_amount numeric, p_todo text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare eid uuid; t text := nullif(btrim(coalesce(p_todo, '')), '');
begin
  perform need_role('finance');
  if not exists (select 1 from fund_card where id = p_card) then raise exception '经费卡不存在'; end if;
  if p_kind is null or p_kind not in ('下达','到账','认领','预借票','核销','冻结','回收') then
    raise exception '类型只能是下达、到账、认领、预借票、核销、冻结或回收';
  end if;
  if p_date is null then raise exception '请填写日期'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '金额必须大于 0'; end if;
  if length(t) > 200 then raise exception '待办说明不能超过 200 个字'; end if;
  insert into fund_event (card_id, kind, event_date, amount, todo, done)
  values (p_card, p_kind, p_date, p_amount, t, t is null) returning id into eid;
  return eid;
end $$;

create or replace function finish_fund_event(p_event uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance');
  update fund_event set done = true where id = p_event and not done;
  if not found then raise exception '这条记录不存在或已经办结'; end if;
end $$;

create trigger audit after insert or update or delete on fund_event for each row execute function trg_audit();

revoke all on function add_fund_event(uuid, text, date, numeric, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function add_fund_event(uuid, text, date, numeric, text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function add_fund_event(uuid, text, date, numeric, text) to app_api;
