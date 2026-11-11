-- 访问控制。
-- 基础表全部开启行级权限且不建策略：除表的所有者外，任何角色都读不到、写不了。
-- API 层用 app_api 角色连接，只能读 api 模式下按身份过滤过的视图，只能通过 0003 的函数写。
-- Supabase 自带的 anon / authenticated 角色没有任何权限，PostgREST 即使开着也拿不到数据。

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api nologin;
  end if;
end $$;

do $$ declare t record; begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('public','legacy') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end $$;

revoke all on all tables in schema public, legacy from public;
revoke all on all functions in schema public from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public, legacy from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke usage on schema legacy from %I', r);
    end if;
  end loop;
end $$;

-- ---------- 身份 ----------
create function can_see_card(p_card uuid) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() in ('finance','director')
      or (app_role() = 'leader' and exists (select 1 from fund_card where id = p_card and owner_id = app_uid()))
$$;

create function is_staff() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce(app_role() in ('finance','director'), false) $$;

-- 飞书登录后由 API 层调用：按 open_id 找人；找不到时按企业邮箱认领从旧门户迁来的账号；再找不到就建一个普通成员。
create function login_feishu(p_open_id text, p_name text, p_email text default null) returns app_user
language plpgsql security definer set search_path = public as $$
declare u app_user; e text := nullif(lower(trim(p_email)), '');
begin
  if coalesce(p_open_id, '') = '' then raise exception '缺少 open_id'; end if;
  select * into u from app_user where feishu_open_id = p_open_id;
  if not found and e is not null then
    update app_user set feishu_open_id = p_open_id, updated_at = now()
    where email = e and feishu_open_id is null returning * into u;
  end if;
  if u.id is null then
    insert into app_user (feishu_open_id, name, email)
    values (p_open_id, p_name, case when exists (select 1 from app_user where email = e) then null else e end)
    returning * into u;
  end if;
  if not u.active then raise exception '账号已停用' using errcode = '42501'; end if;
  return u;
end $$;

create function set_user_role(p_user uuid, p_role text, p_active boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  update app_user set role = p_role, active = p_active, updated_at = now() where id = p_user;
  if not found then raise exception '用户不存在'; end if;
end $$;

-- 记录一条能否报销的答复
create function add_ruling(p_card uuid, p_type uuid, p_on date, p_by text, p_verdict text, p_note text default null, p_source text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  perform need_role('finance','director');
  insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict, note, source)
  values (p_card, p_type, p_on, p_by, p_verdict, p_note, p_source) returning id into rid;
  return rid;
end $$;

create function finish_fund_event(p_event uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance');
  update fund_event set done = true where id = p_event;
end $$;

-- ---------- 审计 ----------
create function trg_audit() returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(coalesce(new, old));
begin
  insert into audit_log (actor, action, entity, entity_id, detail)
  values (app_uid(), tg_op, tg_table_name, nullif(j->>'id', '')::uuid,
          case tg_op when 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)) else j end);
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['app_user','fund_card','budget_line','budget_change','reimb_ruling','expense_request',
                           'voucher','staff_assignment','payroll_sheet','card_settlement','emergency_limit','morningstar_quota'] loop
    execute format('create trigger audit after insert or update or delete on %I for each row execute function trg_audit()', t);
  end loop;
end $$;

-- ---------- 对外只读视图 ----------
create schema api;

create view api.me as
  select id, name, role from app_user where id = app_uid() and active;

create view api.users as
  select id, name, role, active from app_user where is_staff();

-- 选卡用：所有登录用户都能看到卡号、名称、有效期，看不到金额
create view api.card_pick as
  select c.id, c.card_no, c.name, c.template_id, c.start_date, c.cutoff_date, c.status
  from fund_card c where app_role() is not null;

create view api.subject as
  select s.id, s.template_id, s.code, s.name, s.school_name, s.sort
  from template_subject s where app_role() is not null;

create view api.expense_type as
  select id, name, required_path from expense_type where app_role() is not null;

create view api.card as
  select v.*, c.template_id, t.name as template_name, t.locked, c.owner_id, c.rule_note,
         c.school_balance, c.school_frozen, c.school_available, c.school_synced_at
  from v_card v join fund_card c on c.id = v.card_id join card_template t on t.id = c.template_id
  where can_see_card(v.card_id);

create view api.cell  as select * from v_cell  where can_see_card(card_id);
create view api.node  as select * from v_node  where can_see_card(card_id);
create view api.cap   as select * from v_cap   where can_see_card(card_id);

create view api.rule as
  select * from v_reimb_rule where app_role() is not null;

create view api.ruling as
  select id, card_id, expense_type_id, ruled_on, ruled_by, verdict, note, source
  from reimb_ruling where app_role() is not null;

create view api.request as
  select r.id, r.code, r.card_id, r.subject_id, r.expense_type_id, r.title, r.amount, r.eta_date, r.emergency,
         r.status, r.requested_by, r.approved_by, r.created_at, r.updated_at,
         p.path, p.stage, p.stages, v.posted_on, v.amount as posted_amount, v.voucher_no
  from expense_request r
  left join procurement p on p.request_id = r.id
  left join voucher v on v.request_id = r.id
  where r.requested_by = app_uid() or can_see_card(r.card_id);

create view api.request_event as
  select e.id, e.request_id, e.at, e.kind, e.note, e.actor
  from request_event e join api.request r on r.id = e.request_id;

create view api.procurement_event as
  select e.id, e.request_id, e.at, e.kind, e.note
  from procurement_event e join api.request r on r.id = e.request_id;

create view api.budget_change as
  select ch.id, ch.card_id, ch.reason, ch.status, ch.requested_by, ch.confirmed_by, ch.approved_on, ch.created_at,
         (select jsonb_agg(jsonb_build_object('subject_id', l.subject_id, 'delta', l.delta))
          from budget_change_line l where l.change_id = ch.id) as lines
  from budget_change ch where can_see_card(ch.card_id);

create view api.fund_event as
  select * from fund_event where can_see_card(card_id);

-- 人员费只有财务岗和中心负责人能看
create view api.person   as select id, name from person where is_staff();
create view api.pay_type as select * from pay_type where is_staff();
create view api.staff as
  select a.id, a.person_id, a.pay_type_id, a.month, a.card_id, a.amount, a.sheet_id,
         g.why as gap
  from staff_assignment a left join v_staff_gap g on g.assignment_id = a.id
  where is_staff();
create view api.payroll_sheet as
  select ps.*, (select coalesce(sum(a.amount), 0) from staff_assignment a where a.sheet_id = ps.id) as total
  from payroll_sheet ps where is_staff();

create view api.settlement as
  select s.id, s.card_id, s.settled_on, s.confirmed_by, l.subject_id, l.budget, l.actual, l.balance
  from card_settlement s join settlement_line l on l.settlement_id = s.id
  where can_see_card(s.card_id);

create view api.emergency as
  select l.year, l.per_request, l.per_year,
         (select coalesce(sum(amount), 0) from expense_request
          where emergency and status not in ('rejected','released') and extract(year from created_at) = l.year) as used
  from emergency_limit l where app_role() is not null;

-- ---------- 授权 ----------
grant usage on schema public, api to app_api;
grant select on all tables in schema api to app_api;
grant execute on function
  app_uid(), app_role(), app_today(), pay_date(date), can_see_card(uuid), is_staff(), login_feishu(text, text, text), set_user_role(uuid, text, boolean),
  submit_request(uuid, uuid, uuid, text, numeric, date, boolean, text),
  approve_request(uuid), reject_request(uuid, text), send_to_school(uuid),
  post_voucher(uuid, date, numeric, text), school_return(uuid, text),
  move_request(uuid, uuid, uuid), release_request(uuid),
  procurement_advance(uuid), procurement_fail(uuid, text, text, int),
  create_change(uuid, text, jsonb), confirm_change(uuid), reject_change(uuid), approve_change(uuid, date),
  reassign_staff(uuid, uuid, date, date, uuid), build_payroll(date), post_payroll(uuid, date),
  settle_card(uuid), add_ruling(uuid, uuid, date, text, text, text, text), finish_fund_event(uuid)
to app_api;
