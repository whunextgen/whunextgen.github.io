-- ARR 担保名额并入中台，取代多维表格「arr 担保名额」。
-- ARR 投稿须由具备审稿资格的人担保，每人每一轮能担保的篇数有限。担保资格和每轮名额记在人上；
-- 研究单元准备投 ARR 时，负责人在研究单元页选一位有余量的担保人，对方同意后占用一个名额；撤回或对方不同意的，名额退回。
-- 轮次由人事岗开启，开启新一轮后各人的余量重新按名额起算。谁还有余量只给研究单元负责人、担保人本人和人事岗看，不公布。

create table arr_cycle (
  name      text primary key check (length(btrim(name)) between 1 and 30),
  opened_at timestamptz not null default now(),
  opened_by uuid references app_user(id)
);
create table arr_sponsor (
  user_id    uuid primary key references app_user(id),
  qualified  boolean not null default true,
  quota      int not null default 0 check (quota between 0 and 20),
  note       text,
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now()
);
create table arr_claim (
  id         uuid primary key default gen_random_uuid(),
  cycle      text not null references arr_cycle(name),
  project_id uuid not null references project(id),
  sponsor_id uuid not null references app_user(id),
  status     text not null default 'pending' check (status in ('pending','agreed','declined','withdrawn')),
  asked_by   uuid not null references app_user(id),
  asked_at   timestamptz not null default now(),
  decided_at timestamptz,
  note       text
);
-- 一个研究单元一轮只占一个名额
create unique index arr_claim_one_live on arr_claim (cycle, project_id) where status in ('pending','agreed');
create index arr_claim_sponsor on arr_claim (sponsor_id, cycle);
select seal('arr_cycle', 'arr_sponsor', 'arr_claim');
create trigger audit after insert or update or delete on arr_sponsor for each row execute function trg_audit();
create trigger audit after insert or update or delete on arr_claim   for each row execute function trg_audit();

create function arr_current() returns text language sql stable security definer set search_path = public as $$
  select name from arr_cycle order by opened_at desc, name desc limit 1
$$;
-- 某人本轮还剩几个名额：待答复的也先占着
create function arr_left(p_user uuid) returns int language sql stable security definer set search_path = public as $$
  select coalesce((select case when s.qualified then greatest(0, s.quota - (select count(*)::int from arr_claim c
            where c.sponsor_id = s.user_id and c.cycle = arr_current() and c.status in ('pending','agreed'))) else 0 end
          from arr_sponsor s where s.user_id = p_user), 0)
$$;

create function open_arr_cycle(p_name text) returns void language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, ''));
begin
  perform need_perm('people.manage');
  if n = '' then raise exception '请填写轮次名称，例如 2026 年 12 月'; end if;
  if length(n) > 30 then raise exception '轮次名称不得超过 30 个字'; end if;
  if exists (select 1 from arr_cycle where name = n) then raise exception '已有名为「%」的轮次', n; end if;
  insert into arr_cycle (name, opened_by) values (n, app_uid());
end $$;

create function save_arr_sponsor(p_user uuid, p_qualified boolean, p_quota int, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_perm('people.manage');
  if not exists (select 1 from app_user where id = p_user) then raise exception '人员不存在'; end if;
  if p_quota is null or p_quota < 0 or p_quota > 20 then raise exception '每轮名额须在 0 到 20 之间'; end if;
  if nt is not null and length(nt) > 200 then raise exception '备注不得超过 200 个字'; end if;
  insert into arr_sponsor (user_id, qualified, quota, note, updated_by) values (p_user, coalesce(p_qualified, true), p_quota, nt, app_uid())
  on conflict (user_id) do update set qualified = excluded.qualified, quota = excluded.quota, note = excluded.note, updated_by = app_uid(), updated_at = now();
end $$;

-- 申请担保：研究单元负责人提出。请本人担保的，直接生效
create function ask_arr(p_project uuid, p_sponsor uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare u project; cy text := arr_current(); s arr_sponsor; cid uuid; self boolean;
begin
  if app_uid() is null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select * into u from project where id = p_project;
  if not found or u.layer <> 'paper' or not u.active or u.proposed then raise exception '只有已成立的研究单元可以申请担保'; end if;
  if u.owner_id is distinct from app_uid() then raise exception '担保由研究单元的负责人申请' using errcode = '42501'; end if;
  if cy is null then raise exception '尚未开启 ARR 轮次，请联系人事岗'; end if;
  if exists (select 1 from arr_claim where cycle = cy and project_id = p_project and status in ('pending','agreed')) then
    raise exception '本研究单元在「%」一轮已有担保申请，撤回后方可另请他人', cy;
  end if;
  select * into s from arr_sponsor where user_id = p_sponsor for update;
  if not found or not s.qualified then raise exception '所选人员不具备 ARR 担保资格'; end if;
  if not exists (select 1 from app_user where id = p_sponsor and active) then raise exception '所选人员的账号已停用'; end if;
  if arr_left(p_sponsor) <= 0 then raise exception '所选人员在「%」一轮的名额已用完', cy; end if;
  self := p_sponsor = app_uid();
  insert into arr_claim (cycle, project_id, sponsor_id, asked_by, status, decided_at)
  values (cy, p_project, p_sponsor, app_uid(), case when self then 'agreed' else 'pending' end, case when self then now() end) returning id into cid;
  if not self then
    perform notify_user(p_sponsor, format('ARR 担保申请待答复：%s 申请由你为研究单元「%s」在「%s」一轮的 ARR 投稿担保。请在该研究单元页面答复',
      (select name from app_user where id = app_uid()), u.name, cy));
  end if;
  return cid;
end $$;

-- 答复：担保人本人
create function answer_arr(p_id uuid, p_ok boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare c arr_claim; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into c from arr_claim where id = p_id for update;
  if not found then raise exception '担保申请不存在'; end if;
  if c.sponsor_id is distinct from app_uid() then raise exception '担保申请由被请的担保人本人答复' using errcode = '42501'; end if;
  if c.status <> 'pending' then raise exception '该申请已答复或已撤回'; end if;
  if not coalesce(p_ok, false) and nt is null then raise exception '不同意的请写明原因'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  update arr_claim set status = case when p_ok then 'agreed' else 'declined' end, decided_at = now(), note = nt where id = p_id;
  perform notify_user(c.asked_by, format('ARR 担保申请%s：%s %s为研究单元「%s」在「%s」一轮担保%s',
    case when p_ok then '已同意' else '未获同意' end, (select name from app_user where id = app_uid()), case when p_ok then '同意' else '不同意' end,
    (select name from project where id = c.project_id), c.cycle, case when nt is null then '' else '。说明：' || nt end));
end $$;

-- 撤回：研究单元负责人、申请人或人事岗。名额退回担保人
create function withdraw_arr(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare c arr_claim;
begin
  select * into c from arr_claim where id = p_id for update;
  if not found then raise exception '担保申请不存在'; end if;
  if not (c.asked_by = app_uid() or exists (select 1 from project where id = c.project_id and owner_id = app_uid()) or has_perm('people.manage')) then
    raise exception '担保申请由研究单元负责人撤回' using errcode = '42501';
  end if;
  if c.status not in ('pending','agreed') then raise exception '该申请已结束，无需撤回'; end if;
  update arr_claim set status = 'withdrawn', decided_at = coalesce(decided_at, now()) where id = p_id;
  if c.sponsor_id is distinct from app_uid() then
    perform notify_user(c.sponsor_id, format('ARR 担保申请已撤回：研究单元「%s」撤回了「%s」一轮请你担保的申请，名额已退回',
      (select name from project where id = c.project_id), c.cycle));
  end if;
end $$;

select expose('open_arr_cycle(text)', 'save_arr_sponsor(uuid, boolean, int, text)', 'ask_arr(uuid, uuid)', 'answer_arr(uuid, boolean, text)', 'withdraw_arr(uuid)');

create view api.arr_cycle as
  select name, opened_at, (name = arr_current()) as current from arr_cycle where app_role() is not null;

-- 担保人和余量：只给人事岗、担保人本人和研究单元负责人看
create view api.arr_sponsor as
  select s.user_id, u.name as user_name, u.active as user_active, s.qualified, s.quota,
         (select count(*)::int from arr_claim c where c.sponsor_id = s.user_id and c.cycle = arr_current() and c.status in ('pending','agreed')) as used,
         arr_left(s.user_id) as remaining, s.note, s.updated_at
  from arr_sponsor s join app_user u on u.id = s.user_id
  where app_role() is not null and (has_perm('people.manage') or s.user_id = app_uid()
        or exists (select 1 from project p where p.owner_id = app_uid() and p.layer = 'paper' and p.active and not p.proposed));

-- 担保申请：随研究单元公开；担保人本人和人事岗也看得到
create view api.arr_claim as
  select c.id, c.cycle, (c.cycle = arr_current()) as current, c.project_id, p.code as unit_code, p.name as unit_name,
         c.sponsor_id, (select name from app_user where id = c.sponsor_id) as sponsor_name, c.status,
         (select name from app_user where id = c.asked_by) as asked_by_name, c.asked_at, c.decided_at, c.note,
         (c.status = 'pending' and c.sponsor_id = app_uid()) as can_answer,
         (c.status in ('pending','agreed') and (c.asked_by = app_uid() or p.owner_id = app_uid() or has_perm('people.manage'))) as can_withdraw
  from arr_claim c join project p on p.id = c.project_id
  where app_role() is not null and (can_see_project(c.project_id) or c.sponsor_id = app_uid() or has_perm('people.manage'));

grant select on api.arr_cycle, api.arr_sponsor, api.arr_claim to app_api;
