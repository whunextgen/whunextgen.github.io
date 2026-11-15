-- 课题全公开：所有登录的人都能看到每个已立项课题、研究单元的预算金额、执行情况、上限、调剂、成员、设备和接口额度。
--   待立项的课题仍只有申请人、财务岗、中心负责人和录入评定结果的人看得到。
--   逐笔的支出申请、预算行下达到哪些经费卡不随之公开：仍只有申请人、该课题的负责人、财务岗和中心负责人看得到。

-- 原来的可见范围另存为 can_manage_project，给支出申请的视图用
do $$
declare d text := pg_get_functiondef('public.can_see_project(uuid)'::regprocedure);
begin
  execute replace(d, 'FUNCTION public.can_see_project(', 'FUNCTION public.can_manage_project(');
end $$;
-- 预算行下达到哪些经费卡也不随之公开（经费卡属于财务一侧）
do $$
declare v text; d text; n text;
begin
  foreach v in array array['request', 'budget_alloc'] loop
    d := pg_get_viewdef(('api.' || v)::regclass);
    n := replace(d, 'can_see_project(', 'can_manage_project(');
    if n = d then raise exception '视图 % 里未找到课题可见范围的判断', v; end if;
    execute format('create or replace view api.%I as %s', v, n);
  end loop;
end $$;

-- 已立项的课题对所有登录的人可见
do $$
declare d text := pg_get_functiondef('public.can_manage_project(uuid)'::regprocedure); body text; n text;
begin
  create or replace function can_see_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as
  $f$ select can_manage_project(p_project) or (app_role() is not null and exists (select 1 from project where id = p_project and active and not proposed)) $f$;
end $$;
