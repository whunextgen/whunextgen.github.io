-- 本季度可换 API 额度的上限由视图给出（议题 #182）
--   0175 起上限就是公布的总额按 key 所在资源的汇率折算的额度，库存只做登记和对账；但「资产盘点 › 研究单元 API key」
--   仍在页面上把总额折算加库存当成可换的额度，和剩余对不上（可换 17,419.06 美元、已换 457.36，剩余却是 7,050.15）。
--   api.api_quarter 末尾加 cap（本季度全中心可换的额度，按计价单位，与 buy_api_quota 的上限一致），页面直接显示，不再自己算。
create or replace view api.api_quarter as
SELECT q.q_start,
    q.total,
    q.api_rate,
    q.api_stock,
    COALESCE(g.bought, (0)::numeric) AS bought,
    (round((q.total / COALESCE(unit_key_fx(r.*), (1)::numeric)), 2) - COALESCE(g.bought, (0)::numeric)) AS room,
    r.id AS resource_id,
    r.name AS resource_name,
    COALESCE(r.unit, '元'::text) AS unit,
        CASE
            WHEN (unit_key_fx(r.*) <> (1)::numeric) THEN r.fx_rate
            ELSE NULL::numeric
        END AS fx_rate,
    round((q.total / COALESCE(unit_key_fx(r.*), (1)::numeric)), 2) AS total_fx,
    round((q.total / COALESCE(unit_key_fx(r.*), (1)::numeric)), 2) AS cap
   FROM ((coin_quarter q
     LEFT JOIN LATERAL ( SELECT sum(api_grant.quota) AS bought
           FROM api_grant
          WHERE (api_grant.q_start = q.q_start)) g ON (true))
     LEFT JOIN resource r ON ((r.unit_key AND (r.kind = 'api'::text) AND r.active)))
  WHERE ((q.q_start = center_quarter(app_today())) AND (app_role() IS NOT NULL));
