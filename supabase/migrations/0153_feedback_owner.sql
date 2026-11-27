-- 新反馈按岗位自动分派（黄济民 2026-11-27「新反馈进来后，应该自动根据岗位分」，分工表经确认）
--   按提交反馈时所在的页面定负责人；转成议题时议题里写明负责人，协助群的通报用纯文字并 @ 负责人
--   （纯文字各家的 agent 都读得到，卡片读不到）。不在表里的页面、程序出错的，由济民（中台的 coding agent）处理，不 @ 人。
create function feedback_owner(p_page text) returns text language sql immutable as $$
  select case split_part(regexp_replace(coalesce(p_page, ''), '^#?/+', ''), '/', 1)
    when 'budget' then '况紫嫣' when 'plan' then '况紫嫣' when 'apply' then '况紫嫣' when 'requests' then '况紫嫣' when 'petty' then '况紫嫣'
    when 'caps' then '况紫嫣' when 'review' then '况紫嫣' when 'rules' then '况紫嫣' when 'ask' then '况紫嫣' when 'desk' then '况紫嫣'
    when 'resource' then '张睿宇' when 'pool' then '张睿宇' when 's-res' then '张睿宇' when 'stock' then '张睿宇'
    when 'people' then '陈秀栋' when 'staff' then '陈秀栋' when 'members' then '陈秀栋'
    when 'path' then '肖梦溪' when 'select' then '肖梦溪' when 'courses' then '肖梦溪'
    when 'projects' then '唐逸航' when 'project' then '唐逸航' when 'biweekly' then '唐逸航' when 'iterate' then '唐逸航' when 'snapshot' then '唐逸航' when 'query' then '唐逸航'
    when 'live' then '曲保杰' when 'council' then '曲保杰' when 'palette' then '曲保杰' when 'naming' then '曲保杰'
    else null end
$$;

drop function feedback_todo();
create function feedback_todo() returns table(id uuid, seq integer, body text, page text, page_title text, user_name text, created_at timestamptz, owner text)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select f.id, f.seq, f.body, f.page, f.page_title, u.name, f.created_at, feedback_owner(f.page) from feedback f join app_user u on u.id = f.user_id
  where f.issue_number is null and f.tries < 10 and (f.tried_at is null or f.tried_at < now() - interval '10 minutes') order by f.created_at limit 10;
end $$;

-- 协助群通报：纯文字、@ 负责人、挂在该议题的话题下
do $$
declare d text := pg_get_functiondef('public.feedback_issue_save(uuid, integer, text, text)'::regprocedure); n text;
begin
  n := replace(d, $a$    perform github_notice('feedback:' || f.seq, format(E'新反馈 #%s（第 %s 号）：%s\n提交人 %s · 页面 %s',
      p_number, f.seq, case when length(b) > 300 then left(b, 300) || '……' else b end,
      coalesce((select name from app_user where id = f.user_id), '—'), coalesce(nullif(f.page_title, ''), f.page, '—')),
      u, '查看议题', 'issue:' || p_number);$a$,
$b$    insert into github_delivery (id) values ('feedback:' || f.seq) on conflict do nothing;
    if found then
      insert into feishu_outbox (target, payload) values ('assist', jsonb_strip_nulls(jsonb_build_object(
        'text', left(format(E'新反馈 #%s（第 %s 号）：%s\n提交人 %s · 页面 %s\n负责：%s，请在议题下回复「认领」并写预计完成时间',
          p_number, f.seq, case when length(b) > 300 then left(b, 300) || '……' else b end,
          coalesce((select name from app_user where id = f.user_id), '—'), coalesce(nullif(f.page_title, ''), f.page, '—'),
          coalesce(feedback_owner(f.page), '济民（中台程序）')), 1500),
        'url', u, 'btn', '查看议题', 'kind', 'post', 'thread', 'issue:' || p_number, 'plain', true,
        'mention', case when feedback_owner(f.page) is not null then jsonb_build_array(feedback_owner(f.page)) end,
        'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
    end if;$b$);
  if n = d then raise exception 'feedback_issue_save 没有改上'; end if;
  execute n;
end $$;
