-- 个人投给研究单元的实际币保留原有效期（黄济民 2026-11-28「投给研究单元的币也会过期，个人投的」）
--   原来：个人的实际币 4 周过期，投给研究单元后就不过期了，可以在研究单元账上越攒越多。
--   现在：研究单元账也按笔记有效期和剩余（remain、expires_on）。个人投入时，按扣掉的那几笔个人币各自的到期日记入；
--   课题预算兑入的不设有效期。研究单元花币（换卡时、换 API）先用先到期的；到期的作废（kind = expire），计入代币系统的「过期」。
alter table unit_coin add column remain numeric, add column expires_on date;
alter table unit_coin drop constraint unit_coin_kind_check;
alter table unit_coin add constraint unit_coin_kind_check check (kind in ('invest','compute','budget','api','expire'));

-- 已有的账：收入记剩余，再按时间顺序扣掉已花的
update unit_coin set remain = amount where amount > 0;
do $$
declare pr record; need numeric; r record; take numeric;
begin
  for pr in select project_id, -sum(amount) as neg from unit_coin where amount < 0 group by project_id loop
    need := pr.neg;
    for r in select id, remain from unit_coin where project_id = pr.project_id and remain > 0 order by created_at loop
      take := least(r.remain, need);
      update unit_coin set remain = remain - take where id = r.id;
      need := need - take;
      exit when need <= 0;
    end loop;
  end loop;
end $$;

-- 记账：收入的剩余等于数额；花币（换卡时、换 API）先扣先到期的，不够的拦下
create or replace function trg_unit_coin_take() returns trigger language plpgsql security definer set search_path = public as $$
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
  if need > 0 then raise exception '研究单元的实际币不足（有一部分已过期）'; end if;
  return new;
end $$;
create trigger take before insert on unit_coin for each row execute function trg_unit_coin_take();

create or replace function unit_coin_balance(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(remain), 0) from unit_coin where project_id = p_project and remain > 0 and (expires_on is null or expires_on >= app_today())
$$;

-- 投给研究单元：先扣个人先到期的，研究单元按扣掉的每一笔的到期日记入
create or replace function invest_coins(p_project uuid, p_amount numeric, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare p project; left_n numeric; r record; take numeric; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '实际币只能投给已成立的研究单元'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '投入的数目须大于 0'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  if coin_balance(app_uid()) < p_amount then raise exception '实际币不足：余额 %', coin_balance(app_uid()); end if;
  left_n := p_amount;
  for r in select id, remain, expires_on from coin_ledger where user_id = app_uid() and remain > 0 and (expires_on is null or expires_on >= app_today())
           order by expires_on nulls last, created_at for update loop
    take := least(r.remain, left_n);
    update coin_ledger set remain = remain - take where id = r.id;
    insert into unit_coin (project_id, kind, amount, user_id, note, remain, expires_on) values (p_project, 'invest', take, app_uid(), nt, take, r.expires_on);
    left_n := left_n - take;
    exit when left_n <= 0;
  end loop;
  insert into coin_ledger (user_id, kind, amount, project_id, note) values (app_uid(), 'invest', -p_amount, p_project, coalesce(nt, format('投给研究单元「%s」', p.name)));
  perform notify_user(p.owner_id, format('实际币投入：%s 向研究单元「%s」投入 %s 实际币%s', (select name from app_user where id = app_uid()), p.name, p_amount, case when nt is null then '' else '。' || nt end));
end $$;

-- 研究单元账上到期的作废：定时任务调用
create or replace function unit_coin_expire_tick() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for r in select * from unit_coin where remain > 0 and expires_on < app_today() for update loop
    insert into unit_coin (project_id, kind, amount, user_id, note) values (r.project_id, 'expire', -r.remain, r.user_id, format('%s 到期作废', to_char(r.expires_on, 'YYYY-MM-DD')));
    update unit_coin set remain = 0 where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function coin_tick() returns integer language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return coin_expire_tick() + unit_coin_expire_tick() + coin_salary_tick() + coin_mint_tick();
end $$;

-- 研究单元的流水带上有效期和剩余
create or replace view api.unit_coin as
 SELECT c.id, c.project_id, p.code AS project_code, p.name AS project_name, c.kind, c.amount, c.user_id,
    ( SELECT app_user.name FROM app_user WHERE (app_user.id = c.user_id)) AS user_name,
    c.note, c.created_at, unit_coin_balance(c.project_id) AS balance, c.expires_on, c.remain
   FROM (unit_coin c JOIN project p ON ((p.id = c.project_id)))
  WHERE (app_role() IS NOT NULL);

-- 代币系统的「过期」计入研究单元账上到期作废的
create or replace view api.coin_flow as
WITH b AS (
         SELECT (date_trunc('quarter'::text, LEAST(COALESCE(( SELECT min((coin_ledger.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AS min
                   FROM coin_ledger), (app_today())::timestamp without time zone), COALESCE(( SELECT min((unit_coin.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AS min
                   FROM unit_coin), (app_today())::timestamp without time zone))))::date AS s
        ), qs AS (
         SELECT (g.g)::date AS q,
            ((g.g + '3 mons'::interval))::date AS e
           FROM b,
            LATERAL generate_series((b.s)::timestamp with time zone, ((date_trunc('quarter'::text, (app_today())::timestamp with time zone))::date)::timestamp with time zone, '3 mons'::interval) g(g)
        ), cl AS (
         SELECT coin_ledger.kind,
            coin_ledger.amount,
            ((coin_ledger.created_at AT TIME ZONE 'Asia/Shanghai'::text))::date AS d
           FROM coin_ledger
        ), uc AS (
         SELECT unit_coin.kind,
            unit_coin.amount,
            ((unit_coin.created_at AT TIME ZONE 'Asia/Shanghai'::text))::date AS d
           FROM unit_coin
        )
 SELECT q AS q_start,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'salary'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_salary,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'mint'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_mint,
    COALESCE(( SELECT sum(uc.amount) AS sum
           FROM uc
          WHERE ((uc.kind = 'budget'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS issued_budget,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'adjust'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS adjusted,
    COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'compute'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS spent_compute,
    (COALESCE(( SELECT (- sum(cl.amount))
           FROM cl
          WHERE ((cl.kind = 'expire'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric)
     + COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'expire'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric)) AS expired,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE (cl.d < qs.e)), (0)::numeric) AS out_person,
    COALESCE(( SELECT sum(uc.amount) AS sum
           FROM uc
          WHERE (uc.d < qs.e)), (0)::numeric) AS out_unit,
    COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'api'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS spent_api
   FROM qs
  WHERE (has_perm('read.finance'::text) OR has_perm('budget.approve'::text));
