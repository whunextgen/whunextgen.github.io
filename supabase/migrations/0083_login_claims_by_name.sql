-- 首次登录按姓名自动对上原有账号或档案，不再另建一个同名的待确认账号。
-- 此前：旧账号没有记 union_id 的人首次登录，会多出一个同名新账号和一条待确认档案；人事确认时因同名被拦、并入时因档案已有账号被拦，只能由中心负责人到权限管理里合并。
-- 现在：按姓名找得到唯一一个尚未记 union_id 的普通成员账号的，登录身份直接记到该账号上；
--       否则找得到唯一一条没有账号、没有预记飞书身份、在岗或非编的档案的，新账号直接对到该档案上。
-- 同名不止一个、已有同名账号记了 union_id、账号有成员以外角色的，一律不自动对，仍走人事确认。自动对上的通知人事，供事后核对。
create or replace function login_feishu(p_open_id text, p_name text, p_email text default null, p_union_id text default null) returns app_user
language plpgsql security definer set search_path = public as $$
declare u app_user; pr person; e text := nullif(lower(trim(p_email)), ''); n text := nullif(trim(p_union_id), '');
  nm text := coalesce(nullif(btrim(coalesce(p_name, '')), ''), '未填姓名'); byname boolean := false;
begin
  if coalesce(p_open_id, '') = '' then raise exception '缺少 open_id'; end if;
  if n is not null then
    select * into u from app_user where feishu_union_id = n;
  end if;
  if u.id is null then
    select * into u from app_user where feishu_open_id = p_open_id;
    if u.id is not null and n is not null and u.feishu_union_id is null then
      update app_user set feishu_union_id = n, updated_at = now() where id = u.id returning * into u;
    end if;
  end if;
  if u.id is null and e is not null then
    update app_user set feishu_open_id = p_open_id, feishu_union_id = n, updated_at = now()
    where email = e and feishu_open_id is null and feishu_union_id is null returning * into u;
  end if;
  if u.id is null and n is not null then
    select * into pr from person where feishu_union_id = n and user_id is null;
  end if;
  -- 按姓名对原有账号
  if u.id is null and pr.id is null and n is not null and nm <> '未填姓名'
     and (select count(*) from app_user where name = nm) = 1 then
    update app_user set feishu_open_id = p_open_id, feishu_union_id = n, updated_at = now()
    where name = nm and feishu_union_id is null and role = 'member' returning * into u;
    if u.id is not null then
      update person set feishu_union_id = coalesce(feishu_union_id, n), updated_at = now() where user_id = u.id;
      perform notify_people_admin(format('人员档案自动对应：%s 首次以新的登录身份进入中台，已按姓名对应到原有账号。如非同一人，请在「人员档案」中处理', nm));
    end if;
  end if;
  if u.id is null then
    -- 按姓名对没有账号的档案
    if pr.id is null and n is not null and nm <> '未填姓名' and not exists (select 1 from app_user where name = nm)
       and (select count(*) from person where name = nm) = 1 then
      select * into pr from person where name = nm and user_id is null and feishu_union_id is null and status in ('active','offroll');
      byname := pr.id is not null;
    end if;
    insert into app_user (feishu_open_id, feishu_union_id, name, email, active)
    values (p_open_id, n, nm, case when exists (select 1 from app_user where email = e) then null else e end,
            pr.id is not null and pr.status in ('active','offroll'))
    returning * into u;
    if pr.id is not null then
      update person set user_id = u.id, feishu_union_id = coalesce(feishu_union_id, n), updated_at = now() where id = pr.id;
      if byname then
        perform notify_people_admin(format('人员档案自动对应：%s 首次登录中台，已按姓名对应到原有档案，账号已启用。如非同一人，请在「人员档案」中处理', nm));
      end if;
    else
      insert into person (name, user_id, status, feishu_union_id) values (nm, u.id, 'pending', n);
      perform notify_people_admin(format('人员档案待确认：%s 首次登录中台，没有对应的人员档案，账号暂未启用。请在「人员档案」中确认在岗或并入已有档案', nm));
    end if;
    select * into u from app_user where id = u.id;
  end if;
  return u;
end $$;
