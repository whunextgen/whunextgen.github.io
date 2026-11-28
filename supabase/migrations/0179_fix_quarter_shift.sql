-- 改正 0178：11-28 公布的那一期原记在自然季度 2026-10-01，0178 按日期换算成了 2026-08-01（10 月属 8–10 月那一季），
-- 实际是本季度（2026 年 11 月–2027 年 1 月）公布的，应为 2026-11-01。按公布日期所在的中心季度改回。
update coin_quarter set q_start = center_quarter((published_at at time zone 'Asia/Shanghai')::date)
where q_start <> center_quarter((published_at at time zone 'Asia/Shanghai')::date)
  and not exists (select 1 from budget_coin_exchange x where x.q_start = coin_quarter.q_start)
  and not exists (select 1 from api_grant g where g.q_start = coin_quarter.q_start)
  and not exists (select 1 from coin_quarter c2 where c2.q_start = center_quarter((coin_quarter.published_at at time zone 'Asia/Shanghai')::date));
