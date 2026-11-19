-- 经费卡结清后学校仍有出账的，改回未结清：撤销结清记录和回收数，等学校出完账再结清。
-- 结余已结转到后续经费卡的不能改回（钱已经带走）；所属项目已结题的不能改回。须写明原因，留审计记录。

create function reopen_card(p_card uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare c fund_card; n text := nullif(btrim(coalesce(p_note, '')), ''); pj fund_project;
begin
  perform need_perm('card.settle');
  select * into c from fund_card where id = p_card for update;
  if not found then raise exception '经费卡不存在'; end if;
  if c.status <> 'settled' then raise exception '% 未结清，无须改回', c.card_no; end if;
  if n is null then raise exception '请填写改回未结清的原因'; end if;
  if coalesce(c.carried_out, 0) > 0 then raise exception '% 的结余已结转至后续经费卡，不得改回未结清', c.card_no; end if;
  select * into pj from fund_project where id = c.project_id;
  if pj.status <> 'active' then raise exception '所属项目已结题，不得改回未结清'; end if;
  delete from card_settlement where card_id = p_card;
  update fund_card set status = 'active', recalled = 0, carried_out = 0, updated_at = now() where id = p_card;
  insert into audit_log (actor, action, entity, entity_id, detail)
  values (app_uid(), 'reopen_card', 'fund_card', p_card, jsonb_build_object('note', n, 'recalled', c.recalled));
end $$;
revoke all on function reopen_card(uuid, text) from public;
grant execute on function reopen_card(uuid, text) to app_api;
