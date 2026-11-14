-- 更正经费卡各科目的预算时，不再被「学校明细账」这一项拦住。
-- 这一项是导入明细账时放不进本卡科目的支出，本来就没有预算；原来的校验要求每个科目的预算不低于已入账，
-- 结果只要导入过明细账，任何科目的预算都改不了，包括把已经不存在的预算改成零。只控总额的卡也不做这项校验。
do $do$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.set_budget(uuid, jsonb)'::regprocedure);
  d2 := replace(d, 'where v.card_id = p_card and v.avail < 0', 'where v.card_id = p_card and v.avail < 0 and not c.pooled and v.subject_code <> ''school''');
  if d2 = d then raise exception 'set_budget：未找到预算不低于已入账的校验'; end if;
  execute d2;
end $do$;
