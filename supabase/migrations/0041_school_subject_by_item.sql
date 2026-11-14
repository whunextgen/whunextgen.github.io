-- 已入账支出按学校科目的汇总，加上它记在本卡哪个科目下，页面上才能把「学校明细账」这一项按学校科目展开
drop view api.card_school_subject;
create view api.card_school_subject as
  select r.card_id, r.subject_id, coalesce(r.school_name, '（未注明学校科目）') as school_name, max(r.school_code) as school_code, count(*)::int as n, sum(v.amount) as amount
  from expense_request r join voucher v on v.request_id = r.id
  where r.status = 'posted' and r.school_name is not null and can_see_card(r.card_id)
  group by r.card_id, r.subject_id, coalesce(r.school_name, '（未注明学校科目）');
grant select on api.card_school_subject to app_api;
