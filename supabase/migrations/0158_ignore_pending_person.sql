-- 人员档案待处理加「忽略」（#175，黄济民 2026-11-28「忽略也可以加上了」）
--   不是中心的人用飞书登录后，原来只能一直挂在待处理里。现在人事可以忽略：写明理由，档案记为「已忽略」，账号保持停用；
--   此人再登录也不会重新提醒。忽略错了可以恢复为待确认，再按确认在岗或并入处理。
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'person'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%pending%';
  if c is not null then execute format('alter table person drop constraint %I', c); end if;
end $$;
alter table person add constraint person_status_check check (status in ('active','offroll','left','pending','ignored'));
alter table person add column ignore_note text, add column ignored_at timestamptz, add column ignored_by uuid references app_user;

create or replace function ignore_person(p_person uuid, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare p person; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('people.manage');
  select * into p from person where id = p_person for update;
  if not found then raise exception '人员档案不存在'; end if;
  if p.status <> 'pending' then raise exception '只有待确认的人可以忽略'; end if;
  if n is null then raise exception '请写明忽略的理由，比如「不是本中心人员」'; end if;
  if length(n) > 200 then raise exception '理由不超过 200 个字'; end if;
  update person set status = 'ignored', ignore_note = n, ignored_at = now(), ignored_by = app_uid(), updated_at = now() where id = p_person;
end $$;

create or replace function unignore_person(p_person uuid) returns void language plpgsql security definer set search_path = public as $$
declare p person;
begin
  perform need_perm('people.manage');
  select * into p from person where id = p_person for update;
  if not found then raise exception '人员档案不存在'; end if;
  if p.status <> 'ignored' then raise exception '这个人没有被忽略'; end if;
  update person set status = 'pending', ignore_note = null, ignored_at = null, ignored_by = null, updated_at = now() where id = p_person;
end $$;

insert into rbac_fn (fn, sig, perm) values ('ignore_person', '*', 'people.manage'), ('unignore_person', '*', 'people.manage') on conflict do nothing;

-- 已忽略的改为在岗或非编时，账号同样启用
create or replace function trg_person_sync() returns trigger language plpgsql security definer set search_path = public as $$
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
    if new.status in ('left','ignored') then
      if new.user_id = app_uid() then raise exception '不得将本人登记为已离开'; end if;
      update app_user set active = false, updated_at = now() where id = new.user_id and active;
    elsif old.status in ('left','pending','ignored') and new.status in ('active','offroll') then
      update app_user set active = true, updated_at = now() where id = new.user_id and not active;
    end if;
  end if;
  return new;
end $$;

create or replace view api.person as
  select p.id, p.name, p.no, p.kind, p.status, p.joined_on, p.left_on, p.edu, p.school, p.direction, p.mentor, p.note,
         p.user_id, u.name as account_name, u.active as account_active, (p.feishu_union_id is not null) as has_feishu,
         exists (select 1 from staff_assignment s where s.person_id = p.id) as has_pay, p.updated_at,
         p.ignore_note, p.ignored_at, (select name from app_user where id = p.ignored_by) as ignored_by_name
  from person p left join app_user u on u.id = p.user_id
  where has_perm('read.people');
