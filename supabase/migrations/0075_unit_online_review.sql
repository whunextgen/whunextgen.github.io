-- 研究单元改为联席会议在线投票立项。
--   新研究单元须由 Leader 在科研财务中台提交立项申请。联席会议成员在中台在线审核立项申请，采用简单投票，
--   赞成人数超过联席会议总人数一半的，予以立项。审核结果由中台记录存档。
-- 顺序：申请人提交 → 所挂课题的负责人（或副手）同意（申请人本人即是的，提交即视为同意）→ 联席会议在线投票 → 赞成过半即成立。
--   反对票多到赞成已不可能过半的，即为未通过，退回申请人。不再填写会议日期和纪要日期，也不再由助理对照纪要核对。
-- 联席会议成员：在册的博士研究生和博士后（按人员身份登记，晨星学者按博士后登记）。总人数在审核开始时记下，本轮审核内不变。
-- 页面只显示票数，不显示谁投了什么；每一票的增改记入审计日志存档。
alter table project add column review_opened_at timestamptz, add column review_total int;

create table unit_vote (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references project(id),
  user_id uuid not null references app_user(id),
  yes boolean not null,
  voted_at timestamptz not null default now(),
  unique (project_id, user_id));
select seal('unit_vote');
create trigger audit after insert or update or delete on unit_vote for each row execute function trg_audit();

-- 是否联席会议成员
create function unit_voter(p_user uuid default app_uid()) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from app_user where id = p_user and active and kind in ('phd','postdoc')) $$;
grant execute on function unit_voter(uuid) to app_api;

-- 开始在线审核：记下此刻联席会议的总人数，清掉上一轮的票，通知每位成员。只在所挂课题的负责人同意时调用
create function open_unit_review(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project; par project; t int;
begin
  select * into u from project where id = p_unit;
  select * into par from project where id = u.parent_id;
  select count(*) into t from app_user x where unit_voter(x.id);
  if t = 0 then raise exception '尚未登记联席会议成员（博士研究生和博士后），无法开始在线审核。请先由财务岗登记人员身份'; end if;
  delete from unit_vote where project_id = p_unit;
  update project set review_opened_at = now(), review_total = t where id = p_unit;
  perform notify_user(x.id, format('研究单元立项待审核：%s 申请在课题「%s」之下成立「%s」，课题负责人已同意。联席会议共 %s 人，赞成 %s 票及以上予以立项。请在「课题管理」中投票',
    (select name from app_user where id = u.owner_id), par.name, u.name, t, t / 2 + 1))
  from app_user x where unit_voter(x.id);
end $$;
do $$ declare r text; begin
  execute 'revoke all on function open_unit_review(uuid) from public';
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function open_unit_review(uuid) from %I', r); end if;
  end loop;
end $$;

-- 提交或修改研究单元申请：不再填写会议日期和纪要日期。重新提交时清掉原来的同意和上一轮的票，经课题负责人同意后重新审核
drop function propose_unit(uuid, uuid, text, date, date, text, text);
create function propose_unit(p_id uuid, p_parent uuid, p_name text, p_note text, p_members text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); r text := nullif(btrim(coalesce(p_note, '')), ''); par project; old project; c text; i int; uid uuid; ids uuid[] := '{}';
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if n = '' then raise exception '请填写研究单元名称'; end if;
  if length(n) > 60 then raise exception '研究单元名称不得超过 60 个字'; end if;
  if r is null then raise exception '请填写说明：研究内容，以及拟使用的经费和资源'; end if;
  if length(r) > 1000 then raise exception '说明不得超过 1000 个字'; end if;
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
    insert into project (code, name, kind, owner_id, active, layer, parent_id, proposed, apply_note, applied_at)
    values (c, n, par.kind, app_uid(), true, 'paper', p_parent, true, r, now()) returning id into uid;
  else
    select * into old from project where id = p_id for update;
    if not found or old.layer <> 'paper' or not old.proposed or old.applied_at is null then raise exception '该研究单元不是待立项的申请'; end if;
    if old.owner_id is distinct from app_uid() then raise exception '仅申请人可修改申请' using errcode = '42501'; end if;
    if old.parent_id <> p_parent then raise exception '所挂课题不得修改，请撤回后重新申请'; end if;
    update project set name = n, apply_note = r, meeting_on = null, minutes_on = null, applied_at = now(), return_note = null, checked_by = null, checked_at = null,
           parent_ok_by = null, parent_ok_at = null, review_opened_at = null, review_total = null where id = p_id;
    delete from unit_vote where project_id = p_id;
    delete from project_member where project_id = p_id;
    uid := p_id;
  end if;
  insert into project_member (project_id, user_id, joined_on, added_by)
  select uid, s.x, app_today(), app_uid() from (select distinct x from unnest(ids) x) s where s.x <> app_uid();
  if has_perm('budget.project', p_parent) then
    update project set parent_ok_by = app_uid(), parent_ok_at = now() where id = uid;
    perform open_unit_review(uid);
  else
    perform notify_user(par.owner_id, format('研究单元申请待同意：%s 申请在课题「%s」之下成立「%s」，使用该课题的预算。请在「课题管理」中同意或退回', (select name from app_user where id = app_uid()), par.name, n));
  end if;
  return uid;
end $$;

-- 所挂课题的负责人或副手同意：同意即开始联席会议在线审核
create or replace function approve_unit(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project; par project;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待立项的申请'; end if;
  if not has_perm('budget.project', u.parent_id) then raise exception '需要权限：仅所挂课题的负责人和副手可以同意' using errcode = '42501'; end if;
  if u.return_note is not null then raise exception '该申请已退回，待申请人修改后重新提交'; end if;
  if u.review_opened_at is not null then raise exception '该申请已经同意过了，正在联席会议审核'; end if;
  select * into par from project where id = u.parent_id;
  update project set parent_ok_by = app_uid(), parent_ok_at = now() where id = p_unit;
  perform open_unit_review(p_unit);
  perform notify_user(u.owner_id, format('课题「%s」的负责人已同意研究单元申请「%s」，转入联席会议在线审核', par.name, u.name));
end $$;

-- 联席会议成员投票：每人一票，审核结束前可以改投。赞成超过总人数一半的，即予立项；
-- 反对票多到赞成已不可能超过一半的，即为未通过，退回申请人
create function vote_unit(p_unit uuid, p_yes boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u project; par project; y int; n int; t text;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if not unit_voter() then raise exception '仅联席会议成员（博士研究生和博士后）可投票' using errcode = '42501'; end if;
  if p_yes is null then raise exception '请选择赞成或反对'; end if;
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待立项的申请'; end if;
  if u.return_note is not null then raise exception '该申请已退回，待申请人修改后重新提交'; end if;
  if u.review_opened_at is null then raise exception '所挂课题的负责人尚未同意，联席会议审核尚未开始'; end if;
  select * into par from project where id = u.parent_id;
  if not par.active or par.proposed then raise exception '所挂课题尚未立项或已停用'; end if;
  insert into unit_vote (project_id, user_id, yes) values (p_unit, app_uid(), p_yes)
  on conflict (project_id, user_id) do update set yes = excluded.yes, voted_at = now();
  select count(*) filter (where v.yes), count(*) filter (where not v.yes) into y, n from unit_vote v where v.project_id = p_unit;
  if y > u.review_total / 2 then
    update project set proposed = false, checked_by = null, checked_at = now() where id = p_unit;
    perform notify_user(u.owner_id, format('研究单元「%s」经联席会议在线审核通过，已成立，挂在课题「%s」之下。本人为负责人，可管理成员名单', u.name, par.name));
    perform notify_user(m.user_id, format('你已加入研究单元「%s」的成员名单，可使用课题「%s」的预算提交支出申请、申领资源', u.name, par.name))
    from project_member m where m.project_id = p_unit and m.left_on is null;
    if par.owner_id is not null and par.owner_id is distinct from u.owner_id then
      perform notify_user(par.owner_id, format('课题「%s」之下新成立研究单元「%s」，负责人 %s', par.name, u.name, (select name from app_user where id = u.owner_id)));
    end if;
  elsif n >= u.review_total - u.review_total / 2 then
    t := format('联席会议在线审核未通过：赞成 %s 票，反对 %s 票，共 %s 人', y, n, u.review_total);
    update project set parent_ok_by = null, parent_ok_at = null, return_note = t, checked_by = null, checked_at = now() where id = p_unit;
    perform notify_user(u.owner_id, format('研究单元申请「%s」已退回：%s', u.name, t));
  end if;
end $$;

-- 退回：所挂课题的负责人和录入评定结果的人，在审核有结果之前都可以退回；退回即清掉同意，本轮审核停止
create or replace function return_unit(p_unit uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare u project; n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待立项的申请'; end if;
  if not (has_perm('budget.evaluate') or has_perm('budget.project', u.parent_id)) then raise exception '需要权限：录入评定结果，或为所挂课题的负责人' using errcode = '42501'; end if;
  if n is null then raise exception '请填写退回原因'; end if;
  update project set parent_ok_by = null, parent_ok_at = null, return_note = n, checked_by = app_uid(), checked_at = now() where id = p_unit;
  perform notify_user(u.owner_id, format('研究单元申请「%s」已退回：%s', u.name, n));
end $$;

-- 成立之前，申请人可以撤回；已投的票一并删除
create or replace function withdraw_unit(p_unit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u project;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into u from project where id = p_unit for update;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null then raise exception '该研究单元不是待立项的申请'; end if;
  if u.owner_id is distinct from app_uid() and not has_perm('budget.setup') then raise exception '仅申请人和财务岗可撤回申请' using errcode = '42501'; end if;
  delete from unit_vote where project_id = p_unit;
  delete from project_member where project_id = p_unit;
  delete from project where id = p_unit;
end $$;

-- 不再由助理对照纪要核对成立，成立只能经联席会议投票
drop function confirm_unit(uuid);
select expose('propose_unit(uuid, uuid, text, text, text)', 'vote_unit(uuid, boolean)');

-- 改动前已提交、课题负责人已同意、尚未退回的申请，即刻开始在线审核；尚无联席会议成员登记的，待课题负责人再次同意时开始
do $$
declare r record;
begin
  if exists (select 1 from app_user x where unit_voter(x.id)) then
    for r in select id from project where layer = 'paper' and active and proposed and applied_at is not null and parent_ok_at is not null and return_note is null loop
      perform open_unit_review(r.id);
    end loop;
  end if;
end $$;

-- 申请一览：去掉会议日期、纪要日期和否决期；加上审核情况。status：consent 待课题负责人同意，review 联席会议审核中，established 已成立，returned 已退回。
-- 只给票数和本人的一票，不给谁投了什么。联席会议成员看得到审核中的申请
drop view api.unit_apply;
create view api.unit_apply as
  select p.id, p.code, p.name, p.parent_id, pp.code as parent_code, pp.name as parent_name, p.owner_id, (select name from app_user where id = p.owner_id) as owner_name,
         p.apply_note, p.applied_at, p.return_note, (select name from app_user where id = p.checked_by) as checked_by_name, p.checked_at, p.proposed,
         (select string_agg(u.name, '、' order by u.name) from project_member m join app_user u on u.id = m.user_id where m.project_id = p.id and m.left_on is null) as member_names,
         (select string_agg(m.user_id::text, ',') from project_member m where m.project_id = p.id and m.left_on is null) as member_ids,
         (p.owner_id is not distinct from app_uid()) as mine,
         p.parent_ok_at, (select name from app_user where id = p.parent_ok_by) as parent_ok_by_name, (select name from app_user where id = pp.owner_id) as parent_owner_name,
         (p.proposed and has_perm('budget.project', pp.id)) as can_ok,
         case when not p.proposed then 'established' when p.return_note is not null then 'returned' when p.review_opened_at is not null then 'review' else 'consent' end as status,
         p.review_opened_at, p.review_total, p.review_total / 2 + 1 as review_need, v.yes_count, v.no_count, v.my_vote,
         (p.proposed and p.return_note is null and p.review_opened_at is not null and unit_voter()) as can_vote
  from project p join project pp on pp.id = p.parent_id
  cross join lateral (select count(*) filter (where x.yes)::int as yes_count, count(*) filter (where not x.yes)::int as no_count,
                             bool_or(x.yes) filter (where x.user_id = app_uid()) as my_vote from unit_vote x where x.project_id = p.id) v
  where p.applied_at is not null and p.layer = 'paper' and p.active and app_role() is not null
    and (not p.proposed or p.owner_id = app_uid() or has_perm('budget.evaluate') or has_perm('budget.setup') or can_manage_project(pp.id) or has_perm('budget.project', pp.id)
         or (p.review_opened_at is not null and p.return_note is null and unit_voter()));
grant select on api.unit_apply to app_api;
