-- 人事岗在人员经费页看得到经费卡（issue #58）
--   人员经费的排布、发放表要选经费卡，原来 card_pick 只给看得到经费卡的人（财务权限或单独授权），
--   人事劳务角色看到的经费卡一栏是「—」，排布的下拉为空。现在有生成和入账劳务发放表权限的，也列出在用经费卡的卡号、名称和起止日期。
create or replace view api.card_pick as
  select c.id, c.card_no, c.name, c.template_id, c.start_date, c.cutoff_date, c.status, c.year
  from fund_card c where can_see_card(c.id) or has_perm('payroll.run');
