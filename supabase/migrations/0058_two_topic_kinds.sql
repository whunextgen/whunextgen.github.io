-- 课题只有两种类型：课题、中心公共开支。原来的第三种并入课题。
update project set kind = 'project' where kind = 'line';
alter table project drop constraint project_kind_check;
alter table project add constraint project_kind_check check (kind in ('project', 'public'));

do $$
declare d text := pg_get_functiondef('public.save_project(uuid, text, text, text, uuid, boolean, uuid)'::regprocedure); n text;
begin
  n := regexp_replace(d, $re$if k is null or k not in \('project','line','public'\) then raise exception '[^']*';$re$,
    $new$if k is null or k not in ('project','public') then raise exception '类型仅限课题或中心公共开支';$new$);
  if n = d then raise exception '未找到课题类型的检查位置'; end if;
  execute n;
end $$;
