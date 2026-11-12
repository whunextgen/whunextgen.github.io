-- 项目分两层
-- 大项目下面挂论文项目，论文项目必须挂在一个大项目下面，不能再往下套。都由财务岗建。
-- 大项目负责人看得到下面各论文项目的预算和执行。
-- 这一步只加层级，不改预算怎么编、支出怎么批。

alter table project
  add column layer     text not null default 'big' check (layer in ('big','paper')),
  add column parent_id uuid references project,
  add constraint project_layer_parent check ((layer = 'paper') = (parent_id is not null));
create index on project (parent_id);

create function trg_project_parent() returns trigger language plpgsql as $$
declare par project;
begin
  if new.parent_id is not null then
    select * into par from project where id = new.parent_id;
    if par.layer <> 'big' then raise exception '论文项目只能挂在大项目下面'; end if;
    if par.kind = 'public' then raise exception '中心公共开支下面不挂论文项目'; end if;
    if new.active and not par.active then raise exception '所属大项目已停用，论文项目不能在用'; end if;
  end if;
  if new.layer = 'paper' and exists (select 1 from project where parent_id = new.id) then
    raise exception '这个项目下面还有论文项目，不能改成论文项目';
  end if;
  if not new.active and exists (select 1 from project where parent_id = new.id and active) then
    raise exception '下面还有在用的论文项目，先停用它们';
  end if;
  return new;
end $$;
create trigger project_parent before insert or update of layer, parent_id, active on project for each row execute function trg_project_parent();

-- 建项目多一个参数：挂在哪个大项目下面。填了就是论文项目，类型跟大项目走；编号不填就按「大项目编号-两位序号」自动编。
drop function save_project(uuid, text, text, text, uuid, boolean);
create function save_project(p_id uuid, p_code text, p_name text, p_kind text, p_owner uuid, p_active boolean default true, p_parent uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare c text := btrim(coalesce(p_code, '')); n text := btrim(coalesce(p_name, '')); pid uuid; par project; k text := p_kind; i int;
begin
  perform need_role('finance','director');
  if n = '' then raise exception '请填写项目名称'; end if;
  if length(n) > 60 then raise exception '项目名称不能超过 60 个字'; end if;
  if p_parent is not null then
    if p_parent = p_id then raise exception '不能挂在自己下面'; end if;
    select * into par from project where id = p_parent;
    if not found then raise exception '所属大项目不存在'; end if;
    k := par.kind;
    if p_owner is null then raise exception '论文项目要指定负责人'; end if;
    if c = '' then
      perform pg_advisory_xact_lock(hashtext('project_code:' || par.code));
      select coalesce(max(substring(code from '-(\d+)$')::int), 0) + 1 into i from project where parent_id = p_parent and code ~ ('^' || regexp_replace(par.code, '([^A-Za-z0-9])', '\\\1', 'g') || '-\d+$');
      loop
        c := par.code || '-' || lpad(i::text, 2, '0');
        exit when not exists (select 1 from project where code = c);
        i := i + 1;
      end loop;
    end if;
  end if;
  if c = '' then raise exception '请填写项目编号'; end if;
  if k is null or k not in ('project','line','public') then raise exception '类型只能是研究项目、独立研究线或中心公共开支'; end if;
  if p_owner is not null and not exists (select 1 from app_user where id = p_owner and active) then raise exception '负责人不存在或已停用'; end if;
  if exists (select 1 from project where code = c and id is distinct from p_id) then raise exception '已经有编号为「%」的项目', c; end if;
  if p_id is null then
    insert into project (code, name, kind, owner_id, active, layer, parent_id)
    values (c, n, k, p_owner, coalesce(p_active, true), case when p_parent is null then 'big' else 'paper' end, p_parent) returning id into pid;
  else
    update project set code = c, name = n, kind = k, owner_id = p_owner, active = coalesce(p_active, true),
           layer = case when p_parent is null then 'big' else 'paper' end, parent_id = p_parent where id = p_id returning id into pid;
    if pid is null then raise exception '项目不存在'; end if;
    -- 大项目改了类型，下面的论文项目跟着改
    update project set kind = k where parent_id = pid and kind <> k;
  end if;
  return pid;
end $$;

-- 大项目负责人看得到下面各论文项目的预算和执行
create or replace function can_see_project(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select can_edit_project(p_project)
      or (has_perm('read.budget', p_project) and exists (select 1 from project where id = p_project and active))
      or (has_perm('read.budget') and has_perm('read.finance'))
      or exists (select 1 from project c join project b on b.id = c.parent_id
                 where c.id = p_project and c.active and b.active and has_perm('budget.project', b.id))
$$;

create or replace view api.project as
  select p.id, p.code, p.name, p.kind, p.owner_id, u.name as owner_name, p.active,
         can_edit_project(p.id) as mine, p.labor_cap_ratio,
         p.layer, p.parent_id, pp.code as parent_code, pp.name as parent_name, pp.owner_id as parent_owner_id,
         can_see_project(p.id) as seen
  from project p left join app_user u on u.id = p.owner_id left join project pp on pp.id = p.parent_id
  where app_role() is not null and (p.active or has_perm('budget.setup'));

select expose('save_project(uuid, text, text, text, uuid, boolean, uuid)');
revoke all on function trg_project_parent() from public;
