-- 能不能报：不带经费卡的查询。成员和项目负责人看不到经费卡，但要能查一类支出能不能报。
-- 每个支出类型一行，只说在用的卡里有没有能报的、有没有不能报的、有没有带条件的，不出现卡号、卡名和张数。
create view api.rule_lookup as
  select t.id as expense_type_id, t.name, t.required_path,
         coalesce(bool_or(r.verdict = 'yes'), false)         as can_yes,
         coalesce(bool_or(r.verdict = 'conditional'), false) as has_cond,
         coalesce(bool_or(r.verdict = 'no'), false)          as has_no,
         coalesce(bool_or(r.verdict = 'disputed'), false)    as disputed,
         string_agg(distinct r.note, '；') filter (where r.verdict in ('conditional', 'disputed') and nullif(btrim(r.note), '') is not null) as notes,
         max(r.ruled_on) as ruled_on
  from expense_type t
  left join (v_reimb_rule r join fund_card c on c.id = r.card_id and c.status = 'active') on r.expense_type_id = t.id
  where app_role() is not null
  group by t.id, t.name, t.required_path;

grant select on api.rule_lookup to app_api;
