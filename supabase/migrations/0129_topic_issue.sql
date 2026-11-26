-- 分课题下达（黄济民 2026-11-26「我们应该分课题下达？」「财务审核通过即可」）
--   原来支出要等整个年度预算「下达」，而且只能在当年花：一个课题没准备好，全中心都动不了；2027 年度的钱要到 2027-01-01 才能用。
--   现在：年度核定之后，财务岗逐个课题审核预算明细，审核通过即下达：
--     这个课题的明细按经费卡自动分配（分不够的提示先手工分配），课题及其研究单元随即可以提支出申请、按预算行申领资源，不等其他课题，也不等日历年。
--   年度整体的「下达」照旧，下达后全部课题都可以支出。
--   这次只放开支出这条线（提交支出申请、按预算行申领、批准超预算支出、可选的预算行、资源计划）；
--   预算调剂、调整核定数、预算期预算、复盘仍在年度整体下达之后办理。

alter table project_budget add column issued_at timestamptz, add column issued_by uuid references app_user(id), add column issue_note text check (issue_note is null or length(issue_note) <= 300);

-- 预算行能不能用：年度已下达且在当年；或所属课题已由财务审核下达、年度已核定且未决算
create function line_live(p_line uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_budget_line pl join project_budget b on b.id = pl.budget_id join budget_year y on y.year = b.year
    where pl.id = p_line and b.status = 'submitted' and (
      (y.stage = 'issued' and b.year = extract(year from app_today()))
      or (y.stage in ('fixed','issued') and b.issued_at is not null)))
$$;

-- 按课题自动分配经费卡：与年度自动分配同一算法，只分这个课题的明细
create function allocate_topic(p_year int, p_project uuid) returns numeric language plpgsql security definer set search_path = public as $$
declare l record; c record; need numeric; cap numeric; take numeric; short numeric := 0;
begin
  if not exists (select 1 from category_subject) then raise exception '尚未设置预算科目对应的学校科目，请先在「预算参数」中设置'; end if;
  for l in select v.id, v.category_id, v.fixed - v.allocated as need from v_line v
           where v.year = p_year and v.project_id = p_project and coalesce(v.fixed, 0) > v.allocated order by v.fixed desc, v.id loop
    need := l.need;
    for c in select k.id as card_id, m.subject_id
             from fund_card k join template_subject s on s.template_id = k.template_id
             join category_subject m on m.subject_id = s.id and m.category_id = l.category_id
             where k.status = 'active' and k.start_date <= make_date(p_year, 12, 31) and k.cutoff_date >= make_date(p_year, 1, 1)
             order by coalesce(k.priority, 100), case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no, s.sort loop
      exit when need <= 0;
      select coalesce(avail(c.card_id, c.subject_id), 0) - coalesce(sum(greatest(x.amount - x.used, 0)), 0) into cap
      from v_alloc x join project_budget_line pl on pl.id = x.line_id join project_budget b on b.id = pl.budget_id
      join budget_year by on by.year = b.year
      where x.card_id = c.card_id and x.subject_id = c.subject_id and by.stage <> 'closed';
      take := least(need, coalesce(cap, 0));
      if take > 0 then
        insert into budget_allocation (line_id, card_id, subject_id, amount) values (l.id, c.card_id, c.subject_id, take)
        on conflict (line_id, card_id, subject_id) do update set amount = budget_allocation.amount + excluded.amount;
        need := need - take;
      end if;
    end loop;
    short := short + greatest(need, 0);
  end loop;
  return short;
end $$;
revoke execute on function allocate_topic(int, uuid) from public;

-- 财务审核通过即下达
create function issue_topic(p_year int, p_project uuid, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare y budget_year; b project_budget; p project; short numeric; bad text; who uuid;
begin
  perform need_role('finance','director');
  y := lock_year(p_year);
  if y.stage not in ('fixed','issued') then raise exception '% 年度预算核定之后才能按课题下达', p_year; end if;
  select * into p from project where id = p_project;
  select * into b from project_budget where year = p_year and project_id = p_project for update;
  if not found or b.status <> 'submitted' then raise exception '「%」的 % 年度预算尚未提交', coalesce(p.name, '该课题'), p_year; end if;
  if b.issued_at is not null then raise exception '「%」已下达', p.name; end if;
  if not exists (select 1 from v_line where year = p_year and project_id = p_project and coalesce(fixed, 0) > 0) then raise exception '「%」没有核定的明细', p.name; end if;
  short := allocate_topic(p_year, p_project);
  if short > 0 then
    select string_agg(format('%s %s 元', c.name, to_char(v.fixed - v.allocated, 'FM999,999,990.00')), '、') into bad
    from v_line v join budget_category c on c.id = v.category_id where v.year = p_year and v.project_id = p_project and v.fixed > v.allocated;
    raise exception '经费卡上对应科目的可用余额不够，未能分配：%。请先在年度预算页逐行手工分配到经费卡，再审核下达', bad;
  end if;
  update project_budget set issued_at = now(), issued_by = app_uid(), issue_note = nullif(btrim(coalesce(p_note, '')), '') where id = b.id;
  for who in select distinct x from (select p.owner_id x union select u.owner_id from project u where u.parent_id = p_project and u.active
             union select m.user_id from project_member m join project u on u.id = m.project_id where (u.id = p_project or u.parent_id = p_project) and u.active and m.left_on is null) s
           where x is not null loop
    perform notify_user(who, format('课题「%s」%s 年度预算已由财务岗审核下达，课题及其研究单元现在可以提交支出申请', p.name, p_year));
  end loop;
end $$;

-- 撤销下达：还没有任何支出时
create function unissue_topic(p_year int, p_project uuid) returns void language plpgsql security definer set search_path = public as $$
declare b project_budget;
begin
  perform need_role('finance','director');
  select * into b from project_budget where year = p_year and project_id = p_project for update;
  if not found or b.issued_at is null then raise exception '该课题尚未按课题下达'; end if;
  if exists (select 1 from v_line where year = p_year and project_id = p_project and (used > 0 or pending > 0)) then raise exception '已有支出或在办的申请，不能撤销下达'; end if;
  if exists (select 1 from budget_year where year = p_year and stage = 'issued') then raise exception '年度预算已整体下达，不能单独撤销'; end if;
  delete from budget_allocation a using project_budget_line pl where pl.id = a.line_id and pl.budget_id = b.id;
  update project_budget set issued_at = null, issued_by = null, issue_note = null where id = b.id;
end $$;

-- 支出这条线：认按课题下达
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.submit_project_request(uuid, uuid, text, numeric, date, boolean, text, uuid)'::regprocedure);
  n := replace(d, E'  if y.stage <> ''issued'' then raise exception ''拦截：% 年度预算尚未下达，下达后方可支出'', l.year; end if;\n  if l.year <> extract(year from app_today()) then raise exception ''拦截：该预算属 % 年度，仅可在当年支出'', l.year; end if;',
    E'  if not line_live(l.id) then\n    if y.stage <> ''issued'' then raise exception ''拦截：% 年度预算尚未下达到这个课题，财务岗审核下达后方可支出'', l.year; end if;\n    raise exception ''拦截：该预算属 % 年度，仅可在当年支出'', l.year;\n  end if;');
  if n = d then raise exception 'submit_project_request 没有改上'; end if;
  execute n;

  d := pg_get_functiondef('public.open_line(uuid)'::regprocedure);
  n := replace(d, E'  if st <> ''issued'' then raise exception ''拦截：% 年度预算尚未下达，下达后方可申请'', l.year; end if;\n  if l.year <> extract(year from app_today()) then raise exception ''拦截：该预算属 % 年度，仅可在当年使用'', l.year; end if;',
    E'  if not line_live(l.id) then\n    if st <> ''issued'' then raise exception ''拦截：% 年度预算尚未下达到这个课题，财务岗审核下达后方可申请'', l.year; end if;\n    raise exception ''拦截：该预算属 % 年度，仅可在当年使用'', l.year;\n  end if;');
  if n = d then raise exception 'open_line 没有改上'; end if;
  execute n;

  d := pg_get_functiondef('public.approve_request(uuid)'::regprocedure);
  n := replace(d, 'if y.stage <> ''issued'' then raise exception ''% 年度预算不在执行期，不得再批准超预算支出'', l.year; end if;',
                  'if y.stage <> ''issued'' and not line_live(l.id) then raise exception ''% 年度预算不在执行期，不得再批准超预算支出'', l.year; end if;');
  if n = d then raise exception 'approve_request 没有改上'; end if;
  execute n;

  d := pg_get_viewdef('api.line_pick'::regclass);
  n := replace(d, '(y.stage = ''issued''::text) AND ((l.year)::numeric = EXTRACT(year FROM app_today()))', 'line_live(l.id)');
  if n = d then raise exception 'line_pick 没有改上'; end if;
  execute 'create or replace view api.line_pick as ' || n;

  d := pg_get_viewdef('api.resource_plan'::regclass);
  n := replace(d, '(y.stage = ''issued''::text) AND ((b.year)::numeric = EXTRACT(year FROM app_today()))', 'line_live(l.id)');
  if n = d then raise exception 'resource_plan 的开放判断没有改上'; end if;
  n := replace(n, '((b.status = ''submitted''::text) AND (y.stage = ''issued''::text) AND can_use_project(p.id))', '(line_live(l.id) AND can_use_project(p.id))');
  execute 'create or replace view api.resource_plan as ' || n;
end $$;

select expose('issue_topic(int, uuid, text)', 'unissue_topic(int, uuid)');

-- 各课题的下达情况，给预算页和支出申请页用
create view api.topic_issue as
  select b.year, b.project_id, p.code, p.name, b.status, b.issued_at, (select name from app_user where id = b.issued_by) as issued_by_name, b.issue_note,
         (select coalesce(sum(v.fixed), 0) from v_line v where v.year = b.year and v.project_id = b.project_id) as fixed,
         (select coalesce(sum(v.allocated), 0) from v_line v where v.year = b.year and v.project_id = b.project_id) as allocated,
         (b.issued_at is null and b.status = 'submitted' and y.stage = 'fixed' and (has_perm('read.finance') or app_role() in ('finance','director'))) as can_issue,
         (b.issued_at is not null and y.stage = 'fixed' and app_role() in ('finance','director')) as can_unissue
  from project_budget b join project p on p.id = b.project_id join budget_year y on y.year = b.year
  where app_role() is not null and p.layer = 'big';
grant select on api.topic_issue to app_api;
