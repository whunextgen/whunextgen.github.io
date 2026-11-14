-- 项目期限与经费卡年度不一致时不再拦截。
-- 实际中项目会延期，经费也可能在名义期限之外下达或使用；期限只作记录和提示，页面上对期限外的经费卡给出标记。
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.save_fund_project(uuid, text, text, text, uuid, numeric, date, date, uuid, text, text)'::regprocedure);
  d2 := replace(d, $f$  if exists (select 1 from fund_card where project_id = p_id
             and ((p_start is not null and year < extract(year from p_start)) or (p_end is not null and year > extract(year from p_end)))) then
    raise exception '已有经费卡的年度不在该期限内';
  end if;
$f$, '');
  if d2 = d then raise exception 'save_fund_project：未找到期限判断'; end if;
  execute d2;

  d := pg_get_functiondef('public.open_card(uuid, int, text, numeric, date, date, date, text)'::regprocedure);
  d2 := replace(d, $f$  if (p.period_start is not null and p_year < extract(year from p.period_start)) or (p.period_end is not null and p_year > extract(year from p.period_end)) then
    raise exception '% 年不在该项目的期限内', p_year;
  end if;
$f$, '');
  if d2 = d then raise exception 'open_card：未找到期限判断'; end if;
  execute d2;

  d := pg_get_functiondef('public.move_card(uuid, uuid)'::regprocedure);
  d2 := replace(d, $f$  if (t.period_start is not null and c.year < extract(year from t.period_start)) or (t.period_end is not null and c.year > extract(year from t.period_end)) then
    raise exception '该经费卡的年度 % 不在项目的期限内', c.year;
  end if;
$f$, '');
  if d2 = d then raise exception 'move_card：未找到期限判断'; end if;
  execute d2;
end $do$;
