-- 首页两张视图去掉重复计算（提速），输出的列和含义不变
--   period_record：6 期 × 每个研究单元都调用一次 is_on_project，改为先算一次本人所在的研究单元
--   path_person：每个人的主线任务数、完成数各算一遍完整的任务清单（含自动认定），改为把清单按人汇总一次
create or replace view api.period_record as
  with mine as (
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

create or replace view api.path_person as
  with t as (
    select x.person_id, count(*)::int as tasks, (count(*) filter (where x.status = 'done'))::int as done from api.path_tracker x group by x.person_id
  )
  select pr.id as person_id, pr.name as person_name, pr.no, pr.kind, pr.user_id, coalesce(pr.user_id = app_uid(), false) as mine, pr.rank, rank_label(pr.rank) as rank_label,
         coalesce(t.tasks, 0) as tasks,
         coalesce(t.done, 0) as done,
         (select max(c.decided_at) from rank_change c where c.person_id = pr.id) as rank_since,
         (app_role() = 'director') as can_set_rank
  from person pr left join t on t.person_id = pr.id
  where pr.status in ('active','offroll') and path_can_see(pr.id);
