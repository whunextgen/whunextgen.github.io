-- 「我的事项」用的支出申请：只含在办的（待批、已承诺、在学校、学校退回）和本人提交的（提速）
--   原来取全部支出申请，中心负责人、财务岗会取到全部历史单据（线上 251 笔，约 220 KB），「我的事项」只用得到这两类。
--   权限与 api.request 相同（直接从它筛选）。
create view api.request_live as
  select * from api.request r where r.status in ('pending','committed','at_school','returned') or r.requested_by = app_uid();
grant select on api.request_live to app_api;
