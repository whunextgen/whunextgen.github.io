-- 回应质疑入队，经负责人同意即进入该研究单元的成员名单（issue #60，黄济民 2026-11-27「加入名单」）
--   《独立研究者成长路径》第三节和快照与质疑页都说「回应某个研究单元的一条质疑、经负责人同意，即进入该研究单元」，
--   研究单元页的组队说明和代码却是「入队的其他研究单元人员不进名单」。以成长路径为准：
--   研究单元的质疑小队由负责人加人，加人即同意，此人同时进入该研究单元的成员名单（已在名单里的不重复加）；
--   本人主线草稿上的质疑（不属于研究单元）不涉及名单。
do $$
declare d text := pg_get_functiondef('public.add_query_member(uuid, uuid)'::regprocedure); n text;
begin
  n := replace(d, $a$  perform notify_user(p_user, format('质疑小队：你已加入研究单元「%s」的质疑小队（%s：%s），自下一期起参与分配', p.name, axis_label(q.axis), left(q.body, 60)));$a$,
$b$  if q.person_id is null and p.layer = 'paper' and p.active and p.kind <> 'public' and p.owner_id is distinct from p_user
     and not exists (select 1 from project_member where project_id = p.id and user_id = p_user and left_on is null) then
    insert into project_member (project_id, user_id, joined_on, added_by) values (p.id, p_user, app_today(), app_uid());
    perform notify_user_link(p_user, format('质疑小队：你已加入研究单元「%s」的质疑小队（%s：%s），同时进入该研究单元的成员名单，自下一期起参与分配，可从该研究单元提交支出申请、申领资源', p.name, axis_label(q.axis), left(q.body, 60)), '#/project/' || p.id);
  else
    perform notify_user(p_user, format('质疑小队：你已加入研究单元「%s」的质疑小队（%s：%s），自下一期起参与分配', p.name, axis_label(q.axis), left(q.body, 60)));
  end if;$b$);
  if n = d then raise exception 'add_query_member 没有改上'; end if;
  execute n;
end $$;
