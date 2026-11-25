-- 个人主页「我的事项」和研究单元页按设计稿（ir-character-card、ir-unit-card）补齐，并把代币经济接上实际币。
--   一、当日：每日三项。修订（本人登记当日修订了草稿，可注明推进了队里的哪条质疑）、推进（当日抽取本人队里的一条质疑）、
--       审阅（当日抽取其他研究单元的一份快照，提交意见；负责人采纳的记入利）。
--   二、嘉许：每人每期至多给出两次，给别人记入元、亨、利、贞中的一项。
--   三、称号与学期挑战：按记录自动取得，学期按二月、八月起算。
--   四、属性改按点数：文章四项仍按名义币；德行四项按规定的点数累加（见 person_attr）。
--   五、实际币：个人账户按流水记，每笔收入有到期日，支出先扣先到期的。来源有三：按期发放（各身份的额度由中心负责人定，
--       Rising Star、PI、Director 也有）、研究单元解锁后按份额铸造（挂牌铸造率、各级系数）。代币不是经费，与经费卡无关。
--       个人的实际币只能投给研究单元，进研究单元的账；研究单元的负责人再用它换 GPU 卡时（标价由中心负责人定），以后也可以换别的资源。
--       换得的卡时记在 compute_grant，集群一侧按此设定 Slurm 的额度。额度和标价未定的，不发、不换。
--   六、双周表的「写作进度」「成员分工」两栏由快照和质疑取代，不再必填。

-- ---------- 六、双周表 ----------
alter table biweekly_report alter column stage drop not null, alter column division drop not null;
-- 在现行函数上去掉两栏的必填，登记日等其余判断不动
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.save_biweekly_report(uuid, date, text, text, text, text, text, text, text)'::regprocedure);
  n := replace(d, 'if p_stage is null then raise exception ''请选择写作进度''; end if;
  if p_stage not in', 'if p_stage is not null and p_stage not in');
  n := replace(n, 'if v is null then raise exception ''请填写成员分工''; end if;
', '');
  if n = d or position('请选择写作进度' in n) > 0 or position('请填写成员分工' in n) > 0 then raise exception 'save_biweekly_report：没有找到两栏的必填判断'; end if;
  execute n;
end $$;

-- ---------- 一、当日 ----------
create table daily_rev (
  user_id    uuid not null references app_user(id),
  day        date not null,
  project_id uuid not null references project(id),
  query_id   uuid references query(id),
  note       text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);
create table review_note (
  id          uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references snapshot(id),
  author_id   uuid not null references app_user(id),
  day         date not null,
  body        text not null check (length(btrim(body)) between 1 and 500),
  adopted_by  uuid references app_user(id),
  adopted_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index review_note_snap on review_note (snapshot_id);
select seal('daily_rev', 'review_note');
create trigger audit after insert or update or delete on daily_rev for each row execute function trg_audit();
create trigger audit after insert or update or delete on review_note for each row execute function trg_audit();

-- 当日抽取：按日期和本人轮换，同一天抽到的不变
create function today_pick_query(p_user uuid, p_day date) returns uuid language sql stable security definer set search_path = public as $$
  with c as (select q.id, row_number() over (order by q.recorded_at, q.id) - 1 as i, count(*) over () as n
             from query q join query_member m on m.query_id = q.id where m.user_id = p_user and q.status = 'open')
  select id from c where i = mod(abs(hashtext(p_user::text || p_day::text)), greatest(n, 1))
$$;
create function today_pick_snapshot(p_user uuid, p_day date) returns uuid language sql stable security definer set search_path = public as $$
  with s as (select distinct on (s.project_id) s.id, s.project_id from snapshot s join project p on p.id = s.project_id
             where s.period_start >= token_period(p_day) - 14 and p.owner_id is distinct from p_user and not is_on_project(p.id, p_user)
             order by s.project_id, s.seq desc),
       c as (select id, row_number() over (order by project_id) - 1 as i, count(*) over () as n from s)
  select id from c where i = mod(abs(hashtext(p_day::text || p_user::text)), greatest(n, 1))
$$;

create function log_revision(p_project uuid, p_query uuid default null, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare p project; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '请选择已成立的研究单元'; end if;
  if not (p.owner_id = app_uid() or is_on_project(p_project)
          or (p_query is not null and exists (select 1 from query_member where query_id = p_query and user_id = app_uid()))) then
    raise exception '只能登记本人所在研究单元或所在队伍的修订' using errcode = '42501'; end if;
  if p_query is not null and not exists (select 1 from query where id = p_query and project_id = p_project and status = 'open') then raise exception '这条质疑不属于该研究单元或已回应'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  insert into daily_rev (user_id, day, project_id, query_id, note) values (app_uid(), app_today(), p_project, p_query, nt)
  on conflict (user_id, day) do update set project_id = excluded.project_id, query_id = coalesce(excluded.query_id, daily_rev.query_id), note = coalesce(excluded.note, daily_rev.note);
end $$;

create function submit_review(p_snapshot uuid, p_body text) returns uuid language plpgsql security definer set search_path = public as $$
declare s snapshot; p project; b text := btrim(coalesce(p_body, '')); v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into s from snapshot where id = p_snapshot;
  if not found then raise exception '快照不存在'; end if;
  select * into p from project where id = s.project_id;
  if p.owner_id = app_uid() or is_on_project(p.id) then raise exception '审阅的是其他研究单元的快照'; end if;
  if b = '' or length(b) > 500 then raise exception '请写明意见，不超过 500 个字'; end if;
  insert into review_note (snapshot_id, author_id, day, body) values (p_snapshot, app_uid(), app_today(), b) returning review_note.id into v_id;
  perform notify_user(p.owner_id, format('审阅意见：%s 对研究单元「%s」的第 %s 次快照提了意见：%s', (select name from app_user where id = app_uid()), p.name, s.seq, left(b, 80)));
  return v_id;
end $$;

-- 负责人采纳：意见可在下一次研讨会上作为质疑提出；采纳记入审阅人的利
create function adopt_review(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r review_note; p project;
begin
  select * into r from review_note where id = p_id for update;
  if not found then raise exception '意见不存在'; end if;
  select p2.* into p from snapshot s join project p2 on p2.id = s.project_id where s.id = r.snapshot_id;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人采纳' using errcode = '42501'; end if;
  if r.adopted_at is not null then raise exception '已采纳'; end if;
  update review_note set adopted_by = app_uid(), adopted_at = now() where id = p_id;
  perform notify_user(r.author_id, format('审阅意见已采纳：研究单元「%s」的负责人采纳了你的意见，记入利', p.name));
end $$;

-- ---------- 二、嘉许 ----------
create table praise (
  id           uuid primary key default gen_random_uuid(),
  from_user    uuid not null references app_user(id),
  to_user      uuid not null references app_user(id),
  virtue       text not null check (virtue in ('yuan','heng','li','zhen')),
  period_start date not null,
  note         text check (note is null or length(note) <= 120),
  created_at   timestamptz not null default now(),
  check (from_user <> to_user)
);
select seal('praise');
create trigger audit after insert or update or delete on praise for each row execute function trg_audit();
create function virtue_label(p_v text) returns text language sql immutable as $$
  select case p_v when 'yuan' then '元' when 'heng' then '亨' when 'li' then '利' when 'zhen' then '贞' end
$$;
create function give_praise(p_to uuid, p_virtue text, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare per date := token_period(app_today()); nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if p_to = app_uid() then raise exception '不能嘉许本人'; end if;
  if virtue_label(p_virtue) is null then raise exception '嘉许记入元、亨、利、贞中的一项'; end if;
  if not exists (select 1 from app_user where id = p_to and active) then raise exception '人员不存在'; end if;
  if (select count(*) from praise where from_user = app_uid() and period_start = per) >= 2 then raise exception '每期至多给出两次嘉许'; end if;
  if nt is not null and length(nt) > 120 then raise exception '说明不得超过 120 个字'; end if;
  insert into praise (from_user, to_user, virtue, period_start, note) values (app_uid(), p_to, p_virtue, per, nt);
  perform notify_user(p_to, format('嘉许：%s 嘉许了你，记入%s%s', (select name from app_user where id = app_uid()), virtue_label(p_virtue), case when nt is null then '' else '。' || nt end));
end $$;

-- ---------- 三、学期、称号、学期挑战 ----------
create function semester_start(p_day date) returns date language sql immutable as $$
  select case when extract(month from p_day) between 2 and 7 then make_date(extract(year from p_day)::int, 2, 1)
              when extract(month from p_day) >= 8 then make_date(extract(year from p_day)::int, 8, 1)
              else make_date(extract(year from p_day)::int - 1, 8, 1) end
$$;

create table challenge (
  code   text primary key,
  seq    int not null,
  title  text not null,
  detail text,
  need   int not null check (need > 0),
  reward text not null                                   -- 完成后得到的：称号名，或记入的德行
);
insert into challenge values
  ('four',   1, '理、据、体、用四问各回应质疑一条', '本学期内，四问各有一条本人回应的质疑结算', 4, '称号 · 四问'),
  ('askers', 2, '向三个不同研究单元提出质疑', '本学期内，在其他研究单元的快照上提出的质疑记入中台', 3, '利'),
  ('steady', 3, '日常任务连续完成三期', '本学期内，任意连续三期的日常任务全部完成', 3, '贞'),
  ('review', 4, '审阅意见被采纳两次', '本学期内，对其他研究单元快照的意见被负责人采纳', 2, '利'),
  ('show',   5, '在主题研讨会上展示快照两次', '本学期内，本人负责的研究单元的快照经讨论结束', 2, '亨');
select seal('challenge');

create function challenge_progress(p_user uuid, p_code text, p_day date default null) returns int language plpgsql stable security definer set search_path = public as $$
declare s date := semester_start(coalesce(p_day, app_today())); n int := 0;
begin
  if p_code = 'four' then
    select count(distinct axis)::int into n from nominal_entry where user_id = p_user and period_start >= s;
  elsif p_code = 'askers' then
    select count(distinct q.project_id)::int into n from query q join project p on p.id = q.project_id
      where q.raised_by = p_user and q.period_start >= s and p.owner_id is distinct from p_user and not is_on_project(p.id, p_user);
  elsif p_code = 'steady' then
    select coalesce(max(streak), 0)::int into n from daily_streak(p_user) where period_start >= s;
  elsif p_code = 'review' then
    select count(*)::int into n from review_note where author_id = p_user and adopted_at is not null and day >= s;
  elsif p_code = 'show' then
    select count(*)::int into n from snapshot_pitch x join snapshot sn on sn.id = x.snapshot_id join project p on p.id = sn.project_id
      where x.status = 'closed' and p.owner_id = p_user and sn.period_start >= s;
  end if;
  return n;
end $$;

-- 称号：按记录取得，取得后不收回；显示最近取得的一个
create table title_rule (code text primary key, seq int not null, name text not null, rule text not null);
insert into title_rule values
  ('draft',  1, '入稿', '本人的改动第一次进入快照'),
  ('answer', 2, '应疑', '第一次回应质疑并结算'),
  ('four',   3, '四问', '一学期内理、据、体、用四问各回应质疑一条'),
  ('ten',    4, '解惑', '累计回应质疑十条'),
  ('steady', 5, '守恒', '日常任务连续完成六期'),
  ('guide',  6, '引路', '所带的人通过考核');
select seal('title_rule');
create function title_earned(p_user uuid, p_code text) returns boolean language sql stable security definer set search_path = public as $$
  select case p_code
    when 'draft'  then exists (select 1 from snapshot_author where user_id = p_user)
    when 'answer' then exists (select 1 from nominal_entry where user_id = p_user)
    when 'four'   then exists (select 1 from (select semester_start(period_start) s from nominal_entry where user_id = p_user group by 1 having count(distinct axis) = 4) z)
    when 'ten'    then (select count(*) from nominal_entry where user_id = p_user) >= 10
    when 'steady' then coalesce((select max(streak) from daily_streak(p_user)), 0) >= 6
    when 'guide'  then exists (select 1 from assessment where mentor_id = p_user and status = 'passed')
    else false end
$$;

-- ---------- 四、属性改按点数 ----------
drop view api.person_attr;
create view api.person_attr as
  select u.id as user_id, u.name as user_name,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'li'), 0) as a_li,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'ju'), 0) as a_ju,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'ti'), 0) as a_ti,
         coalesce((select sum(coins) from nominal_entry where user_id = u.id and axis = 'yong'), 0) as a_yong,
         -- 元：所带的人每回应一条记 16，通过考核记 40；收到的嘉许每次 4
         ((select count(*) from nominal_entry e where first_mentor(e.user_id) = u.id) * 16
          + (select count(*) from assessment a where a.mentor_id = u.id and a.status = 'passed') * 40
          + (select count(*) from praise where to_user = u.id and virtue = 'yuan') * 4)::int as d_yuan,
         -- 亨：本人负责的研究单元展示快照、主持讨论、中心负责人确认的组织主持，每次 16；嘉许每次 4
         (((select count(*) from snapshot_pitch x join snapshot s on s.id = x.snapshot_id join project p on p.id = s.project_id where x.status = 'closed' and p.owner_id = u.id)
          + (select count(*) from snapshot_pitch x where x.status = 'closed' and x.closed_by = u.id)
          + (select count(*) from merit m where m.user_id = u.id and m.virtue = 'heng')) * 16
          + (select count(*) from praise where to_user = u.id and virtue = 'heng') * 4)::int as d_heng,
         -- 利：给别人的快照提出质疑每条 4；回应别的研究单元的质疑按所得名义币；审阅意见被采纳每次 4；公共事务每项 16；嘉许每次 4
         ((select count(*) from query q join project p on p.id = q.project_id where q.raised_by = u.id and p.owner_id is distinct from u.id and not is_on_project(p.id, u.id)) * 4
          + coalesce((select sum(e.coins) from nominal_entry e join project p on p.id = e.project_id where e.user_id = u.id and p.owner_id is distinct from u.id and not is_on_project(p.id, u.id)), 0)
          + (select count(*) from review_note where author_id = u.id and adopted_at is not null) * 4
          + (select count(*) from merit m where m.user_id = u.id and m.virtue = 'li') * 16
          + (select count(*) from praise where to_user = u.id and virtue = 'li') * 4)::numeric as d_li,
         -- 贞：每完成一期记 10，连续每多一期多计一成；当日修订每日 1；嘉许每次 4
         (coalesce((select sum(zhen) from daily_streak(u.id)), 0) * 10
          + (select count(*) from daily_rev where user_id = u.id)
          + (select count(*) from praise where to_user = u.id and virtue = 'zhen') * 4) as d_zhen,
         coalesce((select streak from daily_streak(u.id) order by period_start desc limit 1), 0) as streak,
         (select t.name from title_rule t where title_earned(u.id, t.code) order by t.seq desc limit 1) as title
  from app_user u where u.active and app_role() is not null and exists (select 1 from person pr where pr.user_id = u.id and pr.status in ('active','offroll'));

-- ---------- 五、实际币 ----------
alter table token_param drop constraint token_param_key_check;
alter table token_param add constraint token_param_key_check check (key in ('nominal', 'phase', 'split', 'reserve', 'levels', 'resubmit', 'rate', 'valid', 'salary', 'price'));
insert into token_param (key, value) values
  ('salary', '{"intern": null, "assistant": null, "researcher": null, "rising_star": null, "pi": null, "director": null}'),
  ('price', 'null');

create table coin_ledger (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user(id),
  kind         text not null check (kind in ('salary','mint','invest','expire','adjust')),
  amount       numeric not null check (amount <> 0),
  remain       numeric,                                  -- 收入尚未用掉、未过期的部分
  expires_on   date,
  period_start date,
  project_id   uuid references project(id),
  level        int,
  note         text check (note is null or length(note) <= 200),
  created_by   uuid references app_user(id),
  created_at   timestamptz not null default now(),
  check ((amount > 0) = (remain is not null))
);
create unique index coin_salary_once on coin_ledger (user_id, period_start) where kind = 'salary';
create unique index coin_mint_once on coin_ledger (user_id, project_id, level) where kind = 'mint';
create index coin_ledger_user on coin_ledger (user_id, created_at desc);
create table compute_grant (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references project(id),
  hours       numeric not null check (hours > 0),
  coins       numeric not null check (coins > 0),
  bought_by   uuid not null references app_user(id),
  bought_at   timestamptz not null default now()
);
-- 研究单元的实际币账：成员和其他人投入的，负责人换资源用掉的
create table unit_coin (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references project(id),
  kind        text not null check (kind in ('invest','compute')),
  amount      numeric not null check (amount <> 0),
  user_id     uuid not null references app_user(id),
  note        text check (note is null or length(note) <= 200),
  created_at  timestamptz not null default now()
);
create index unit_coin_project on unit_coin (project_id);
select seal('coin_ledger', 'compute_grant', 'unit_coin');
create trigger audit after insert or update or delete on unit_coin for each row execute function trg_audit();
create trigger audit after insert or update or delete on coin_ledger for each row execute function trg_audit();
create trigger audit after insert or update or delete on compute_grant for each row execute function trg_audit();

create function coin_valid_months() returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from token_param where key = 'valid'), 12)
$$;
create function coin_balance(p_user uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(remain), 0) from coin_ledger where user_id = p_user and remain > 0 and (expires_on is null or expires_on >= app_today())
$$;

-- 到期的作废：定时任务调用
create function coin_expire_tick() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for r in select * from coin_ledger where remain > 0 and expires_on < app_today() for update loop
    insert into coin_ledger (user_id, kind, amount, note) values (r.user_id, 'expire', -r.remain, format('%s 到期作废', to_char(r.expires_on, 'YYYY-MM-DD')));
    update coin_ledger set remain = 0 where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 按期发放：各身份的额度未定的不发；每人每期一次
create function coin_salary_tick() returns int language plpgsql security definer set search_path = public as $$
declare per date := token_period(app_today()); s jsonb := (select value from token_param where key = 'salary'); r record; amt numeric; n int := 0;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  for r in select pr.user_id, pr.rank from person pr join app_user u on u.id = pr.user_id where pr.status in ('active','offroll') and u.active loop
    amt := nullif(s ->> r.rank, '')::numeric;
    if amt is null or amt <= 0 then continue; end if;
    insert into coin_ledger (user_id, kind, amount, remain, expires_on, period_start, note)
    values (r.user_id, 'salary', amt, amt, (per + make_interval(months => coin_valid_months()))::date, per, format('%s 起一期按身份发放（%s）', to_char(per, 'YYYY-MM-DD'), rank_label(r.rank)))
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- 解锁后按份额铸造：一级按挂牌铸造率等额，二、三、四级按追加系数；挂牌铸造率未定的不铸
create function coin_mint_tick() returns int language plpgsql security definer set search_path = public as $$
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
      values (m.user_id, 'mint', amt, amt, (app_today() + make_interval(months => coin_valid_months()))::date, o.project_id, o.level,
              format('研究单元「%s」%s级成果，按份额铸造', (select name from project where id = o.project_id), o.level))
      on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end loop;
  return n;
end $$;

create function coin_tick() returns int language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return coin_expire_tick() + coin_salary_tick() + coin_mint_tick();
end $$;

-- 投给研究单元：任何人都可以把自己的实际币投给一个已成立的研究单元，先扣先到期的
create function invest_coins(p_project uuid, p_amount numeric, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare p project; left_n numeric; r record; take numeric; nt text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into p from project where id = p_project;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '实际币只能投给已成立的研究单元'; end if;
  if p_amount is null or p_amount <= 0 then raise exception '投入的数目须大于 0'; end if;
  if nt is not null and length(nt) > 200 then raise exception '说明不得超过 200 个字'; end if;
  if coin_balance(app_uid()) < p_amount then raise exception '实际币不足：余额 %', coin_balance(app_uid()); end if;
  left_n := p_amount;
  for r in select id, remain from coin_ledger where user_id = app_uid() and remain > 0 and (expires_on is null or expires_on >= app_today())
           order by expires_on nulls last, created_at for update loop
    take := least(r.remain, left_n);
    update coin_ledger set remain = remain - take where id = r.id;
    left_n := left_n - take;
    exit when left_n <= 0;
  end loop;
  insert into coin_ledger (user_id, kind, amount, project_id, note) values (app_uid(), 'invest', -p_amount, p_project, coalesce(nt, format('投给研究单元「%s」', p.name)));
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'invest', p_amount, app_uid(), nt);
  perform notify_user(p.owner_id, format('实际币投入：%s 向研究单元「%s」投入 %s 实际币%s', (select name from app_user where id = app_uid()), p.name, p_amount, case when nt is null then '' else '。' || nt end));
end $$;

create function unit_coin_balance(p_project uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from unit_coin where project_id = p_project
$$;

-- 研究单元换 GPU 卡时：由负责人办理，按标价从研究单元的账上扣
create function buy_compute(p_project uuid, p_hours numeric) returns uuid language plpgsql security definer set search_path = public as $$
declare price numeric := nullif((select value #>> '{}' from token_param where key = 'price'), '')::numeric; p project; need numeric; v_id uuid;
begin
  if app_uid() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if price is null or price <= 0 then raise exception '卡时的标价尚未公布'; end if;
  select * into p from project where id = p_project for update;
  if not found or p.layer <> 'paper' or not p.active or p.proposed then raise exception '卡时由研究单元换'; end if;
  if not (p.owner_id = app_uid() or app_role() = 'director') then raise exception '由研究单元的负责人办理' using errcode = '42501'; end if;
  if p_hours is null or p_hours <= 0 or p_hours <> round(p_hours) then raise exception '卡时须为正整数'; end if;
  need := p_hours * price;
  if unit_coin_balance(p_project) < need then raise exception '研究单元的实际币不足：需要 %，账上 %', need, unit_coin_balance(p_project); end if;
  insert into unit_coin (project_id, kind, amount, user_id, note) values (p_project, 'compute', -need, app_uid(), format('换 %s 卡时', p_hours));
  insert into compute_grant (project_id, hours, coins, bought_by) values (p_project, p_hours, need, app_uid()) returning compute_grant.id into v_id;
  return v_id;
end $$;

-- 参数：增加各身份每期发放的实际币、卡时标价；挂牌铸造率不再受计划经济时期限制
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
  elsif p_key = 'price' then
    if jsonb_typeof(p_value) not in ('null', 'number') or (jsonb_typeof(p_value) = 'number' and p_value::text::numeric <= 0) then raise exception '卡时标价须大于 0，未定的留空'; end if;
  else
    raise exception '该参数不可在此修改';
  end if;
  update token_param set value = p_value, updated_by = app_uid(), updated_at = now() where key = p_key;
end $$;

select expose('log_revision(uuid, uuid, text)', 'submit_review(uuid, text)', 'adopt_review(uuid)', 'give_praise(uuid, text, text)', 'invest_coins(uuid, numeric, text)', 'buy_compute(uuid, numeric)', 'coin_tick()');

-- ---------- 视图 ----------
-- 本人的当日：今天是本回合第几日、三项是否完成、抽到的质疑和快照
create view api.today_mine as
  select app_today() as day, token_period(app_today()) as period_start,
         (app_today() - token_period(app_today()) + 1) as day_no,
         exists (select 1 from daily_rev where user_id = app_uid() and day = app_today()) as rev_done,
         (select count(*)::int from daily_rev where user_id = app_uid() and day = app_today() - 1) as rev_yesterday,
         (with recursive d(x) as (select app_today() - case when exists (select 1 from daily_rev where user_id = app_uid() and day = app_today()) then 0 else 1 end
                                  union all select x - 1 from d where exists (select 1 from daily_rev where user_id = app_uid() and day = x))
          select (count(*) - 1)::int from d) as rev_streak,
         q.id as pick_query, q.body as pick_query_body, q.axis as pick_query_axis, qp.id as pick_query_project, qp.name as pick_query_project_name,
         exists (select 1 from daily_rev where user_id = app_uid() and day = app_today() and query_id = q.id) as push_done,
         s.id as pick_snapshot, s.seq as pick_snapshot_seq, s.link as pick_snapshot_link, sp.name as pick_snapshot_project_name,
         exists (select 1 from review_note where author_id = app_uid() and day = app_today()) as review_done
  from (select 1) z
  left join query q on q.id = today_pick_query(app_uid(), app_today())
  left join project qp on qp.id = q.project_id
  left join snapshot s on s.id = today_pick_snapshot(app_uid(), app_today())
  left join project sp on sp.id = s.project_id
  where app_uid() is not null;

create view api.review_note as
  select r.id, r.snapshot_id, s.project_id, p.name as project_name, s.seq, r.author_id, (select name from app_user where id = r.author_id) as author_name, r.day, r.body,
         r.adopted_at, (r.adopted_at is null and (p.owner_id = app_uid() or app_role() = 'director')) as can_adopt
  from review_note r join snapshot s on s.id = r.snapshot_id join project p on p.id = s.project_id
  where app_role() is not null and (r.author_id = app_uid() or p.owner_id = app_uid() or is_on_project(p.id) or app_role() = 'director');

create view api.praise_mine as
  select x.id, x.from_user, (select name from app_user where id = x.from_user) as from_name, x.to_user, (select name from app_user where id = x.to_user) as to_name,
         x.virtue, x.period_start, x.note, x.created_at
  from praise x where app_uid() is not null and (x.from_user = app_uid() or x.to_user = app_uid());

create view api.challenge_mine as
  select c.code, c.seq, c.title, c.detail, c.need, c.reward, least(challenge_progress(app_uid(), c.code), c.need) as progress, semester_start(app_today()) as semester
  from challenge c where app_uid() is not null;

create view api.title_mine as
  select t.code, t.seq, t.name, t.rule, title_earned(app_uid(), t.code) as earned from title_rule t where app_uid() is not null;

-- 本人的实际币：余额、近期到期、流水
create view api.coin_mine as
  select coin_balance(app_uid()) as balance,
         coalesce((select sum(remain) from coin_ledger where user_id = app_uid() and remain > 0 and expires_on between app_today() and app_today() + 60), 0) as expiring,
         (select min(expires_on) from coin_ledger where user_id = app_uid() and remain > 0 and expires_on >= app_today()) as next_expiry,
         nullif((select value #>> '{}' from token_param where key = 'price'), '')::numeric as price,
         nullif((select value #>> '{}' from token_param where key = 'rate'), '')::numeric as rate,
         nullif((select value ->> (select rank from person where user_id = app_uid() and status in ('active','offroll') order by updated_at desc nulls last limit 1) from token_param where key = 'salary'), '')::numeric as salary
  where app_uid() is not null;
create view api.coin_ledger as
  select l.id, l.user_id, l.kind, l.amount, l.remain, l.expires_on, l.period_start, l.project_id, (select name from project where id = l.project_id) as project_name, l.level, l.note, l.created_at
  from coin_ledger l where app_role() is not null and (l.user_id = app_uid() or has_perm('budget.approve'));

-- 换得的卡时：全中心看得到；集群一侧按研究单元或课题汇总设定额度
create view api.compute_grant as
  select g.id, g.project_id, p.code as project_code, p.name as project_name, p.layer, g.hours, g.coins, (select name from app_user where id = g.bought_by) as bought_by_name, g.bought_at
  from compute_grant g join project p on p.id = g.project_id where app_role() is not null;

-- 各期记录：本人最近六期的出勤、双周表、快照收录
create view api.period_record as
  select d.period_start,
         (select case when count(*) = 0 then null when bool_and(a.status = 'present') then 2 when bool_and(a.status = 'present' or (a.status = 'leave' and a.made_up)) then 1 else 0 end
            from attend_event e left join attend a on a.event_id = e.id and a.user_id = app_uid() where e.kind = 'lecture' and e.held_on between d.period_start and d.period_start + 13) as lecture,
         (select case when count(*) = 0 then null when bool_or(a.status = 'present') then 2 when bool_or(a.status = 'leave' and a.made_up) then 1 else 0 end
            from attend_event e left join attend a on a.event_id = e.id and a.user_id = app_uid() where e.kind = 'seminar' and e.held_on between d.period_start and d.period_start + 13) as seminar,
         (select case when count(*) = 0 then null when bool_and(exists (select 1 from biweekly_report b where b.project_id = p.id and b.period_start = d.period_start)) then 2 else 0 end
            from project p where p.layer = 'paper' and p.active and not p.proposed and (p.owner_id = app_uid() or is_on_project(p.id))) as biweekly,
         (case when exists (select 1 from snapshot s join snapshot_author a on a.snapshot_id = s.id where a.user_id = app_uid() and s.period_start = d.period_start) then 2 else 0 end) as snapshot
  from (select (token_period(app_today()) - g * 14) as period_start from generate_series(0, 5) g) d
  where app_uid() is not null;

-- 研究单元的实际币账：全中心看得到
create view api.unit_coin as
  select c.id, c.project_id, p.code as project_code, p.name as project_name, c.kind, c.amount, c.user_id, (select name from app_user where id = c.user_id) as user_name, c.note, c.created_at,
         unit_coin_balance(c.project_id) as balance
  from unit_coin c join project p on p.id = c.project_id where app_role() is not null;
create view api.unit_coin_balance as
  select p.id as project_id, unit_coin_balance(p.id) as balance,
         coalesce((select sum(hours) from compute_grant g where g.project_id = p.id), 0) as hours,
         (p.owner_id = app_uid() or app_role() = 'director') as can_buy
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;
grant select on api.unit_coin, api.unit_coin_balance to app_api;

grant select on api.person_attr, api.today_mine, api.review_note, api.praise_mine, api.challenge_mine, api.title_mine, api.coin_mine, api.coin_ledger, api.compute_grant, api.period_record to app_api;

-- 研究单元页的成员名单加上身份
create or replace view api.project_member as
  select m.id, m.project_id, m.user_id, u.name as user_name, m.joined_on, m.left_on,
         (select name from app_user where id = m.added_by) as added_by_name,
         case when m.left_on is null then member_holding(m.project_id, m.user_id) else 0 end as holding,
         u.scholar_url,
         (select rank_label(pr.rank) from person pr where pr.user_id = m.user_id and pr.status in ('active','offroll') order by pr.updated_at desc nulls last limit 1) as rank_label
  from project_member m join app_user u on u.id = m.user_id
  where can_see_project(m.project_id) or m.user_id = app_uid();

-- ---------- 七、与集群同步的接口 ----------
-- 中台只记研究单元换得的卡时；QOS 怎么建、挂到谁的集群账号上，由集群一侧在 Slurm 里设置。
-- 集群一侧用一个带「集群同步」权限的访问令牌，经 MCP 读写：
--   读 cluster_quota：每个已成立的研究单元一行，累计换得的卡时、集群报回的已用卡时、剩余，名单内的人（含负责人），最近一次执行回执
--   写 report_cluster_usage：按研究单元、按期报回已用的 GPU 卡时（同一期再报即覆盖）
--   写 ack_cluster_quota：报回额度已在集群上执行到多少卡时，成功或失败及原因
insert into rbac_perm (code, name, grp, scope, sort) values ('cluster.sync', '集群同步：读取研究单元的卡时额度，报回用量和执行结果', '资源', 'global', 60)
on conflict (code) do nothing;
insert into rbac_role (code, name, note, builtin, locked, implicit, sort)
values ('cluster', '集群同步', '集群一侧的同步脚本使用', false, false, false, 20) on conflict (code) do nothing;
insert into rbac_role_perm (role_id, perm) select r.id, 'cluster.sync' from rbac_role r where r.code in ('cluster', 'director') on conflict do nothing;

create table cluster_usage (
  project_id   uuid not null references project(id),
  period_start date not null check (period_start = token_period(period_start)),
  hours        numeric not null check (hours >= 0),
  reported_by  uuid not null references app_user(id),
  reported_at  timestamptz not null default now(),
  primary key (project_id, period_start)
);
create table cluster_ack (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  hours        numeric not null check (hours >= 0),
  ok           boolean not null,
  note         text check (note is null or length(note) <= 300),
  reported_by  uuid not null references app_user(id),
  reported_at  timestamptz not null default now()
);
select seal('cluster_usage', 'cluster_ack');
create trigger audit after insert or update or delete on cluster_usage for each row execute function trg_audit();
create trigger audit after insert or update or delete on cluster_ack for each row execute function trg_audit();

create function report_cluster_usage(p_project uuid, p_period date, p_hours numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('cluster.sync') then raise exception '需要权限：cluster.sync' using errcode = '42501'; end if;
  if not exists (select 1 from project where id = p_project and layer = 'paper') then raise exception '研究单元不存在'; end if;
  if p_period is null or p_period <> token_period(p_period) or p_period > token_period(app_today()) then raise exception '期次有误：须为某一期的第一天，且不晚于本期'; end if;
  if p_hours is null or p_hours < 0 then raise exception '卡时不能为负'; end if;
  insert into cluster_usage (project_id, period_start, hours, reported_by) values (p_project, p_period, p_hours, app_uid())
  on conflict (project_id, period_start) do update set hours = excluded.hours, reported_by = excluded.reported_by, reported_at = now();
end $$;

create function ack_cluster_quota(p_project uuid, p_hours numeric, p_ok boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('cluster.sync') then raise exception '需要权限：cluster.sync' using errcode = '42501'; end if;
  if not exists (select 1 from project where id = p_project and layer = 'paper') then raise exception '研究单元不存在'; end if;
  if p_hours is null or p_hours < 0 then raise exception '卡时不能为负'; end if;
  insert into cluster_ack (project_id, hours, ok, note, reported_by) values (p_project, p_hours, coalesce(p_ok, false), left(nullif(btrim(coalesce(p_note, '')), ''), 300), app_uid());
end $$;
select expose('report_cluster_usage(uuid, date, numeric)', 'ack_cluster_quota(uuid, numeric, boolean, text)');

create view api.cluster_quota as
  select p.id as project_id, p.code as project_code, p.name as project_name,
         coalesce((select sum(hours) from compute_grant g where g.project_id = p.id), 0) as granted_hours,
         coalesce((select sum(hours) from cluster_usage u where u.project_id = p.id), 0) as used_hours,
         coalesce((select sum(hours) from compute_grant g where g.project_id = p.id), 0) - coalesce((select sum(hours) from cluster_usage u where u.project_id = p.id), 0) as left_hours,
         (select coalesce(jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.name, 'owner', u.id = p.owner_id) order by u.name), '[]')
            from app_user u where u.active and (u.id = p.owner_id or exists (select 1 from project_member m where m.project_id = p.id and m.user_id = u.id and m.left_on is null))) as members,
         (select jsonb_build_object('hours', a.hours, 'ok', a.ok, 'note', a.note, 'at', a.reported_at) from cluster_ack a where a.project_id = p.id order by a.reported_at desc limit 1) as last_ack
  from project p where p.layer = 'paper' and p.active and not p.proposed and app_role() is not null;
create view api.cluster_usage as
  select u.project_id, p.code as project_code, p.name as project_name, u.period_start, u.hours, u.reported_at
  from cluster_usage u join project p on p.id = u.project_id where app_role() is not null;
grant select on api.cluster_quota, api.cluster_usage to app_api;
