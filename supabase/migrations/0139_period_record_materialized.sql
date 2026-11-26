-- period_record：0138 的 CTE 被数据库展开回每一期（仍算 6 次），加 materialized 强制只算一次
create or replace view api.period_record as
  with mine as materialized (
    select p.id from project p
    where app_uid() is not null and p.layer = 'paper' and p.active and not p.proposed and (p.owner_id = app_uid() or is_on_project(p.id))
  )
  select d.period_start,
         (select case when count(*) = 0 then null when bool_and(a.status = 'present') then 2 when bool_and(a.status = 'present' or (a.status = 'leave' and a.made_up)) then 1 else 0 end
            from attend_event e left join attend a on a.event_id = e.id and a.user_id = app_uid() where e.kind = 'lecture' and e.held_on between d.period_start and d.period_start + 13) as lecture,
         (select case when count(*) = 0 then null when bool_or(a.status = 'present') then 2 when bool_or(a.status = 'leave' and a.made_up) then 1 else 0 end
            from attend_event e left join attend a on a.event_id = e.id and a.user_id = app_uid() where e.kind = 'seminar' and e.held_on between d.period_start and d.period_start + 13) as seminar,
         (select case when count(*) = 0 then null when bool_and(exists (select 1 from biweekly_report b where b.project_id = m.id and b.period_start = d.period_start)) then 2 else 0 end
            from mine m) as biweekly,
         (case when exists (select 1 from snapshot s join snapshot_author a on a.snapshot_id = s.id where a.user_id = app_uid() and s.period_start = d.period_start) then 2 else 0 end) as snapshot
  from (select (token_period(app_today()) - g * 14) as period_start from generate_series(0, 5) g) d
  where app_uid() is not null;

