-- 课题和研究单元的负责人可以自己改名称。此前只有财务岗和中心负责人能在课题管理里改。
-- 研究单元的名称就是稿子的名称，写作过程中改题是常事。只改名称，编号、负责人、所挂课题不动。
-- 研究单元改名通知所挂课题的负责人；课题改名通知中心负责人。待成立的研究单元申请仍在申请上修改。
create function rename_project(p_id uuid, p_name text) returns void language plpgsql security definer set search_path = public as $$
declare r project; n text := btrim(coalesce(p_name, '')); par project; who text; d record;
begin
  if app_uid() is null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select * into r from project where id = p_id for update;
  if not found then raise exception '课题或研究单元不存在'; end if;
  if r.owner_id is distinct from app_uid() then raise exception '名称由负责人修改' using errcode = '42501'; end if;
  if r.kind = 'public' then raise exception '中心公共开支的名称不在此修改'; end if;
  if r.proposed then raise exception '尚未成立，请在申请上修改名称'; end if;
  if not r.active then raise exception '已停用，不能改名'; end if;
  if n = '' then raise exception '请填写名称'; end if;
  if length(n) > 60 then raise exception '名称不得超过 60 个字'; end if;
  if n = r.name then return; end if;
  update project set name = n where id = p_id;
  who := (select name from app_user where id = app_uid());
  if r.layer = 'paper' then
    select * into par from project where id = r.parent_id;
    perform notify_user(par.owner_id, format('研究单元改名：%s 把课题「%s」之下的研究单元 %s 由「%s」改为「%s」', who, par.name, r.code, r.name, n));
  else
    for d in select id from app_user where role = 'director' and active loop
      perform notify_user(d.id, format('课题改名：%s 把课题 %s 由「%s」改为「%s」', who, r.code, r.name, n));
    end loop;
  end if;
end $$;
select expose('rename_project(uuid, text)');
