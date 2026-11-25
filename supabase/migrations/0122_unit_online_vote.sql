-- 研究单元立项按修订后的规则（况紫嫣 PR 14 所引，黄济民 2026-11-26 确认）：
--   新研究单元由申请人在中台提交，所挂课题负责人同意后，联席会议成员在中台在线表决；赞成人数超过有表决权成员总数一半的，予以立项，即刻成立；
--   赞成已不可能过半的，即为未通过，退回申请人。审核结果由中台记录存档。不经否决期。
--   涉及本人或合作者的仍回避；总人数按开始表决时可以投票的有表决权成员计，回避的不计入，免得回避使立项无法通过
alter table motion drop constraint motion_threshold_check;
alter table motion add constraint motion_threshold_check check (threshold in ('majority','two_thirds','abs_majority'));
alter table motion add column total int;   -- 绝对多数：开始表决时有表决权成员的总数

-- 开始研究单元的在线表决：议题已列入、课题负责人已同意
create function unit_vote_open(p_unit uuid) returns void language plpgsql security definer set search_path = public as $$
declare m motion; u project; tot int := council_electorate(); v uuid;
begin
  select * into u from project where id = p_unit;
  if not found or not u.proposed or u.applied_at is null or u.parent_ok_at is null or u.return_note is not null then return; end if;
  select * into m from motion where ref_kind = 'unit' and ref_id = p_unit and status = 'seconded' order by created_at desc limit 1 for update;
  if not found then return; end if;
  tot := 0;
  for v in select id from app_user where active and user_rank(id) in ('researcher','rising_star','pi') loop
    if motion_can_vote(m.id, v) then tot := tot + 1; end if;
  end loop;
  if tot = 0 then raise exception '还没有可以投票的有表决权成员，不能开始表决'; end if;
  update motion set status = 'voting', online = true, threshold = 'abs_majority', total = tot, vote_open_at = now(), vote_until = null, meeting_id = null where id = m.id;
  for v in select id from app_user where active and user_rank(id) in ('researcher','rising_star','pi') loop
    if motion_can_vote(m.id, v) then perform council_notify(v, format('研究单元立项待表决：%s，在正则上投票；赞成超过 %s 人即立项', motion_label(m), tot / 2)); end if;
  end loop;
end $$;
revoke execute on function unit_vote_open(uuid) from public;

create function trg_unit_vote_open() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.layer = 'paper' and new.proposed and new.parent_ok_at is not null and (old.parent_ok_at is null or old.applied_at is distinct from new.applied_at) then perform unit_vote_open(new.id); end if;
  return new;
end $$;
create trigger unit_vote_open after update of parent_ok_at, applied_at on project for each row execute function trg_unit_vote_open();

-- 生成议题后：课题负责人本人提交的（已视为同意）即刻开始表决
do $$
declare d text := pg_get_functiondef('public.unit_motion_sync(uuid)'::regprocedure); n text;
begin
  n := regexp_replace(d, E'\nend\\s*\\$function\\$', E'\n  perform unit_vote_open(p_unit);\nend $function$');
  if n = d then raise exception '研究单元议题函数没有改上'; end if;
  execute n;
end $$;

-- 投票即判定：赞成过半数即通过，赞成已不可能过半即未通过
do $$
declare d text := pg_get_functiondef('public.cast_vote(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, E'  on conflict (motion_id, round, user_id) do update set choice = excluded.choice, at = now();',
E'  on conflict (motion_id, round, user_id) do update set choice = excluded.choice, at = now();
  if m.threshold = ''abs_majority'' then
    if (select count(*) from motion_vote where motion_id = p_id and round = m.round and choice = ''yes'') * 2 > m.total
       or (select count(*) from motion_vote where motion_id = p_id and round = m.round and choice = ''no'') >= m.total - m.total / 2 then
      perform motion_close(p_id);
    end if;
  end if;');
  if n = d then raise exception '投票函数没有改上'; end if;
  execute n;
end $$;

-- 计票：绝对多数按开始时的总人数；通过的即刻生效并办理，不经否决期
do $$
declare d text := pg_get_functiondef('public.motion_close(uuid)'::regprocedure); n text;
begin
  n := replace(d, E'  if m.online and (y + n + ab) * 2 <= tot then',
                  E'  if m.threshold = ''abs_majority'' then ok := y * 2 > m.total; elig := m.total;\n  elsif m.online and (y + n + ab) * 2 <= tot then');
  n := replace(n, E'  if ok and m.mtype = ''main'' then',
                  E'  if ok and m.threshold = ''abs_majority'' then\n    update motion set status = ''effective'', effective_at = now() where id = p_id;\n    perform motion_apply(p_id, ''effective'');\n  elsif ok and m.mtype = ''main'' then');
  if n = d or position('abs_majority' in n) = 0 then raise exception '计票函数没有改上'; end if;
  execute n;
end $$;

-- 研究单元在线表决不转到会上
do $$
declare d text := pg_get_functiondef('public.request_meeting(uuid)'::regprocedure); n text;
begin
  n := replace(d, E'  if m.status <> ''voting'' or not m.online then raise exception ''只有会外表决可以要求转到会上''; end if;',
    E'  if m.status <> ''voting'' or not m.online then raise exception ''只有会外表决可以要求转到会上''; end if;\n  if m.threshold = ''abs_majority'' then raise exception ''研究单元立项在线表决，不转到会上''; end if;');
  if n = d then raise exception '转到会上的函数没有改上'; end if;
  execute n;
end $$;

-- 通过即成立：不再等助理确认和登记日
do $$
declare d text := pg_get_functiondef('public.motion_apply(uuid, text)'::regprocedure); n text;
begin
  n := replace(d, E'      update project set meeting_on = on_, minutes_on = on_ where id = u.id;',
E'      update project set meeting_on = on_, minutes_on = on_ where id = u.id;
      if m.threshold = ''abs_majority'' and u.parent_ok_at is not null then
        update project set proposed = false, checked_at = now() where id = u.id;
        perform notify_group(format(''研究单元成立：研究单元「%s」经联席会议在线表决通过（赞成 %s 人，共 %s 人），挂在课题「%s」之下，负责人 %s'',
          u.name, m.yes, m.total, (select name from project where id = u.parent_id), coalesce((select name from app_user where id = u.owner_id), ''—'')));
        perform council_notify(u.owner_id, format(''研究单元「%s」经联席会议在线表决通过，已成立。本人为负责人，可管理成员名单'', u.name));
        perform council_notify(x.user_id, format(''你已加入研究单元「%s」的成员名单'', u.name)) from project_member x where x.project_id = u.id and x.left_on is null;
        return;
      end if;');
  if n = d then raise exception '落回函数没有改上'; end if;
  execute n;
end $$;

-- 已经同意、尚在议程上的研究单元申请，即刻开始在线表决
do $$ declare r record; begin
  for r in select p.id from project p where p.layer = 'paper' and p.proposed and p.applied_at is not null and p.parent_ok_at is not null and p.return_note is null
    and exists (select 1 from motion m where m.ref_kind = 'unit' and m.ref_id = p.id and m.status = 'seconded') loop
    perform unit_vote_open(r.id);
  end loop;
end $$;

create or replace view api.council_info as
  select council_term(app_today()) as term, council_electorate() as electorate, council_voter(app_uid()) as am_voter,
         (council_rep() = app_uid()) as am_rep, council_rep_eligible(app_uid()) as can_rep_vote, council_chair() as can_chair,
         (app_role() = 'director') as am_director, (select name from app_user where id = council_rep()) as rep_name,
         (select candidate_id from council_rep_vote where term = council_term(app_today()) and voter_id = app_uid()) as my_rep_vote
  where app_role() is not null;

-- 表决有结果之前退回的，撤下表决
do $$
declare d text := pg_get_functiondef('public.return_unit(uuid, text)'::regprocedure); n text;
begin
  n := regexp_replace(d, E'\nend\\s*\\$function\\$', E'\n  update motion set status = ''withdrawn'', decided_at = now(), note = ''申请已退回'' where ref_kind = ''unit'' and ref_id = p_unit and status in (''proposed'',''seconded'',''voting'');\nend $function$');
  if n = d then raise exception '退回函数没有改上'; end if;
  execute n;
end $$;

-- 议题视图加上绝对多数的总人数
do $$
declare d text := pg_get_viewdef('api.council_motion'::regclass, true);
begin
  execute 'create or replace view api.council_motion as ' || regexp_replace(rtrim(d, '; 
'), '\s+FROM motion m\s+WHERE', ', m.total FROM motion m WHERE', 'i');
end $$;
