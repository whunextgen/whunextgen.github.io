-- 修正 0015：子查询里的 d 被明细自己的 d 抢了名字，提交和明细没对上，状态仍是旧值。这里指明用提交那一行的 d。
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
    from legacy.entity e where e.type = 'morningstar_budget_item' and e.d->>'submission_id' = x.d->>'id') i
  where r.table_id = 'entity' and r.fields->>'type' = 'morningstar_budget_submission'
    and (is_staff() or d->>'leader_name' = my_name());
