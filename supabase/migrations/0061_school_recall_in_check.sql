-- 学校余额核对计入学校中途回收的经费。
-- 学校会在经费卡到期前后把卡上的钱收回，收回的会再下达，不是支出；原来按「上年结转 + 收入 − 明细账支出」核对，
-- 回收过的卡永远对不上。回收在「报销与入账」页按学校侧进度登记（类型：回收），核对时扣除。
-- 项目还剩多少仍按花销算（额度 − 已入账 − 在途），与学校余额无关。

do $$
declare d text := pg_get_viewdef('api.card'::regclass); n text;
begin
  n := regexp_replace(d, '(\s+FROM \(*v_card v)', ', (select coalesce(sum(e.amount), 0) from fund_event e where e.card_id = c.id and e.kind = ''回收'') as school_recalled\1');
  if n = d then raise exception '未找到经费卡视图的位置'; end if;
  execute 'create or replace view api.card as ' || n;
end $$;
