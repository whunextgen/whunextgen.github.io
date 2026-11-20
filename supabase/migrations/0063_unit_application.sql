-- 研究单元立项，并把经费规则改正为：研究单元都用课题的钱。
--   一、研究单元一律独立申请，挂在一个已立项的课题下面（中心公共开支之下不设）。按章程先经联席会议通过，
--       纪要发出满三个工作日未被否决后决议生效；申请人在系统里提交申请，助理对照纪要核对后成立，申请人即为负责人。
--       系统只登记会议结果，不另作评议。申请课题立项时不再一并列研究单元。
--   二、年度预算只编在课题上，研究单元不设预算行。课题及其下属研究单元名单里的人，都从课题的预算行提支出申请、
--       申领资源、申请备用金；申请记在所属研究单元名下，由该研究单元的负责人确认，执行据此按研究单元统计。
--   三、从中心公共开支申请（含公共设备），须已在某个已立项的课题或研究单元的名单里，不再按个人身份单独放开。

-- ---------- 一、研究单元申请 ----------
alter table project add column apply_note text, add column meeting_on date, add column minutes_on date, add column applied_at timestamptz,
                    add column checked_by uuid references app_user(id), add column checked_at timestamptz, add column return_note text;

-- 往后数若干个工作日（周一至周五；法定节假日未计）
create function add_workdays(p_from date, p_n int) returns date language plpgsql immutable as $$
declare d date := p_from; k int := 0;
begin
  while k < p_n loop
    d := d + 1;
    if extract(isodow from d) < 6 then k := k + 1; end if;
  end loop;
  return d;
end $$;

-- 提交或修改研究单元申请。成员名单以逗号分隔的人员编号传入
create function propose_unit(p_id uuid, p_parent uuid, p_name text, p_meeting_on date, p_minutes_on date, p_note text, p_members text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); r text := nullif(btrim(coalesce(p_note, '')), ''); par project; old project; c text; i int; uid uuid; ids uuid[] := '{}';
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if n = '' then raise exception '请填写研究单元名称'; end if;
  if length(n) > 60 then raise exception '研究单元名称不得超过 60 个字'; end if;
  if r is null then raise exception '请填写说明：研究内容，以及拟使用的经费和资源'; end if;
  if length(r) > 1000 then raise exception '说明不得超过 1000 个字'; end if;
  if p_meeting_on is null then raise exception '请填写联席会议通过的日期'; end if;
  if p_minutes_on is null then raise exception '请填写会议纪要发出的日期'; end if;
  if p_meeting_on > app_today() or p_minutes_on > app_today() then raise exception '日期不得晚于今日；研究单元须先经联席会议通过，再提交申请'; end if;
  if p_minutes_on < p_meeting_on then raise exception '纪要发出日期不得早于会议日期'; end if;
  select * into par from project where id = p_parent;
  if not found or par.layer <> 'big' then raise exception '所挂课题不存在'; end if;
  if par.kind = 'public' then raise exception '中心公共开支之下不设研究单元'; end if;
  if not par.active or par.proposed then raise exception '所挂课题尚未立项或已停用，研究单元须挂在已立项的课题之下'; end if;
  if nullif(btrim(coalesce(p_members, '')), '') is not null then
    begin
      ids := string_to_array(replace(p_members, ' ', ''), ',')::uuid[];
    exception when others then raise exception '成员名单格式有误';
    end;
  end if;
  if exists (select 1 from unnest(ids) x where not exists (select 1 from app_user u where u.id = x and u.active)) then raise exception '拟加入的成员中有人不存在或已停用'; end if;
  if exists (select 1 from project where parent_id = p_parent and name = n and active and id is distinct from p_id) then raise exception '该课题下已有同名研究单元「%」', n; end if;
  if p_id is null then
    perform pg_advisory_xact_lock(hashtext('project_code:' || par.code));
    select coalesce(max(substring(code from '-(\d+)$')::int), 0) + 1 into i from project where parent_id = p_parent and code ~ ('^' || regexp_replace(par.code, '([^A-Za-z0-9])', '\\\1', 'g') || '-\d+$');
    loop
      c := par.code || '-' || lpad(i::text, 2, '0');
      exit when not exists (select 1 from project where code = c);
      i := i + 1;
    end loop;
    insert into project (code, name, kind, owner_id, active, layer, parent_id, proposed, apply_note, meeting_on, minutes_on, applied_at)
    values (c, n, par.kind, app_uid(), true, 'paper', p_parent, true, r, p_meeting_on, p_minutes_on, now()) returning id into uid;
  else
    select * into old from project where id = p_id for update;
    if not found or old.layer <> 'paper' or not old.proposed or old.applied_at is null then raise exception '该研究单元不是待核对的申请'; end if;
    if old.owner_id is distinct from app_uid() then raise exception '仅申请人可修改申请' using errcode = '42501'; end if;
    if old.parent_id <> p_parent then raise exception '所挂课题不得修改，请撤回后重新申请'; end if;
    update project set name = n, apply_note = r, meeting_on = p_meeting_on, minutes_on = p_minutes_on, applied_at = now(), return_note = null, checked_by = null, checked_at = null where id = p_id;
    delete from project_member where project_id = p_id;
    uid := p_id;
  end if;
  insert into project_member (project_id, user_id, joined_on, added_by)
  select uid, s.x, app_today(), app_uid() from (select distinct x from unnest(ids) x) s where s.x <> app_uid();
  perform notify_user(u.id, format('研究单元申请待核对：%s 申请成立「%s」，挂在课题「%s」之下，联席会议 %s 通过', (select name from app_user where id = app_uid()), n, par.name, p_meeting_on))
  from app_user u where u.active and u.id <> app_uid() and user_perm(u.id, 'budget.evaluate');
  return uid;
end $$;

-- 对照联席会议纪要核对：确认成立
create function confirm_unit(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project; par project; until date;
begin
  perform need_perm('budget.evaluate');
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待核对的申请'; end if;
  if u.return_note is not null then raise exception '该申请已退回，待申请人修改后重新提交'; end if;
  until := add_workdays(u.minutes_on, 3);
  if app_today() <= until then raise exception '会议纪要于 % 发出，三个工作日的否决期至 % 届满，届满后方可确认成立', u.minutes_on, until; end if;
  select * into par from project where id = u.parent_id;
  if not par.active or par.proposed then raise exception '所挂课题尚未立项或已停用'; end if;
  update project set proposed = false, checked_by = app_uid(), checked_at = now() where id = p_unit;
  perform notify_user(u.owner_id, format('研究单元「%s」已成立，挂在课题「%s」之下。本人为负责人，可管理成员名单', u.name, par.name));
  perform notify_user(m.user_id, format('你已加入研究单元「%s」的成员名单，可使用课题「%s」的预算提交支出申请、申领资源', u.name, par.name))
  from project_member m where m.project_id = p_unit and m.left_on is null;
  if par.owner_id is not null and par.owner_id is distinct from u.owner_id then
    perform notify_user(par.owner_id, format('课题「%s」之下新成立研究单元「%s」，负责人 %s', par.name, u.name, (select name from app_user where id = u.owner_id)));
  end if;
end $$;

-- 会议没有这一项、内容不符或已被否决的：退回
create function return_unit(p_unit uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare u project; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('budget.evaluate');
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待核对的申请'; end if;
  if n is null then raise exception '请填写退回原因'; end if;
  update project set return_note = n, checked_by = app_uid(), checked_at = now() where id = p_unit;
  perform notify_user(u.owner_id, format('研究单元申请「%s」已退回：%s', u.name, n));
end $$;

-- 成立之前，申请人可以撤回
create function withdraw_unit(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待核对的申请'; end if;
  if u.owner_id is distinct from app_uid() and not has_perm('budget.setup') then raise exception '仅申请人和财务岗可撤回申请' using errcode = '42501'; end if;
  delete from project_member where project_id = p_unit;
  delete from project where id = p_unit;
end $$;

select expose('propose_unit(uuid, uuid, text, date, date, text, text)', 'confirm_unit(uuid)', 'return_unit(uuid, text)', 'withdraw_unit(uuid)');

create view api.unit_apply as
  select p.id, p.code, p.name, p.parent_id, pp.code as parent_code, pp.name as parent_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         p.apply_note, p.meeting_on, p.minutes_on, p.applied_at, p.return_note, (select name from app_user where id = p.checked_by) as checked_by_name, p.checked_at,
         p.proposed, add_workdays(p.minutes_on, 3) as veto_until,
         (select string_agg(u.name, '、' order by u.name) from project_member m join app_user u on u.id = m.user_id where m.project_id = p.id and m.left_on is null) as member_names,
         (select string_agg(m.user_id::text, ',') from project_member m where m.project_id = p.id and m.left_on is null) as member_ids,
         (p.owner_id is not distinct from app_uid()) as mine
  from project p join project pp on pp.id = p.parent_id
  where p.applied_at is not null and p.layer = 'paper' and p.active and app_role() is not null
    and (not p.proposed or p.owner_id = app_uid() or has_perm('budget.evaluate') or has_perm('budget.setup') or can_manage_project(pp.id));
grant select on api.unit_apply to app_api;

-- 申请课题立项时不再一并列研究单元（参数保留以免调用方出错，内容不再使用）
create or replace function propose_project(p_year int, p_name text, p_tier uuid, p_reason text, p_units text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare y budget_year; n text := btrim(coalesce(p_name, '')); r text := nullif(btrim(coalesce(p_reason, '')), ''); c text; i int; pid uuid;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if nullif(btrim(coalesce(p_units, '')), '') is not null then raise exception '研究单元须在课题成立后单独申请，立项申请中不再一并填写'; end if;
  y := lock_year(p_year);
  if y.stage <> 'declare' then raise exception '% 年度预算已过申请阶段', p_year; end if;
  if y.plan_at is null then raise exception '% 年度预算方案尚未批准，暂不能申请立项', p_year; end if;
  if n = '' then raise exception '请填写课题名称'; end if;
  if length(n) > 60 then raise exception '课题名称不得超过 60 个字'; end if;
  if r is null then raise exception '请填写研究内容和申请理由'; end if;
  if not exists (select 1 from budget_tier where id = p_tier and year = p_year) then raise exception '档次不存在'; end if;
  if exists (select 1 from project where name = n and layer = 'big' and (active or proposed)) then raise exception '已有同名课题「%」', n; end if;
  perform pg_advisory_xact_lock(hashtext('project_code:new'));
  select coalesce(max(substring(code from '^P-(\d+)$')::int), 0) + 1 into i from project where code ~ '^P-\d+$';
  loop
    c := 'P-' || lpad(i::text, 2, '0');
    exit when not exists (select 1 from project where code = c);
    i := i + 1;
  end loop;
  insert into project (code, name, kind, owner_id, active, layer, parent_id, proposed) values (c, n, 'project', app_uid(), true, 'big', null, true) returning id into pid;
  insert into tier_pick (year, project_id, tier_id, reason, picked_by, kind) values (p_year, pid, p_tier, r, app_uid(), 'new');
  return pid;
end $$;

-- ---------- 二、研究单元都用课题的钱 ----------
-- 年度预算只编在课题上
create function trg_budget_topic_only() returns trigger language plpgsql as $$
begin
  if (select layer from project where id = new.project_id) = 'paper' then
    raise exception '研究单元不设预算行：研究单元使用所属课题的预算，请在课题的年度预算中填报';
  end if;
  return new;
end $$;
create trigger budget_topic_only before insert on project_budget for each row execute function trg_budget_topic_only();

-- 本人是否已在某个已立项的课题或研究单元的名单里（含负责人、副手）
create function in_any_project() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from project p where p.active and not p.proposed and is_on_project(p.id))
$$;
grant execute on function in_any_project() to app_api;

-- 能不能用这个课题的预算：财务一侧照旧；课题名单里的人，以及课题下属已成立研究单元名单里的人；
-- 中心公共开支须已在某个已立项的课题或研究单元的名单里
create or replace function can_use_project(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm('budget.compile') or has_perm('request.process')
      or case when exists (select 1 from project where id = p_project and kind = 'public') then in_any_project()
              else is_on_project(p_project)
                or exists (select 1 from project c where c.parent_id = p_project and c.active and not c.proposed and is_on_project(c.id)) end
$$;

-- 一笔申请记在谁名下：指明了研究单元的按所指；没指明的，本人在课题名单里就记在课题名下，
-- 只在一个研究单元名单里就记在那个研究单元名下，在多个研究单元名单里的须指明
create function request_owner(p_topic uuid, p_unit uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare t project; u project; n int; pick uuid; staff boolean := has_perm('budget.compile') or has_perm('request.process'); on_topic boolean;
begin
  select * into t from project where id = p_topic;
  if not found then raise exception '预算行所在的课题不存在'; end if;
  if t.kind = 'public' then
    if not (staff or in_any_project()) then
      raise exception '拦截：本人尚不在任何已立项的课题或研究单元的成员名单内，暂不能从中心公共开支申请。请先由研究单元负责人将本人加入名单，或申请成立研究单元';
    end if;
    return p_topic;
  end if;
  on_topic := is_on_project(p_topic);
  if p_unit is not null and p_unit <> p_topic then
    select * into u from project where id = p_unit;
    if not found or u.parent_id is distinct from p_topic then raise exception '所选研究单元不属于该预算行所在的课题'; end if;
    if not u.active or u.proposed then raise exception '拦截：所选研究单元尚未成立或已停用'; end if;
    if not (staff or is_on_project(p_unit)) then raise exception '拦截：本人不在该研究单元成员名单内，请研究单元负责人先将本人加入名单'; end if;
    return p_unit;
  end if;
  if p_unit = p_topic then
    if not (staff or on_topic) then raise exception '拦截：本人不在该课题成员名单内'; end if;
    return p_topic;
  end if;
  if staff then return p_topic; end if;
  select count(*), min(c.id::text)::uuid into n, pick from project c where c.parent_id = p_topic and c.active and not c.proposed and is_on_project(c.id);
  if on_topic then return p_topic; end if;
  if n = 1 then return pick; end if;
  if n = 0 then raise exception '拦截：本人不在该课题及其研究单元的成员名单内，请研究单元负责人先将本人加入名单'; end if;
  raise exception '本人在该课题下不止一个研究单元的名单内，请选择这笔申请所属的研究单元';
end $$;

-- 按现行定义改写：找不到要改的那一句就中止
create function _swap(d text, a text, b text) returns text language plpgsql as $$
begin
  if position(a in d) = 0 then raise exception '未找到要改写的语句：%', left(a, 60); end if;
  return replace(d, a, b);
end $$;

-- 支出申请：记在所属研究单元名下，由该研究单元的负责人确认
do $$
declare d text := pg_get_functiondef('public.submit_project_request(uuid, uuid, text, numeric, date, boolean, text)'::regprocedure);
begin
  d := _swap(d, 'p_path text DEFAULT NULL::text)', 'p_path text DEFAULT NULL::text, p_unit uuid DEFAULT NULL::uuid)');
  d := _swap(d, 'declare l v_line;', 'declare tgt uuid; l v_line;');
  d := _swap(d, 'if not can_use_project(pj.id) then raise exception ''拦截：本人不在该研究单元成员名单内，请研究单元负责人先将本人加入名单''; end if;', 'tgt := request_owner(pj.id, p_unit);');
  d := _swap(d, 'update expense_request set project_id = l.project_id, budget_line_id = p_line where id = rid;', 'update expense_request set project_id = tgt, budget_line_id = p_line where id = rid;');
  d := _swap(d, '''request.confirm'', pj.id)', '''request.confirm'', tgt)');
  execute d;
end $$;
drop function submit_project_request(uuid, uuid, text, numeric, date, boolean, text);
select expose('submit_project_request(uuid, uuid, text, numeric, date, boolean, text, uuid)');

-- 资源申领：同上，由所属研究单元的负责人批示
do $$
declare d text := pg_get_functiondef('public.save_resource_request(uuid, text, uuid, uuid, numeric, date, text, text, boolean)'::regprocedure);
begin
  d := _swap(d, 'p_urgent boolean DEFAULT false)', 'p_urgent boolean DEFAULT false, p_unit uuid DEFAULT NULL::uuid)');
  d := _swap(d, 'declare r resource;', 'declare tgt uuid; r resource;');
  d := _swap(d, 'if not can_use_project(l.project_id) then raise exception ''拦截：本人不在该研究单元成员名单内，请研究单元负责人先将本人加入名单''; end if;',
                'tgt := request_owner(l.project_id, p_unit); select owner_id into own from project where id = tgt;');
  d := _swap(d, 'values (p_kind, p_resource, l.project_id, p_line,', 'values (p_kind, p_resource, tgt, p_line,');
  d := _swap(d, 'project_id = l.project_id, budget_line_id = p_line, amount = p_amount', 'project_id = tgt, budget_line_id = p_line, amount = p_amount');
  execute d;
end $$;
drop function save_resource_request(uuid, text, uuid, uuid, numeric, date, text, text, boolean);
select expose('save_resource_request(uuid, text, uuid, uuid, numeric, date, text, text, boolean, uuid)');

-- 备用金：同上；原先没有核对名单，一并补上
do $$
declare d text := pg_get_functiondef('public.save_petty_cash(uuid, numeric, text, uuid)'::regprocedure);
begin
  d := _swap(d, 'p_line uuid)', 'p_line uuid, p_unit uuid DEFAULT NULL::uuid)');
  d := _swap(d, 'declare pu text', 'declare tgt uuid; pu text');
  d := _swap(d, 'l := open_line(p_line);', 'l := open_line(p_line); tgt := request_owner(l.project_id, p_unit);');
  d := _swap(d, 'values (app_uid(), l.project_id, p_line,', 'values (app_uid(), tgt, p_line,');
  d := _swap(d, 'project_id = l.project_id, budget_line_id = p_line, updated_at', 'project_id = tgt, budget_line_id = p_line, updated_at');
  execute d;
end $$;
drop function save_petty_cash(uuid, numeric, text, uuid);
select expose('save_petty_cash(uuid, numeric, text, uuid, uuid)');

-- 预算填报的提示语：填报的是课题的预算
do $$
declare d text;
begin
  d := pg_get_functiondef('public.save_budget_line(uuid, integer, uuid, uuid, text, numeric, numeric, numeric, numeric)'::regprocedure);
  execute _swap(d, '研究单元', '课题');
  d := pg_get_functiondef('public.set_project_budget(integer, uuid, text, text)'::regprocedure);
  execute _swap(d, '研究单元', '课题');
  d := pg_get_functiondef('public.delete_budget_line(uuid)'::regprocedure);
  execute _swap(d, '研究单元', '课题');
  -- 预算行之间的调剂由课题负责人办
  d := pg_get_functiondef('public.shift_budget(uuid, uuid, numeric, text)'::regprocedure);
  execute _swap(d, '研究单元', '课题');
end $$;

drop function _swap(text, text, text);
