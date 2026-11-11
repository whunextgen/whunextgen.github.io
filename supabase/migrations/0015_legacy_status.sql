-- 旧门户里一次提交的状态没有随逐行审核更新（明细全部通过了，提交还显示待审核）。
-- 历史视图里改为按明细的实际状态推出：明细状态一致就用它；还有没审的算审核中；有通过也有没通过的算部分通过。
create or replace view api.legacy_ms_submission as
  select d->>'id' as id, d->>'leader_name' as leader_name, d->>'file_name' as file_name,
         legacy_ts(d->>'submitted_at') as submitted_at, legacy_num(d->>'total_amount') as total,
         legacy_num(d->>'approved_amount') as approved, legacy_num(d->>'pending_amount') as pending, legacy_num(d->>'rejected_amount') as rejected,
         case when i.kinds = 1 then i.one when i.waiting then '审核中' when i.passed then '部分通过' else r.fields->>'status' end as status,
         coalesce(nullif(d->>'finance_comment', ''), nullif(d->>'withdraw_reason', ''), nullif(d->>'void_reason', '')) as comment
  from legacy.record r cross join lateral (select r.fields->'data' as d) x
  cross join lateral (
    select count(distinct e.status) as kinds, min(e.status) as one,
           coalesce(bool_or(e.status = '待审核'), false) as waiting, coalesce(bool_or(e.status = '已通过'), false) as passed
    from legacy.entity e where e.type = 'morningstar_budget_item' and e.d->>'submission_id' = d->>'id') i
  where r.table_id = 'entity' and r.fields->>'type' = 'morningstar_budget_submission'
    and (is_staff() or d->>'leader_name' = my_name());
