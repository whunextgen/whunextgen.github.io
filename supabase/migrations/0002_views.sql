-- 口径视图。余额不落表，全部由流水算出。

-- 会话上下文：API 层在每个事务开头 set_config('app.uid', ...)。
create function app_uid() returns uuid language sql stable as
$$ select nullif(current_setting('app.uid', true), '')::uuid $$;

create function app_role() returns text language sql stable security definer set search_path = public as
$$ select role from app_user where id = app_uid() and active $$;

-- 现行预算 = 年初预算 + 已批复变更
create view v_budget as
select c.id as card_id, s.id as subject_id, s.code as subject_code, s.name as subject_name, s.sort,
       coalesce(b.amount, 0) as orig,
       coalesce(a.adj, 0)    as adj,
       coalesce(b.amount, 0) + coalesce(a.adj, 0) as cur
from fund_card c
join template_subject s on s.template_id = c.template_id
left join budget_line b on b.card_id = c.id and b.subject_id = s.id
left join (
  select ch.card_id, l.subject_id, sum(l.delta) as adj
  from budget_change ch join budget_change_line l on l.change_id = ch.id
  where ch.status = 'approved'
  group by 1, 2
) a on a.card_id = c.id and a.subject_id = s.id;

-- 人员费发放日：当月 20 日
create function pay_date(m date) returns date language sql immutable as $$ select m + 19 $$;

-- 流水：每张卡每一笔钱，带日期和状态。actual 只来自学校入账。
create view v_flow as
select r.card_id, r.subject_id, v.amount, v.posted_on as flow_date, 'actual'::text as kind, 'request'::text as src
from voucher v join expense_request r on r.id = v.request_id
where r.status = 'posted'
union all
select card_id, subject_id, amount, eta_date, 'commit', 'request'
from expense_request
where status in ('committed','at_school','returned')
union all
select a.card_id, s.id, a.amount,
       coalesce(ps.posted_on, pay_date(a.month)),
       case when ps.status = 'posted' then 'actual' else 'commit' end,
       'staff'
from staff_assignment a
join pay_type pt on pt.id = a.pay_type_id
join fund_card c on c.id = a.card_id
join template_subject s on s.template_id = c.template_id and s.code = pt.subject_code
left join payroll_sheet ps on ps.id = a.sheet_id
where ps.status = 'posted'
   or pay_date(a.month) between c.start_date and c.cutoff_date;

-- 卡 × 科目：现行预算 / 承诺 / 决算数 / 可用
create view v_cell as
select b.card_id, b.subject_id, b.subject_code, b.subject_name, b.sort, b.orig, b.adj, b.cur,
       coalesce(f.commit, 0) as commit,
       coalesce(f.actual, 0) as actual,
       b.cur - coalesce(f.commit, 0) - coalesce(f.actual, 0) as avail
from v_budget b
left join (
  select card_id, subject_id,
         sum(amount) filter (where kind = 'commit') as commit,
         sum(amount) filter (where kind = 'actual') as actual
  from v_flow group by 1, 2
) f on f.card_id = b.card_id and f.subject_id = b.subject_id;

create view v_card as
select c.id as card_id, c.card_no, c.name, c.status, c.start_date, c.cutoff_date, c.settle_date, c.end_rule,
       sum(x.orig) as orig, sum(x.adj) as adj, sum(x.cur) as cur,
       sum(x.commit) as commit, sum(x.actual) as actual, sum(x.avail) as avail
from fund_card c join v_cell x on x.card_id = c.id
group by c.id;

-- 节点预测 = 已入账 + 预计在节点日前入账的承诺
create view v_node as
select n.id as node_id, n.card_id, n.node_date, n.ratio, n.consequence,
       round(t.cur * n.ratio, 2) as need,
       coalesce((select sum(f.amount) from v_flow f where f.card_id = n.card_id and f.flow_date <= n.node_date), 0) as forecast
from card_node n
join (select card_id, sum(cur) as cur from v_budget group by 1) t on t.card_id = n.card_id;

-- 人员费空档：发放日不在卡的有效期内，这笔钱发不出去
create view v_staff_gap as
select a.id as assignment_id, a.person_id, a.pay_type_id, a.month, a.card_id, a.amount,
       case when pay_date(a.month) < c.start_date then '未下达'
            when c.end_rule = 'recall' then '已回收' else '已结题' end as why
from staff_assignment a
join fund_card c on c.id = a.card_id
left join payroll_sheet ps on ps.id = a.sheet_id
where coalesce(ps.status, 'draft') <> 'posted'
  and not (pay_date(a.month) between c.start_date and c.cutoff_date);

-- 可报销规则的当前结论：取最近一条答复；最近两条在能否报销上相反时为争议
create view v_reimb_rule as
select card_id, expense_type_id, ruled_on, ruled_by, note,
       case when prev is not null and (prev = 'no') <> (verdict = 'no') then 'disputed' else verdict end as verdict
from (
  select r.*,
         lag(verdict) over w as prev,
         row_number() over (partition by card_id, expense_type_id order by ruled_on desc, created_at desc, id desc) as rn
  from reimb_ruling r
  window w as (partition by card_id, expense_type_id order by ruled_on, created_at, id)
) x
where rn = 1;

-- 比例上限检查
create view v_cap as
select c.id as card_id, k.id as cap_id, k.name, k.max_ratio,
       coalesce(sum(b.cur) filter (where ks.subject_id is not null), 0) as used,
       round(sum(b.cur) * k.max_ratio, 2) as max_amount
from fund_card c
join template_cap k on k.template_id = c.template_id
join v_budget b on b.card_id = c.id
left join template_cap_subject ks on ks.cap_id = k.id and ks.subject_id = b.subject_id
group by c.id, k.id;
