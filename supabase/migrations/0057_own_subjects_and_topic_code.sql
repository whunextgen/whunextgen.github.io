-- 一、经费卡自编的预算科目只在本卡显示。
-- 现行预算的视图按模板取科目，把别的卡自编的预算科目也带了进来（金额为 0，但能看到、能点改名）。

create or replace view v_budget as
select c.id as card_id, s.id as subject_id, s.code as subject_code, s.name as subject_name, s.sort,
       coalesce(b.amount, 0) as orig,
       coalesce(a.adj, 0)    as adj,
       coalesce(b.amount, 0) + coalesce(a.adj, 0) as cur
from fund_card c
join template_subject s on s.template_id = c.template_id and (s.card_id is null or s.card_id = c.id)
left join budget_line b on b.card_id = c.id and b.subject_id = s.id
left join (
  select ch.card_id, l.subject_id, sum(l.delta) as adj
  from budget_change ch join budget_change_line l on l.change_id = ch.id
  where ch.status = 'approved'
  group by 1, 2
) a on a.card_id = c.id and a.subject_id = s.id;

-- 二、课题编号留空时自动生成，与立项申请同一套编号（P-两位序号）。
do $$
declare d text := pg_get_functiondef('public.save_project(uuid, text, text, text, uuid, boolean, uuid)'::regprocedure); n text;
begin
  n := regexp_replace(d, $re$if c = '' then raise exception '[^']*编号[^']*'; end if;$re$, $new$if c = '' then
    declare seq int;
    begin
      perform pg_advisory_xact_lock(hashtext('project_code:new'));
      select coalesce(max(substring(code from '^P-(\d+)$')::int), 0) + 1 into seq from project where code ~ '^P-\d+$';
      loop
        c := 'P-' || lpad(seq::text, 2, '0');
        exit when not exists (select 1 from project where code = c);
        seq := seq + 1;
      end loop;
    end;
  end if;$new$);
  if n = d then raise exception '未找到课题编号的检查位置'; end if;
  execute n;
end $$;
