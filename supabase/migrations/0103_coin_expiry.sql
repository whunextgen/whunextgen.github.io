-- 实际币和卡时的有效期，防止攒起来一次用（黄济民 2026-11-26 定）：
--   按期发放的实际币只在发放的这一期和下一期有效（共四周，参数 salary_periods = 2），用不掉作废；
--   成果铸造的实际币仍按「铸造所得的有效期」（12 个月）；
--   研究单元换得的 GPU 卡时，买后 8 周内有效（参数 hours_days = 56）。报给集群的剩余卡时按先买先用扣掉用量，过期的不计。
alter table token_param drop constraint token_param_key_check;
alter table token_param add constraint token_param_key_check check (key in ('nominal', 'phase', 'split', 'reserve', 'levels', 'resubmit', 'rate', 'valid', 'salary', 'price', 'salary_periods', 'hours_days'));
insert into token_param (key, value) values ('salary_periods', '2'), ('hours_days', '56') on conflict (key) do nothing;

create function coin_salary_periods() returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from token_param where key = 'salary_periods'), 2)
$$;
create function compute_hours_days() returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from token_param where key = 'hours_days'), 56)
$$;

create or replace function coin_salary_tick() returns int language plpgsql security definer set search_path = public as $$
declare per date := token_period(app_today()); s jsonb := (select value from token_param where key = 'salary'); r record; amt numeric; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for r in select pr.user_id, pr.rank from person pr join app_user u on u.id = pr.user_id where pr.status in ('active','offroll') and u.active loop
    amt := nullif(s ->> r.rank, '')::numeric;
    if amt is null or amt <= 0 then continue; end if;
    insert into coin_ledger (user_id, kind, amount, remain, expires_on, period_start, note)
    values (r.user_id, 'salary', amt, amt, per + 14 * coin_salary_periods() - 1, per, format('%s 起一期按身份发放（%s）', to_char(per, 'YYYY-MM-DD'), rank_label(r.rank)))
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- 已发的这一期改按四周有效
update coin_ledger set expires_on = period_start + 14 * coin_salary_periods() - 1 where kind = 'salary';

-- 卡时的有效期
alter table compute_grant add column expires_on date;
update compute_grant set expires_on = (bought_at at time zone 'Asia/Shanghai')::date + compute_hours_days();
alter table compute_grant alter column expires_on set not null;
create function trg_compute_grant_expiry() returns trigger language plpgsql as $$
begin
  if new.expires_on is null then new.expires_on := app_today() + compute_hours_days(); end if;
  return new;
end $$;
create trigger compute_grant_expiry before insert on compute_grant for each row execute function trg_compute_grant_expiry();

-- 剩余与过期：集群报回的用量按先买先用扣，各笔在到期前用不掉的部分作废
create function unit_hours_split(p_project uuid) returns table (left_hours numeric, expired_hours numeric) language plpgsql stable security definer set search_path = public as $$
declare used numeric := coalesce((select sum(hours) from cluster_usage where project_id = p_project), 0); g record; take numeric; l numeric := 0; e numeric := 0;
begin
  for g in select hours, expires_on from compute_grant where project_id = p_project order by bought_at loop
    take := least(g.hours, used); used := used - take;
    if g.expires_on >= app_today() then l := l + g.hours - take; else e := e + g.hours - take; end if;
  end loop;
  return query select l, e;
end $$;
create function unit_hours_left(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select left_hours from unit_hours_split(p_project)
$$;
create function unit_hours_expired(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select expired_hours from unit_hours_split(p_project)
$$;

create or replace view api.cluster_quota as
  select p.id as project_id, p.code as project_code, p.name as project_name,
         coalesce((select sum(hours) from compute_grant g where g.project_id = p.id), 0) as granted_hours,
         coalesce((select sum(hours) from cluster_usage u where u.project_id = p.id), 0) as used_hours,
         unit_hours_left(p.id) as left_hours,
         (select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.name, 'owner', u.id = p.owner_id) order by u.name), '[]')
            from app_user u where u.active and (u.id = p.owner_id or exists (select 1 from project_member m where m.project_id = p.id and m.user_id = u.id and m.left_on is null))) as members,
         (select jsonb_build_object('hours', a.hours, 'ok', a.ok, 'note', a.note, 'at', a.reported_at) from cluster_ack a where a.project_id = p.id order by a.reported_at desc limit 1) as last_ack,
         unit_hours_expired(p.id) as expired_hours,
         (select min(g.expires_on) from compute_grant g where g.project_id = p.id and g.expires_on >= app_today()) as next_expiry
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;

create or replace view api.compute_grant as
  select g.id, g.project_id, p.code as project_code, p.name as project_name, p.layer, g.hours, g.coins, (select name from app_user where id = g.bought_by) as bought_by_name, g.bought_at, g.expires_on
  from compute_grant g join project p on p.id = g.project_id where app_role() is not null;

create or replace function set_token_param(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v text; n numeric;
  function_keys constant jsonb := '{"levels": ["r1", "t1", "l2", "l3", "l4"], "resubmit": ["lower", "decay", "rounds", "extra"], "split": ["eval"]}';
begin
  perform need_perm('budget.approve');
  if p_key = 'nominal' then
    if jsonb_typeof(p_value) <> 'object' then raise exception '各身份的名义币格式有误'; end if;
    for k, v in select * from jsonb_each_text(p_value) loop
      if k not in ('postdoc', 'phd', 'master', 'ra', 'ri', 'visitor') then raise exception '身份有误'; end if;
      if v !~ '^\d+(\.\d+)?$' or v::numeric > 1000 then raise exception '名义币须为 0 到 1000 之间的数'; end if;
    end loop;
  elsif p_key in ('levels', 'resubmit', 'split') then
    if jsonb_typeof(p_value) <> 'object' then raise exception '参数格式有误'; end if;
    for k in select jsonb_array_elements_text(function_keys -> p_key) loop
      if not (p_value ? k) or jsonb_typeof(p_value -> k) <> 'number' then raise exception '参数不完整'; end if;
    end loop;
    if (select count(*) from jsonb_object_keys(p_value)) <> jsonb_array_length(function_keys -> p_key) then raise exception '参数有多余的项'; end if;
    if p_key = 'levels' then
      if exists (select 1 from jsonb_each_text(p_value) e where e.value::numeric < 0 or e.value::numeric > 20) then raise exception '各级系数须在 0 到 20 之间'; end if;
    elsif p_key = 'split' then
      n := (p_value ->> 'eval')::numeric;
      if n < 0.3 or n > 1 then raise exception '按档次评定发的比例须在 30%% 到 100%% 之间'; end if;
    else
      if (p_value ->> 'lower')::numeric not between 0 and 1 or (p_value ->> 'decay')::numeric not between 0 and 1 or (p_value ->> 'extra')::numeric not between 0 and 1 then
        raise exception '折扣和比例须在 0 到 1 之间';
      end if;
      if (p_value ->> 'rounds')::numeric not between 1 and 6 or (p_value ->> 'rounds')::numeric <> trunc((p_value ->> 'rounds')::numeric) then raise exception '最多投稿轮数须为 1 到 6 的整数'; end if;
    end if;
  elsif p_key = 'reserve' then
    if jsonb_typeof(p_value) <> 'number' or p_value::text::numeric not between 0 and 0.5 then raise exception '预备的比例须在 0 到 50%% 之间'; end if;
  elsif p_key = 'valid' then
    if jsonb_typeof(p_value) <> 'number' or p_value::text::numeric not between 1 and 36 then raise exception '有效期须在 1 到 36 个月之间'; end if;
  elsif p_key = 'rate' then
    if jsonb_typeof(p_value) not in ('null', 'number') or (jsonb_typeof(p_value) = 'number' and p_value::text::numeric <= 0) then raise exception '挂牌铸造率须大于 0'; end if;
  elsif p_key = 'salary' then
    if jsonb_typeof(p_value) <> 'object' then raise exception '各身份的发放额度格式有误'; end if;
    for k, v in select * from jsonb_each_text(p_value) loop
      if rank_label(k) is null then raise exception '身份不在六种之内'; end if;
      if v is not null and (v !~ '^\d+(\.\d+)?$' or v::numeric > 100000) then raise exception '每期发放须为 0 到 100000 之间的数，未定的留空'; end if;
    end loop;
  elsif p_key = 'salary_periods' then
    if jsonb_typeof(p_value) <> 'number' or p_value::text::numeric not between 1 and 6 or p_value::text::numeric <> trunc(p_value::text::numeric) then raise exception '按期发放的有效期须为 1 到 6 期'; end if;
  elsif p_key = 'hours_days' then
    if jsonb_typeof(p_value) <> 'number' or p_value::text::numeric not between 7 and 365 or p_value::text::numeric <> trunc(p_value::text::numeric) then raise exception '卡时的有效期须为 7 到 365 天'; end if;
  elsif p_key = 'price' then
    if jsonb_typeof(p_value) not in ('null', 'number') or (jsonb_typeof(p_value) = 'number' and p_value::text::numeric <= 0) then raise exception '卡时标价须大于 0，未定的留空'; end if;
  else
    raise exception '该参数不可在此修改';
  end if;
  update token_param set value = p_value, updated_by = app_uid(), updated_at = now() where key = p_key;
end $$;
