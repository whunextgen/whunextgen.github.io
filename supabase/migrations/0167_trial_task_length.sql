-- 开试做期提交时一直显示「数据不合法」（#165）
--   首个小任务的「做什么」限 80 字、「交付什么」限 1000 字，原来只靠表上的约束拦，超出时只返回「数据不合法」，
--   负责人看不出是哪一项、改什么。现在写入前先校验，超出的说明是哪一项、限多少字。限额不变。
create or replace function start_trial(p_project uuid, p_user uuid, p_mentor uuid, p_end date, p_task_title text, p_task_detail text, p_task_due date, p_no_conflict boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare p project; v_id uuid; tt text := btrim(coalesce(p_task_title, '')); td text := btrim(coalesce(p_task_detail, ''));
begin
  select * into p from project where id = p_project;
  if not found or not p.active or p.proposed or p.kind = 'public' then raise exception '课题或研究单元不存在'; end if;
  if not has_perm('budget.project', p_project) then raise exception '由负责人或副手开试做期' using errcode = '42501'; end if;
  if user_rank(p_user) not in ('intern','assistant') then raise exception '试做期适用于 Intern 和 Assistant'; end if;
  if not user_rank_at_least(p_mentor, 'researcher') then raise exception '指导人由 Researcher 及以上担任'; end if;
  if p_mentor = p_user then raise exception '指导人不能是本人'; end if;
  if not coalesce(p_no_conflict, false) then raise exception '指导人须与成员没有私人关系；有的，请另选指导人'; end if;
  if p_end is null or p_end <= app_today() or p_end > app_today() + 31 then raise exception '试做期为一个月，截止日期须在今天之后、一个月以内'; end if;
  if p_task_due is null or p_task_due < app_today() or p_task_due > p_end then raise exception '小任务的提交日期须在试做期内'; end if;
  if tt = '' or td = '' then raise exception '请写明首个小任务做什么、交付什么'; end if;
  if length(tt) > 80 then raise exception '首个小任务「做什么」不超过 80 字（现在 % 字），细节写进「交付什么」', length(tt); end if;
  if length(td) > 1000 then raise exception '首个小任务「交付什么」不超过 1000 字（现在 % 字）', length(td); end if;
  if exists (select 1 from trial where project_id = p_project and user_id = p_user and status = 'running') then raise exception '这名成员在这里已有试做期'; end if;
  if not exists (select 1 from project_member where project_id = p_project and user_id = p_user and left_on is null) then perform add_project_member(p_project, p_user); end if;
  insert into trial (project_id, user_id, mentor_id, start_on, end_on, task_title, task_detail, task_due, started_by)
  values (p_project, p_user, p_mentor, app_today(), p_end, tt, td, p_task_due, app_uid()) returning trial.id into v_id;
  insert into trial_log (trial_id, kind, note, end_on) values (v_id, 'start', tt, p_end);
  perform notify_user(p_user, format('试做期开始：「%s」，指导人 %s，至 %s。首个小任务：%s，%s 前提交', p.name, (select name from app_user where id = p_mentor), p_end, tt, p_task_due));
  if p_mentor <> app_uid() then perform notify_user(p_mentor, format('试做期指导：你是 %s 在「%s」的试做期指导人，至 %s', (select name from app_user where id = p_user), p.name, p_end)); end if;
  return v_id;
end $$;
