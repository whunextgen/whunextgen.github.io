-- 研讨会组织者撤回对投稿的决定（#168「会议的 agenda 通过后，没法回到没通过的状态」）
--   接收为口头报告、海报或不接收之后，本期内可以撤回，回到投稿待定，再重新决定。
--   已接收的，只在还没开始讨论时可以撤回：没有记入质疑、没有待记入或已记入的质疑卡、没有点过名、没在写卡。已结束讨论的不能撤回。

create function undo_pitch_decision(p_pitch uuid) returns void language plpgsql security definer set search_path = public as $$
declare x snapshot_pitch; s snapshot; p project; sm seminar; was text;
begin
  select * into x from snapshot_pitch where id = p_pitch for update;
  if not found then raise exception '提交不存在'; end if;
  if not is_organizer(x.seminar) then raise exception '由该研讨会的组织者撤回' using errcode = '42501'; end if;
  if x.status = 'closed' then raise exception '已结束讨论的不能撤回'; end if;
  if x.status not in ('accepted','declined') then raise exception '这份提交还没有决定'; end if;
  select * into s from snapshot where id = x.snapshot_id;
  if s.period_start <> token_period(app_today()) then raise exception '往期的提交不再处理'; end if;
  if x.status = 'accepted' then
    if x.card_round then raise exception '正在写卡，先收卡'; end if;
    if exists (select 1 from query where pitch_id = p_pitch)
       or exists (select 1 from query_draft where pitch_id = p_pitch and status in ('pending','accepted'))
       or exists (select 1 from speak_turn where pitch_id = p_pitch) then
      raise exception '这份已开始讨论（记入过质疑、有人交了质疑卡或点过名），不能撤回接收';
    end if;
  end if;
  was := x.status;
  update snapshot_pitch set status = 'pending', note = null, decided_by = null, decided_at = null, format = null, minutes = null where id = p_pitch;
  select * into p from project where id = s.project_id; select * into sm from seminar where code = x.seminar;
  perform notify_user(s.submitted_by, format('快照改回待定：研究单元「%s」的第 %s 次快照，「%s」主题研讨会的组织者撤回了%s的决定，改回投稿待定，将重新决定',
    p.name, s.seq, sm.name, case when was = 'accepted' then '接收' else '不接收' end));
  if p.owner_id is distinct from s.submitted_by then
    perform notify_user(p.owner_id, format('快照改回待定：研究单元「%s」的第 %s 次快照，「%s」主题研讨会改回投稿待定，将重新决定', p.name, s.seq, sm.name));
  end if;
end $$;
select expose('undo_pitch_decision(uuid)');
