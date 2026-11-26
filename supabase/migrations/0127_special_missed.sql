-- 0126 补漏：双周表登记情况的「漏登期数」也要认特批。特批了本期、还在当天登记的，不算漏登
do $$
declare d text := pg_get_viewdef('api.biweekly_status'::regclass); n text;
begin
  n := replace(d, '(NOT biweekly_open(s.cur))', '(NOT (biweekly_open(s.cur) OR special_biweekly_ok(p.id, s.cur)))');
  if n = d and position('special_biweekly_ok(p.id, s.cur))) AND' in d) = 0 and position('(NOT (biweekly_open(s.cur) OR special_biweekly_ok' in d) = 0 then
    raise exception 'biweekly_status 的漏登判断没有改上';
  end if;
  if n <> d then execute 'create or replace view api.biweekly_status as ' || n; end if;
end $$;
