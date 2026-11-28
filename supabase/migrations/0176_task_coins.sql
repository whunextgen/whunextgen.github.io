-- 做任务换实际币（黄济民 2026-11-28：「所有任务都定，包含所有行为，包括组织会议等等，根据他们在正则上的操作，然后工资降低很多」
--   「任务才能算大头」「还要奖励连续」「可以的」）
--   一、按在正则上的操作直接发实际币到个人，和按期发放一样 2 期（4 周）有效。只算上线之后的操作（coin_task_setting.since）。
--   二、规则表 coin_task_rule：每类行为的数额和每人每季度的条数上限；连续奖励按「期」或「工作日」计连续，到节点发一次，
--       最高节点之后每再连续一个最高节点的长度再发一次最高档。
--   三、每人每季度任务加连续奖励合计最多 coin_task_setting.cap（3,000），超出的不发，记 0 留痕。
--   四、每件事只发一次：coin_task_award (user_id, code, source_key) 唯一。定时任务 coin_tick 里扫描。
--   回应质疑仍按 0065 记名义币进池子、成果解锁后铸造；按期发放降到原来的八分之一另行设参数。

alter table coin_ledger drop constraint coin_ledger_kind_check;
alter table coin_ledger add constraint coin_ledger_kind_check check (kind in ('salary','mint','invest','expire','adjust','task'));

create table coin_task_rule (
  code        text primary key,
  label       text not null,
  amount      numeric(10,2) not null check (amount >= 0),
  quarter_cap int check (quarter_cap is null or quarter_cap > 0),   -- 每人每季度最多发几次；空为不限
  streak      jsonb,                                                -- 连续奖励的节点：{"3": 20, "6": 50}；空为一般任务
  unit        text check (unit in ('period','workday')),            -- 连续按期还是按工作日
  sort        int not null default 0
);
create table coin_task_setting (
  id    boolean primary key default true check (id),
  since timestamptz not null,                                       -- 只算这之后的操作
  cap   numeric(10,2) not null default 3000                         -- 每人每季度任务加连续奖励合计上限
);
insert into coin_task_setting (since, cap) values (now(), 3000);

create table coin_task_award (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_user,
  code       text not null references coin_task_rule,
  source_key text not null,
  amount     numeric(10,2) not null check (amount >= 0),            -- 实发；到了上限的记 0
  q_start    date not null,
  note       text,
  created_at timestamptz not null default now(),
  unique (user_id, code, source_key)
);
create index on coin_task_award (user_id, q_start);
select seal('coin_task_rule', 'coin_task_setting', 'coin_task_award');
create trigger audit after insert or update or delete on coin_task_rule for each row execute function trg_audit();

insert into coin_task_rule (code, label, amount, quarter_cap, sort) values
  ('organize',      '组织一场研讨会（在正则上开完会），组织者平分', 60, null, 10),
  ('record_query',  '记入一条质疑（组织者，每场最多 20 条）',      2, null, 11),
  ('transcript',    '研讨会录音整理并核对，组织者平分',            20, null, 12),
  ('oral',          '口头报告（讨论结束）',                         40, null, 13),
  ('poster',        '海报（讨论结束）',                             20, null, 14),
  ('snapshot',      '提交快照（每个研究单元每期一次）',             10, null, 15),
  ('raise_query',   '提质疑，被记入',                                8, 30,   16),
  ('attend',        '到场签到（研讨会、讲座、联席会议），补签不算',  4, null, 17),
  ('biweekly',      '双周表登记',                                   10, null, 20),
  ('daily',         '日常登记（每期最多 10 天）',                     2, null, 21),
  ('review_note',   '写快照点评',                                   20, 15,   30),
  ('review_adopted','快照点评被采纳',                               10, null, 31),
  ('submission',    '投稿登记',                                      6, null, 32),
  ('arr',           'ARR 担保（同意担保）',                          20, null, 33),
  ('motion',        '联席会议提案列入议程',                         20, null, 40),
  ('second',        '联席会议附议',                                  4, null, 41),
  ('vote',          '联席会议表决',                                  4, null, 42),
  ('speech',        '联席会议会上发言',                              4, null, 43),
  ('interest',      '双选表达意向',                                  2, null, 50),
  ('trial_start',   '开试做期',                                     20, null, 51),
  ('trial_file',    '试做期结论备案（指导人）',                     20, null, 52),
  ('term_comment',  '学期考核写短评',                               10, null, 53),
  ('term_sign',     '学期考核签署意见',                             10, null, 54),
  ('course_attend', '训练课程出勤',                                  6, null, 60),
  ('course_teach',  '训练课程授课（开完课）',                       60, null, 61),
  ('feedback',      '反馈转成议题',                                  6, 10,   70);
insert into coin_task_rule (code, label, amount, streak, unit, sort) values
  ('s_daily',    '连续日常登记（工作日）',   0, '{"5": 5, "10": 15, "20": 40}', 'workday', 80),
  ('s_biweekly', '连续双周表登记',           0, '{"3": 20, "6": 50, "12": 120}', 'period', 81),
  ('s_snapshot', '连续每期提交快照',         0, '{"3": 20, "6": 50}', 'period', 82),
  ('s_attend',   '连续每期到场（研讨会等）', 0, '{"3": 10, "6": 30, "12": 80}', 'period', 83),
  ('s_organize', '连续每期组织研讨会',       0, '{"3": 30, "6": 80}', 'period', 84),
  ('s_respond',  '连续每期回应质疑',         0, '{"3": 20, "6": 60}', 'period', 85);

-- 发一笔：每件事只发一次；条数上限、季度合计上限之内；到了上限的记 0
create or replace function coin_task_give(p_user uuid, p_code text, p_key text, p_amount numeric, p_note text default null) returns numeric
language plpgsql security definer set search_path = public as $$
declare r coin_task_rule; q date := date_trunc('quarter', app_today())::date; amt numeric; cap numeric; got numeric; per date := token_period(app_today());
begin
  if p_user is null or p_amount is null or p_amount <= 0 then return 0; end if;
  if exists (select 1 from coin_task_award where user_id = p_user and code = p_code and source_key = p_key) then return 0; end if;
  if not exists (select 1 from app_user u join person pr on pr.user_id = u.id where u.id = p_user and u.active and pr.status in ('active','offroll')) then return 0; end if;
  select * into r from coin_task_rule where code = p_code;
  if not found then return 0; end if;
  amt := round(p_amount, 2);
  if r.quarter_cap is not null and (select count(*) from coin_task_award where user_id = p_user and code = p_code and q_start = q and amount > 0) >= r.quarter_cap then amt := 0; end if;
  select s.cap into cap from coin_task_setting s;
  select coalesce(sum(amount), 0) into got from coin_task_award where user_id = p_user and q_start = q;
  amt := greatest(least(amt, cap - got), 0);
  insert into coin_task_award (user_id, code, source_key, amount, q_start, note) values (p_user, p_code, p_key, amt, q, left(coalesce(p_note, r.label), 200));
  if amt > 0 then
    insert into coin_ledger (user_id, kind, amount, remain, expires_on, period_start, note)
    values (p_user, 'task', amt, amt, per + 14 * coin_salary_periods() - 1, per, left(coalesce(p_note, r.label), 200));
  end if;
  return amt;
end $$;

-- 连续：给一串「第几期 / 第几个工作日」的序号，找出每一段连续，按节点发
create or replace function coin_streak_give(p_user uuid, p_code text, p_idx int[]) returns int
language plpgsql security definer set search_path = public as $$
declare r coin_task_rule; s record; m record; top int; topv numeric; k int; n int := 0;
begin
  select * into r from coin_task_rule where code = p_code;
  if not found or r.streak is null or p_idx is null then return 0; end if;
  select max(key::int), (array_agg(value::numeric order by key::int desc))[1] into top, topv from jsonb_each_text(r.streak);
  for s in select min(i) as st, count(*)::int as len from (select i, i - row_number() over (order by i) as g from (select distinct unnest(p_idx) i) z) y group by g loop
    for m in select key::int as at, value::numeric as v from jsonb_each_text(r.streak) where key::int <= s.len loop
      n := n + (coin_task_give(p_user, p_code, s.st || ':' || m.at, m.v, format('%s（连续 %s）', r.label, m.at)) > 0)::int;
    end loop;
    k := top * 2;
    while k <= s.len loop
      n := n + (coin_task_give(p_user, p_code, s.st || ':' || k, topv, format('%s（连续 %s）', r.label, k)) > 0)::int;
      k := k + top;
    end loop;
  end loop;
  return n;
end $$;

create or replace function coin_period_idx(d date) returns int language sql immutable as $$ select ((d - date '2026-11-16') / 14)::int $$;
create or replace function coin_workday_idx(d date) returns int language sql immutable as $$
  select (((d - date '2000-01-03') / 7) * 5 + least(extract(isodow from d)::int, 5) - 1)::int
$$;

-- 扫描上线之后的操作并发币：定时任务调用
create or replace function coin_task_tick() returns int language plpgsql security definer set search_path = public as $$
declare since timestamptz; x record; n int := 0; k int; v numeric;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select s.since into since from coin_task_setting s;
  -- 组织研讨会、录音整理：开完会的研讨会，组织者平分
  for x in select e.id, e.seminar, e.held_on, (select count(*) from seminar_organizer o where o.seminar = e.seminar) as k,
                  exists (select 1 from meeting_transcript t where t.event_id = e.id and t.extracted_at is not null) as tr
           from attend_event e where e.kind = 'seminar' and e.ended_at is not null and e.ended_at >= since loop
    if x.k > 0 then
      perform coin_task_give(o.user_id, 'organize', x.id::text, 60.0 / x.k, format('组织研讨会 %s', to_char(x.held_on, 'MM-DD'))) from seminar_organizer o where o.seminar = x.seminar;
      if x.tr then perform coin_task_give(o.user_id, 'transcript', x.id::text, 20.0 / x.k, format('研讨会录音整理 %s', to_char(x.held_on, 'MM-DD'))) from seminar_organizer o where o.seminar = x.seminar; end if;
    end if;
  end loop;
  -- 记入质疑：每人每份提交最多 20 条
  perform coin_task_give(z.recorded_by, 'record_query', z.id::text, 2) from (
    select q.id, q.recorded_by, row_number() over (partition by q.recorded_by, q.pitch_id order by q.recorded_at) rn
    from query q where q.recorded_by is not null and q.recorded_at >= since) z where z.rn <= 20;
  -- 提质疑被记入
  perform coin_task_give(q.raised_by, 'raise_query', q.id::text, 8) from query q where q.raised_by is not null and q.recorded_at >= since;
  -- 汇报：讨论结束的口头报告、海报，发给提交快照的人
  perform coin_task_give(s.submitted_by, p.format, p.id::text, case p.format when 'oral' then 40 else 20 end, case p.format when 'oral' then '口头报告' else '海报' end)
  from snapshot_pitch p join snapshot s on s.id = p.snapshot_id where p.status = 'closed' and p.format is not null and p.closed_at >= since;
  -- 快照：每个研究单元每期一次
  perform coin_task_give(s.submitted_by, 'snapshot', s.project_id || ':' || s.period_start, 10) from snapshot s where s.submitted_at >= since;
  -- 到场签到：研讨会、讲座、联席会议计 attend，训练课程计 course_attend；补签不算
  perform coin_task_give(a.user_id, case when e.kind = 'training' then 'course_attend' else 'attend' end, e.id::text, case when e.kind = 'training' then 6 else 4 end,
                         format('%s %s', case e.kind when 'training' then '训练课程出勤' else '到场签到' end, to_char(e.held_on, 'MM-DD')))
  from attend a join attend_event e on e.id = a.event_id
  where a.status = 'present' and not coalesce(a.made_up, false) and e.kind in ('seminar','lecture','council','training') and coalesce(e.ended_at, e.started_at, e.recorded_at) >= since;
  -- 训练课程授课：开完课，发给建这节课的人
  perform coin_task_give(e.recorded_by, 'course_teach', e.id::text, 60, format('训练课程授课 %s', to_char(e.held_on, 'MM-DD')))
  from attend_event e where e.kind = 'training' and e.ended_at is not null and e.ended_at >= since and e.recorded_by is not null;
  -- 双周表
  perform coin_task_give(b.submitted_by, 'biweekly', b.project_id || ':' || b.period_start, 10) from biweekly_report b where b.submitted_at >= since;
  -- 日常：每期最多 10 天
  perform coin_task_give(z.user_id, 'daily', z.day::text, 2) from (
    select d.user_id, d.day, row_number() over (partition by d.user_id, token_period(d.day) order by d.day) rn
    from (select distinct user_id, day from daily_rev where created_at >= since) d) z where z.rn <= 10;
  -- 快照点评、点评被采纳
  perform coin_task_give(r.author_id, 'review_note', r.id::text, 20) from review_note r where r.created_at >= since;
  perform coin_task_give(r.author_id, 'review_adopted', r.id::text, 10) from review_note r where r.adopted_at is not null and r.adopted_at >= since;
  -- 投稿登记、ARR 担保
  perform coin_task_give(s.created_by, 'submission', s.id::text, 6) from submission s where s.created_by is not null and s.imported_at >= since;
  perform coin_task_give(c.sponsor_id, 'arr', c.id::text, 20) from arr_claim c where c.status = 'agreed' and c.decided_at >= since;
  -- 联席会议
  perform coin_task_give(m.proposer_id, 'motion', m.id::text, 20) from motion m where m.status not in ('proposed','withdrawn') and m.proposer_id is not null and coalesce(m.vote_open_at, m.decided_at, now()) >= since;
  perform coin_task_give(m.seconder_id, 'second', m.id::text, 4) from motion m where m.seconder_id is not null and m.status <> 'withdrawn' and coalesce(m.vote_open_at, m.decided_at, now()) >= since;
  perform coin_task_give(v.user_id, 'vote', v.motion_id || ':' || v.round, 4) from motion_vote v where v.at >= since;
  perform coin_task_give(s.user_id, 'speech', s.id::text, 4) from motion_speech s where s.spoke_at is not null and s.spoke_at >= since;
  -- 双选与试做期
  perform coin_task_give(i.user_id, 'interest', i.id::text, 2) from recruit_interest i where i.created_at >= since;
  perform coin_task_give(t.started_by, 'trial_start', t.id::text, 20) from trial t where t.created_at >= since and t.started_by is not null;
  perform coin_task_give(t.mentor_id, 'trial_file', t.id::text, 20) from trial t where t.concluded_at is not null and t.concluded_at >= since;
  -- 学期考核
  perform coin_task_give(c.author_id, 'term_comment', c.review_id || ':' || c.author_id, 10) from term_comment c where c.created_at >= since;
  perform coin_task_give(r.user_id, 'term_sign', r.review_id::text, 10) from term_reviewer r where r.signed_at is not null and r.signed_at >= since;
  -- 反馈转成议题
  perform coin_task_give(f.user_id, 'feedback', f.id::text, 6) from feedback f where f.issue_number is not null and f.created_at >= since;

  -- 连续奖励
  for x in select user_id, array_agg(distinct coin_workday_idx(day)) idx from daily_rev where created_at >= since and extract(isodow from day) < 6 group by 1 loop
    n := n + coin_streak_give(x.user_id, 's_daily', x.idx); end loop;
  for x in select submitted_by u, array_agg(distinct coin_period_idx(period_start)) idx from biweekly_report where submitted_at >= since group by 1 loop
    n := n + coin_streak_give(x.u, 's_biweekly', x.idx); end loop;
  for x in select submitted_by u, array_agg(distinct coin_period_idx(period_start)) idx from snapshot where submitted_at >= since group by 1 loop
    n := n + coin_streak_give(x.u, 's_snapshot', x.idx); end loop;
  -- 到场：本期有到场，或者本期请了假（请假不算断）
  for x in select u, array_agg(distinct i) idx from (
             select a.user_id u, coin_period_idx(token_period(e.held_on)) i from attend a join attend_event e on e.id = a.event_id
             where a.status in ('present','leave') and not coalesce(a.made_up, false) and e.kind in ('seminar','lecture','council') and coalesce(e.ended_at, e.started_at, e.recorded_at) >= since
             union select l.user_id, coin_period_idx(token_period(l.held_on)) from leave_request l where l.created_at >= since) z group by u loop
    n := n + coin_streak_give(x.u, 's_attend', x.idx); end loop;
  for x in select o.user_id u, array_agg(distinct coin_period_idx(token_period(e.held_on))) idx from attend_event e join seminar_organizer o on o.seminar = e.seminar
           where e.kind = 'seminar' and e.ended_at is not null and e.ended_at >= since group by 1 loop
    n := n + coin_streak_give(x.u, 's_organize', x.idx); end loop;
  for x in select user_id u, array_agg(distinct coin_period_idx(period_start)) idx from nominal_entry where created_at >= since group by 1 loop
    n := n + coin_streak_give(x.u, 's_respond', x.idx); end loop;
  return n;
end $$;

create or replace function coin_tick() returns integer language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return coin_expire_tick() + unit_coin_expire_tick() + coin_salary_tick() + coin_mint_tick() + coin_task_tick();
end $$;

-- 任务表全中心可见；发放记录本人看自己的，财务岗和中心负责人看全部
create view api.coin_task_rule as
  select r.code, r.label, r.amount, r.quarter_cap, r.streak, r.unit, r.sort, (select cap from coin_task_setting) as quarter_total_cap
  from coin_task_rule r where app_role() is not null;
create view api.coin_task_award as
  select a.id, a.user_id, u.name as user_name, a.code, r.label, a.amount, a.q_start, a.note, a.created_at
  from coin_task_award a join coin_task_rule r on r.code = a.code join app_user u on u.id = a.user_id
  where app_role() is not null and (a.user_id = app_uid() or has_perm('read.finance') or has_perm('budget.approve'));
grant select on api.coin_task_rule, api.coin_task_award to app_api;

-- 代币系统的流量计入做任务发的实际币
create or replace view api.coin_flow as
WITH b AS (
         SELECT (date_trunc('quarter'::text, LEAST(COALESCE(( SELECT min((coin_ledger.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AS min
                   FROM coin_ledger), (app_today())::timestamp without time zone), COALESCE(( SELECT min((unit_coin.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AS min
                   FROM unit_coin), (app_today())::timestamp without time zone))))::date AS s
        ), qs AS (
         SELECT (g.g)::date AS q,
            ((g.g + '3 mons'::interval))::date AS e
           FROM b,
            LATERAL generate_series((b.s)::timestamp with time zone, ((date_trunc('quarter'::text, (app_today())::timestamp with time zone))::date)::timestamp with time zone, '3 mons'::interval) g(g)
        ), cl AS (
         SELECT coin_ledger.kind,
            coin_ledger.amount,
            ((coin_ledger.created_at AT TIME ZONE 'Asia/Shanghai'::text))::date AS d
           FROM coin_ledger
        ), uc AS (
         SELECT unit_coin.kind,
            unit_coin.amount,
            ((unit_coin.created_at AT TIME ZONE 'Asia/Shanghai'::text))::date AS d
           FROM unit_coin
        )
 SELECT q AS q_start,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'salary'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_salary,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'mint'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_mint,
    COALESCE(( SELECT sum(uc.amount) AS sum
           FROM uc
          WHERE ((uc.kind = 'budget'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS issued_budget,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'adjust'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS adjusted,
    COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'compute'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS spent_compute,
    (COALESCE(( SELECT (- sum(cl.amount))
           FROM cl
          WHERE ((cl.kind = 'expire'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) + COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'expire'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric)) AS expired,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE (cl.d < qs.e)), (0)::numeric) AS out_person,
    COALESCE(( SELECT sum(uc.amount) AS sum
           FROM uc
          WHERE (uc.d < qs.e)), (0)::numeric) AS out_unit,
    COALESCE(( SELECT (- sum(uc.amount))
           FROM uc
          WHERE ((uc.kind = 'api'::text) AND (uc.d >= qs.q) AND (uc.d < qs.e))), (0)::numeric) AS spent_api,
    COALESCE(( SELECT sum(cl.amount) AS sum
           FROM cl
          WHERE ((cl.kind = 'task'::text) AND (cl.d >= qs.q) AND (cl.d < qs.e))), (0)::numeric) AS issued_task
   FROM qs
  WHERE (has_perm('read.finance'::text) OR has_perm('budget.approve'::text));
