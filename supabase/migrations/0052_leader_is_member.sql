-- 取消「负责人」和「成员」两种基础角色的区别：负责人就是通过了立项的成员，身份来自所负责的课题或研究单元，不再是一种基础角色。
--   原来两者只差一项「查看本人负责的经费卡」，并入成员；现有的负责人账号一律改为成员。
--   任何成员都可以申请立项。旧的 leader 角色保留一行以兼容历史记录，不再授予。
insert into rbac_role_perm (role_id, perm) select r.id, 'card.own' from rbac_role r where r.code = 'member' on conflict do nothing;
update app_user set role = 'member', updated_at = now() where role = 'leader';
update rbac_role set name = '负责人（已并入成员）', note = '不再授予：负责人即通过立项的成员，身份来自所负责的课题或研究单元' where code = 'leader';

do $$
declare d text := pg_get_functiondef('public.propose_project(integer, text, uuid, text, text)'::regprocedure); n text;
begin
  n := replace(d, $a$  if app_role() not in ('leader', 'finance', 'director') and not exists (select 1 from project where owner_id = app_uid() and active) then
    raise exception '仅课题、研究单元负责人可申请立项' using errcode = '42501';
  end if;
$a$, '');
  if n = d then raise exception '未找到立项申请的角色检查'; end if;
  execute n;
end $$;
