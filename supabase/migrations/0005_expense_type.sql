-- 支出类型维护。财务岗和中心负责人可以新增、改名、改必须走的采购路径；不提供删除，已被答复或申请引用的类型要留着。
create function save_expense_type(p_id uuid, p_name text, p_required_path text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := nullif(trim(p_name), ''); rid uuid;
begin
  perform need_role('finance','director');
  if n is null then raise exception '类型名称不能为空'; end if;
  if char_length(n) > 60 then raise exception '类型名称不超过 60 个字'; end if;
  if p_required_path is not null and p_required_path not in ('直采','集采','分散采购') then
    raise exception '采购路径只能是直采、集采或分散采购';
  end if;
  if exists (select 1 from expense_type where name = n and id is distinct from p_id) then
    raise exception '已经有叫「%」的支出类型', n;
  end if;
  if p_id is null then
    insert into expense_type (name, required_path) values (n, p_required_path) returning id into rid;
  else
    update expense_type set name = n, required_path = p_required_path where id = p_id returning id into rid;
    if rid is null then raise exception '支出类型不存在'; end if;
  end if;
  return rid;
end $$;

create trigger audit after insert or update or delete on expense_type for each row execute function trg_audit();

revoke all on function save_expense_type(uuid, text, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function save_expense_type(uuid, text, text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function save_expense_type(uuid, text, text) to app_api;
