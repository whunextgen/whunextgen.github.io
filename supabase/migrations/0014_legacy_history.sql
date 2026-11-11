-- 旧门户的数据全部进来。
-- legacy.record 是导入时装进来的旧门户原始数据（密钥和访问码已在装入前剔除），从暂存改为长期保留的历史档案。
-- 在新系统里有对应位置的，转成正式数据：考核节点、资产目录、资产发放台账、接口资源池。
-- 没有对应位置的（晨星按月预算及明细、资源申请、额度台账、预算调整版本、附件表格等），原样保留，通过只读视图查看。

comment on table legacy.record is '旧门户原始数据，长期保留作为历史档案';

alter table resource add column legacy_id text unique;
alter table resource_allocation add column legacy_id text unique;

create function legacy_num(t text) returns numeric language sql immutable as $$
  select case when replace(t, ',', '') ~ '^-?\d+(\.\d+)?$' then replace(t, ',', '')::numeric end
$$;
create function legacy_ts(t text) returns timestamptz language sql stable as $$
  select case when t ~ '^\d{12,14}$' then to_timestamp(t::bigint / 1000.0)
              when t ~ '^\d{4}-\d{2}-\d{2}T' then t::timestamptz
              when t ~ '^\d{4}-\d{2}-\d{2}$' then t::date::timestamptz end
$$;
create function my_name() returns text language sql stable security definer set search_path = public as $$
  select name from app_user where id = app_uid()
$$;

-- ---------- 资产：一类资产可以有库存数量，按件发给多人 ----------
create or replace function save_resource(p_id uuid, p_kind text, p_name text, p_ref text default null, p_total numeric default null,
                              p_unit text default null, p_note text default null, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); rf text := nullif(btrim(coalesce(p_ref, '')), '');
  un text := nullif(btrim(coalesce(p_unit, '')), ''); nt text := nullif(btrim(coalesce(p_note, '')), ''); rid uuid;
begin
  perform need_role('finance','director');
  if p_kind is null or p_kind not in ('api','asset') then raise exception '类型只能是接口配额或资产'; end if;
  if n = '' then raise exception '请填写名称'; end if;
  if length(n) > 60 then raise exception '名称不能超过 60 个字'; end if;
  if length(un) > 10 then raise exception '单位不能超过 10 个字'; end if;
  if length(nt) > 300 then raise exception '备注不能超过 300 个字'; end if;
  if length(rf) > 40 or rf ~ '[A-Za-z0-9_\-]{24,}' or rf ~* '^(sk-|ak-|akia|ghp_|xox|bearer )[A-Za-z0-9_\-]{8,}' then
    raise exception '编号一栏只填保管库里的编号或掩码（例如 sk-…a3f9），不要填密钥本身';
  end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '备注里不要填密钥'; end if;
  if p_total is not null and p_total <= 0 then raise exception '总配额必须大于 0'; end if;
  if exists (select 1 from resource where kind = p_kind and name = n and id is distinct from p_id) then
    raise exception '已经有叫「%」的资源', n;
  end if;
  if p_id is null then
    insert into resource (kind, name, ref, total, unit, note, active)
    values (p_kind, n, rf, p_total, un, nt, coalesce(p_active, true)) returning id into rid;
  else
    update resource set name = n, ref = rf, total = p_total, unit = un, note = nt, active = coalesce(p_active, true)
    where id = p_id returning id into rid;
    if rid is null then raise exception '资源不存在'; end if;
    if p_total is not null and p_total < (select coalesce(sum(quota), 0) from resource_allocation a
        where a.resource_id = rid and a.returned_on is null and (a.to_date is null or a.to_date >= app_today())) then
      raise exception '总配额不能低于已经分出去的配额';
    end if;
  end if;
  return rid;
end $$;

create or replace function allocate_resource(p_resource uuid, p_user uuid, p_quota numeric default null, p_from date default null,
                                  p_to date default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare r resource; f date := coalesce(p_from, app_today()); out_ numeric; aid uuid; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform need_role('finance','director');
  select * into r from resource where id = p_resource for update;
  if not found then raise exception '资源不存在'; end if;
  if not r.active then raise exception '「%」已停用，不能再分配', r.name; end if;
  if not exists (select 1 from app_user where id = p_user and active) then raise exception '使用人不存在或已停用'; end if;
  if p_to is not null and p_to < f then raise exception '到期日不能早于起始日'; end if;
  if length(nt) > 200 then raise exception '备注不能超过 200 个字'; end if;
  if nt ~ '[A-Za-z0-9_\-]{32,}' then raise exception '备注里不要填密钥'; end if;
  if r.kind = 'asset' then
    if r.total is null then
      -- 单件资产：一次只能在一个人名下
      if exists (select 1 from resource_allocation where resource_id = p_resource and returned_on is null) then
        raise exception '「%」还在别人名下，先登记归还', r.name;
      end if;
      p_quota := null;
    else
      -- 有库存数量的一类资产：按件数发放，发出去的不超过库存
      p_quota := coalesce(p_quota, 1);
      if p_quota <= 0 or p_quota <> trunc(p_quota) then raise exception '数量要填正整数'; end if;
      select coalesce(sum(quota), 0) into out_ from resource_allocation where resource_id = p_resource and returned_on is null;
      if out_ + p_quota > r.total then raise exception '「%」库存 %，已发出 %，不够再发 %', r.name, r.total, out_, p_quota; end if;
    end if;
  else
    if p_quota is not null and p_quota <= 0 then raise exception '配额必须大于 0'; end if;
    if r.total is not null then
      if p_quota is null then raise exception '「%」设了总配额，分配时要填配额', r.name; end if;
      select coalesce(sum(quota), 0) into out_ from resource_allocation
        where resource_id = p_resource and returned_on is null and (to_date is null or to_date >= app_today());
      if out_ + p_quota > r.total then raise exception '「%」剩余配额 %，不足 %', r.name, r.total - out_, p_quota; end if;
    end if;
  end if;
  insert into resource_allocation (resource_id, user_id, quota, from_date, to_date, note, created_by)
  values (p_resource, p_user, p_quota, f, p_to, nt, app_uid()) returning id into aid;
  return aid;
end $$;


-- ---------- 转成正式数据（可重复执行；没有旧数据时什么也不做） ----------
create view legacy.entity as
  select r.fields->>'type' as type, r.fields->>'status' as status, r.fields->>'id' as id, r.fields->'data' as d
  from legacy.record r where r.table_id = 'entity';

create function legacy_import() returns void language plpgsql as $fn$
begin

-- 考核节点：旧门户按目标金额记，这里换算成占总经费的比例。比例超过 100% 的（录入有误）不导入，留在历史档案里。
insert into card_node (card_id, node_date, ratio, consequence)
select c.id, (m.d->>'target_date')::date,
       round(legacy_num(m.d->>'target_amount') / legacy_num(p.d->>'total_amount'), 4), '旧门户导入，后果待补'
from legacy.entity m join legacy.entity p on p.type = 'funding_project' and p.id = m.d->>'project_id'
join fund_card c on c.card_no = p.d->>'project_number'
where m.type = 'milestone' and m.status is distinct from '作废' and legacy_num(p.d->>'total_amount') > 0
  and legacy_num(m.d->>'target_amount') > 0 and legacy_num(m.d->>'target_amount') <= legacy_num(p.d->>'total_amount')
on conflict (card_id, node_date) do nothing;

-- 资产目录 → 资源（资产）。库存取目录库存和已发数量里较大的一个，保证已发的都装得下。
insert into resource (kind, name, ref, total, unit, note, active, legacy_id)
select 'asset', c.d->>'name', left(nullif(c.d->>'spec', ''), 40),
       greatest(coalesce(legacy_num(c.d->>'stock_quantity'), 0),
                coalesce((select sum(legacy_num(l.d->>'quantity')) from legacy.entity l where l.type = 'asset_ledger' and l.status <> '已作废' and l.d->>'catalog_id' = c.id), 0), 1),
       left(nullif(c.d->>'unit', ''), 10),
       left(concat_ws('；', nullif(c.d->>'category', ''), nullif(c.d->>'asset_nature', ''), nullif(c.d->>'bundle', ''),
                      '存放 ' || nullif(c.d->>'location', ''), '标准单价 ' || nullif(c.d->>'standard_unit_price', '')), 300),
       c.status = '启用', c.id
from legacy.entity c where c.type = 'asset_catalog_item'
on conflict do nothing;

-- 资产发放台账 → 分配记录。作废的记为已收回。
insert into resource_allocation (resource_id, user_id, quota, from_date, note, returned_on, legacy_id)
select res.id, u.id, coalesce(legacy_num(l.d->>'quantity'), 1), legacy_ts(l.d->>'created_at')::date,
       left(concat_ws('；', '旧门户：' || (l.d->>'action'), nullif(l.d->>'note', ''), case when l.status = '已作废' then '已作废' end), 200),
       case when l.status = '已作废' then coalesce(legacy_ts(l.d->>'voided_at'), legacy_ts(l.d->>'updated_at'))::date end, l.id
from legacy.entity l join resource res on res.legacy_id = l.d->>'catalog_id' join app_user u on u.name = l.d->>'leader_name'
where l.type = 'asset_ledger' and legacy_ts(l.d->>'created_at') is not null
on conflict do nothing;

-- 接口资源池 → 资源（接口配额）。密钥不在旧数据里，也不进系统。
insert into resource (kind, name, total, unit, note, active, legacy_id)
select 'api', left(concat_ws(' ', nullif(p.d->>'provider', ''), nullif(p.d->>'model', '')), 60), legacy_num(p.d->>'purchased_amount'),
       left(coalesce(nullif(p.d->>'currency', ''), '元'), 10),
       left(concat_ws('；', '旧门户资源池「' || (p.d->>'name') || '」', '余额 ' || nullif(p.d->>'balance_amount', ''),
                      '旧门户已分配 ' || nullif(p.d->>'allocated_amount', ''), '数据截至 ' || left(p.d->>'updated_at', 10)), 300),
       p.status is distinct from '停用', p.id
from legacy.entity p where p.type = 'api_resource_pool' and legacy_num(p.d->>'purchased_amount') > 0
on conflict do nothing;

end $fn$;
revoke all on function legacy_import() from public;
select legacy_import();

-- ---------- 历史档案的只读视图 ----------
-- 晨星按月预算：负责人上传的预算表（一次提交）和逐行审核的明细。财务岗、中心负责人看全部，负责人看自己的。
create view api.legacy_ms_submission as
  select d->>'id' as id, d->>'leader_name' as leader_name, d->>'file_name' as file_name,
         legacy_ts(d->>'submitted_at') as submitted_at, legacy_num(d->>'total_amount') as total,
         legacy_num(d->>'approved_amount') as approved, legacy_num(d->>'pending_amount') as pending, legacy_num(d->>'rejected_amount') as rejected,
         r.fields->>'status' as status,
         coalesce(nullif(d->>'finance_comment', ''), nullif(d->>'withdraw_reason', ''), nullif(d->>'void_reason', '')) as comment
  from legacy.record r cross join lateral (select r.fields->'data' as d) x
  where r.table_id = 'entity' and r.fields->>'type' = 'morningstar_budget_submission'
    and (is_staff() or d->>'leader_name' = my_name());

create view api.legacy_ms_item as
  select d->>'id' as id, d->>'submission_id' as submission_id, d->>'leader_name' as leader_name, d->>'serial' as serial,
         d->>'expense_type' as expense_type, d->>'parent_category' as parent_category,
         legacy_num(d->>'quantity') as quantity, legacy_num(d->>'unit_amount') as unit_amount,
         legacy_num(d->>'requested_amount') as requested, legacy_num(d->>'approved_amount') as approved,
         nullif(d->>'note', '') as note, nullif(d->>'finance_comment', '') as comment, r.fields->>'status' as status,
         nullif(d->>'budget_project_name', '') as card_name, nullif(d->>'budget_category_name', '') as subject_name,
         coalesce(legacy_num(d->>'row_number'), 0) as row_no
  from legacy.record r cross join lateral (select r.fields->'data' as d) x
  where r.table_id = 'entity' and r.fields->>'type' = 'morningstar_budget_item'
    and (is_staff() or d->>'leader_name' = my_name());

-- 旧门户的预算调整记录：挂在对应的经费卡上，看得到卡的人就看得到
create view api.legacy_budget_adjust as
  select d->>'id' as id, c.id as card_id, d->>'category_name' as subject_name,
         legacy_num(d->>'previous_amount') as previous, legacy_num(d->>'amount') as amount,
         nullif(d->>'reason', '') as reason, legacy_num(d->>'version') as version, legacy_ts(d->>'adjusted_at') as adjusted_at
  from legacy.record r cross join lateral (select r.fields->'data' as d) x
  join legacy.record p on p.table_id = 'entity' and p.fields->>'type' = 'funding_project' and p.fields->>'id' = d->>'project_id'
  join fund_card c on c.card_no = p.fields->'data'->>'project_number'
  where r.table_id = 'entity' and r.fields->>'type' = 'budget_adjustment' and can_see_card(c.id);

-- 旧门户的资源申请（接口额度、账号等）：财务岗、中心负责人看全部，其他人看自己提的
create view api.legacy_resource_request as
  select r.record_id as id, f->>'申请人姓名' as applicant, f->>'申请类型' as kind, f->>'资源类型' as resource,
         nullif(f->>'项目', '') as project, nullif(f->>'用途', '') as purpose, nullif(f->>'预计用量说明', '') as usage,
         coalesce(legacy_num(f->>'预算金额'), legacy_num(f->>'预计金额')) as amount, nullif(f->>'建议使用期限', '') as period,
         f->>'申请状态' as status, legacy_ts(f->>'申请时间') as applied_at,
         nullif(concat_ws('；', nullif(f->>'导师审核意见', ''), nullif(f->>'财务审核意见', ''), nullif(f->>'审批意见', ''), nullif(f->>'分发说明', '')), '') as comment
  from legacy.record r cross join lateral (select r.fields as f) x
  where r.table_name = '资源申请表' and (is_staff() or f->>'申请人姓名' = my_name());

-- 旧门户的额度台账：按周期发给个人的接口额度
create view api.legacy_quota_ledger as
  select r.record_id as id, f->>'用户姓名' as user_name, f->>'资源类型' as resource, nullif(f->>'项目', '') as project,
         nullif(f->>'周期', '') as period, legacy_num(f->>'总额度') as total, legacy_num(f->>'已用额度') as used,
         legacy_num(f->>'剩余额度') as remaining, nullif(f->>'有效期', '') as valid_to
  from legacy.record r cross join lateral (select r.fields as f) x
  where r.table_name = '额度台账表' and (is_staff() or f->>'用户姓名' = my_name());

-- 全部旧数据的目录和原始记录，只有财务岗和中心负责人能看。用户表已经转成正式用户，不在这里重复。
create view api.legacy_source as
  select case when r.table_id = 'entity' then 'entity:' || (r.fields->>'type') else r.table_id end as source,
         case when r.table_id = 'entity' then r.fields->>'type' else r.table_name end as name,
         count(*)::int as n
  from legacy.record r where is_staff() and r.table_id <> 'users'
  group by 1, 2;

create view api.legacy_record as
  select case when r.table_id = 'entity' then 'entity:' || (r.fields->>'type') else r.table_id end as source,
         r.record_id, case when r.table_id = 'entity' then r.fields->>'status' end as status,
         case when r.table_id = 'entity' then r.fields->'data' else r.fields end as data
  from legacy.record r where is_staff() and r.table_id <> 'users';

grant select on api.legacy_ms_submission, api.legacy_ms_item, api.legacy_budget_adjust, api.legacy_resource_request,
                api.legacy_quota_ledger, api.legacy_source, api.legacy_record to app_api;
select expose('legacy_num(text)', 'legacy_ts(text)', 'my_name()');
