-- 研讨会组织者由 Researcher 及以上担任，Director 不参与组织（黄济民 2026-11-26）
create or replace function organizer_rank_ok(p_user uuid) returns boolean language sql stable security definer set search_path = public as $$
  select user_rank_at_least(p_user, 'researcher') and not user_rank_at_least(p_user, 'director')
$$;

create or replace function set_seminar_organizers(p_seminar text, p_users uuid[]) returns void language plpgsql security definer set search_path = public as $$
declare s seminar; u uuid;
begin
  if app_role() is distinct from 'director' then raise exception '组织者由中心负责人指定' using errcode = '42501'; end if;
  select * into s from seminar where code = p_seminar for update;
  if not found then raise exception '研讨会不存在'; end if;
  if coalesce(array_length(p_users, 1), 0) < 2 then raise exception '每个研讨会至少两位组织者'; end if;
  foreach u in array p_users loop
    if not organizer_rank_ok(u) then raise exception '组织者由 Researcher 及以上担任，Director 不参与组织：%', (select name from app_user where id = u); end if;
  end loop;
  for u in select user_id from seminar_organizer where seminar = p_seminar and not (user_id = any(p_users)) loop
    delete from seminar_organizer where seminar = p_seminar and user_id = u;
  end loop;
  foreach u in array p_users loop
    insert into seminar_organizer (seminar, user_id, set_by) values (p_seminar, u, app_uid()) on conflict do nothing;
    if found then perform notify_user(u, format('研讨会组织者：你已被指定为「%s」主题研讨会的组织者之一，与其他组织者一起接收投稿、决定口头报告或海报、开会并记入质疑', s.name)); end if;
  end loop;
  update seminar set updated_at = now() where code = p_seminar;
end $$;

create or replace function set_seminar_organizer(p_seminar text, p_user uuid) returns void language plpgsql security definer set search_path = public as $$
declare s seminar;
begin
  if app_role() is distinct from 'director' then raise exception '组织者由中心负责人指定' using errcode = '42501'; end if;
  select * into s from seminar where code = p_seminar;
  if not found then raise exception '研讨会不存在'; end if;
  if p_user is null then return; end if;
  if not organizer_rank_ok(p_user) then raise exception '组织者由 Researcher 及以上担任，Director 不参与组织'; end if;
  insert into seminar_organizer (seminar, user_id, set_by) values (p_seminar, p_user, app_uid()) on conflict do nothing;
  if found then perform notify_user(p_user, format('研讨会组织者：你已被指定为「%s」主题研讨会的组织者之一', s.name)); end if;
end $$;
