-- 0182 研究单元就是一个池子：个人投入的币按投入数记份额，成果铸造按份额分实际币。
--   回应质疑只是一项任务，发名义币，不再直接记份额（nominal_entry 仍用于属性和称号）。
--   投进来的币照样能换 API 额度和卡时，花掉和季末作废只减余额，不减份额；课题预算兑入的只能花，不记份额。
update coin_task_rule set label = '回应质疑（每条 16，队员平分）' where code = 'respond';

create or replace view api.unit_share as
  select e.project_id, e.user_id, u.name as user_name, u.kind as user_kind, sum(e.amount) as coins,
         sum(e.amount) / nullif((select sum(x.amount) from unit_coin x where x.project_id = e.project_id and x.kind = 'invest'), 0) as share
  from unit_coin e join app_user u on u.id = e.user_id
  where e.kind = 'invest' and app_role() is not null and (e.user_id = app_uid() or is_on_project(e.project_id) or can_manage_project(e.project_id) or has_perm('budget.setup') or has_perm('budget.evaluate'))
  group by e.project_id, e.user_id, u.name, u.kind;

create or replace view api.unit_pool as
  select p.id as project_id, p.parent_id, p.pool_cap,
    coalesce((select sum(e.amount) from unit_coin e where e.project_id = p.id and e.kind = 'invest'), 0) as coins,
    (select count(distinct e.user_id)::int from unit_coin e where e.project_id = p.id and e.kind = 'invest') as people,
    (select count(*)::int from query q where q.project_id = p.id and q.status = 'open' and q.parent_id is null) as pending,
    coalesce((select max(o.level) from outcome o where o.project_id = p.id and o.checked_at is not null and not o.rejected), 0) as level
  from project p
  where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;

CREATE OR REPLACE FUNCTION public.coin_mint_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare rate numeric := nullif((select value #>> '{}' from token_param where key = 'rate'), '')::numeric; lv jsonb := (select value from token_param where key = 'levels');
  o record; m record; k numeric; amt numeric; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if rate is null or rate <= 0 then return 0; end if;
  for o in select project_id, level from outcome where checked_at is not null and not rejected loop
    k := case o.level when 1 then coalesce((lv ->> 'r1')::numeric, 1) else coalesce((lv ->> ('l' || o.level))::numeric, 0) end;
    if k <= 0 then continue; end if;
    for m in select user_id, sum(amount) c from unit_coin where project_id = o.project_id and kind = 'invest' group by user_id loop
      amt := round(m.c * rate * k, 2);
      if amt <= 0 then continue; end if;
      insert into coin_ledger (user_id, kind, amount, remain, expires_on, project_id, level, note)
      values (m.user_id, 'mint', amt, amt, null, o.project_id, o.level,
              format('研究单元「%s」%s级成果，按份额铸造', (select name from project where id = o.project_id), o.level))
      on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
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
  perform notify_user(p.owner_id, format('代币投入：%s 向研究单元「%s」投入 %s 币，记入池子份额%s', (select name from app_user where id = app_uid()), p.name, p_amount, case when nt is null then '' else '。' || nt end));
end $function$;
