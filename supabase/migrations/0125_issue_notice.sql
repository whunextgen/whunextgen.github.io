-- 反馈转成的 GitHub 议题也在协助群通报（黄济民 2026-11-26「正则的 issue 怎么没有在群里通知」）
--   原来只转发中台分支上的 PR 事件，议题一律跳过；反馈转议题时也只通知了提交人本人。
--   现在：反馈转成议题时由正则直接在协助群发一条，不依赖 GitHub 的事件推送；
--   议题关闭、重新打开时经 webhook 通报（需要仓库的 webhook 勾选 Issues 事件），只认带「反馈」标签的议题。
--   一个议题一个话题，键为 issue:<编号>，与 PR 的 pr:<编号> 并列。

alter table notice_thread drop constraint notice_thread_key_check;
alter table notice_thread add constraint notice_thread_key_check check (key ~ '^(pr|issue):[0-9]{1,7}$');

create or replace function github_notice(p_delivery text, p_text text, p_url text default null, p_btn text default null, p_thread text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  if coalesce(btrim(p_text), '') = '' then raise exception '通报内容为空'; end if;
  if p_thread is not null and p_thread !~ '^(pr|issue):[0-9]{1,7}$' then raise exception '话题键不对'; end if;
  insert into github_delivery (id) values (p_delivery) on conflict do nothing;
  if not found then return false; end if;
  insert into feishu_outbox (target, payload)
  values ('assist', jsonb_strip_nulls(jsonb_build_object('text', left(p_text, 1500), 'url', p_url, 'btn', p_btn, 'kind', 'post', 'thread', p_thread,
    'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
  return true;
end $$;

create or replace function feedback_issue_save(p_id uuid, p_number int, p_url text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare f feedback; b text;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update feedback set issue_number = p_number, issue_url = p_url, tries = tries + 1, tried_at = now(), last_error = left(p_error, 300) where id = p_id returning * into f;
  if p_number is not null then
    perform notify_sys(f.user_id, format('反馈已收到：你的第 %s 号反馈已转为议题 #%s，处理进展可在「反馈」里查看', f.seq, p_number));
    b := replace(btrim(f.body), E'\r', '');
    perform github_notice('feedback:' || f.seq, format(E'新反馈 #%s（第 %s 号）：%s\n提交人 %s · 页面 %s',
      p_number, f.seq, case when length(b) > 300 then left(b, 300) || '……' else b end,
      coalesce((select name from app_user where id = f.user_id), '—'), coalesce(nullif(f.page_title, ''), f.page, '—')),
      case when p_url ~ '^https://github\.com/' then p_url end, '查看议题', 'issue:' || p_number);
  end if;
end $$;
