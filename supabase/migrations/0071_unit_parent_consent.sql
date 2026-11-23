-- 研究单元用的是所挂课题的钱，成立须经该课题负责人同意。
-- 顺序：联席会议通过 → 申请人提交 → 所挂课题的负责人（或副手）同意 → 助理对照纪要核对 → 成立。
-- 申请人本人就是所挂课题的负责人或副手的，提交即视为同意。课题负责人不同意的，退回并写明原因。
alter table project add column parent_ok_by uuid references app_user(id), add column parent_ok_at timestamptz;

-- 改动前已提交、尚待核对的申请，同样须经课题负责人同意；已成立的研究单元不受影响

do $$
declare d text; n text;
begin
  -- 提交：重新提交时清掉原来的同意；申请人是课题负责人的直接记为已同意并通知核对的人，否则通知课题负责人
  d := pg_get_functiondef('public.propose_unit(uuid, uuid, text, date, date, text, text)'::regprocedure);
  n := replace(d, 'return_note = null, checked_by = null, checked_at = null where id = p_id;',
                  'return_note = null, checked_by = null, checked_at = null, parent_ok_by = null, parent_ok_at = null where id = p_id;');
  if n = d then raise exception 'propose_unit：没有找到重新提交的语句'; end if;
  d := n;
  n := regexp_replace(d, '(perform notify_user\(u\.id, format\(''研究单元申请待核对：.*?user_perm\(u\.id, ''budget\.evaluate''\);)',
    'if has_perm(''budget.project'', p_parent) then
    update project set parent_ok_by = app_uid(), parent_ok_at = now() where id = uid;
    \1
  else
    perform notify_user(par.owner_id, format(''研究单元申请待同意：%s 申请在课题「%s」之下成立「%s」，使用该课题的预算。请在「课题管理」中同意或退回'', (select name from app_user where id = app_uid()), par.name, n));
  end if;');
  if n = d then raise exception 'propose_unit：没有找到通知语句'; end if;
  execute n;

  -- 核对：须课题负责人已同意
  d := pg_get_functiondef('public.confirm_unit(uuid)'::regprocedure);
  n := replace(d, 'until := add_workdays(u.minutes_on, 3);',
    'if u.parent_ok_at is null then raise exception ''所挂课题的负责人尚未同意，同意后方可确认成立''; end if;
  until := add_workdays(u.minutes_on, 3);');
  if n = d then raise exception 'confirm_unit：没有找到插入位置'; end if;
  execute n;

  -- 退回：核对的人和所挂课题的负责人都可以退回；退回即清掉同意
  d := pg_get_functiondef('public.return_unit(uuid, text)'::regprocedure);
  n := replace(d, 'perform need_perm(''budget.evaluate'');', '');
  n := replace(n, 'if n is null then raise exception ''请填写退回原因''; end if;',
    'if not (has_perm(''budget.evaluate'') or has_perm(''budget.project'', u.parent_id)) then raise exception ''需要权限：录入评定结果，或为所挂课题的负责人'' using errcode = ''42501''; end if;
  if n is null then raise exception ''请填写退回原因''; end if;');
  n := replace(n, 'update project set return_note = n,', 'update project set parent_ok_by = null, parent_ok_at = null, return_note = n,');
  if n = d or n not like '%parent_ok_by = null%' or n not like '%或为所挂课题的负责人%' or n like '%perform need_perm(%' then raise exception 'return_unit：改写不完整'; end if;
  execute n;
end $$;

-- 所挂课题的负责人或副手同意
create function approve_unit(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project; par project;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待核对的申请'; end if;
  if not has_perm('budget.project', u.parent_id) then raise exception '需要权限：仅所挂课题的负责人和副手可以同意' using errcode = '42501'; end if;
  if u.return_note is not null then raise exception '该申请已退回，待申请人修改后重新提交'; end if;
  if u.parent_ok_at is not null then raise exception '该申请已经同意过了'; end if;
  select * into par from project where id = u.parent_id;
  update project set parent_ok_by = app_uid(), parent_ok_at = now() where id = p_unit;
  perform notify_user(u.owner_id, format('课题「%s」的负责人已同意研究单元申请「%s」，待助理对照联席会议纪要核对', par.name, u.name));
  perform notify_user(x.id, format('研究单元申请待核对：%s 申请成立「%s」，挂在课题「%s」之下，课题负责人已同意，联席会议 %s 通过', (select name from app_user where id = u.owner_id), u.name, par.name, u.meeting_on))
  from app_user x where x.active and x.id <> app_uid() and user_perm(x.id, 'budget.evaluate');
end $$;
select expose('approve_unit(uuid)');

create or replace view api.unit_apply as
  select p.id, p.code, p.name, p.parent_id, pp.code as parent_code, pp.name as parent_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         p.apply_note, p.meeting_on, p.minutes_on, p.applied_at, p.return_note, (select name from app_user where id = p.checked_by) as checked_by_name, p.checked_at,
         p.proposed, add_workdays(p.minutes_on, 3) as veto_until,
         (select string_agg(u.name, '、' order by u.name) from project_member m join app_user u on u.id = m.user_id where m.project_id = p.id and m.left_on is null) as member_names,
         (select string_agg(m.user_id::text, ',') from project_member m where m.project_id = p.id and m.left_on is null) as member_ids,
         (p.owner_id is not distinct from app_uid()) as mine,
         p.parent_ok_at, (select name from app_user where id = p.parent_ok_by) as parent_ok_by_name, (select name from app_user where id = pp.owner_id) as parent_owner_name,
         (p.proposed and has_perm('budget.project', pp.id)) as can_ok
  from project p join project pp on pp.id = p.parent_id
  where p.applied_at is not null and p.layer = 'paper' and p.active and app_role() is not null
    and (not p.proposed or p.owner_id = app_uid() or has_perm('budget.evaluate') or has_perm('budget.setup') or can_manage_project(pp.id) or has_perm('budget.project', pp.id));
