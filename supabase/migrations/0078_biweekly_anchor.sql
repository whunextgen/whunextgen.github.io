-- 双周表的期次改为自 2026-11-23（周一）起算，第一期为 11-23 至 12-06；名义币的期次（token_period，自 2026-11-16 起）不变。
create function biweekly_period(p_day date) returns date language sql immutable as $$
  select date '2026-11-23' + (floor((p_day - date '2026-11-23') / 14.0)::int * 14)
$$;

-- 已按原期次（11-16 起）登记的，并入第一期
alter table biweekly_report drop constraint biweekly_report_period_start_check;
update biweekly_report set period_start = date '2026-11-23' where period_start < date '2026-11-23';
alter table biweekly_report add constraint biweekly_report_period_start_check check (period_start = biweekly_period(period_start));

-- 按现行定义改写：找不到要改的那一句就中止
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.biweekly_from(uuid)'::regprocedure);
  n := replace(replace(d, '''2026-11-16''', '''2026-11-23'''), 'token_period(', 'biweekly_period(');
  if n = d or position('token_period(' in n) > 0 or position('2026-11-23' in n) = 0 then raise exception 'biweekly_from：改写不完整'; end if;
  execute n;

  d := pg_get_functiondef('public.save_biweekly_report(uuid, date, text, text, text, text, text, text, text)'::regprocedure);
  n := replace(d, 'token_period(', 'biweekly_period(');
  n := replace(n, 'if p_period is null or p_period <> biweekly_period(p_period) then raise exception ''登记的期次有误''; end if;',
    'if p_period is null or p_period <> biweekly_period(p_period) then raise exception ''登记的期次有误''; end if;
  if p_period < date ''2026-11-23'' then raise exception ''双周表自 2026 年 11 月 23 日起算，第一期为 11 月 23 日至 12 月 6 日''; end if;');
  if position('token_period(' in n) > 0 or position('第一期为 11 月 23 日' in n) = 0 then raise exception 'save_biweekly_report：改写不完整'; end if;
  execute n;

  d := pg_get_viewdef('api.biweekly_status'::regclass);
  n := replace(d, 'token_period(', 'biweekly_period(');
  if n = d then raise exception '未找到双周表登记情况视图里的期次'; end if;
  execute 'create or replace view api.biweekly_status as ' || n;
end $$;

comment on function biweekly_period(date) is '双周表的期次：自 2026-11-23 起两周一期';
