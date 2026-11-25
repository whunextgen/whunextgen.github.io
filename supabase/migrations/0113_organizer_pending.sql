-- 待登录的组织者：还没有正则账号的人可以先记为某研讨会的组织者，首次登录对上档案时自动成为组织者并收到通知
create table seminar_organizer_pending (
  seminar text not null references seminar(code) on delete cascade,
  person_id uuid not null references person(id) on delete cascade,
  set_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  primary key (seminar, person_id)
);
select seal('seminar_organizer_pending');

create function trg_organizer_pending() returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.user_id is null or (tg_op = 'UPDATE' and old.user_id is not distinct from new.user_id) then return new; end if;
  for r in select p.seminar, s.name from seminar_organizer_pending p join seminar s on s.code = p.seminar where p.person_id = new.id loop
    if organizer_rank_ok(new.user_id) then
      insert into seminar_organizer (seminar, user_id, set_by) select r.seminar, new.user_id, p.set_by from seminar_organizer_pending p where p.seminar = r.seminar and p.person_id = new.id on conflict do nothing;
      perform notify_sys(new.user_id, format('研讨会组织者：你已被指定为「%s」主题研讨会的组织者之一，与其他组织者一起接收投稿、决定口头报告或海报、开会并记入质疑', r.name));
    end if;
    delete from seminar_organizer_pending where seminar = r.seminar and person_id = new.id;
  end loop;
  return new;
end $$;
create trigger organizer_pending after insert or update of user_id on person for each row execute function trg_organizer_pending();

-- 中心负责人把还没有账号的人记为待登录的组织者
create function add_pending_organizer(p_seminar text, p_person uuid) returns void language plpgsql security definer set search_path = public as $$
declare pr person;
begin
  if app_role() is distinct from 'director' then raise exception '组织者由中心负责人指定' using errcode = '42501'; end if;
  if not exists (select 1 from seminar where code = p_seminar) then raise exception '研讨会不存在'; end if;
  select * into pr from person where id = p_person;
  if not found then raise exception '人员不存在'; end if;
  if pr.user_id is not null then raise exception '此人已有账号，请直接指定为组织者'; end if;
  if rank_ord(pr.rank) < rank_ord('researcher') or rank_ord(pr.rank) >= rank_ord('director') then raise exception '组织者由 Researcher 及以上担任，Director 不参与组织'; end if;
  insert into seminar_organizer_pending (seminar, person_id, set_by) values (p_seminar, p_person, app_uid()) on conflict do nothing;
end $$;
