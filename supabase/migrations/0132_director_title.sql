-- 称呼统一为「中心负责人」（issue #67）
--   联席会议、加入与考核等函数产生的通知、议题正文、否决说明里写的是「中心主任」，其他页面写「中心负责人」。
--   把函数和视图定义里的「中心主任」统一换成「中心负责人」。已经存下的议题正文、说明不改。
do $$
declare f record; v record; d text; n int := 0;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosrc like '%中心主任%' loop
    d := pg_get_functiondef(f.oid);
    execute replace(d, '中心主任', '中心负责人');
    n := n + 1;
  end loop;
  for v in select c.oid, n2.nspname, c.relname from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
           where c.relkind = 'v' and n2.nspname in ('public','api') and pg_get_viewdef(c.oid) like '%中心主任%' loop
    execute format('create or replace view %I.%I as %s', v.nspname, v.relname, replace(pg_get_viewdef(v.oid), '中心主任', '中心负责人'));
    n := n + 1;
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%中心主任%') then raise exception '还有函数没有改上'; end if;
  raise notice '改了 % 个函数和视图', n;
end $$;
