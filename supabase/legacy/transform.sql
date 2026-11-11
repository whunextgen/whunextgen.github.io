-- 把 legacy.record 里的旧门户数据转成新表。可重复执行。
-- 旧门户只有一套自定义科目，这里先建一个过渡模板承接历史预算和支出；
-- 各卡真实的科目表、比例上限、考核节点、单据截止日由财务岗在新系统里重设。

-- 用户：open_id 因应用而异，这里只带邮箱，首次飞书登录时认领
insert into app_user (name, email, role, legacy_serial)
select fields->>'name', nullif(lower(fields->>'email'), ''),
       case fields->>'role' when 'finance' then 'finance' when 'leader' then 'leader' else 'member' end,
       fields->>'serial'
from legacy.record
where table_id = 'users' and coalesce(fields->>'name', '') <> ''
on conflict (legacy_serial) do nothing;

-- 旧表的飞书账号字段带 open_id（属于导出所用的应用，登录须用同一个应用）。直接绑定，登录时不依赖邮箱。
-- 先清掉登录时因认不出而新建的空账号（有业务记录的会因外键报错，需人工处理），再绑定；重复出现的 open_id 不绑。
create temp view legacy_oid as
select fields->>'serial' as serial, fields->>'open_id' as open_id
from legacy.record
where table_id = 'users' and coalesce(fields->>'open_id', '') <> ''
  and fields->>'open_id' in (select fields->>'open_id' from legacy.record where table_id = 'users' group by 1 having count(*) = 1);

delete from app_user u using legacy_oid o
where u.feishu_open_id = o.open_id and u.legacy_serial is null;

update app_user u set feishu_open_id = o.open_id, updated_at = now()
from legacy_oid o
where u.legacy_serial = o.serial and u.feishu_open_id is null
  and not exists (select 1 from app_user x where x.feishu_open_id = o.open_id);

drop view legacy_oid;

insert into card_template (code, name) values ('LEGACY', '旧门户科目（过渡）') on conflict (code) do nothing;

insert into template_subject (template_id, code, name, sort)
select t.id, r.fields->>'id', (r.fields->'data'->>'parent') || ' / ' || (r.fields->>'name'),
       coalesce(nullif(regexp_replace(r.fields->>'id', '\D', '', 'g'), '')::int, 0)
from legacy.record r, card_template t
where r.table_id = 'entity' and r.fields->>'type' = 'category' and t.code = 'LEGACY'
on conflict (template_id, code) do nothing;

insert into fund_card (card_no, name, template_id, start_date, cutoff_date, settle_date, end_rule, rule_note)
select d->>'project_number', d->>'name', t.id,
       coalesce(nullif(d->>'start_date', '')::date, (d->>'created_at')::timestamptz::date),
       (d->>'reclaim_date')::date,
       case when d->>'funding_type' = '财政' then (d->>'reclaim_date')::date end,
       case when d->>'funding_type' = '财政' then 'recall' else 'carry' end,
       '旧门户导入（' || (d->>'funding_type') || '）。单据截止日暂取回收日期，待财务岗核对。旧 ID ' || (r.fields->>'id')
from legacy.record r cross join lateral (select r.fields->'data' as d) x, card_template t
where r.table_id = 'entity' and r.fields->>'type' = 'funding_project' and t.code = 'LEGACY'
on conflict (card_no) do nothing;

create temp view legacy_card as
select r.fields->>'id' as legacy_id, c.id as card_id
from legacy.record r join fund_card c on c.card_no = r.fields->'data'->>'project_number'
where r.table_id = 'entity' and r.fields->>'type' = 'funding_project';

-- 年初预算：旧门户里生效的预算行，按卡 × 科目合计
insert into budget_line (card_id, subject_id, amount)
select lc.card_id, s.id, sum((r.fields->'data'->>'amount')::numeric)
from legacy.record r
join legacy_card lc on lc.legacy_id = r.fields->'data'->>'project_id'
join fund_card c on c.id = lc.card_id
join template_subject s on s.template_id = c.template_id and s.code = r.fields->'data'->>'category_id'
where r.table_id = 'entity' and r.fields->>'type' = 'budget' and r.fields->>'status' = '生效'
group by 1, 2
on conflict (card_id, subject_id) do nothing;

-- 已确认的历史支出：每条分摊是一笔已入账的支出
insert into expense_type (name) values ('旧门户导入') on conflict (name) do nothing;

insert into expense_request (code, card_id, subject_id, expense_type_id, title, amount, eta_date, status, legacy_id)
select null, lc.card_id, s.id, t.id,
       coalesce(nullif(d->>'description', ''), d->>'name'), (a.value->>'amount')::numeric, (d->>'expense_date')::date,
       'posted', (r.fields->>'id') || ':' || a.ordinality
from legacy.record r
cross join lateral (select r.fields->'data' as d) x
cross join lateral jsonb_array_elements(d->'allocations') with ordinality a
join legacy_card lc on lc.legacy_id = a.value->>'project_id'
join fund_card c on c.id = lc.card_id
join template_subject s on s.template_id = c.template_id and s.code = d->>'category_id'
join expense_type t on t.name = '旧门户导入'
where r.table_id = 'entity' and r.fields->>'type' = 'expense' and r.fields->>'status' = '已确认'
on conflict (legacy_id) do nothing;

insert into voucher (request_id, posted_on, amount)
select e.id, e.eta_date, e.amount from expense_request e
where e.legacy_id is not null and e.status = 'posted'
on conflict (request_id) do nothing;

drop view legacy_card;
