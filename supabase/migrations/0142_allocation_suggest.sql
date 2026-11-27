-- 经费卡由财务岗手动匹配，系统只推荐（黄济民 2026-11-27「自动匹配经费卡这个不行，必须给王菲对应调整的空间，也就是财务在这里得手动匹配，自动智能用来推荐」）
--   原来「审核通过并下达」时系统按算法把明细直接分到经费卡（0129）。陈焱凯 P-16 的 1 万就这样被分到了一张
--   还没有「API」可报销答复的卡上，财务岗事先看不到、也没有机会调整，结果课题下达了却提不了支出。
--   现在：
--     一、审核下达不再自动分配。课题的每一行都已由财务岗分配到经费卡（合计等于核定数）才能下达，否则列出未分配的行。
--     二、suggest_allocation 只计算、不写入：按原算法（优先级、到期回收优先、可用余额）给出这一行的推荐分配，
--        供分配对话框预填；财务岗核对每张卡能否列支这类支出后修改、保存。
--   年度整体的「自动分配」函数保留给旧年度，页面上不再提供一键自动分配。

create function suggest_allocation(p_line uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare l record; c record; need numeric; cap numeric; take numeric; out jsonb := '[]'::jsonb;
begin
  perform need_role('finance','director');
  select v.id, v.year, v.category_id, coalesce(v.fixed, 0) as fixed into l from v_line v where v.id = p_line;
  if not found then raise exception '该预算行不存在'; end if;
  need := l.fixed;
  for c in select k.id as card_id, m.subject_id
           from fund_card k join template_subject s on s.template_id = k.template_id
           join category_subject m on m.subject_id = s.id and m.category_id = l.category_id
           where k.status = 'active' and k.start_date <= make_date(l.year, 12, 31) and k.cutoff_date >= make_date(l.year, 1, 1)
           order by coalesce(k.priority, 100), case k.end_rule when 'recall' then 0 when 'return' then 1 else 2 end, coalesce(k.settle_date, k.cutoff_date), k.card_no, s.sort loop
    exit when need <= 0;
    -- 可分配额：经费卡该科目可用额，减去其他预算行已占用（未用部分）；本行原有的分配不算占用，推荐是整行重新分
    select coalesce(avail(c.card_id, c.subject_id), 0) - coalesce(sum(greatest(x.amount - x.used, 0)), 0) into cap
    from v_alloc x join project_budget_line pl on pl.id = x.line_id join project_budget b on b.id = pl.budget_id join budget_year by on by.year = b.year
    where x.card_id = c.card_id and x.subject_id = c.subject_id and by.stage <> 'closed' and x.line_id <> p_line;
    take := least(need, greatest(coalesce(cap, 0), 0));
    if take > 0 then
      out := out || jsonb_build_object('card_id', c.card_id, 'subject_id', c.subject_id, 'amount', take);
      need := need - take;
    end if;
  end loop;
  return jsonb_build_object('parts', out, 'short', greatest(need, 0));
end $$;
insert into rbac_fn (fn, sig, perm) values ('suggest_allocation', '*', 'budget.issue') on conflict do nothing;

-- 审核下达：不再自动分配，要求各行已由财务岗分配完毕
do $$
declare d text := pg_get_functiondef('public.issue_topic(int, uuid, text)'::regprocedure); n text;
begin
  n := replace(d, $o$  short := allocate_topic(p_year, p_project);
  if short > 0 then
    select string_agg(format('%s %s 元', c.name, to_char(v.fixed - v.allocated, 'FM999,999,990.00')), '、') into bad
    from v_line v join budget_category c on c.id = v.category_id where v.year = p_year and v.project_id = p_project and v.fixed > v.allocated;
    raise exception '经费卡上对应科目的可用余额不够，未能分配：%。请先在年度预算页逐行手工分配到经费卡，再审核下达', bad;
  end if;$o$, $n$  select string_agg(format('%s「%s」还差 %s 元', c.name, v.purpose, to_char(v.fixed - v.allocated, 'FM999,999,990.00')), '、') into bad
  from v_line v join budget_category c on c.id = v.category_id where v.year = p_year and v.project_id = p_project and coalesce(v.fixed, 0) > v.allocated;
  if bad is not null then
    raise exception '以下预算行尚未分配到经费卡：%。请先在「各预算行分配情况」中逐行分配（对话框已按推荐预填，请核对后保存），再审核下达', bad;
  end if;$n$);
  if n = d then raise exception 'issue_topic 没有改上'; end if;
  execute n;
end $$;
