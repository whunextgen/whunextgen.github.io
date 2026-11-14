-- 经费卡的当年下达数可以直接填写。
-- 此前下达数只能由各学校科目的明细加出来，明细没录全时下达数就偏小，也没有地方直接改。
-- 现在：下达数是卡上的一个数，按下达通知填；各科目的明细合计不得超过它，差额是尚未分到科目的部分。
-- 没有填下达数的卡，仍按明细合计算。

alter table fund_card add column granted numeric(14,2) check (granted is null or granted >= 0);   -- 当年下达数，不含上年结转

-- 一个项目历年下达数合计：填了下达数的卡取所填的数，没填的取明细合计减去上年结转
create or replace function fund_granted(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(coalesce(c.granted, (select coalesce(sum(b.amount), 0) from budget_line b where b.card_id = c.id) - c.carried_in)), 0)
  from fund_card c where c.project_id = p_project
$$;

-- 调高某个科目的明细时：不得超过这张卡的下达数（连同上年结转），项目历年下达合计不得超过额度
create or replace function trg_quota() returns trigger language plpgsql security definer set search_path = public as $$
declare p fund_project; c fund_card; g numeric; s numeric;
begin
  if tg_op = 'UPDATE' and new.amount <= old.amount then return null; end if;
  select * into c from fund_card where id = new.card_id;
  if c.granted is not null then
    select coalesce(sum(amount), 0) into s from budget_line where card_id = c.id;
    if s > c.granted + c.carried_in then
      raise exception '该经费卡各科目明细合计 % 超过当年下达数 %，请核对明细或先修改下达数', s, c.granted + c.carried_in;
    end if;
  end if;
  select * into p from fund_project where id = c.project_id;
  if p.quota is null then return null; end if;
  g := fund_granted(p.id);
  if g > p.quota then
    raise exception '项目「%」历年下达数合计 % 超过项目额度 %，请核对下达数或先调整项目额度', p.name, g, p.quota;
  end if;
  return null;
end $$;

-- 填写、修改或清空当年下达数。清空后按明细合计算
create function set_card_granted(p_card uuid, p_granted numeric) returns void
language plpgsql security definer set search_path = public as $$
declare c fund_card; p fund_project; s numeric; g numeric;
begin
  perform need_perm('card.manage');
  select * into c from fund_card where id = p_card for update;
  if not found then raise exception '经费卡不存在'; end if;
  if c.status <> 'active' then raise exception '经费卡已结清，不得修改下达数'; end if;
  if p_granted is not null and p_granted < 0 then raise exception '下达数不得为负数'; end if;
  select coalesce(sum(amount), 0) into s from budget_line where card_id = p_card;
  if p_granted is not null and s > p_granted + c.carried_in then
    raise exception '当年下达数 % 小于已录入各科目的明细合计 %，请先调减明细', p_granted, s - c.carried_in;
  end if;
  update fund_card set granted = p_granted, updated_at = now() where id = p_card;
  select * into p from fund_project where id = c.project_id;
  g := fund_granted(p.id);
  if p.quota is not null and g > p.quota then
    raise exception '项目「%」历年下达数合计 % 超过项目额度 %，请核对下达数或先调整项目额度', p.name, g, p.quota;
  end if;
end $$;

create or replace view api.card as
  select v.card_id, v.card_no, v.name, v.status, v.start_date, v.cutoff_date, v.settle_date, v.end_rule,
         v.orig, v.adj, v.cur, v.commit, v.actual, v.avail,
         c.template_id, t.name as template_name, t.locked, c.owner_id, c.rule_note,
         c.school_balance, c.school_frozen, c.school_available, c.school_synced_at, c.fund_kind, c.received, c.priority,
         c.total_amount, c.period_start, c.period_end,
         c.project_id, c.year, c.applied, c.carried_in, c.recalled, c.carried_out, c.granted
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

select expose('set_card_granted(uuid, numeric)');
