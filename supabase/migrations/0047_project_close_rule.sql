-- 结余上缴是按项目办的（如财政项目），不是按经费卡：
--   经费卡的到期处理只有两种：到期回收（结余回到项目的额度剩余）、结转（带入更晚的同卡号经费卡）；
--   项目另有结束处理：结余上缴的，结题时把额度剩余记为上缴数。
alter table fund_project add column close_rule text not null default 'none' check (close_rule in ('none', 'return')),
                         add column returned numeric(14,2);

-- 此前在经费卡和项目上登记为结余上缴的，经费卡一律改为到期回收，结余上缴记到项目上
update fund_project set close_rule = 'return', end_rule = 'recall', updated_at = now() where end_rule = 'return';
update fund_card set end_rule = 'recall', updated_at = now() where end_rule = 'return';

-- 建项目、改经费卡时，到期处理不再接受结余上缴
do $$
declare r record; d text; n text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname in ('save_fund_project', 'save_card') loop
    d := pg_get_functiondef(r.oid);
    n := replace(d, $a$p_end_rule not in ('recall','carry','return')$a$, $a$p_end_rule not in ('recall','carry')$a$);
    if n = d then raise exception '未找到 % 的到期处理校验', r.proname; end if;
    n := replace(n, '到期回收、结转或结余上缴', '到期回收或结转');
    n := replace(n, '年底规则须为', '经费卡到期处理须为');
    execute n;
  end loop;
end $$;

create function set_project_close_rule(p_id uuid, p_rule text) returns void
language plpgsql security definer set search_path = public as $$
declare p fund_project;
begin
  perform need_perm('card.manage');
  select * into p from fund_project where id = p_id for update;
  if not found then raise exception '项目不存在'; end if;
  if p.status <> 'active' then raise exception '项目已结题'; end if;
  if p_rule is null or p_rule not in ('none', 'return') then raise exception '项目结束处理须为结余上缴或无须上缴'; end if;
  update fund_project set close_rule = p_rule, updated_at = now() where id = p_id;
end $$;
select expose('set_project_close_rule(uuid, text)');

-- 结题：结束处理为结余上缴且填了额度的，记下上缴数（额度 − 占用额度）
create or replace function close_fund_project(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare p fund_project; k int;
begin
  perform need_perm('card.manage');
  select * into p from fund_project where id = p_id for update;
  if not found then raise exception '项目不存在'; end if;
  if p.status <> 'active' then raise exception '项目已结题'; end if;
  select count(*) into k from fund_card where project_id = p_id and status = 'active';
  if k > 0 then raise exception '尚有 % 张经费卡未结清，不得结题', k; end if;
  update fund_project set status = 'closed', updated_at = now(),
         returned = case when p.close_rule = 'return' and p.quota is not null then greatest(p.quota - fund_granted(p_id), 0) end
   where id = p_id;
end $$;

create or replace view api.fund_project as
  select p.id, p.name, p.source, p.fund_kind, p.owner_id, u.name as owner_name, p.quota, p.period_start, p.period_end,
         p.template_id, t.name as template_name, p.end_rule, p.note, p.status,
         fund_granted(p.id) as granted,
         (select coalesce(sum(c.recalled), 0) from fund_card c where c.project_id = p.id) as recalled,
         (select count(*) from fund_card c where c.project_id = p.id)::int as cards,
         p.auto, p.close_rule, p.returned
  from fund_project p join card_template t on t.id = p.template_id left join app_user u on u.id = p.owner_id
  where has_perm('read.finance') or has_perm('card.manage')
     or exists (select 1 from fund_card c where c.project_id = p.id and can_see_card(c.id));
