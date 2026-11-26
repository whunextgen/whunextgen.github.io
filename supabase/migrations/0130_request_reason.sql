-- 支出申请挑不到经费卡时，成员也看到真实原因（issue #55）
--   原来对没有财务权限的人一律提示「该预算行下达的经费卡余额不足以列支该笔支出」，
--   实际原因可能是这类支出能否列支尚无答复、单据截止、经费卡尚未生效等，成员看了以为是额度不够。
--   现在逐条说明原因，只是不写经费卡号；有财务权限的照旧看到卡号和原因。
do $$
declare d text := pg_get_functiondef('public.submit_project_request(uuid, uuid, text, numeric, date, boolean, text, uuid)'::regprocedure); n text := d;
  r text[][] := array[
    ['declare tgt uuid;', 'declare wm text := ''''; tgt uuid;'],
    ['why := why || c.card_no || '' 已结清；'';', 'why := why || c.card_no || '' 已结清；''; wm := wm || ''经费卡已结清；'';'],
    ['why := why || c.card_no || '' 下达的预算仅剩 '' || c.rest || ''；'';', 'why := why || c.card_no || '' 下达的预算仅剩 '' || c.rest || ''；''; wm := wm || ''下达到经费卡的预算仅剩 '' || c.rest || '' 元；'';'],
    ['why := why || c.card_no || '' '' || c.start_date || '' 方下达；'';', 'why := why || c.card_no || '' '' || c.start_date || '' 方下达；''; wm := wm || ''经费卡 '' || c.start_date || '' 才生效；'';'],
    ['why := why || c.card_no || '' 单据 '' || c.cutoff_date || '' 截止；'';', 'why := why || c.card_no || '' 单据 '' || c.cutoff_date || '' 截止；''; wm := wm || ''预计入账日晚于经费卡的单据截止日 '' || c.cutoff_date || ''；'';'],
    ['why := why || c.card_no || '' 能否列支「'' || coalesce(tn, '''') || ''」尚无答复；'';', 'why := why || c.card_no || '' 能否列支「'' || coalesce(tn, '''') || ''」尚无答复；''; wm := wm || ''「'' || coalesce(tn, '''') || ''」在下达的经费卡上能否列支尚无答复；'';'],
    ['why := why || c.card_no || '' 不能列支「'' || coalesce(tn, '''') || ''」；'';', 'why := why || c.card_no || '' 不能列支「'' || coalesce(tn, '''') || ''」；''; wm := wm || ''下达的经费卡不能列支「'' || coalesce(tn, '''') || ''」；'';'],
    ['why := why || c.card_no || '' 该科目可用额度不足；'';', 'why := why || c.card_no || '' 该科目可用额度不足；''; wm := wm || ''经费卡该科目可用额度不足；'';'],
    ['if not has_perm(''read.finance'') then raise exception ''拦截：该预算行下达的经费卡余额不足以列支该笔支出，请联系财务岗''; end if;',
     'if not has_perm(''read.finance'') then raise exception ''拦截：这笔支出暂时不能列支。%请联系财务岗'', wm; end if;']];
  i int;
begin
  for i in 1 .. array_length(r, 1) loop
    if position(r[i][1] in n) = 0 then raise exception 'submit_project_request 第 % 处没有找到：%', i, r[i][1]; end if;
    n := replace(n, r[i][1], r[i][2]);
  end loop;
  execute n;
end $$;
