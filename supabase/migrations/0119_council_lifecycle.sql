-- 研究单元、课题和人员的生命周期接入联席会议（黄济民 2026-11-26「人员和项目这些生命周期都在里面，包括停滞」）：
--   停滞：研究单元连续两期未登记双周表，自动列入议程「过问」，负责人到会说明，不表决，主持人记下过问结果
--   应予终止：停滞满两期仍未恢复，自动生成「终止研究单元」议题表决；其间恢复登记的，两项都自动撤下
--   主动结束：负责人申请终止或结项（免附议）；其他有表决权的成员提议（须附议）。研究单元生效即停用；课题生效后转中心负责人和财务办理
--   建议退组：有表决权的成员提议，须附议、三分之二同意、不记名，本人可到会申辩；生效后由中心负责人决定，同意的人员档案记为已离开

alter table motion drop constraint motion_mtype_check;
alter table motion add constraint motion_mtype_check check (mtype in ('main','amend','reconsider','procedural','inquiry'));
alter table motion drop constraint motion_ref_kind_check;
alter table motion add constraint motion_ref_kind_check check (ref_kind in ('assessment','unit','tier','path','fixed_change','period_report','unit_stall','project_end','removal'));
alter table motion add column decided_note text, add column director_decision text check (director_decision in ('accepted','declined'));

-- ---------- 停滞与应予终止 ----------
create function stall_motions(p_unit uuid, p_status text) returns void language plpgsql security definer set search_path = public as $$
declare u project; par project; v_id uuid;
begin
  select * into u from project where id = p_unit;
  select * into par from project where id = u.parent_id;
  if p_status = 'stalled' then
    if exists (select 1 from motion where ref_kind = 'unit_stall' and ref_id = p_unit and created_at > now() - interval '27 days') then return; end if;
    v_id := motion_auto('unit_stall', p_unit, null, 'unit', format('过问：研究单元「%s」停滞', u.name),
      format(E'研究单元「%s」（%s）连续两期未登记双周表，已转为停滞。\n所挂课题：%s\n负责人：%s\n\n按章程，超过两周未登记的项目由联席会议优先过问：请负责人到会说明情况和恢复计划。过问不表决；停滞满两期仍未恢复的，按规定转为终止议题。',
        u.name, u.code, coalesce(par.name, '—'), coalesce((select name from app_user where id = u.owner_id), '—')),
      coalesce(u.owner_id, par.owner_id), council_subjects_for(p_unit));
    update motion set mtype = 'inquiry', threshold = 'majority', ballot = 'open' where id = v_id and mtype = 'main';
  elsif p_status = 'terminate' then
    perform motion_auto('project_end', p_unit, null, 'unit', format('终止研究单元「%s」', u.name),
      format(E'研究单元「%s」（%s）停滞满两期仍未恢复登记双周表，按规定应予终止。\n所挂课题：%s\n负责人：%s\n\n表决通过、否决期满后，研究单元停用；成员可以加入其他研究单元，或重新申请。表决前恢复登记的，这一议题自动撤下。',
        u.name, u.code, coalesce(par.name, '—'), coalesce((select name from app_user where id = u.owner_id), '—')),
      coalesce(u.owner_id, par.owner_id), council_subjects_for(p_unit), 'stall');
  end if;
end $$;
revoke execute on function stall_motions(uuid, text) from public;

do $$
declare d text := pg_get_functiondef('public.unit_stall_tick()'::regprocedure); n text;
begin
  n := replace(d, E'    if not found then continue; end if;\n', E'    if not found then continue; end if;\n    perform stall_motions(r.id, st);\n');
  if n = d then raise exception '停滞定时任务没有改上'; end if;
  execute n;
end $$;

-- 恢复登记：撤下尚未表决的过问和终止议题
create function trg_stall_resume() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update motion set status = 'withdrawn', decided_at = now(), note = '研究单元已恢复登记双周表'
  where ref_id = new.project_id and (ref_kind = 'unit_stall' or (ref_kind = 'project_end' and ref_code = 'stall')) and status in ('proposed','seconded');
  return new;
end $$;
create trigger stall_resume after insert on biweekly_report for each row execute function trg_stall_resume();

-- 过问：主持人记下结果
create function close_inquiry(p_id uuid, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare m motion; n text := btrim(coalesce(p_note, ''));
begin
  if not council_chair() then raise exception '由联席会议主持人记下过问结果' using errcode = '42501'; end if;
  select * into m from motion where id = p_id for update;
  if not found or m.mtype <> 'inquiry' then raise exception '这一项不是过问事项'; end if;
  if m.status not in ('proposed','seconded') then raise exception '已过问或已撤下'; end if;
  if n = '' or length(n) > 1000 then raise exception '请记下过问结果，不超过 1000 字'; end if;
  update motion set status = 'effective', decided_at = now(), effective_at = now(), decided_note = n where id = p_id;
  perform council_notify(m.proposer_id, format('联席会议过问：%s。结果：%s', motion_label(m), left(n, 300)));
end $$;

do $$
declare d text := pg_get_functiondef('public.open_vote(uuid, uuid)'::regprocedure); n text;
begin
  n := replace(d, E'  if m.status <> ''seconded'' then raise exception ''只有已附议、尚未表决的可以开放表决''; end if;',
    E'  if m.mtype = ''inquiry'' then raise exception ''过问事项不表决，由主持人记下过问结果''; end if;\n  if m.status <> ''seconded'' then raise exception ''只有已附议、尚未表决的可以开放表决''; end if;');
  if n = d then raise exception '开放表决的函数没有改上'; end if;
  execute n;
end $$;

-- ---------- 主动结束：终止或结项 ----------
create function propose_project_end(p_project uuid, p_kind text, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; r text := btrim(coalesce(p_reason, '')); own boolean; lbl text; v_id uuid; t text; b text;
begin
  select * into p from project where id = p_project;
  if not found or not p.active or p.proposed or p.kind = 'public' then raise exception '只有在用的研究单元和课题可以提议终止或结项'; end if;
  if p_kind not in ('end','close') then raise exception '请选择终止或结项'; end if;
  if r = '' or length(r) > 2000 then raise exception '请写明理由，不超过 2000 字'; end if;
  own := has_perm('budget.project', p_project) or p.owner_id = app_uid();
  if not (own or council_voter(app_uid()) or app_role() = 'director') then raise exception '负责人申请，或有表决权的成员提议' using errcode = '42501'; end if;
  lbl := case when p.layer = 'paper' then '研究单元' else '课题' end;
  t := format('%s%s「%s」', case p_kind when 'end' then '终止' else '结项' end, lbl, p.name);
  b := format(E'%s%s「%s」（%s）\n负责人：%s\n提出人：%s\n\n理由：\n%s\n\n表决通过、否决期满后，%s',
    case p_kind when 'end' then '终止' else '结项' end, lbl, p.name, p.code, coalesce((select name from app_user where id = p.owner_id), '—'),
    (select name from app_user where id = app_uid()), r,
    case when p.layer = 'paper' then '研究单元停用；成员可以加入其他研究单元。' else '转中心负责人和中心财务办理课题的预算和研究单元。' end);
  if own then
    v_id := motion_auto('project_end', p_project, null, case when p.layer = 'paper' then 'unit' else 'topic' end, t, b, app_uid(), council_subjects_for(p_project), p_kind);
  else
    if exists (select 1 from motion where ref_kind = 'project_end' and ref_id = p_project and status in ('proposed','seconded','voting','passed')) then raise exception '已有一份在办理中'; end if;
    insert into motion (mtype, category, title, body, proposer_id, subjects, threshold, ballot, ref_kind, ref_id, ref_code)
    values ('main', case when p.layer = 'paper' then 'unit' else 'topic' end, left(t, 80), b, app_uid(), council_subjects_for(p_project), 'majority', 'open', 'project_end', p_project, p_kind)
    returning motion.id into v_id;
  end if;
  return v_id;
end $$;

-- ---------- 建议退组 ----------
create function propose_removal(p_person uuid, p_reason text) returns uuid language plpgsql security definer set search_path = public as $$
declare pr person; r text := btrim(coalesce(p_reason, '')); v_id uuid;
begin
  if not council_voter(app_uid()) then raise exception '由有表决权的成员提议' using errcode = '42501'; end if;
  select * into pr from person where id = p_person and status in ('active','offroll');
  if not found then raise exception '人员不存在或已离开'; end if;
  if pr.user_id = app_uid() then raise exception '不能提议本人退组'; end if;
  if r = '' or length(r) > 2000 then raise exception '请写明依据（考核结论、改进目标未达成等），不超过 2000 字'; end if;
  if exists (select 1 from motion where ref_kind = 'removal' and ref_id = p_person and status in ('proposed','seconded','voting','passed')) then raise exception '已有一份在办理中'; end if;
  insert into motion (mtype, category, title, body, proposer_id, subjects, threshold, ballot, ref_kind, ref_id)
  values ('main', 'removal', format('建议 %s 退组', pr.name),
    format(E'建议 %s（%s）退组\n\n依据：\n%s\n\n按章程，连续两次需改进且未达成改进目标的，联席会议可以表决建议退组，须投票者三分之二同意、不记名；本人可以到会申辩。表决通过、否决期满后，由中心负责人决定。',
      pr.name, rank_label(pr.rank), r),
    app_uid(), case when pr.user_id is null then '{}'::uuid[] else array[pr.user_id] end, 'two_thirds', 'secret', 'removal', p_person)
  returning motion.id into v_id;
  return v_id;
end $$;

create function decide_removal(p_id uuid, p_accept boolean, p_note text default null) returns void language plpgsql security definer set search_path = public as $$
declare m motion; pr person;
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人决定' using errcode = '42501'; end if;
  select * into m from motion where id = p_id for update;
  if not found or m.ref_kind <> 'removal' or m.status <> 'effective' or m.director_decision is not null then raise exception '只能对已生效、尚未决定的退组建议作决定'; end if;
  select * into pr from person where id = m.ref_id for update;
  update motion set director_decision = case when p_accept then 'accepted' else 'declined' end, decided_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
  if p_accept then
    update person set status = 'left', updated_at = now() where id = pr.id;
    perform council_notify(pr.user_id, format('中心负责人决定：根据联席会议第 %s 号决议，%s 退组%s', m.seq, pr.name, coalesce('。说明：' || nullif(btrim(coalesce(p_note, '')), ''), '')));
  else
    perform council_notify(pr.user_id, format('中心负责人决定：联席会议第 %s 号退组建议不予采纳%s', m.seq, coalesce('。说明：' || nullif(btrim(coalesce(p_note, '')), ''), '')));
  end if;
end $$;

-- 申辩：表决事项涉及的人可以申请发言
do $$
declare d text := pg_get_functiondef('public.request_speech(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, 'or m.proposer_id = app_uid()) then', 'or m.proposer_id = app_uid() or app_uid() = any(m.subjects)) then');
  if n = d then raise exception '申请发言的函数没有改上'; end if;
  execute n;
end $$;

-- ---------- 落回 ----------
do $$
declare d text := pg_get_functiondef('public.motion_apply(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, E'  elsif m.ref_kind = ''tier'' then',
E'  elsif m.ref_kind = ''project_end'' then
    select * into u from project where id = m.ref_id for update;
    if p_result = ''effective'' and found and u.active then
      if u.layer = ''paper'' then
        update project set active = false where id = u.id;
        perform council_notify(u.owner_id, format(''联席会议决议生效：研究单元「%s」已停用'', u.name));
        perform council_notify(x.user_id, format(''研究单元「%s」已按联席会议决议停用；可以加入其他研究单元，或重新申请'', u.name)) from project_member x where x.project_id = u.id and x.left_on is null;
      else
        perform council_notify_directors(format(''课题%s待办理：%s 决议已生效，请办理预算和研究单元'', case when m.ref_code = ''close'' then ''结项'' else ''终止'' end, motion_label(m)));
        for who in select id from app_user where active and (user_perm(id, ''budget.setup'') or user_perm(id, ''budget.review'')) loop
          perform council_notify(who, format(''课题%s待办理：%s 决议已生效'', case when m.ref_code = ''close'' then ''结项'' else ''终止'' end, motion_label(m)));
        end loop;
      end if;
    end if;
  elsif m.ref_kind = ''removal'' then
    if p_result = ''effective'' then perform council_notify_directors(format(''退组建议待决定：%s 决议已生效，请在议题页决定'', motion_label(m))); end if;
  elsif m.ref_kind = ''tier'' then');
  if n = d then raise exception '落回函数没有改上'; end if;
  execute n;
end $$;

select expose('close_inquiry(uuid, text)', 'propose_project_end(uuid, text, text)', 'propose_removal(uuid, text)', 'decide_removal(uuid, boolean, text)');

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
         m.auto, m.ref_year, m.ref_code,
         (m.ref_kind = 'fixed_change' and m.status = 'effective' and app_role() = 'director' and exists (select 1 from fixed_change c where c.id = m.ref_id and c.status = 'approved')) as can_execute,
         m.decided_note, m.director_decision,
         (m.ref_kind = 'removal' and m.status = 'effective' and m.director_decision is null and app_role() = 'director') as can_decide
  from motion m where app_role() is not null;

create view api.council_targets as
  select p.id, p.code, p.name, p.layer, (select name from app_user where id = p.owner_id) as owner_name from project p
  where app_role() is not null and p.active and not p.proposed and p.kind <> 'public' and p.layer in ('big','paper');
create view api.council_people as
  select pr.id, pr.name, rank_label(pr.rank) as rank_label from person pr where app_role() is not null and pr.status in ('active','offroll');
grant select on api.council_targets, api.council_people to app_api;
