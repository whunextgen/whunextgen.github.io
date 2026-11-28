-- 名义币会过期、实际币不过期（黄济民 2026-11-28「如果会过期，不如就是名义币呢？不用等解锁，名义币就是会过期，而实际币不会」
--   「实际币之后可以开放兑换绩效，然后换API还是要投入项目变成名义币」「作废」）
--   名义币：做任务、按期发放、回应质疑得的，发到个人，当季最后一天作废；研究单元账上一律是名义币（课题预算兑入的也当季作废）。
--   实际币：研究单元成果核对通过后按池子份额铸造到个人，不过期；以后可开放兑换绩效。
--   换 API、卡时：个人的币（名义币或实际币）投入研究单元，投入后都是名义币，当季作废；先用快过期的。
--   回应质疑：照旧记入研究单元池子的份额（nominal_entry，页面改叫「份额」），同时按同样的数发可花的名义币（任务 respond）。
--   账上种类不改：salary、task 是名义币，mint 是实际币。
insert into coin_task_rule (code, label, amount, quarter_cap, sort) values ('respond', '回应质疑（每条 16，队员平分；同时记入池子份额）', 16, null, 18)
on conflict (code) do nothing;

CREATE OR REPLACE FUNCTION public.coin_mint_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare rate numeric := nullif((select value #>> '{}' from token_param where key = 'rate'), '')::numeric; lv jsonb := (select value from token_param where key = 'levels');
  o record; m record; k numeric; amt numeric; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if rate is null or rate <= 0 then return 0; end if;
  for o in select project_id, level from outcome where checked_at is not null and not rejected loop
    k := case o.level when 1 then coalesce((lv ->> 'r1')::numeric, 1) else coalesce((lv ->> ('l' || o.level))::numeric, 0) end;
    if k <= 0 then continue; end if;
    for m in select user_id, sum(coins) c from nominal_entry where project_id = o.project_id group by user_id loop
      amt := round(m.c * rate * k, 2);
      if amt <= 0 then continue; end if;
      insert into coin_ledger (user_id, kind, amount, remain, expires_on, project_id, level, note)
      values (m.user_id, 'mint', amt, amt, null, o.project_id, o.level,
              format('研究单元「%s」%s级成果，按份额铸造', (select name from project where id = o.project_id), o.level))
      on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;

CREATE OR REPLACE FUNCTION public.invest_coins(p_project uuid, p_amount numeric, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare p project; left_n numeric; r record; take numeric; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '实际币只能投给已成立的研究单元'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '投入的数目须大于 0'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  if coin_balance(app_uid()) < p_amount then raise exception '实际币不足：余额 %', coin_balance(app_uid()); end if;
  left_n := p_amount;
  for r in select id, remain, expires_on from coin_ledger where user_id = app_uid() and remain > 0 and (expires_on is null or expires_on >= app_today())
           order by expires_on nulls last, created_at for update loop
    take := least(r.remain, left_n);
    update coin_ledger set remain = remain - take where id = r.id;
    -- 投入研究单元的一律成为名义币：名义币沿用原到期日，实际币（不过期）投入时到当季最后一天作废
    insert into unit_coin (project_id, kind, amount, user_id, note, remain, expires_on) values (p_project, 'invest', take, app_uid(), nt, take, coalesce(r.expires_on, coin_quarter_end(app_today())));
    left_n := left_n - take;
    exit when left_n <= 0;
  end loop;
  insert into coin_ledger (user_id, kind, amount, project_id, note) values (app_uid(), 'invest', -p_amount, p_project, coalesce(nt, format('投给研究单元「%s」', p.name)));
  perform notify_user(p.owner_id, format('实际币投入：%s 向研究单元「%s」投入 %s 实际币%s', (select name from app_user where id = app_uid()), p.name, p_amount, case when nt is null then '' else '。' || nt end));
end $$;

CREATE OR REPLACE FUNCTION public.exchange_budget(p_line uuid, p_unit uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare q coin_quarter; pl project_budget_line; topic uuid; u project; used_q numeric; room numeric; c numeric;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into q from coin_quarter where q_start = center_quarter(app_today()) for update;
  if not found then raise exception '本季度的兑换总额和比例尚未公布，请等财务岗公布'; end if;
  select l.* into pl from project_budget_line l where l.id = p_line for update;
  if not found then raise exception '预算行不存在'; end if;
  if not exists (select 1 from budget_category bc where bc.id = pl.category_id and bc.coin) then raise exception '只有「算力与模型接口」科目的预算可以兑换实际币'; end if;
  select b.project_id into topic from project_budget b where b.id = pl.budget_id;
  if not (can_manage_project(topic) or has_perm('budget.issue')) then raise exception '由课题负责人办理' using errcode = '42501'; end if;
  if not line_live(p_line) or coalesce(pl.fixed, 0) <= 0 then raise exception '这一行预算尚未下达，不能兑换'; end if;
  select * into u from project where id = p_unit;
  if not found or u.layer <> 'paper' or not u.active or u.proposed or (u.parent_id is distinct from topic and u.id <> topic) then
    raise exception '实际币记入本课题下已成立的研究单元';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception '兑换的预算须大于 0'; end if;
  select coalesce(sum(amt), 0) into room from v_line_use where line_id = p_line;
  room := coalesce(pl.fixed, 0) - room;
  if p_amount > room then raise exception '这一行核定 %，已用和已兑换 %，最多还能兑 %', pl.fixed, pl.fixed - room, greatest(room, 0); end if;
  select coalesce(sum(amount), 0) into used_q from budget_coin_exchange where q_start = q.q_start;
  if used_q + p_amount > q.total then
    raise exception '本季度全中心可兑换 %，已兑 %，剩余 %，不够兑 %（兑满即止）', q.total, used_q, greatest(q.total - used_q, 0), p_amount;
  end if;
  c := round(p_amount * q.rate, 2);
  insert into budget_coin_exchange (q_start, line_id, topic_id, unit_id, amount, coins, rate, by_user) values (q.q_start, p_line, topic, p_unit, p_amount, c, q.rate, app_uid());
  insert into unit_coin (project_id, kind, amount, user_id, expires_on, note) values (p_unit, 'budget', c, app_uid(), coin_quarter_end(app_today()), format('课题预算兑换：%s 元 × %s', p_amount, q.rate));
  if u.owner_id is not null and u.owner_id <> app_uid() then
    perform notify_user(u.owner_id, format('研究单元「%s」收到课题预算兑换的 %s 实际币，可用来换 API 额度或 GPU 卡时', u.name, c));
  end if;
  return c;
end $$;

CREATE OR REPLACE FUNCTION public.coin_task_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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

  -- 回应质疑：结清时记入池子份额（nominal_entry）的同时，按同样的数发可花的名义币
  perform coin_task_give(e.user_id, 'respond', e.id::text, e.coins, '回应质疑') from nominal_entry e where e.created_at >= since and e.coins > 0;
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

create or replace view api.coin_mine as
SELECT coin_balance(app_uid()) AS balance,
    COALESCE(( SELECT sum(coin_ledger.remain) AS sum
           FROM coin_ledger
          WHERE ((coin_ledger.user_id = app_uid()) AND (coin_ledger.remain > (0)::numeric) AND ((coin_ledger.expires_on >= app_today()) AND (coin_ledger.expires_on <= (app_today() + 60))))), (0)::numeric) AS expiring,
    ( SELECT min(coin_ledger.expires_on) AS min
           FROM coin_ledger
          WHERE ((coin_ledger.user_id = app_uid()) AND (coin_ledger.remain > (0)::numeric) AND (coin_ledger.expires_on >= app_today()))) AS next_expiry,
    (NULLIF(( SELECT (token_param.value #>> '{}'::text[])
           FROM token_param
          WHERE (token_param.key = 'price'::text)), ''::text))::numeric AS price,
    (NULLIF(( SELECT (token_param.value #>> '{}'::text[])
           FROM token_param
          WHERE (token_param.key = 'rate'::text)), ''::text))::numeric AS rate,
    (NULLIF(( SELECT (token_param.value ->> ( SELECT person.rank
                   FROM person
                  WHERE ((person.user_id = app_uid()) AND (person.status = ANY (ARRAY['active'::text, 'offroll'::text])))
                  ORDER BY person.updated_at DESC NULLS LAST
                 LIMIT 1))
           FROM token_param
          WHERE (token_param.key = 'salary'::text)), ''::text))::numeric AS salary,
    COALESCE(( SELECT sum(coin_ledger.remain) FROM coin_ledger
          WHERE coin_ledger.user_id = app_uid() AND coin_ledger.remain > 0 AND coin_ledger.kind <> 'mint' AND (coin_ledger.expires_on IS NULL OR coin_ledger.expires_on >= app_today())), (0)::numeric) AS nominal,
    COALESCE(( SELECT sum(coin_ledger.remain) FROM coin_ledger
          WHERE coin_ledger.user_id = app_uid() AND coin_ledger.remain > 0 AND coin_ledger.kind = 'mint'), (0)::numeric) AS real
  WHERE (app_uid() IS NOT NULL);

create or replace view api.coin_now as
SELECT COALESCE(( SELECT sum(coin_ledger.amount) AS sum
           FROM coin_ledger), (0)::numeric) AS out_person,
    COALESCE(( SELECT sum(unit_coin.amount) AS sum
           FROM unit_coin), (0)::numeric) AS out_unit,
    COALESCE(( SELECT sum(coin_ledger.remain) AS sum
           FROM coin_ledger
          WHERE ((coin_ledger.remain > (0)::numeric) AND (coin_ledger.expires_on >= app_today()) AND (coin_ledger.expires_on < (app_today() + 90)))), (0)::numeric) AS expiring_90d,
    ( SELECT count(DISTINCT coin_ledger.user_id) AS count
           FROM coin_ledger
          WHERE ((coin_ledger.remain > (0)::numeric) AND ((coin_ledger.expires_on IS NULL) OR (coin_ledger.expires_on >= app_today())))) AS holders,
    ( SELECT count(*) AS count
           FROM ( SELECT unit_coin.project_id
                   FROM unit_coin
                  GROUP BY unit_coin.project_id
                 HAVING (sum(unit_coin.amount) > (0)::numeric)) z) AS unit_holders,
    COALESCE(( SELECT sum(coin_ledger.remain) FROM coin_ledger WHERE coin_ledger.remain > 0 AND coin_ledger.kind <> 'mint' AND (coin_ledger.expires_on IS NULL OR coin_ledger.expires_on >= app_today())), (0)::numeric) AS nominal_person,
    COALESCE(( SELECT sum(coin_ledger.remain) FROM coin_ledger WHERE coin_ledger.remain > 0 AND coin_ledger.kind = 'mint'), (0)::numeric) AS real_person
  WHERE (has_perm('read.finance'::text) OR has_perm('budget.approve'::text));
