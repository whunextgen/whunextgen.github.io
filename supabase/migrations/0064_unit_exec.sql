-- 课题的预算按研究单元分列执行：预算行都在课题上，支出申请记在所属研究单元名下（或直接记在课题名下）。
-- 只给汇总数，不列逐笔申请；课题公开，登录的人都能看已立项课题的这张表。
create view api.unit_exec as
  select l.year, l.project_id as topic_id, r.project_id, count(*)::int as n,
         coalesce(sum(case when r.status = 'posted' then coalesce(v.amount, r.amount) else r.amount end), 0) as used,
         coalesce(sum(coalesce(v.amount, r.amount)) filter (where r.status = 'posted'), 0) as actual
  from expense_request r join v_line l on l.id = r.budget_line_id left join voucher v on v.request_id = r.id
  where r.project_id is not null and r.status in ('pending', 'committed', 'at_school', 'returned', 'posted')
    and app_role() is not null and can_see_project(l.project_id)
  group by l.year, l.project_id, r.project_id;
grant select on api.unit_exec to app_api;
