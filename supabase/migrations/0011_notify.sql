-- 飞书通知：业务事件发生时把要发的消息写进队列，由接口层的定时任务取出发送。
-- 队列只在数据库里排队；发不发由接口层的开关决定（默认关）。超过 24 小时没发出去的作废，避免开关打开时补发一堆旧消息。

alter table feishu_outbox add column user_id uuid references app_user, add column sent_at timestamptz;

-- 给一个人排一条消息。不通知操作者本人；没绑定飞书或已停用的跳过；没有登录身份的写入（导入脚本）不通知。
create function notify_user(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if app_uid() is null or p_user is null or p_user = app_uid() then return; end if;
  select feishu_open_id into oid from app_user where id = p_user and active;
  if oid is null then return; end if;
  insert into feishu_outbox (target, payload, user_id) values (oid, jsonb_build_object('text', p_text), p_user);
end $$;

create function notify_role(p_role text, p_text text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform notify_user(u.id, p_text) from app_user u where u.role = p_role and u.active;
end $$;

-- 支出申请的每一步
create function trg_notify_request() returns trigger language plpgsql security definer set search_path = public as $$
declare r expense_request; msg text;
begin
  select * into r from expense_request where id = new.request_id;
  msg := format('「%s」%s 元（%s）', r.title, to_char(r.amount, 'FM999,999,999,990.00'), (select name from fund_card where id = r.card_id));
  case new.kind
    when 'submit' then
      if r.status = 'pending' then perform notify_role('director', '待审批：' || msg);
      else perform notify_role('director', '紧急通道已直接承诺，请事后补批：' || msg); end if;
    when 'approve' then
      perform notify_user(r.requested_by, '已批准：' || msg);
      perform notify_role('finance', '已批准，待提交学校：' || msg);
    when 'reject' then perform notify_user(r.requested_by, '已驳回：' || msg || coalesce('。原因：' || new.note, ''));
    when 'return' then
      perform notify_user(r.requested_by, '学校退回：' || msg || coalesce('。原因：' || new.note, ''));
      perform notify_role('director', '学校退回：' || msg || coalesce('。原因：' || new.note, ''));
    when 'move' then perform notify_user(r.requested_by, '已改到另一张卡重新送审：' || msg);
    when 'post' then perform notify_user(r.requested_by, '学校已入账：' || msg);
    when 'release' then perform notify_user(r.requested_by, '已释放，这笔申请作废：' || msg);
    else null;
  end case;
  return new;
end $$;
create trigger notify after insert on request_event for each row execute function trg_notify_request();

-- 预算变更的每一步
create function trg_notify_change() returns trigger language plpgsql security definer set search_path = public as $$
declare msg text := format('%s：%s', (select name from fund_card where id = new.card_id), new.reason);
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then perform notify_role('director', '预算变更待确认。' || msg); end if;
  elsif new.status is distinct from old.status then
    case new.status
      when 'filed' then perform notify_role('finance', '预算变更已确认，待录入发规办批复。' || msg);
      when 'approved' then perform notify_user(new.requested_by, '预算变更已批复生效。' || msg);
      when 'rejected' then perform notify_user(new.requested_by, '预算变更被驳回。' || msg);
      else null;
    end case;
  end if;
  return new;
end $$;
create trigger notify after insert or update on budget_change for each row execute function trg_notify_change();

-- ---------- 发送端 ----------
-- 这两个函数只给接口层的定时任务用（没有登录身份），不在接口的函数白名单里，登录用户调不到
create function outbox_take(p_limit int default 20) returns table (msg_id bigint, target_id text, body jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update feishu_outbox set status = 'failed', last_error = '超过 24 小时未发送，已作废'
  where status = 'queued' and created_at < now() - interval '24 hours';
  return query
    update feishu_outbox o set attempts = o.attempts + 1
    where o.id in (select q.id from feishu_outbox q where q.status = 'queued' order by q.id limit greatest(1, least(coalesce(p_limit, 20), 50)) for update skip locked)
    returning o.id, o.target, o.payload;
end $$;

create function outbox_done(p_id bigint, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update feishu_outbox set
    status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
    sent_at = case when p_ok then now() end,
    last_error = case when p_ok then null else left(coalesce(p_error, '发送失败'), 300) end
  where id = p_id and status = 'queued';
end $$;

-- 财务岗和中心负责人能看队列，用来确认通知有没有发出去
create view api.outbox as
  select o.id, o.created_at, o.user_id, u.name as user_name, o.payload->>'text' as text,
         case when o.status = 'queued' and o.created_at < now() - interval '24 hours' then 'expired' else o.status end as status, o.attempts, o.last_error, o.sent_at
  from feishu_outbox o left join app_user u on u.id = o.user_id
  where is_staff() and o.created_at > now() - interval '30 days';

grant select on api.outbox to app_api;
select expose('outbox_take(int)', 'outbox_done(bigint, boolean, text)');
do $$ declare f text; r text; begin
  foreach f in array array['notify_user(uuid, text)', 'notify_role(text, text)', 'trg_notify_request()', 'trg_notify_change()', 'check_user_change(uuid, text, boolean)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
end $$;
