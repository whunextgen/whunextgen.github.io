-- 研究单元申请的会议日期和纪要日期不再限制在今日及以前。是否已经联席会议通过，由助理对照纪要核对。
do $$
declare d text := pg_get_functiondef('public.propose_unit(uuid, uuid, text, date, date, text, text)'::regprocedure); n text;
begin
  n := regexp_replace(d, '\s*if p_meeting_on > app_today\(\) or p_minutes_on > app_today\(\) then raise exception ''[^'']*''; end if;', '');
  if n = d then raise exception '没有找到要去掉的日期限制'; end if;
  execute n;
end $$;
