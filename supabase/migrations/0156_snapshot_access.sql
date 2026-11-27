-- 看不到别人的快照草稿（issue #167，熊瑶）
--   正则对所有人列出快照和「打开草稿」，但草稿是作者自己的飞书文档或知识库页面，能不能打开取决于文档本身的分享设置；
--   作者没有开放的，别人在正则里看得到质疑，点开草稿却没有权限。正则改不了别人文档的权限，所以：
--   提交快照时提醒并要求确认已设为「组织内获得链接的人可阅读」（页面上办）；打不开的，读者可以一键提醒作者开放。
create function ask_snapshot_access(p_snapshot uuid) returns integer language plpgsql security definer set search_path = public as $$
declare s snapshot; t text; who uuid; n int := 0; me text;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  select * into s from snapshot where id = p_snapshot;
  if not found then raise exception '快照不存在'; end if;
  me := (select name from app_user where id = app_uid());
  t := format('快照草稿打不开：%s 打不开你的「%s」第 %s 次快照的写作草稿。请在飞书里把这份文档的分享设为「组织内获得链接的人可阅读」，大家才能读稿、提质疑',
    me, coalesce(s.title, (select name from project where id = s.project_id)), s.seq);
  for who in select distinct x from (select a.user_id x from snapshot_author a where a.snapshot_id = s.id union select s.person_id union select s.submitted_by) z where x is not null and x <> app_uid() loop
    perform notify_user_link(who, t, '#/snapshot/' || s.id);
    n := n + 1;
  end loop;
  if n = 0 then raise exception '这份快照的作者就是本人，或者没有登记作者'; end if;
  return n;
end $$;
select expose('ask_snapshot_access(uuid)');

-- 反馈分派补上主题研讨会页（#/seminar/…）：会议、讲座与研讨会归曲保杰（#167 是从这一页提交的，原来没对上）
create or replace function feedback_owner(p_page text) returns text language sql immutable as $$
  select case split_part(regexp_replace(coalesce(p_page, ''), '^#?/+', ''), '/', 1)
    when 'budget' then '况紫嫣' when 'plan' then '况紫嫣' when 'apply' then '况紫嫣' when 'requests' then '况紫嫣' when 'petty' then '况紫嫣'
    when 'caps' then '况紫嫣' when 'review' then '况紫嫣' when 'rules' then '况紫嫣' when 'ask' then '况紫嫣' when 'desk' then '况紫嫣'
    when 'resource' then '张睿宇' when 'pool' then '张睿宇' when 's-res' then '张睿宇' when 'stock' then '张睿宇'
    when 'people' then '陈秀栋' when 'staff' then '陈秀栋' when 'members' then '陈秀栋'
    when 'path' then '肖梦溪' when 'select' then '肖梦溪' when 'courses' then '肖梦溪'
    when 'projects' then '唐逸航' when 'project' then '唐逸航' when 'biweekly' then '唐逸航' when 'iterate' then '唐逸航' when 'snapshot' then '唐逸航' when 'query' then '唐逸航'
    when 'live' then '曲保杰' when 'council' then '曲保杰' when 'seminar' then '曲保杰' when 'palette' then '曲保杰' when 'naming' then '曲保杰'
    else null end
$$;
