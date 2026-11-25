-- 课题系统接入联席会议（黄济民 2026-11-26「课题系统也要自动对接进来」）：
--   研究单元申请、课题立项与延续的档次申请，提交即由正则生成议题并列入议程（免附议），表决结果自动落回申请：
--   研究单元：生效后记下会议和纪要日期，课题负责人已同意的，待登记日由助理确认成立；未通过、被否决的退回申请人
--   课题档次：生效后按申请的档次定档（名额或条件不符的，通知评定人另行定档）；未通过、被否决的记为不予通过
--   仍可按原来的办法填写会议日期提交（会外已表决的），这样的不再生成议题

alter table motion drop constraint motion_category_check;
alter table motion add constraint motion_category_check check (category in ('research','unit','topic','budget','assessment','personnel','removal','rules','other','procedure'));
alter table motion drop constraint motion_ref_kind_check;
alter table motion add constraint motion_ref_kind_check check (ref_kind in ('assessment','unit','tier'));
alter table motion add column ref_year int, add column auto boolean not null default false;

-- 申请流程生成的议题：免附议，直接列入议程；同一份申请只有一份未了结的议题，申请改了就更新正文
create function motion_auto(p_kind text, p_ref uuid, p_year int, p_category text, p_title text, p_body text, p_proposer uuid, p_subjects uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare m motion; v_id uuid;
begin
  select * into m from motion where ref_kind = p_kind and ref_id = p_ref and ref_year is not distinct from p_year and status not in ('failed','vetoed','withdrawn','effective') order by created_at desc limit 1;
  if found then
    if m.status = 'voting' then raise exception '这份申请正在联席会议表决，表决结束前不能修改'; end if;
    if m.status in ('proposed','seconded') then update motion set title = left(p_title, 80), body = left(p_body, 12000), subjects = p_subjects where id = m.id; end if;
    return m.id;
  end if;
  insert into motion (mtype, category, title, body, proposer_id, subjects, threshold, ballot, ref_kind, ref_id, ref_year, auto, status, seconded_at, note)
  values ('main', p_category, left(p_title, 80), left(p_body, 12000), p_proposer, p_subjects, 'majority', 'open', p_kind, p_ref, p_year, true, 'seconded', now(), '由申请流程自动列入议程，免附议')
  returning motion.id into v_id;
  return v_id;
end $$;
revoke execute on function motion_auto(text, uuid, int, text, text, text, uuid, uuid[]) from public;

create function motion_auto_withdraw(p_kind text, p_ref uuid, p_year int) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from motion where ref_kind = p_kind and ref_id = p_ref and ref_year is not distinct from p_year and status = 'voting') then raise exception '这份申请正在联席会议表决，表决结束前不能撤回'; end if;
  update motion set status = 'withdrawn', decided_at = now(), note = '申请已撤回' where ref_kind = p_kind and ref_id = p_ref and ref_year is not distinct from p_year and status in ('proposed','seconded');
end $$;
revoke execute on function motion_auto_withdraw(text, uuid, int) from public;

-- ---------- 研究单元 ----------
create function unit_motion_sync(p_unit uuid) returns void language plpgsql security definer set search_path = public as $$
declare u project; par project; subj uuid[];
begin
  select * into u from project where id = p_unit;
  if not found or u.layer <> 'paper' or not u.proposed or u.applied_at is null or u.meeting_on is not null then return; end if;
  select * into par from project where id = u.parent_id;
  select array_agg(distinct x) into subj from (select u.owner_id x union select par.owner_id union select user_id from project_member where project_id = p_unit and left_on is null) s where x is not null;
  perform motion_auto('unit', p_unit, null, 'unit', format('成立研究单元「%s」', u.name),
    format(E'研究单元申请：%s\n所挂课题：%s（负责人 %s）\n申请人，拟任负责人：%s\n成员：%s\n\n%s', u.name, par.name, coalesce((select name from app_user where id = par.owner_id), '—'),
      coalesce((select name from app_user where id = u.owner_id), '—'),
      coalesce((select string_agg(a.name, '、' order by a.name) from project_member m join app_user a on a.id = m.user_id where m.project_id = p_unit and m.left_on is null), '无'),
      coalesce(u.apply_note, '')),
    u.owner_id, coalesce(subj, '{}'));
end $$;
revoke execute on function unit_motion_sync(uuid) from public;

-- 提交申请时会议日期改为选填：不填的，生成议题；填了的（会外已表决），照原来核对
do $$
declare d text := pg_get_functiondef('public.propose_unit(uuid, uuid, text, date, date, text, text)'::regprocedure); n text;
begin
  n := replace(d, $x$if p_meeting_on is null then raise exception '请填写联席会议通过的日期'; end if;$x$, $x$if (p_meeting_on is null) <> (p_minutes_on is null) then raise exception '联席会议通过的日期和纪要发出的日期须一起填写；都不填的，提交后由正则列入联席会议议程'; end if;$x$);
  n := replace(n, $x$if p_minutes_on is null then raise exception '请填写会议纪要发出的日期'; end if;$x$, '');
  n := replace(n, $x$, '联席会议 %s 通过', $x$, $x$, '%s', $x$);
  n := replace(n, $x$par.name, p_meeting_on))$x$, $x$par.name, case when p_meeting_on is null then '待联席会议表决' else '联席会议 ' || p_meeting_on || ' 通过' end))$x$);
  n := replace(n, E'  return uid;\nend', E'  perform unit_motion_sync(uid);\n  return uid;\nend');
  if n = d or position('unit_motion_sync' in n) = 0 or position('待联席会议表决' in n) = 0 then raise exception '研究单元申请函数没有改上'; end if;
  execute n;
end $$;

do $$
declare d text := pg_get_functiondef('public.approve_unit(uuid)'::regprocedure); n text;
begin
  n := replace(d, $x$'课题「%s」的负责人已同意研究单元申请「%s」，待助理对照联席会议纪要核对'$x$, $x$'课题「%s」的负责人已同意研究单元申请「%s」，待联席会议决议生效后由助理确认成立'$x$);
  n := replace(n, $x$课题负责人已同意，联席会议 %s 通过', (select name from app_user where id = u.owner_id), u.name, par.name, u.meeting_on))$x$,
    $x$课题负责人已同意，%s', (select name from app_user where id = u.owner_id), u.name, par.name, case when u.meeting_on is null then '待联席会议表决' else '联席会议 ' || u.meeting_on || ' 通过' end))$x$);
  if n = d then raise exception '同意研究单元的函数没有改上'; end if;
  execute n;
end $$;

do $$
declare d text := pg_get_functiondef('public.confirm_unit(uuid)'::regprocedure); n text;
begin
  n := replace(d, E'  until := add_workdays(u.minutes_on, 3);', E'  if u.minutes_on is null then raise exception ''联席会议尚未表决通过这份申请，或决议尚未生效''; end if;\n  until := add_workdays(u.minutes_on, 3);');
  if n = d then raise exception '确认成立的函数没有改上'; end if;
  execute n;
end $$;

do $$
declare d text := pg_get_functiondef('public.withdraw_unit(uuid)'::regprocedure); n text;
begin
  n := regexp_replace(d, E'\nend\\s*\\$function\\$', E'\n  perform motion_auto_withdraw(''unit'', p_unit, null);\nend $function$');
  if n = d then raise exception '撤回研究单元的函数没有改上'; end if;
  execute n;
end $$;

-- ---------- 课题档次 ----------
create function tier_motion_sync(p_year int, p_project uuid) returns void language plpgsql security definer set search_path = public as $$
declare k tier_pick; p project; t budget_tier; subj uuid[];
begin
  select * into k from tier_pick where year = p_year and project_id = p_project;
  if not found or k.decided_tier_id is not null or k.rejected then return; end if;
  select * into p from project where id = p_project;
  if p.kind = 'public' then return; end if;
  select * into t from budget_tier where id = k.tier_id;
  select array_agg(distinct x) into subj from (select p.owner_id x union select k.picked_by
    union select m.user_id from project_member m join project q on q.id = m.project_id where (q.id = p_project or q.parent_id = p_project) and m.left_on is null
    union select q.owner_id from project q where q.parent_id = p_project and q.active) s where x is not null;
  perform motion_auto('tier', p_project, p_year, 'topic',
    format('%s 年度课题%s：%s', p_year, case when k.kind = 'new' then '立项' else '延续' end, p.name),
    format(E'%s 年度课题%s申请\n课题：%s（%s）\n负责人：%s\n申请档次：%s，%s 元\n研究单元：%s\n\n申请理由：\n%s\n\n表决通过、否决期满后，按申请的档次定档；联席会议认为应定其他档次的，可提修正案写明，由评定人按决议定档。',
      p_year, case when k.kind = 'new' then '立项' else '延续' end, p.name, p.code, coalesce((select name from app_user where id = p.owner_id), '—'),
      t.name, to_char(t.amount, 'FM999,999,999'),
      coalesce((select string_agg(q.name, '、' order by q.code) from project q where q.parent_id = p_project and q.active), '无'), coalesce(k.reason, '')),
    coalesce(k.picked_by, p.owner_id), coalesce(subj, '{}'));
end $$;
revoke execute on function tier_motion_sync(int, uuid) from public;

create function trg_tier_motion() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform motion_auto_withdraw('tier', old.project_id, old.year); return old; end if;
  if tg_op = 'UPDATE' and (new.decided_tier_id is not null or new.rejected) then return new; end if;
  perform tier_motion_sync(new.year, new.project_id);
  return new;
end $$;
create trigger tier_motion after insert or update of tier_id, reason or delete on tier_pick for each row execute function trg_tier_motion();

-- ---------- 表决结果落回申请 ----------
create function motion_apply(p_id uuid, p_result text) returns void language plpgsql security definer set search_path = public as $$
declare m motion; k tier_pick; t budget_tier; y budget_year; n int; bad text; on_ date; u project; who uuid;
begin
  select * into m from motion where id = p_id;
  on_ := (coalesce(m.decided_at, now()) at time zone 'Asia/Shanghai')::date;
  if m.ref_kind = 'assessment' then
    perform assessment_council_apply(m.ref_id, p_result = 'effective', on_, case when p_result = 'vetoed' then '中心主任否决：' || m.veto_reason end);
  elsif m.ref_kind = 'unit' then
    select * into u from project where id = m.ref_id for update;
    if not found or not u.proposed or u.applied_at is null then return; end if;
    if p_result = 'effective' then
      update project set meeting_on = on_, minutes_on = on_ where id = u.id;
      perform council_notify(u.owner_id, format('联席会议决议生效：研究单元「%s」的申请已通过%s', u.name, case when u.parent_ok_at is null then '，待课题负责人同意后由助理确认成立' else '，待登记日由助理确认成立' end));
      for who in select id from app_user where active and user_perm(id, 'budget.evaluate') loop
        perform council_notify(who, format('研究单元待确认成立：「%s」的申请经联席会议表决通过，决议已生效%s', u.name, case when u.parent_ok_at is null then '，课题负责人尚未同意' else '' end));
      end loop;
    else
      update project set parent_ok_by = null, parent_ok_at = null, return_note = case when p_result = 'vetoed' then '中心主任否决联席会议决议：' || m.veto_reason else '联席会议表决未通过' end,
        checked_at = now() where id = u.id;
      perform council_notify(u.owner_id, format('研究单元申请「%s」已退回：%s', u.name, case when p_result = 'vetoed' then '中心主任否决联席会议决议' else '联席会议表决未通过' end));
    end if;
  elsif m.ref_kind = 'tier' then
    select * into k from tier_pick where year = m.ref_year and project_id = m.ref_id for update;
    if not found or k.decided_tier_id is not null or k.rejected then return; end if;
    select * into y from budget_year where year = m.ref_year;
    if y.stage <> 'declare' then
      for who in select id from app_user where active and user_perm(id, 'budget.evaluate') loop
        perform council_notify(who, format('课题定档待处理：%s 的联席会议表决结果已出，但 %s 年度预算已过评定阶段，请另行处理', motion_label(m), m.ref_year));
      end loop;
      return;
    end if;
    if p_result <> 'effective' then
      update tier_pick set rejected = true, decided_tier_id = null, decided_at = now(), meeting_on = on_,
        decide_note = case when p_result = 'vetoed' then '中心主任否决联席会议决议：' || m.veto_reason else '联席会议表决未通过' end
      where year = m.ref_year and project_id = m.ref_id;
      return;
    end if;
    select * into t from budget_tier where id = k.tier_id;
    select count(*) into n from tier_pick where year = m.ref_year and decided_tier_id = k.tier_id and project_id <> m.ref_id;
    bad := case when n >= t.slots then format('「%s」的名额 %s 个已评满', t.name, t.slots) else tier_violation(m.ref_year, m.ref_id, k.tier_id) end;
    if bad is null then
      update tier_pick set rejected = false, decided_tier_id = k.tier_id, decided_at = now(), meeting_on = on_, decide_note = '联席会议表决通过，按申请档次定档'
      where year = m.ref_year and project_id = m.ref_id;
    else
      for who in select id from app_user where active and user_perm(id, 'budget.evaluate') loop
        perform council_notify(who, format('课题定档待处理：%s 经联席会议通过，但按申请的档次定档不成：%s。请按决议另行定档', motion_label(m), bad));
      end loop;
    end if;
  end if;
end $$;
revoke execute on function motion_apply(uuid, text) from public;

-- 计票、否决、生效时调用：替换 0116 里只处理考核的写法
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.motion_close(uuid)'::regprocedure);
  n := replace(d, E'elsif m.ref_kind = ''assessment'' then\n    perform assessment_council_apply(m.ref_id, false, (now() at time zone ''Asia/Shanghai'')::date, null);',
                  E'elsif m.ref_kind is not null and m.mtype = ''main'' then\n    perform motion_apply(m.id, ''failed'');');
  if n = d then raise exception '计票函数没有改上'; end if;
  execute n;
  d := pg_get_functiondef('public.council_tick()'::regprocedure);
  n := replace(d, E'if m.ref_kind = ''assessment'' then perform assessment_council_apply(m.ref_id, true, (m.decided_at at time zone ''Asia/Shanghai'')::date, null); end if;',
                  E'if m.ref_kind is not null then perform motion_apply(m.id, ''effective''); end if;');
  if n = d then raise exception '生效函数没有改上'; end if;
  execute n;
  d := pg_get_functiondef('public.veto_motion(uuid, text)'::regprocedure);
  n := replace(d, E'update motion set status = ''vetoed'', veto_reason = r, vetoed_by = app_uid() where id = p_id;',
                  E'update motion set status = ''vetoed'', veto_reason = r, vetoed_by = app_uid() where id = p_id;\n  if m.ref_kind is not null then perform motion_apply(p_id, ''vetoed''); end if;');
  if n = d then raise exception '否决函数没有改上'; end if;
  execute n;
end $$;

-- 申请流程生成的议题不能由提案人以外的人撤回；提案人撤回议题等于撤回表决，申请照旧，需在申请那边撤回
do $$
declare d text := pg_get_functiondef('public.withdraw_motion(uuid)'::regprocedure); n text;
begin
  n := replace(d, E'  if m.status not in (''proposed'',''seconded'') then raise exception ''表决开始后不能撤回''; end if;',
    E'  if m.status not in (''proposed'',''seconded'') then raise exception ''表决开始后不能撤回''; end if;\n  if m.auto then raise exception ''这份议题由申请生成，请撤回申请''; end if;');
  if n = d then raise exception '撤回议题的函数没有改上'; end if;
  execute n;
end $$;

create or replace view api.council_motion as
  select m.id, m.seq, m.mtype, m.category, m.title, m.body, m.link, m.parent_id, (select seq from motion p where p.id = m.parent_id) as parent_seq,
         (select title from motion p where p.id = m.parent_id) as parent_title,
         m.proposer_id, (select name from app_user where id = m.proposer_id) as proposer_name, (select name from app_user where id = m.seconder_id) as seconder_name,
         (select coalesce(jsonb_agg(u.name order by u.name), '[]') from app_user u where u.id = any(m.subjects)) as subject_names,
         m.threshold, m.ballot, m.urgent, m.ref_kind, m.ref_id, m.status, m.round, m.meeting_id, m.online, m.vote_open_at, m.vote_until,
         case when m.status <> 'voting' then m.yes end as yes, case when m.status <> 'voting' then m.no end as no, case when m.status <> 'voting' then m.abstain end as abstain,
         m.eligible, m.note, m.decided_at, m.veto_until, m.veto_reason, m.effective_at, m.body_prev, m.created_at, m.seconded_at,
         (select count(*)::int from motion_vote v where v.motion_id = m.id and v.round = m.round) as cast_count,
         (select choice from motion_vote v where v.motion_id = m.id and v.round = m.round and v.user_id = app_uid()) as my_vote,
         motion_can_vote(m.id, app_uid()) as can_vote,
         (council_voter(app_uid()) and m.status = 'proposed' and m.proposer_id <> app_uid()) as can_second,
         (m.proposer_id = app_uid() and m.status in ('proposed','seconded') and not m.auto) as can_withdraw,
         council_chair() as can_chair,
         (app_role() = 'director' and m.status = 'passed' and m.mtype = 'main' and m.veto_until > now()) as can_veto,
         exists (select 1 from motion_recusal r where r.motion_id = m.id and r.user_id = app_uid()) as recused,
         (select coalesce(jsonb_agg(u.name order by u.name), '[]') from motion_recusal r join app_user u on u.id = r.user_id where r.motion_id = m.id) as recused_names,
         (select count(*)::int from motion_meeting_request r where r.motion_id = m.id and r.round = m.round) as meeting_requests,
         exists (select 1 from motion_meeting_request r where r.motion_id = m.id and r.round = m.round and r.user_id = app_uid()) as my_request,
         (select count(*)::int from motion c where c.parent_id = m.id and c.mtype = 'amend' and c.status in ('proposed','seconded','voting')) as open_amendments,
         m.auto, m.ref_year
  from motion m where app_role() is not null;
