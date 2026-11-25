-- 登记时段过后才成立的研究单元，从下一期起登记：成立那天已经不能登记当期的双周表，不该算它未登记。
-- 登记日办理的规矩下，核对只在登记日当天，本来不会出现这种情况；切换那一晚（2026-11-25 零点后、规矩上线前）成立了一个。
create function register_window(p_day date) returns boolean language sql immutable as $$
  select p_day = token_period(p_day) or (token_period(p_day) = date '2026-11-23' and p_day <= date '2026-11-24')
$$;
create or replace function biweekly_open(p_period date) returns boolean language sql stable security definer set search_path = public as $$
  select p_period = token_period(app_today()) and register_window(app_today())
$$;
create or replace function biweekly_from(p_project uuid) returns date language sql stable security definer set search_path = public as $$
  select greatest(date '2026-11-23', token_period(d) + case when register_window(d) then 0 else 14 end)
  from (select (coalesce(checked_at, created_at) at time zone 'Asia/Shanghai')::date as d from project where id = p_project) x
$$;
