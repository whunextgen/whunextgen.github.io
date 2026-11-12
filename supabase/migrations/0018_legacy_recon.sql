-- 旧门户数据的对账表：按新系统的五步（预算、申请、承诺、入账、结清）加资源、存档归类。
-- 每一行给出旧门户里有多少、按规则应转入新系统多少、新系统里实际有多少；数字都是现算的，对不上会直接显示出来。
--   old_*  旧门户原始数据里的条数和金额
--   in_*   其中应转入新系统的（null 表示这一类只存档，不转入）
--   new_*  新系统里实际查到的
--   cmp    核对口径：amt 只比金额（多行合并成一行的情况），both 条数和金额都比

create view legacy.recon as
with e as (select * from legacy.entity),
proj as (
  select p.id, c.id as card_id, legacy_num(p.d->>'total_amount') as total
  from e p left join fund_card c on c.card_no = p.d->>'project_number' where p.type = 'funding_project'),
ms as (select m.*, pr.card_id, pr.total, legacy_num(m.d->>'target_amount') as target from e m left join proj pr on pr.id = m.d->>'project_id' where m.type = 'milestone'),
alloc as (
  select x.status, (a.value->>'amount')::numeric as amount from e x cross join lateral jsonb_array_elements(x.d->'allocations') a where x.type = 'expense'),
item as (select status, legacy_num(d->>'requested_amount') as amount from e where type = 'morningstar_budget_item'),
r(step, sort, key, source, label, old_n, old_amt, in_n, in_amt, new_n, new_amt, cmp, place, note) as (
  -- ---------- 预算 ----------
  select 1, 10, 'card', 'entity:funding_project', '经费项目', count(*)::int, null::numeric, count(*)::int, null::numeric,
         count(card_id)::int, null::numeric, 'both', '经费卡',
         '旧门户登记的经费总额合计 ' || to_char(coalesce(sum(total), 0), 'FM999,999,999,990.00') || '；新系统以各科目预算为准，不单独存总额'
  from proj
  union all
  select 1, 20, 'subject', 'entity:category', '科目', count(*)::int, null, count(*)::int, null,
         (select count(*)::int from template_subject s join card_template t on t.id = s.template_id where t.code = 'LEGACY'), null, 'both', '过渡科目模板', null
  from e where type = 'category'
  union all
  select 1, 30, 'budget', 'entity:budget', '生效的预算', count(*)::int, sum(legacy_num(d->>'amount')), count(*)::int, sum(legacy_num(d->>'amount')),
         (select count(*)::int from budget_line b where b.card_id in (select card_id from proj)),
         (select sum(b.amount) from budget_line b where b.card_id in (select card_id from proj)), 'amt', '经费卡的年初预算',
         '同一张卡同一科目的多行合并成一行，所以条数变少、金额不变'
  from e where type = 'budget' and status = '生效'
  union all
  select 1, 40, 'budget_void', 'entity:budget', '作废的预算', count(*)::int, sum(legacy_num(d->>'amount')), null, null, null, null, 'both', null, null
  from e where type = 'budget' and status is distinct from '生效'
  union all
  select 1, 50, 'adjust', 'entity:budget_adjustment', '预算调整记录', count(*)::int, null, null, null, null, null, 'both', null, '在对应经费卡的页面里能看到'
  from e where type = 'budget_adjustment'
  union all
  select 1, 60, 'node', 'entity:milestone', '考核节点', count(*)::int, null,
         (count(*) filter (where status is distinct from '作废' and total > 0 and target > 0 and target <= total and card_id is not null))::int, null,
         (select count(*)::int from ms m join card_node k on k.card_id = m.card_id and k.node_date = (m.d->>'target_date')::date), null, 'both', '经费卡的考核节点',
         case when count(*) filter (where target > total) > 0
              then (count(*) filter (where target > total)) || ' 条的目标金额超过经费总额，没有导入' end
  from ms
  -- ---------- 申请 ----------
  union all
  select 2, 10, 'ms_sub', 'entity:morningstar_budget_submission', '晨星预算提交（次）', count(*)::int, null, null, null, null, null, 'both', null, '下面几行是这些提交里的明细，按审核结果分开'
  from e where type = 'morningstar_budget_submission'
  union all
  select 2, 20 + case status when '待审核' then 1 when '已打回' then 2 when '已撤回' then 3 else 4 end, 'ms_item:' || status, 'entity:morningstar_budget_item',
         '晨星预算明细 · ' || status, count(*)::int, sum(amount), null, null, null, null, 'both', null,
         case status when '待审核' then '旧门户里没审完；还需要的在新系统重新提交支出申请' end
  from item where status is distinct from '已通过' group by status
  union all
  select 2, 40, 'res_req', min(table_id), '资源申请', count(*)::int, sum(coalesce(legacy_num(fields->>'预算金额'), legacy_num(fields->>'预计金额'))), null, null, null, null, 'both', null, null
  from legacy.record where table_name = '资源申请表'
  union all
  select 2, 50, 'asset_req', 'entity:asset_request', '资产申请', count(*)::int, null, null, null, null, null, 'both', null, null
  from e where type = 'asset_request'
  -- ---------- 承诺 ----------
  union all
  select 3, 10, 'ms_item:已通过', 'entity:morningstar_budget_item', '晨星预算明细 · 已通过', count(*)::int, sum(amount), null, null, null, null, 'both', null,
         '旧门户里批准了，但没有入账记录；不计入新系统的承诺和额度'
  from item where status = '已通过'
  -- ---------- 入账 ----------
  union all
  select 4, 10, 'expense', 'entity:expense', '支出', count(*)::int, sum(amount), (count(*) filter (where status = '已确认'))::int, sum(amount) filter (where status = '已确认'),
         (select count(*)::int from expense_request q join voucher v on v.request_id = q.id where q.legacy_id is not null and q.status = 'posted'),
         (select sum(v.amount) from expense_request q join voucher v on v.request_id = q.id where q.legacy_id is not null and q.status = 'posted'),
         'both', '已入账的支出申请', '每笔都带入账凭证，计入决算数'
  from alloc
  -- ---------- 资源 ----------
  union all
  select 6, 10, 'asset', 'entity:asset_catalog_item', '资产目录', count(*)::int, null, count(*)::int, null,
         (select count(*)::int from resource x where x.kind = 'asset' and x.legacy_id is not null), null, 'both', '资源（资产）', null
  from e where type = 'asset_catalog_item'
  union all
  select 6, 20, 'asset_ledger', 'entity:asset_ledger', '资产发放台账', count(*)::int, null, count(*)::int, null,
         (select count(*)::int from resource_allocation a join resource x on x.id = a.resource_id where x.kind = 'asset' and a.legacy_id is not null), null, 'both', '资源的分配记录',
         case when count(*) filter (where status = '已作废') > 0 then (count(*) filter (where status = '已作废')) || ' 条已作废，记为已收回' end
  from e where type = 'asset_ledger'
  union all
  select 6, 30, 'pool', 'entity:api_resource_pool', '接口资源池', count(*)::int, sum(legacy_num(d->>'purchased_amount')),
         (count(*) filter (where legacy_num(d->>'purchased_amount') > 0))::int, sum(legacy_num(d->>'purchased_amount')) filter (where legacy_num(d->>'purchased_amount') > 0),
         (select count(*)::int from resource x where x.kind = 'api' and x.legacy_id is not null),
         (select sum(x.total) from resource x where x.kind = 'api' and x.legacy_id is not null), 'both', '资源（接口配额）', '金额是已购金额；密钥没有导入'
  from e where type = 'api_resource_pool'
  union all
  select 6, 40, 'quota', min(table_id), '额度台账', count(*)::int, sum(legacy_num(fields->>'总额度')), null, null, null, null, 'both', null, '金额是总额度'
  from legacy.record where table_name = '额度台账表'
  -- ---------- 存档 ----------
  union all
  select 7, 10, 'rule', 'entity:priority_rule', '经费卡优先规则', count(*)::int, null, null, null, null, null, 'both', null, null
  from e where type = 'priority_rule'
  union all
  select 7, 20, 'attach', null, '附件表格（' || count(distinct table_id) || ' 张）的行', count(*)::int, null, null, null, null, null, 'both', null, '申报时上传的预算表原件'
  from legacy.record where table_id not in ('entity', 'users') and table_name not in ('资源申请表', '额度台账表')
  union all
  select 7, 30, 'user', null, '用户', count(*)::int, null, (count(*) filter (where coalesce(fields->>'name', '') <> ''))::int, null,
         (select count(*)::int from app_user where legacy_serial is not null), null, 'both', '正式用户',
         concat_ws('；', case when count(*) filter (where coalesce(fields->>'name', '') = '') > 0
                             then (count(*) filter (where coalesce(fields->>'name', '') = '')) || ' 条没有姓名，没有转入' end, '首次飞书登录时认领；访问码没有导入')
  from legacy.record where table_id = 'users'
)
select step, sort, key, source, label, old_n, old_amt, in_n, in_amt, new_n, new_amt, place, note,
       case when in_n is null then null
            when cmp = 'amt' then in_amt is not distinct from new_amt
            else in_n = new_n and in_amt is not distinct from new_amt end as ok,
       (select count(*)::int from legacy.record) as all_n
from r where old_n > 0;

create view api.legacy_recon as select * from legacy.recon where is_staff();
grant select on api.legacy_recon to app_api;
