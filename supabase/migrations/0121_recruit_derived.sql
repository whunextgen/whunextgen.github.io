-- 双选不再另填招募信息（黄济民 2026-11-26「负责人就是课题和研究单元而已，不需要额外填什么」）：
--   研究什么取研究单元申请时的说明、课题最近一次档次申请的理由；加入后做什么取这里尚未回应的质疑；联系的就是负责人
drop view api.recruit;
drop view api.recruit_interest;
drop function save_project_recruit(uuid, text, text, text, text, text, uuid);
drop table project_recruit;

create or replace function express_interest(p_project uuid, p_note text, p_link text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare p project; v_id uuid; lk text := nullif(btrim(coalesce(p_link, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or not p.active or p.proposed or p.kind = 'public' then raise exception '课题或研究单元不存在'; end if;
  if exists (select 1 from project_member where project_id = p_project and user_id = app_uid() and left_on is null) or p.owner_id = app_uid() then raise exception '已在成员名单里'; end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception '请写明本人情况和兴趣'; end if;
  if lk is not null and lk !~ '^https?://' then raise exception '链接须以 http 开头'; end if;
  insert into recruit_interest (project_id, user_id, note, link) values (p_project, app_uid(), btrim(p_note), lk) returning recruit_interest.id into v_id;
  perform notify_user(p.owner_id, format('双选意向：%s 想参与「%s」：%s', (select name from app_user where id = app_uid()), p.name, left(btrim(p_note), 120)));
  return v_id;
exception when unique_violation then raise exception '已表达过意向，等负责人联系';
end $$;

create view api.recruit as
  select p.id, p.code, p.name, p.layer, p.parent_id, (select name from project q where q.id = p.parent_id) as parent_name,
         p.owner_id, (select name from app_user where id = p.owner_id) as owner_name, (select scholar_url from app_user where id = p.owner_id) as owner_scholar_url,
         case when p.layer = 'paper' then p.apply_note else (select k.reason from tier_pick k where k.project_id = p.id order by k.year desc limit 1) end as intro,
         (select jsonb_build_object('id', s.id, 'seq', s.seq, 'link', s.link, 'period_start', s.period_start) from snapshot s where s.project_id = p.id and s.person_id is null order by s.seq desc limit 1) as snapshot,
         (select count(*)::int from query q where q.project_id = p.id and q.status = 'open' and q.parent_id is null) as open_queries,
         (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]') from (select jsonb_build_object('id', q.id, 'axis', axis_label(q.axis), 'body', q.body, 'at', q.recorded_at) x
            from query q where q.project_id = p.id and q.status = 'open' and q.parent_id is null order by q.recorded_at desc limit 3) z) as queries,
         (select count(*)::int from project_member m where m.project_id = p.id and m.left_on is null) as members,
         has_perm('budget.project', p.id) as can_manage,
         (p.owner_id = app_uid() or exists (select 1 from project_member m where m.project_id = p.id and m.user_id = app_uid() and m.left_on is null)) as am_member,
         exists (select 1 from recruit_interest i where i.project_id = p.id and i.user_id = app_uid() and i.status = 'open') as my_interest
  from project p
  where app_role() is not null and p.active and not p.proposed and p.kind <> 'public' and p.layer in ('big','paper');

create view api.recruit_interest as
  select i.id, i.project_id, p.name as project_name, i.user_id, u.name as user_name, rank_label(user_rank(i.user_id)) as rank_label, i.note, i.link, i.status, i.created_at,
         (i.user_id = app_uid()) as mine
  from recruit_interest i join project p on p.id = i.project_id join app_user u on u.id = i.user_id
  where app_role() is not null and (i.user_id = app_uid() or has_perm('budget.project', i.project_id));

grant select on api.recruit, api.recruit_interest to app_api;
