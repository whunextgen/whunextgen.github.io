-- 实际币兑换 API key（黄济民 2026-11-28 定的执行细则：API 额度和 GPU 卡时一律用实际币兑换；课题不直接兑换资源）
--   一、换：研究单元负责人用单元账上的实际币，按本季度公布的比例（coin_quarter.api_rate，1 实际币兑多少元 API 额度）
--       换 API 额度，记在研究单元名下（api_grant），从单元的实际币账上扣（unit_coin，kind = api）。本季度比例未公布的不能换。
--   二、分：负责人把换得的额度分给本研究单元名单内的成员（负责人本人也可以），生成一笔已批准、不挂预算行的接口额度申请
--       （resource_request.via_coin）。之后复用现有的分发和密钥：财务岗在「资源调配」分发，在额度台账发放密钥（加密保存），
--       成员在「资源申领」取用，每次取用留记录；负责人在研究单元页「接口额度」收回。
--   三、分出去的额度在成员撤回、被驳回时回到研究单元名下，可以再分；分发后收回的不退回（细则未规定，取最简单的做法）。
--   GPU 卡时仍由研究单元用 buy_compute 换，标价跟着季度公布走（0164）。

alter table unit_coin drop constraint unit_coin_kind_check;
alter table unit_coin add constraint unit_coin_kind_check check (kind in ('invest','compute','budget','api'));

create table api_grant (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references project,
  quota      numeric(14,2) not null check (quota > 0),          -- 换得的 API 额度（元）
  coins      numeric(14,2) not null check (coins > 0),          -- 用去的实际币
  rate       numeric(12,4) not null,                            -- 当时的比例：1 实际币兑多少元
  q_start    date not null references coin_quarter,
  bought_by  uuid not null references app_user,
  bought_at  timestamptz not null default now()
);
create index on api_grant (project_id);
select seal('api_grant');
create trigger audit after insert or update or delete on api_grant for each row execute function trg_audit();

-- 研究单元分给成员的额度：不挂预算行
alter table resource_request alter column budget_line_id drop not null;
alter table resource_request add column via_coin boolean not null default false;
alter table resource_request add constraint resource_request_via_coin_check
  check (case when via_coin then kind = 'api' and budget_line_id is null else budget_line_id is not null end);

-- 研究单元名下还没分出去的 API 额度：换得的减去分给成员的（撤回、驳回的不算）
create function unit_api_left(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(quota) from api_grant where project_id = p_project), 0)
       - coalesce((select sum(coalesce(approved_amount, amount)) from resource_request where project_id = p_project and via_coin and status in ('approved','fulfilled')), 0)
$$;

-- 研究单元换 API 额度：由负责人办理，按本季度公布的比例从研究单元的账上扣
create function buy_api_quota(p_project uuid, p_coins numeric) returns uuid language plpgsql security definer set search_path = public as $$
declare q coin_quarter; p project; amt numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = date_trunc('quarter', app_today())::date;
  if not found then raise exception '本季度的兑换比例尚未公布，请等财务岗公布'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception 'API 额度由研究单元换'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  if p_coins is null or p_coins <= 0 or p_coins <> round(p_coins, 2) then raise exception '换出的实际币须大于 0，最多两位小数'; end if;
  if unit_coin_balance(p_project) < p_coins then raise exception '研究单元的实际币不足：需要 %，账上 %', p_coins, unit_coin_balance(p_project); end if;
  amt := round(p_coins * q.api_rate, 2);
  if amt <= 0 then raise exception '换得的额度不足 0.01 元'; end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'api', -p_coins, app_uid(), format('换 %s 元 API 额度', amt));
  insert into api_grant (project_id, quota, coins, rate, q_start, bought_by) values (p_project, amt, p_coins, q.api_rate, q.q_start, app_uid()) returning api_grant.id into v_id;
  return v_id;
end $$;

-- 分给名单内的成员：生成一笔已批准的接口额度申请，交财务岗分发并发放密钥
create function assign_api_quota(p_project uuid, p_user uuid, p_quota numeric, p_note text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare p project; nt text := nullif(btrim(coalesce(p_note, '')), ''); who text; left_ numeric; rid uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception 'API 额度由研究单元分给成员'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  select name into who from app_user where id = p_user and active;
  if who is null then raise exception '成员不存在或已停用'; end if;
  if not (p_user = p.owner_id or exists (select 1 from project_member m where m.project_id = p_project and m.user_id = p_user and m.left_on is null)) then
    raise exception 'API 额度只分给本研究单元名单内的成员';
  end if;
  if p_quota is null or p_quota <= 0 or p_quota <> round(p_quota, 2) then raise exception '分出的额度须大于 0，最多两位小数'; end if;
  left_ := unit_api_left(p_project);
  if p_quota > left_ then raise exception '研究单元换得的 API 额度还剩 %，不够分 %。先用实际币换 API 额度', left_, p_quota; end if;
  if length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '说明中不得填写密钥'; end if;
  insert into resource_request (kind, resource_id, project_id, budget_line_id, requested_by, amount, period, purpose, usage_note, status,
                                reviewed_by, reviewed_at, approved_amount, decided_by, decided_at, via_coin)
  values ('api', null, p_project, null, p_user, p_quota, null, format('研究单元「%s」用实际币换的 API 额度', p.name), nt, 'approved',
          app_uid(), now(), p_quota, app_uid(), now(), true)
  returning id into rid;
  perform notify_role('finance', format('待分发：研究单元「%s」把 %s 元 API 额度分给 %s，请在「资源调配」分发，并在额度台账发放密钥', p.name, p_quota, who));
  if p_user <> app_uid() then
    perform notify_user(p_user, format('研究单元「%s」给你分了 %s 元 API 额度，财务岗分发并发放密钥后，在「资源申领」取用', p.name, p_quota));
  end if;
  return rid;
end $$;

select expose('unit_api_left(uuid)', 'buy_api_quota(uuid, numeric)', 'assign_api_quota(uuid, uuid, numeric, text)');

-- 研究单元换得的 API 额度：全中心看得到，与换得的卡时一样
create view api.api_grant as
  select g.id, g.project_id, p.code as project_code, p.name as project_name, g.quota, g.coins, g.rate, g.q_start,
         (select name from app_user where id = g.bought_by) as bought_by_name, g.bought_at
  from api_grant g join project p on p.id = g.project_id where app_role() is not null;
grant select on api.api_grant to app_api;

-- 研究单元的实际币账：加上换得的 API 额度和还没分出去的
create or replace view api.unit_coin_balance as
  select p.id as project_id, unit_coin_balance(p.id) as balance,
         coalesce((select sum(hours) from compute_grant g where g.project_id = p.id), 0) as hours,
         (p.owner_id = app_uid() or app_role() = 'director') as can_buy,
         coalesce((select sum(quota) from api_grant g where g.project_id = p.id), 0) as api_quota,
         unit_api_left(p.id) as api_left
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;

-- 资源申请带上是否由研究单元用实际币换来分给成员的
create or replace view api.resource_request as
SELECT q.id,
    q.kind,
    q.resource_id,
    r.name AS resource_name,
    r.unit,
    q.project_id,
    p.code AS project_code,
    p.name AS project_name,
    q.requested_by,
    u.name AS requester_name,
    q.amount,
    q.period,
    q.purpose,
    q.usage_note,
    q.urgent,
    q.status,
    q.reviewed_at,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = q.reviewed_by)) AS reviewed_by_name,
    q.approved_amount,
    q.decided_at,
    ( SELECT app_user.name
           FROM app_user
          WHERE (app_user.id = q.decided_by)) AS decided_by_name,
    q.decide_note,
    q.fulfilled_at,
    q.created_at,
    (((p.owner_id IS NOT NULL) AND (p.owner_id = app_uid())) OR has_scoped('resource.review'::text, p.id)) AS my_project,
    q.budget_line_id,
    bl.purpose AS line_purpose,
    bl.plan_qty,
    ((q.kind = 'asset'::text) AND (q.resource_id IS NOT NULL) AND asset_priority(q.resource_id, q.requested_by)) AS priority,
    q.plan_add,
    q.via_coin
   FROM ((((resource_request q
     JOIN app_user u ON ((u.id = q.requested_by)))
     LEFT JOIN resource r ON ((r.id = q.resource_id)))
     LEFT JOIN project p ON ((p.id = q.project_id)))
     LEFT JOIN project_budget_line bl ON ((bl.id = q.budget_line_id)))
  WHERE (has_perm('read.resource'::text) OR (q.requested_by = app_uid()) OR (p.owner_id = app_uid()) OR has_scoped('resource.review'::text, p.id));
