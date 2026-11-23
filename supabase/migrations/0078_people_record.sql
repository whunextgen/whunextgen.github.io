-- 人员档案：档案独立于账号，一人一条，最多对应一个账号；类别、状态以档案为准，账号上的身份和启停跟着档案走。
--   原来身份记在账号上：没登录过的人记不进来，离开只能靠停用账号表示，编号、入离日期、学校、方向没有地方放。
--   人员费用的 person 表就是档案，这里把它补全，不另起一张表。
-- 对齐规则：
--   1. 档案有类别和状态（在岗、非编、已离开、待人事确认）。对应了账号的，账号的身份随档案的类别变。
--   2. 档案登记为已离开，对应的账号随即停用；从已离开或待确认改回在岗、非编，账号恢复启用。
--   3. 人事可以预先在档案上记下飞书身份；本人首次登录时按它认领档案，账号直接可用。
--   4. 没有档案的新面孔登录：建账号但不启用，同时建一条待人事确认的档案并通知人事；确认或并入已有档案之后才能进入。
--      此前这样的人会直接得到一个空白的成员账号。
--   5. 已有的启用账号一律补一条在岗档案，不受影响。

alter table person
  add column no text unique,
  add column kind text check (kind in ('teacher','postdoc','phd','master','ra','ri','visitor','external')),
  add column status text not null default 'active' check (status in ('active','offroll','left','pending')),
  add column joined_on date,
  add column left_on date,
  add column edu text,
  add column school text,
  add column direction text,
  add column mentor text,
  add column note text,
  add column feishu_union_id text unique,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();
create unique index person_user_uq on person (user_id) where user_id is not null;

alter table app_user drop constraint app_user_kind_check;
alter table app_user add constraint app_user_kind_check check (kind in ('teacher','postdoc','phd','master','ra','ri','visitor'));

-- 已有的启用账号补档案：同名且未对应账号的档案直接对上，否则新建一条在岗档案，类别取账号上已登记的身份
do $$
declare u record; pid uuid;
begin
  for u in select * from app_user a where a.active and not exists (select 1 from person p where p.user_id = a.id) order by a.created_at loop
    pid := null;
    if (select count(*) from person p where p.name = u.name and p.user_id is null) = 1 then
      select id into pid from person p where p.name = u.name and p.user_id is null;
      update person set user_id = u.id, kind = coalesce(kind, u.kind), feishu_union_id = u.feishu_union_id where id = pid;
    else
      insert into person (name, user_id, kind, status, feishu_union_id) values (u.name, u.id, u.kind, 'active', u.feishu_union_id);
    end if;
  end loop;
end $$;

-- 档案变了，账号跟着变
create function trg_person_sync() returns trigger language plpgsql security definer set search_path = public as $$
declare k text := case when new.kind in ('teacher','postdoc','phd','master','ra','ri','visitor') then new.kind end;
begin
  if new.user_id is null then return new; end if;
  update app_user set kind = k, updated_at = now() where id = new.user_id and kind is distinct from k;
  if tg_op = 'INSERT' or new.user_id is distinct from old.user_id then
    if new.status = 'left' then
      if new.user_id = app_uid() then raise exception '不得将本人登记为已离开'; end if;
      update app_user set active = false, updated_at = now() where id = new.user_id and active;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'left' then
      if new.user_id = app_uid() then raise exception '不得将本人登记为已离开'; end if;
      update app_user set active = false, updated_at = now() where id = new.user_id and active;
    elsif old.status in ('left','pending') and new.status in ('active','offroll') then
      update app_user set active = true, updated_at = now() where id = new.user_id and not active;
    end if;
  end if;
  return new;
end $$;
create trigger sync after insert or update of kind, status, user_id on person for each row execute function trg_person_sync();

-- 通知有 people.manage 权限的人（人事岗、财务岗、中心负责人）。登录时还没有当前用户，notify_user 不发，所以这里直接入队
create function notify_people_admin(p_text text) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into feishu_outbox (target, payload, user_id)
  select coalesce(x.feishu_union_id, x.feishu_open_id), jsonb_build_object('text', p_text), x.id from app_user x
  where x.active and coalesce(x.feishu_union_id, x.feishu_open_id) is not null and user_perm(x.id, 'people.manage');
end $$;
revoke all on function notify_people_admin(text) from public;

-- 登录：认不出的新面孔先看人事有没有预先登记这个飞书身份；没有就建一个未启用的账号和一条待确认的档案。
-- 不再在这里报「账号已停用」，由接口层看返回的 active 决定能不能进。
create or replace function login_feishu(p_open_id text, p_name text, p_email text default null, p_union_id text default null) returns app_user
language plpgsql security definer set search_path = public as $$
declare u app_user; pr person; e text := nullif(lower(trim(p_email)), ''); n text := nullif(trim(p_union_id), '');
  nm text := coalesce(nullif(btrim(coalesce(p_name, '')), ''), '未填姓名');
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
  if u.id is null then
    if n is not null then
      select * into pr from person where feishu_union_id = n and user_id is null;
    end if;
    insert into app_user (feishu_open_id, feishu_union_id, name, email, active)
    values (p_open_id, n, nm, case when exists (select 1 from app_user where email = e) then null else e end,
            pr.id is not null and pr.status in ('active','offroll'))
    returning * into u;
    if pr.id is not null then
      update person set user_id = u.id, updated_at = now() where id = pr.id;
    else
      insert into person (name, user_id, status, feishu_union_id) values (nm, u.id, 'pending', n);
      perform notify_people_admin(format('人员档案待确认：%s 首次登录中台，没有对应的人员档案，账号暂未启用。请在「人员档案」中确认在岗或并入已有档案', nm));
    end if;
    select * into u from app_user where id = u.id;
  end if;
  return u;
end $$;

-- 登记或修改档案。编号留空且类别是研究助理、研究实习生、硕士的，新建时按现有编号顺延
create function save_person_record(p_id uuid, p_no text, p_name text, p_kind text, p_status text, p_joined date, p_left date,
                                   p_edu text, p_school text, p_direction text, p_mentor text, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); no_ text := nullif(btrim(coalesce(p_no, '')), ''); k text := nullif(btrim(coalesce(p_kind, '')), '');
  s text := coalesce(nullif(btrim(coalesce(p_status, '')), ''), 'active'); old person; pid uuid; nx int;
  t text[] := array[nullif(btrim(coalesce(p_edu, '')), ''), nullif(btrim(coalesce(p_school, '')), ''), nullif(btrim(coalesce(p_direction, '')), ''),
                    nullif(btrim(coalesce(p_mentor, '')), ''), nullif(btrim(coalesce(p_note, '')), '')];
begin
  perform need_perm('people.manage');
  if n = '' then raise exception '请填写姓名'; end if;
  if length(n) > 40 then raise exception '姓名不得超过 40 个字'; end if;
  if k is not null and k not in ('teacher','postdoc','phd','master','ra','ri','visitor','external') then
    raise exception '类别仅限教师、博士后、博士、硕士、研究助理、研究实习生、访问学生或外部人员';
  end if;
  if s not in ('active','offroll','left') then raise exception '状态仅限在岗、非编或已离开'; end if;
  if exists (select 1 from person where name = n and id is distinct from p_id) then raise exception '已有名为「%」的人员，同名请加备注区分', n; end if;
  if no_ is not null and length(no_) > 20 then raise exception '编号不得超过 20 个字符'; end if;
  if no_ is not null and exists (select 1 from person where no = no_ and id is distinct from p_id) then raise exception '编号「%」已被占用', no_; end if;
  if exists (select 1 from unnest(t) x where length(x) > 300) then raise exception '学历、学校、研究方向、导师和备注每项不得超过 300 个字'; end if;
  if p_joined is not null and p_left is not null and p_left < p_joined then raise exception '离开日期不得早于加入日期'; end if;
  if p_id is null then
    if no_ is null and k in ('ra','ri','master') then
      perform pg_advisory_xact_lock(hashtext('person_no'));
      select coalesce(max(substring(no from '-(\d+)$')::int), 0) + 1 into nx from person where no ~ '^[A-Za-z]+-\d+$';
      no_ := case k when 'ra' then 'RA' when 'ri' then 'RI' else 'Master' end || '-' || lpad(nx::text, 3, '0');
    end if;
    insert into person (no, name, kind, status, joined_on, left_on, edu, school, direction, mentor, note)
    values (no_, n, k, s, p_joined, case when s = 'left' then coalesce(p_left, app_today()) end, t[1], t[2], t[3], t[4], t[5]) returning id into pid;
  else
    select * into old from person where id = p_id for update;
    if not found then raise exception '人员档案不存在'; end if;
    update person set no = no_, name = n, kind = k, status = s, joined_on = p_joined,
           left_on = case when s = 'left' then coalesce(p_left, old.left_on, app_today()) end,
           edu = t[1], school = t[2], direction = t[3], mentor = t[4], note = t[5], updated_at = now() where id = p_id;
    pid := p_id;
  end if;
  return pid;
end $$;

-- 指认：把一个账号对到一条档案上。账号原先只有一条待确认的档案的，那一条并掉
create function link_person(p_person uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare tgt person; cur person; a app_user; was_pending boolean := false;
begin
  perform need_perm('people.manage');
  select * into tgt from person where id = p_person for update;
  if not found then raise exception '人员档案不存在'; end if;
  select * into a from app_user where id = p_user for update;
  if not found then raise exception '账号不存在'; end if;
  if tgt.user_id = p_user then return; end if;
  if tgt.user_id is not null then raise exception '该档案已对应账号「%」', (select name from app_user where id = tgt.user_id); end if;
  if tgt.status = 'pending' then raise exception '待确认的档案不能作为并入的目标，请先确认在岗'; end if;
  select * into cur from person where user_id = p_user for update;
  if found then
    if cur.status <> 'pending' or exists (select 1 from staff_assignment s where s.person_id = cur.id) then
      raise exception '该账号已有档案「%」，一个账号只能对应一条档案', cur.name;
    end if;
    delete from person where id = cur.id;
    was_pending := true;
  end if;
  update person set user_id = p_user, feishu_union_id = coalesce(feishu_union_id, a.feishu_union_id), updated_at = now() where id = p_person;
  if was_pending and tgt.status in ('active','offroll') then
    update app_user set active = true, updated_at = now() where id = p_user and not active;
  end if;
end $$;

-- 身份登记（权限管理里的那一栏）：有档案的改档案，账号随之变；没有档案的照旧直接改账号。类别加上教师
create or replace function set_user_kind(p_user uuid, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  if p_kind is not null and p_kind not in ('teacher','postdoc','phd','master','ra','ri','visitor') then raise exception '身份仅限教师、博士后、博士、硕士、研究助理、研究实习生或访问学生'; end if;
  if not exists (select 1 from app_user where id = p_user) then raise exception '用户不存在'; end if;
  update person set kind = p_kind, updated_at = now() where user_id = p_user;
  if not found then update app_user set kind = p_kind, updated_at = now() where id = p_user; end if;
end $$;

-- 合并账号：被并掉的账号只有一条待确认档案的，那一条删掉；两边都有档案的，被并掉一方的档案与账号脱开，留给人事处理
do $$
declare d text; a text := '  for f in select c.conrelid::regclass::text as tbl';
begin
  select pg_get_functiondef(oid) into strict d from pg_proc where proname = 'merge_user' and pronamespace = 'public'::regnamespace;
  if position(a in d) = 0 then raise exception 'merge_user 里找不到要接的位置'; end if;
  execute replace(d, a,
    '  delete from person x where x.user_id = p_from and x.status = ''pending'' and not exists (select 1 from staff_assignment s where s.person_id = x.id);' || E'\n' ||
    '  update person set user_id = null, updated_at = now() where user_id = p_from and exists (select 1 from person y where y.user_id = p_into);' || E'\n' || a);
end $$;

select expose('save_person_record(uuid, text, text, text, text, date, date, text, text, text, text, text)', 'link_person(uuid, uuid)');

-- 档案一览：不给出飞书身份本身，只给出有没有记
create or replace view api.person as
  select p.id, p.name, p.no, p.kind, p.status, p.joined_on, p.left_on, p.edu, p.school, p.direction, p.mentor, p.note,
         p.user_id, u.name as account_name, u.active as account_active, (p.feishu_union_id is not null) as has_feishu,
         exists (select 1 from staff_assignment s where s.person_id = p.id) as has_pay, p.updated_at
  from person p left join app_user u on u.id = p.user_id
  where has_perm('read.people');
