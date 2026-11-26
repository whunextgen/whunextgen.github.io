-- 选人框按资格过滤（issue #76）：people_pick 追加本人身份（Intern 至 Director），
-- 指定研讨会组织者、登记进展小组等对话框据此只列符合资格的人，不必等保存时由后台拒绝。
create or replace view api.people_pick as
  select u.id, u.name, user_rank(u.id) as rank from app_user u where u.active and app_role() is not null;
