-- 晨星只是一个标签，不是一套额度。
--   课题、研究单元上加「晨星」标签；按负责人按年度记额度、把支出挂到额度上的做法取消。
--   额度表和支出上的挂接字段保留不动（线上没有数据），只收回入口：对外的视图、函数和权限点。
alter table project add column morningstar boolean not null default false;

-- 标签单独一个视图：能看到课题或研究单元的人，才看得到它的标签
create view api.project_tag as
  select p.id, p.morningstar from project p where exists (select 1 from api.project v where v.id = p.id);
grant select on api.project_tag to app_api;

create function set_project_morningstar(p_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_perm('budget.setup');
  update project set morningstar = coalesce(p_on, false) where id = p_id;
  if not found then raise exception '课题或研究单元不存在'; end if;
end $$;
select expose('set_project_morningstar(uuid, boolean)');
insert into rbac_fn (fn, sig, perm) values ('set_project_morningstar', '*', 'budget.setup') on conflict do nothing;

-- 取消晨星额度的入口
drop view if exists api.quota;
drop view if exists api.quota_pick;
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname in ('save_quota', 'quota_to_project', 'set_request_quota', 'submit_request_quota') loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;
delete from rbac_fn where fn in ('save_quota', 'quota_to_project', 'set_request_quota', 'submit_request_quota');
delete from rbac_role_perm where perm in ('quota.set', 'quota.manage');
delete from rbac_conflict where a in ('quota.set', 'quota.manage') or b in ('quota.set', 'quota.manage');
delete from rbac_perm where code in ('quota.set', 'quota.manage');
