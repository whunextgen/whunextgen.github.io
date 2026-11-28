-- 0183 分课题审核下达的提醒（黄济民 2026-11-28「财务岗有收到审核的通知吗？」「都补上」）
--   年度核定之后，课题提交（或补交）预算明细，正则私信财务岗：这个课题可以审核下达了。
--   年度核定（stage 改为 fixed）那一刻，已经提交、尚未下达的课题合在一条里私信财务岗。
--   首页待办另列待审核下达的课题（页面上算，不在这里）。
create function notify_topic_review() returns trigger language plpgsql security definer set search_path = public as $$
declare y budget_year; p project;
begin
  if new.status <> 'submitted' or new.issued_at is not null or old.status is not distinct from new.status then return new; end if;
  select * into y from budget_year where year = new.year;
  if y.stage not in ('fixed', 'issued') then return new; end if;
  select * into p from project where id = new.project_id;
  perform notify_user_link(u.id, format('课题「%s」%s 年度预算明细已提交，可以审核下达：在各预算行分配好经费卡后点「审核通过并下达」，下达后课题即可支出、兑换名义币', p.name, new.year),
                           '#/budget/' || new.year, '去审核下达')
    from app_user u where u.role = 'finance' and u.active;
  return new;
end $$;
create trigger topic_review_notice after update of status on project_budget for each row execute function notify_topic_review();

create function notify_year_fixed_review() returns trigger language plpgsql security definer set search_path = public as $$
declare n int; names text;
begin
  if new.stage <> 'fixed' or old.stage is not distinct from new.stage then return new; end if;
  select count(*), string_agg(p.name, '、' order by p.code) into n, names
    from project_budget b join project p on p.id = b.project_id where b.year = new.year and b.status = 'submitted' and b.issued_at is null;
  if n = 0 then return new; end if;
  perform notify_user_link(u.id, format('%s 年度预算已核定，%s 个课题的明细已提交，可以逐个审核下达：%s', new.year, n, names), '#/budget/' || new.year, '去审核下达')
    from app_user u where u.role = 'finance' and u.active;
  return new;
end $$;
create trigger year_fixed_review_notice after update of stage on budget_year for each row execute function notify_year_fixed_review();
