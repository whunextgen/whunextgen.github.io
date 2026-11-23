-- 两周一期改为自 2026-11-23（周一）起算：第一期 11-23 至 12-06。
-- 原先自 11-16 起算，与中心实际的双周节奏差一周。已登记在 11-16 那一期的双周表，一并移到 11-23 这一期（名义币登记尚无数据）。
alter table biweekly_report drop constraint biweekly_report_period_start_check;

create or replace function token_period(p_day date) returns date language sql immutable as $$
  select date '2026-11-23' + (floor((p_day - date '2026-11-23') / 14.0)::int * 14)
$$;

update biweekly_report set period_start = date '2026-11-23' where period_start = date '2026-11-16';

alter table biweekly_report add constraint biweekly_report_period_start_check check (period_start = token_period(period_start));

-- 研究单元从哪一期起须登记：成立所在的那一期，最早 2026-11-23
create or replace function biweekly_from(p_project uuid) returns date language sql stable security definer set search_path = public as $$
  select greatest(date '2026-11-23', token_period((coalesce(checked_at, created_at) at time zone 'Asia/Shanghai')::date)) from project where id = p_project
$$;
