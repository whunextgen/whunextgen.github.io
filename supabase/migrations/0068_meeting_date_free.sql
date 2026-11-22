-- 评定结果的联席会议日期不再限制在今日及以前：会议定在哪一天就填哪一天。
-- 另：今日一律按北京时间算。数据库时钟是 UTC，北京时间零点到八点之间，系统里的今日比实际早一天。
create or replace function app_today() returns date language sql stable as
$$ select coalesce(nullif(current_setting('app.today', true), '')::date, (now() at time zone 'Asia/Shanghai')::date) $$;

do $$
declare r record; d text; n text;
begin
  for r in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname in ('decide_tier', 'reject_tier') loop
    d := pg_get_functiondef(r.oid);
    n := regexp_replace(d, '\s*if p_on > app_today\(\) then raise exception ''联席会议日期不得晚于今日''; end if;', '', 'g');
    if n = d then raise exception '没有找到要去掉的日期限制：%', r.oid::regprocedure; end if;
    execute n;
  end loop;
end $$;
