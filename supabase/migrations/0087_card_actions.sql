-- 通知卡片上直接办理：能在卡片上办的通知，随通知记下要办的动作，发送端据此在卡片上放「同意」按钮。
-- 这一版只有一种：研究单元申请待所挂课题的负责人同意。退回要写原因，仍到页面上办。

-- 同 notify_user，多带一项动作
create function notify_user_act(p_act jsonb, p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if app_uid() is null or p_user is null or p_user = app_uid() then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null then return; end if;
  insert into feishu_outbox (target, payload, user_id)
  values (oid, jsonb_build_object('text', p_text, 'by', (select name from app_user where id = app_uid()),
                                  'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'), 'act', p_act), p_user);
end $$;
revoke all on function notify_user_act(jsonb, uuid, text) from public;

-- 提交研究单元申请时发给课题负责人的那条，带上动作
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.propose_unit(uuid, uuid, text, date, date, text, text)'::regprocedure);
  n := replace(d, 'perform notify_user(par.owner_id, format(''研究单元申请待同意：',
                  'perform notify_user_act(jsonb_build_object(''kind'', ''unit_consent'', ''unit'', uid), par.owner_id, format(''研究单元申请待同意：');
  if n = d then raise exception 'propose_unit：没有找到待同意的通知语句'; end if;
  execute n;
end $$;

-- 发送端收到卡片上的点击后，按通知编号取回这条通知是发给谁的、要办什么。只有定时任务所用的无登录身份可以取
create function outbox_act(p_msg bigint) returns table (user_id uuid, target_id text, body jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select o.user_id, o.target, o.payload from feishu_outbox o where o.id = p_msg and o.payload ? 'act' and o.user_id is not null;
end $$;
select expose('outbox_act(bigint)');
