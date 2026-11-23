-- 研究单元确认成立：三个工作日的否决期是留给中心负责人否决用的。
-- 中心负责人本人确认，即表示不否决，不必再等否决期届满；其他核对人仍须等届满。所挂课题负责人同意这一条不变。
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.confirm_unit(uuid)'::regprocedure);
  n := replace(d, 'if app_today() <= until then raise exception', 'if app_role() is distinct from ''director'' and app_today() <= until then raise exception');
  if n = d then raise exception 'confirm_unit：没有找到否决期判断'; end if;
  execute n;
end $$;
