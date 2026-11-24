-- 通知发到全员群：研究单元成立即时发一条；双周表每期发三条汇总（期中、截止前一日、补登期结束后）。
-- 群是哪一个不记在库里：队列里的对象写作 group，由发送端按配置换成群。支出、备用金、资源申领仍只通知本人。
create function notify_group(p_text text, p_url text default null, p_btn text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into feishu_outbox (target, payload)
  values ('group', jsonb_strip_nulls(jsonb_build_object('text', p_text, 'url', p_url, 'btn', p_btn,
    'by', (select name from app_user where id = app_uid()),
    'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
end $$;
revoke all on function notify_group(text, text, text) from public;

-- 研究单元成立：在群里公布
do $$
declare d text; n text; a text := 'update project set proposed = false, checked_by = app_uid(), checked_at = now() where id = p_unit;';
begin
  d := pg_get_functiondef('public.confirm_unit(uuid)'::regprocedure);
  n := replace(d, a, a || E'\n  perform notify_group(format(''研究单元成立：研究单元「%s」已成立，挂在课题「%s」之下，负责人 %s'', u.name, par.name, coalesce((select name from app_user where id = u.owner_id), ''—'')));');
  if n = d then raise exception 'confirm_unit：没有找到成立的那一句'; end if;
  execute n;
end $$;

-- 双周表汇总：每期每种只发一次
create table group_digest (
  kind         text not null check (kind in ('mid', 'last', 'final')),
  period_start date not null,
  sent_at      timestamptz not null default now(),
  primary key (kind, period_start)
);
alter table group_digest enable row level security;

-- 由定时任务调用。期中：本期第 8 天；截止前一日：本期第 13 天；结果：下一期第 4 天（补登期已过）。当天没有该发的返回空。
create function group_digest_tick() returns text
language plpgsql security definer set search_path = public as $$
declare cur date := token_period(app_today()); d int := app_today() - token_period(app_today());
        k text; ps date; span text; total int; n_ok int; n_no int; l_ok text; l_no text; l_long text; msg text;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if d = 7 then k := 'mid'; ps := cur;
  elsif d = 12 then k := 'last'; ps := cur;
  elsif d = 3 and cur - 14 >= date '2026-11-23' then k := 'final'; ps := cur - 14;
  else return null; end if;
  insert into group_digest (kind, period_start) values (k, ps) on conflict do nothing;
  if not found then return null; end if;
  span := to_char(ps, 'MM-DD') || ' 至 ' || to_char(ps + 13, 'MM-DD');
  with due as (
    select p.id, p.code, p.name || '（' || coalesce((select name from app_user where id = p.owner_id), '—') || '）' as label,
           exists (select 1 from biweekly_report r where r.project_id = p.id and r.period_start = ps) as filled,
           biweekly_from(p.id) as since,
           (select max(r.period_start) from biweekly_report r where r.project_id = p.id and r.period_start < ps) as last
    from project p where p.layer = 'paper' and p.active and not p.proposed and biweekly_from(p.id) <= ps
  ), s as (
    select *, case when filled then 0 else (ps - greatest(since, coalesce(last + 14, since))) / 14 + 1 end as streak from due
  )
  select count(*), count(*) filter (where filled), count(*) filter (where not filled),
         string_agg('· ' || label, E'\n' order by code) filter (where filled),
         string_agg('· ' || label, E'\n' order by code) filter (where not filled),
         string_agg('· ' || label || ' ' || streak || ' 期', E'\n' order by code) filter (where streak >= 2)
    into total, n_ok, n_no, l_ok, l_no, l_long from s;
  if total = 0 then return null; end if;
  if k = 'mid' then
    msg := format('双周表登记情况：本期 %s，应登记 %s 个研究单元，已登记 %s 个，未登记 %s 个。', span, total, n_ok, n_no)
      || coalesce(E'\n已登记\n' || l_ok, '') || coalesce(E'\n未登记\n' || l_no, '')
      || E'\n本期登记至 ' || to_char(ps + 13, 'MM-DD') || ' 截止，之后三日内可以补登。';
  elsif k = 'last' then
    if n_no = 0 then msg := format('双周表登记情况：本期 %s 明日截止，%s 个研究单元已全部登记。', span, total);
    else msg := format('双周表登记提醒：本期 %s 明日截止，尚有 %s 个研究单元未登记，请负责人或名单内成员尽快登记。', span, n_no) || E'\n未登记\n' || l_no; end if;
  else
    msg := format('双周表本期结果：%s 一期的登记和补登已结束，应登记 %s 个研究单元，已登记 %s 个，未登记 %s 个。', span, total, n_ok, n_no)
      || coalesce(E'\n未登记\n' || l_no, '') || coalesce(E'\n连续两期及以上未登记\n' || l_long, '');
  end if;
  perform notify_group(msg);
  return k;
end $$;
