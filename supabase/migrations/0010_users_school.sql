-- 用户管理，学校侧余额回写，批量入账。

-- ---------- 用户 ----------
-- 中心负责人不能停用自己，也不能改掉自己的角色：这样系统里始终至少有一位中心负责人。
create function check_user_change(p_user uuid, p_role text, p_active boolean) returns void language plpgsql as $$
begin
  if p_role is null or p_role not in ('finance','director','leader','member') then
    raise exception '角色只能是财务岗、中心负责人、负责人或成员';
  end if;
  if p_user = app_uid() and (p_role <> 'director' or not coalesce(p_active, true)) then
    raise exception '不能停用自己或改掉自己的角色，请让另一位中心负责人操作';
  end if;
end $$;

create or replace function set_user_role(p_user uuid, p_role text, p_active boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  perform check_user_change(p_user, p_role, p_active);
  update app_user set role = p_role, active = coalesce(p_active, true), updated_at = now() where id = p_user;
  if not found then raise exception '用户不存在'; end if;
end $$;

-- 预先登记一个人（按企业邮箱，首次飞书登录时自动认领），或修改已有用户
create function save_user(p_id uuid, p_name text, p_email text, p_role text, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); e text := nullif(lower(btrim(coalesce(p_email, ''))), ''); uid uuid;
begin
  perform need_role('director');
  if n = '' then raise exception '请填写姓名'; end if;
  if length(n) > 40 then raise exception '姓名不能超过 40 个字'; end if;
  if e is not null and e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception '邮箱格式不对'; end if;
  if e is not null and exists (select 1 from app_user where email = e and id is distinct from p_id) then
    raise exception '这个邮箱已经登记在另一个用户名下';
  end if;
  perform check_user_change(p_id, p_role, p_active);
  if p_id is null then
    if e is null then raise exception '预先登记要填企业邮箱，首次飞书登录时按邮箱认领'; end if;
    insert into app_user (name, email, role, active) values (n, e, p_role, coalesce(p_active, true)) returning id into uid;
  else
    update app_user set name = n, email = e, role = p_role, active = coalesce(p_active, true), updated_at = now()
    where id = p_id returning id into uid;
    if uid is null then raise exception '用户不存在'; end if;
  end if;
  return uid;
end $$;

-- 只有中心负责人能看到邮箱和绑定情况；不暴露飞书 open_id
create view api.user_admin as
  select u.id, u.name, u.email, u.role, u.active, (u.feishu_open_id is not null) as linked,
         (u.legacy_serial is not null) as migrated, u.created_at,
         (select count(*) from fund_card c where c.owner_id = u.id)::int as cards,
         (select count(*) from expense_request r where r.requested_by = u.id)::int as requests
  from app_user u where app_role() = 'director';

-- ---------- 学校侧余额回写 ----------
-- 学校财务系统没有接口，三个数由财务岗对照学校系统手工回写，用来和本系统的可用额度对账
create function set_school_balance(p_card uuid, p_balance numeric, p_frozen numeric, p_available numeric default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance');
  if p_balance is null or p_balance < 0 then raise exception '请填写学校系统里的余额'; end if;
  if coalesce(p_frozen, 0) < 0 then raise exception '冻结金额不能为负'; end if;
  if p_available is not null and p_available < 0 then raise exception '可用金额不能为负'; end if;
  update fund_card set school_balance = p_balance, school_frozen = coalesce(p_frozen, 0),
         school_available = coalesce(p_available, p_balance - coalesce(p_frozen, 0)), school_synced_at = now(), updated_at = now()
  where id = p_card;
  if not found then raise exception '经费卡不存在'; end if;
end $$;

-- ---------- 批量入账 ----------
-- p_rows: [{"id": "申请 id", "posted_on": "2026-09-18", "amount": 9800, "voucher_no": "PZ-001"}]
-- 整批一个事务：有一行不合规就全部不入，并指出是哪一行
create function post_vouchers(p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare e jsonb; i int := 0; t text;
begin
  perform need_role('finance');
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '没有要入账的单据'; end if;
  if jsonb_array_length(p_rows) > 200 then raise exception '一次最多入账 200 笔'; end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    select title into t from expense_request where id = (e->>'id')::uuid;
    if t is null then raise exception '第 % 行：找不到这笔申请', i; end if;
    if (e->>'posted_on') is null or (e->>'amount') is null or (e->>'amount')::numeric <= 0 then
      raise exception '第 % 行（%）：入账日期和金额都要填，金额大于 0', i, t;
    end if;
    begin
      perform post_voucher((e->>'id')::uuid, (e->>'posted_on')::date, (e->>'amount')::numeric, nullif(btrim(coalesce(e->>'voucher_no', '')), ''));
    exception when raise_exception then
      raise exception '第 % 行（%）：%', i, t, sqlerrm;
    end;
  end loop;
  return i;
end $$;

grant select on api.user_admin to app_api;
select expose('save_user(uuid, text, text, text, boolean)', 'set_school_balance(uuid, numeric, numeric, numeric)', 'post_vouchers(jsonb)');
