-- 年度预算这条线原来没有通知。补上：方案批准、课题提交申请、录入评定结果、评定完成。
-- 都走 notify_user：不通知操作者本人，没绑定飞书或已停用的跳过。

-- 课题提交立项或延续申请：通知录入评定结果的人
create function trg_notify_pick_new() returns trigger language plpgsql security definer set search_path = public as $$
declare msg text;
begin
  msg := format('%s 年度%s申请：%s 为课题「%s」申请「%s」', new.year, case new.kind when 'new' then '立项' else '延续' end,
    coalesce((select name from app_user where id = app_uid()), '—'), (select name from project where id = new.project_id), (select name from budget_tier where id = new.tier_id));
  perform notify_user(u.id, msg) from app_user u where u.active and user_perm(u.id, 'budget.evaluate');
  return new;
end $$;
create trigger notify_new after insert on tier_pick for each row execute function trg_notify_pick_new();

-- 录入、改动或撤销评定结果：通知课题负责人和申请人
create function trg_notify_pick_decide() returns trigger language plpgsql security definer set search_path = public as $$
declare p project; t budget_tier; msg text; kind text := case new.kind when 'new' then '立项' else '延续' end;
begin
  if new.rejected is not distinct from old.rejected and new.decided_tier_id is not distinct from old.decided_tier_id
     and new.decide_note is not distinct from old.decide_note and new.meeting_on is not distinct from old.meeting_on then return new; end if;
  select * into p from project where id = new.project_id;
  if new.rejected then
    msg := format('课题「%s」%s 年度%s申请不予通过（%s 联席会议）。原因：%s', p.name, new.year, kind, new.meeting_on, coalesce(new.decide_note, '未填写'));
  elsif new.decided_tier_id is not null then
    select * into t from budget_tier where id = new.decided_tier_id;
    msg := format('课题「%s」%s 年度评定为「%s」，%s 元（%s 联席会议）%s。全部课题评定完成并经中心负责人确认后生效', p.name, new.year, t.name,
      to_char(t.amount, 'FM999,999,999,990.00'), new.meeting_on, coalesce('。会议意见：' || new.decide_note, ''));
  elsif old.rejected or old.decided_tier_id is not null then
    msg := format('课题「%s」%s 年度的评定结果已撤销，待重新录入', p.name, new.year);
  else return new;
  end if;
  perform notify_user(x, msg) from (select p.owner_id as x union select new.picked_by) s where x is not null;
  return new;
end $$;
create trigger notify_decide after update on tier_pick for each row execute function trg_notify_pick_decide();

-- 方案批准：通知全体成员可以申请。评定完成：通知各课题负责人结果，通知财务岗转入下达。撤回评定完成：通知各课题负责人
create function trg_notify_year() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.plan_at is null and new.plan_at is not null then
    perform notify_user(u.id, format('%s 年度预算方案已批准。课题的立项与延续申请请在「课题 › 立项与延续申请」中提交', new.year)) from app_user u where u.active;
  end if;
  if old.stage = 'declare' and new.stage = 'fixed' then
    perform notify_user(x, msg) from (
      select distinct u.x, case when k.rejected then format('%s 年度评定完成：课题「%s」的申请不予通过', new.year, p.name)
          else format('%s 年度评定完成：课题「%s」定为「%s」，年度上限 %s 元，已提交的明细成为核定的预算', new.year, p.name, t.name, to_char(t.amount, 'FM999,999,999,990.00')) end as msg
      from tier_pick k join project p on p.id = k.project_id left join budget_tier t on t.id = k.decided_tier_id
        cross join lateral (select p.owner_id as x union select k.picked_by) u
      where k.year = new.year and u.x is not null and (k.rejected or k.decided_tier_id is not null)) s;
    perform notify_role('finance', format('%s 年度评定完成，转入下达', new.year));
  elsif old.stage = 'fixed' and new.stage = 'declare' then
    perform notify_user(x, format('%s 年度的评定完成已撤回，回到评定阶段，各课题的上限和核定数一并撤销', new.year)) from (
      select p.owner_id as x from tier_pick k join project p on p.id = k.project_id where k.year = new.year
      union select k.picked_by from tier_pick k where k.year = new.year) s where x is not null;
  end if;
  return new;
end $$;
create trigger notify after update on budget_year for each row execute function trg_notify_year();
