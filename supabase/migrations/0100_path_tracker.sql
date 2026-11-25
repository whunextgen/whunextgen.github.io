-- 独立研究者的成长路径（The Path of an Independent Researcher，草案第五十三版）：身份与主线任务清单。
-- 身份六种：Intern（RI）、Assistant（RA）、Researcher、Rising Star、PI、Director，记在人员档案上，不看学籍。
--   档案上原有的「类别」（教师、博士、硕士、研究助理等）是学籍和名册口径，与身份分开，不改。
--   加入即为 Intern。身份变动由中心负责人认定，每次变动都留记录：从哪一级到哪一级、依据、认定人。
--   上线时按各人手里的课题和研究单元给出初始身份（见文末），之后由中心负责人逐个调整。
-- 主线任务：每种身份一份任务清单，取自草案第三节，按草案版次登记在 path_task 里，草案再改只改这张表。
--   每条任务写明由谁认定：中台自动的，由中台按记录判定，第一次判定完成即记下，此后以这条记录为准，
--   负责人变更、退出名单不使已完成的倒退；其余由对应岗位在中台确认，留下确认人和日期。
--   需要快照、质疑、考核等功能的自动任务，在那些功能上线之前显示为「待中台开通」，不能手工确认。
-- 每人都有自己的任务清单：本人看得到自己的，有人员查看权限的人和中心负责人看得到全中心的。

alter table person add column rank text not null default 'intern'
  check (rank in ('intern','assistant','researcher','rising_star','pi','director'));

create function rank_label(p_rank text) returns text language sql immutable as $$
  select case p_rank when 'intern' then 'Intern（RI）' when 'assistant' then 'Assistant（RA）' when 'researcher' then 'Researcher'
    when 'rising_star' then 'Rising Star' when 'pi' then 'Principal Investigator（PI）' when 'director' then 'Director' end
$$;

create table rank_change (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references person(id),
  from_rank  text not null,
  to_rank    text not null,
  basis      text not null check (length(btrim(basis)) between 1 and 300),
  decided_by uuid references app_user(id),
  decided_at timestamptz not null default now()
);
create index rank_change_person on rank_change (person_id, decided_at desc);

-- 认定方：auto 中台自动；其余对应草案「认定」一栏
create table path_task (
  code    text primary key,
  rank    text not null check (rank in ('intern','assistant','researcher','rising_star','pi')),
  seq     int not null,
  title   text not null,
  detail  text,
  verify  text not null check (verify in ('auto','hr','training','meeting','seminar','council','finance','outcome','degree','appoint','director')),
  ready   boolean not null default true,     -- 中台自动的任务，所需功能已上线才为真
  edition int not null default 53,
  unique (rank, seq)
);
create table path_done (
  person_id    uuid not null references person(id),
  task_code    text not null references path_task(code),
  done_on      date not null,
  note         text check (note is null or length(note) <= 300),
  confirmed_by uuid references app_user(id),
  confirmed_at timestamptz not null default now(),
  primary key (person_id, task_code)
);
select seal('rank_change', 'path_task', 'path_done');
create trigger audit after insert or update or delete on rank_change for each row execute function trg_audit();
create trigger audit after insert or update or delete on path_done   for each row execute function trg_audit();

insert into path_task (code, rank, seq, title, detail, verify, ready) values
  ('ri-sign',    'intern', 1, '签署协议和保密承诺，人员档案经人事确认', null, 'hr', true),
  ('ri-train',   'intern', 2, '完成三项入门训练', '集群使用、科研规范与数据保密、中台使用', 'training', true),
  ('ri-open',    'intern', 3, '开题', '加入后第一期内写出开题稿，用理、据、体、用四问写清要研究的问题，在会上展示并接受质疑', 'meeting', true),
  ('ri-unit',    'intern', 4, '进入一个研究单元', '回应第一条质疑，经负责人同意进入该研究单元；中台按研究单元名单判定', 'auto', true),
  ('ri-three',   'intern', 5, '累计三期的快照里有本人回应的质疑', '不要求连续', 'auto', false),
  ('ri-survey',  'intern', 6, '综述一篇', '在会上展示，下一期无人再提同样的质疑', 'meeting', true),
  ('ri-plan',    'intern', 7, '方案报告一篇', '写清拟研究的问题和做法，在会上展示，下一期无人再提同样的质疑', 'meeting', true),
  ('ri-talk',    'intern', 8, '作一次三分钟报告', '在主题研讨会或周日讲座上', 'seminar', true),
  ('ra-unit',    'assistant', 1, '提出研究单元并担任负责人', '一页研究单元提案经联席会议通过、所挂课题负责人同意，在中台立项', 'auto', true),
  ('ra-biweekly','assistant', 2, '负责的研究单元登记双周表累计六期', null, 'auto', true),
  ('ra-paper',   'assistant', 3, '完成一篇完整的研究论文', '负责的研究单元有一份稿子理、据、体、用四问俱全，经联席会议审核。硕士研究生以此为学位论文', 'council', true),
  ('ra-mentor',  'assistant', 4, '接收过至少一名 RI，并带其通过 RA 考核', null, 'auto', false),
  ('ra-clear',   'assistant', 5, '所用资源按期归还，支出申请无逾期未结', null, 'finance', true),
  ('rs-topic',   'researcher', 1, '担任课题负责人满一个年度，年度评定正常', '申请课题并经联席会议评定立项', 'council', true),
  ('rs-units',   'researcher', 2, '课题之下至少两个研究单元取得对外成果', null, 'outcome', true),
  ('rs-conf',    'researcher', 3, '会议论文三篇', null, 'outcome', true),
  ('rs-journal', 'researcher', 4, '期刊论文一至两篇', null, 'outcome', true),
  ('rs-mentor',  'researcher', 5, '带出至少一名通过 Researcher 考核的 RA', null, 'auto', false),
  ('rs-position','researcher', 6, '立场论文一篇', '先形成内部版本，有实证工作支撑后再投稿，不强制发表。博士研究生的学位论文以其最终版本为第一章', 'council', true),
  ('rs-budget',  'researcher', 7, '课题预算执行达到中心要求，资源和账目办结无遗留', null, 'finance', true),
  ('st-degree',  'rising_star', 1, '取得博士学位，或完成一期博士后研究', null, 'degree', true),
  ('st-question','rising_star', 2, '形成自己的长期研究问题，有以本人为主的代表性成果', '在海外期间', 'outcome', true),
  ('st-collab',  'rising_star', 3, '至少一项成果与中心的研究单元共同完成', '在海外期间与中心保持合作', 'outcome', true),
  ('st-post',    'rising_star', 4, '取得独立的研究岗位，或独立主持一项经费', null, 'appoint', true),
  ('pi-years',   'pi', 1, '所主持的项目支持的课题运行满两个年度，年度评定正常', '在中心任职', 'council', true),
  ('pi-fund',    'pi', 2, '以本人主持的经费支持中心的课题，经费执行和账目无遗留', null, 'finance', true),
  ('pi-star',    'pi', 3, '带出至少一名 Rising Star', null, 'auto', false),
  ('pi-public',  'pi', 4, '承担过一项中心的公共事务', '如培养、人事、财务或对外合作中的一项', 'director', true);

create function path_verify_label(p_verify text) returns text language sql immutable as $$
  select case p_verify when 'auto' then '中台自动' when 'hr' then '人事岗位' when 'training' then '培训出勤记录' when 'meeting' then '会议记录'
    when 'seminar' then '主题研讨会纪要' when 'council' then '联席会议' when 'finance' then '中心财务' when 'outcome' then '成果登记'
    when 'degree' then '学位或出站证明' when 'appoint' then '聘任或立项文件' when 'director' then '现任 Director' end
$$;

-- 谁能确认这一类任务：人事和培训、会议纪要由人事岗；财务由记账岗；联席会议的结果由录入评定的中心助理；其余由中心负责人。中心负责人都能确认
create function path_can_confirm(p_verify text) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() = 'director'
      or (p_verify in ('hr','training','meeting','seminar') and has_perm('people.manage'))
      or (p_verify = 'finance' and has_perm('ledger.post'))
      or (p_verify = 'council' and has_perm('budget.evaluate'))
$$;

-- 中台自动的任务：是否完成，以及进度说明
create function path_auto(p_person uuid, p_code text) returns table (done boolean, progress text)
language plpgsql stable security definer set search_path = public as $$
declare u uuid := (select user_id from person where id = p_person); n int;
begin
  if u is null then return query select false, '尚未对应中台账号'; return; end if;
  if p_code = 'ri-unit' then
    return query select exists (select 1 from project_member m join project p on p.id = m.project_id where m.user_id = u and p.layer = 'paper' and not p.proposed)
                     or exists (select 1 from project p where p.owner_id = u and p.layer = 'paper' and not p.proposed), null::text;
  elsif p_code = 'ra-unit' then
    return query select exists (select 1 from project p where p.owner_id = u and p.layer = 'paper' and not p.proposed), null::text;
  elsif p_code = 'ra-biweekly' then
    -- 按登记人计，只计研究单元的双周表：研究单元换了负责人，已登记的期数不转给新负责人
    select count(distinct r.period_start)::int into n from biweekly_report r join project p on p.id = r.project_id
      where p.layer = 'paper' and r.submitted_by = u;
    return query select n >= 6, format('已登记 %s 期，共需 6 期', least(n, 6));
  else
    return query select false, null::text;
  end if;
end $$;

-- 查看范围：本人；有人员查看权限的人；中心负责人
create function path_can_see(p_person uuid) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() is not null and (app_role() = 'director' or has_perm('read.people')
    or exists (select 1 from person where id = p_person and user_id = app_uid()))
$$;

-- 认定身份：中心负责人。高一级身份同时拥有低一级的全部权限，所以不论升降都只记一条
create function set_rank(p_person uuid, p_rank text, p_basis text) returns void language plpgsql security definer set search_path = public as $$
declare pr person; b text := btrim(coalesce(p_basis, ''));
begin
  if app_role() is distinct from 'director' then raise exception '身份由中心负责人认定' using errcode = '42501'; end if;
  select * into pr from person where id = p_person for update;
  if not found then raise exception '人员不存在'; end if;
  if p_rank is null or rank_label(p_rank) is null then raise exception '身份不在六种之内'; end if;
  if pr.rank = p_rank then raise exception '此人已是 %', rank_label(p_rank); end if;
  if b = '' then raise exception '请写明认定的依据，例如考核结论或联席会议决议'; end if;
  if length(b) > 300 then raise exception '依据不得超过 300 个字'; end if;
  insert into rank_change (person_id, from_rank, to_rank, basis, decided_by) values (p_person, pr.rank, p_rank, b, app_uid());
  update person set rank = p_rank, updated_at = now() where id = p_person;
  if pr.user_id is not null then
    perform notify_user(pr.user_id, format('身份认定：你的身份已由 %s 认定为 %s（原为 %s）。依据：%s', (select name from app_user where id = app_uid()), rank_label(p_rank), rank_label(pr.rank), b));
  end if;
end $$;

-- 确认一条主线任务已完成
create function confirm_path_task(p_person uuid, p_code text, p_done_on date default null, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t path_task; pr person; nt text := nullif(btrim(coalesce(p_note, '')), ''); d date := coalesce(p_done_on, app_today());
begin
  select * into t from path_task where code = p_code;
  if not found then raise exception '任务不存在'; end if;
  if t.verify = 'auto' then raise exception '这一条由中台按记录自动认定，不能手工确认'; end if;
  if not path_can_confirm(t.verify) then raise exception '这一条由%认定', path_verify_label(t.verify) using errcode = '42501'; end if;
  select * into pr from person where id = p_person;
  if not found then raise exception '人员不存在'; end if;
  if d > app_today() then raise exception '完成日期不能晚于今天'; end if;
  if nt is not null and length(nt) > 300 then raise exception '说明不得超过 300 个字'; end if;
  if exists (select 1 from path_done where person_id = p_person and task_code = p_code) then raise exception '这一条已确认过'; end if;
  insert into path_done (person_id, task_code, done_on, note, confirmed_by) values (p_person, p_code, d, nt, app_uid());
  if pr.user_id is not null and pr.user_id is distinct from app_uid() then
    perform notify_user(pr.user_id, format('主线任务已认定：「%s」已由 %s 确认完成（%s）%s', t.title, (select name from app_user where id = app_uid()),
      to_char(d, 'YYYY-MM-DD'), case when nt is null then '' else '。说明：' || nt end));
  end if;
end $$;

-- 撤销确认：确认错了的，由有权确认的人撤销
create function undo_path_task(p_person uuid, p_code text) returns void language plpgsql security definer set search_path = public as $$
declare t path_task; pr person;
begin
  select * into t from path_task where code = p_code;
  if not found then raise exception '任务不存在'; end if;
  if t.verify = 'auto' then raise exception '这一条由中台按记录自动认定，不能撤销'; end if;
  if not path_can_confirm(t.verify) then raise exception '这一条由%认定', path_verify_label(t.verify) using errcode = '42501'; end if;
  select * into pr from person where id = p_person;
  delete from path_done where person_id = p_person and task_code = p_code;
  if not found then raise exception '这一条尚未确认'; end if;
  if pr.user_id is not null and pr.user_id is distinct from app_uid() then
    perform notify_user(pr.user_id, format('主线任务认定已撤销：「%s」的完成认定已由 %s 撤销', t.title, (select name from app_user where id = app_uid())));
  end if;
end $$;

-- 中台自动的任务第一次判定完成即记下（确认人为空，说明「中台自动」）。负责人变更、退出名单、加入名单、
-- 登记双周表时先记一次，变更前的完成不因变更而倒退；每次定时任务也补记一遍
create function path_latch(p_user uuid default null) returns int language plpgsql security definer set search_path = public as $$
declare k int;
begin
  insert into path_done (person_id, task_code, done_on, note, confirmed_by)
  select pr.id, t.code, app_today(), '中台自动', null
  from person pr cross join path_task t
  cross join lateral path_auto(pr.id, t.code) a
  where t.verify = 'auto' and t.ready and pr.user_id is not null and (p_user is null or pr.user_id = p_user) and a.done
  on conflict do nothing;
  get diagnostics k = row_count;
  return k;
end $$;
create function path_latch_tick() returns int language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return path_latch(null);
end $$;
-- 变更前先记：before 触发，按变更前的记录判定
create function trg_path_latch_before() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'project' then perform path_latch(old.owner_id);
  else perform path_latch(old.user_id); end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create function trg_path_latch_after() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'project' then
    if new.owner_id is not null then perform path_latch(new.owner_id); end if;
  elsif tg_table_name = 'project_member' then perform path_latch(new.user_id);
  else perform path_latch(new.submitted_by); end if;
  return null;
end $$;
create trigger path_latch_before before update of owner_id, active, proposed, layer on project for each row
  when (old.owner_id is not null) execute function trg_path_latch_before();
create trigger path_latch_after after insert or update of owner_id, active, proposed, layer on project for each row execute function trg_path_latch_after();
create trigger path_latch_before before update of left_on or delete on project_member for each row execute function trg_path_latch_before();
create trigger path_latch_after after insert or update on project_member for each row execute function trg_path_latch_after();
create trigger path_latch_after after insert on biweekly_report for each row execute function trg_path_latch_after();

revoke execute on function path_latch(uuid) from public;
select expose('path_latch_tick()');

select expose('set_rank(uuid, text, text)', 'confirm_path_task(uuid, text, date, text)', 'undo_path_task(uuid, text)');

-- 任务清单：每人当前身份的全部主线任务及其状态。done 已完成；open 待完成；waiting 待中台开通
create view api.path_tracker as
  select pr.id as person_id, pr.name as person_name, pr.user_id, coalesce(pr.user_id = app_uid(), false) as mine, pr.rank, rank_label(pr.rank) as rank_label,
         t.code, t.seq, t.title, t.detail, t.verify, path_verify_label(t.verify) as verify_label, t.edition,
         case when d.task_code is not null or (t.verify = 'auto' and a.done) then 'done' when t.verify = 'auto' and not t.ready then 'waiting' else 'open' end as status,
         case when t.verify = 'auto' and t.ready then a.progress end as progress,
         d.done_on, d.note, (select name from app_user where id = d.confirmed_by) as confirmed_by_name,
         (t.verify <> 'auto' and path_can_confirm(t.verify)) as can_confirm
  from person pr
  join path_task t on t.rank = pr.rank
  left join path_done d on d.person_id = pr.id and d.task_code = t.code
  left join lateral path_auto(pr.id, t.code) a on t.verify = 'auto'
  where pr.status in ('active','offroll') and path_can_see(pr.id);

-- 每人一行的概况：身份、本级任务完成几条
create view api.path_person as
  select pr.id as person_id, pr.name as person_name, pr.no, pr.kind, pr.user_id, coalesce(pr.user_id = app_uid(), false) as mine, pr.rank, rank_label(pr.rank) as rank_label,
         (select count(*)::int from api.path_tracker x where x.person_id = pr.id) as tasks,
         (select count(*)::int from api.path_tracker x where x.person_id = pr.id and x.status = 'done') as done,
         (select max(c.decided_at) from rank_change c where c.person_id = pr.id) as rank_since,
         (app_role() = 'director') as can_set_rank
  from person pr
  where pr.status in ('active','offroll') and path_can_see(pr.id);

-- 身份变动记录
create view api.rank_change as
  select c.id, c.person_id, pr.name as person_name, c.from_rank, rank_label(c.from_rank) as from_label, c.to_rank, rank_label(c.to_rank) as to_label,
         c.basis, (select name from app_user where id = c.decided_by) as decided_by_name, c.decided_at
  from rank_change c join person pr on pr.id = c.person_id
  where path_can_see(c.person_id);

grant select on api.path_tracker, api.path_person, api.rank_change to app_api;

-- ---------- 上线时的初始身份 ----------
-- 按上线时手里的课题和研究单元：负责已立项课题的（不含中心公共开支）记为 Researcher；负责已成立研究单元的记为 Assistant（RA）；
-- 其余为 Intern（RI）。Rising Star、PI、Director 不按名单推断，由中心负责人认定。每人的初始认定记一条，认定人为空
with r as (
  select pr.id,
         case when exists (select 1 from project p where p.owner_id = pr.user_id and p.layer <> 'paper' and p.kind <> 'public' and p.active and not p.proposed) then 'researcher'
              when exists (select 1 from project p where p.owner_id = pr.user_id and p.layer = 'paper' and p.active and not p.proposed) then 'assistant' end as rank
  from person pr where pr.user_id is not null
), u as (
  update person pr set rank = r.rank from r where r.id = pr.id and r.rank is not null returning pr.id, r.rank
)
insert into rank_change (person_id, from_rank, to_rank, basis, decided_by)
select id, 'intern', rank, '上线时按负责的课题或研究单元初始认定', null from u;

-- 上线时已满足的自动任务记下
select path_latch(null);
