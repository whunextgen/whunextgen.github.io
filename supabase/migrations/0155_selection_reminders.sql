-- 人事手动触发双选私信。仅赋予人事角色专用权限，不向全体人员查看者开放。
insert into rbac_perm(code,name,grp,scope,sort) values('selection.remind','发送双选私信提醒','人员劳务','global',44);
insert into rbac_role_perm(role_id,perm) select id,'selection.remind' from rbac_role where code='hr';

create table selection_reminder_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_user,
  audience text not null check(audience in ('apply','contact','owner')),
  remind_on date not null,
  requested_by uuid not null references app_user,
  created_at timestamptz not null default now(),
  outbox_id bigint references feishu_outbox,
  unique(user_id,audience,remind_on)
);

-- 不接收客户端收件人或文案。每次预览及发送都按当前档案、意向、成员关系重新计算。
create function selection_reminder_targets() returns table(user_id uuid,name text,audience text,message text,blocked text)
language plpgsql stable security definer set search_path=public as $$
begin
  perform need_perm('selection.remind');
  return query
  with candidates as (
    select r.* from api.selection_roster r
    where r.rank='intern' and r.selection_status <> 'joined'
      and not exists (
        select 1 from project_member m join project p on p.id=m.project_id
        where m.user_id=r.user_id and m.joined_on<=app_today() and (m.left_on is null or m.left_on>app_today())
          and p.active and not p.proposed and p.kind<>'public' and p.layer in ('big','paper')
      )
  ), targets as (
    select c.user_id,c.name,
      case when jsonb_array_length(c.interests)>0 then 'contact' else 'apply' end as audience,
      case when jsonb_array_length(c.interests)>0
        then '双选提醒：你已在正则表达研究意向，目前尚未加入课题或研究单元。请主动联系相应负责人，沟通研究安排及需要完成的小任务；双方确认接收后，请负责人在系统中将你加入成员名单。'
        else '双选提醒：你目前尚未加入课题或研究单元。请尽快在正则「双选」中查看研究方向并表达意向（申请），主动联系负责人；若已在线下谈妥，请负责人在系统中将你加入成员名单。' end as message
    from candidates c
    union all
    select p.owner_id,coalesce(u.name,'负责人待明确'),'owner',
      format('双选接收提醒：你负责的 %s 尚有 Intern 的未处理意向。请尽快主动联系申请者，沟通研究安排及需要完成的小任务，并及时确认是否接收；谈妥接收后，请在课题管理中将对方加入对应成员名单。',string_agg(distinct p.code||'「'||p.name||'」','、' order by p.code||'「'||p.name||'」'))
    from candidates c join recruit_interest i on i.user_id=c.user_id and i.status='open'
      join project p on p.id=i.project_id left join app_user u on u.id=p.owner_id
    where c.selection_status='interested' and p.active and not p.proposed and p.kind<>'public' and p.layer in ('big','paper')
    group by p.owner_id,u.name
  )
  select t.user_id,t.name,t.audience,t.message,
    case when t.user_id is null then case when t.audience='owner' then '负责人待明确' else '待关联账号' end
      when not coalesce(u.active,false) then '账号已停用'
      when t.user_id=app_uid() then '本人经办，无需私发给本人'
      when nullif(btrim(coalesce(u.feishu_union_id,u.feishu_open_id)), '') is null then '尚未绑定可用飞书身份'
      when exists(select 1 from selection_reminder_log l where l.user_id=t.user_id and l.audience=t.audience and l.remind_on=(now() at time zone 'Asia/Shanghai')::date) then '今日同类提醒已入队'
      else null end
  from targets t left join app_user u on u.id=t.user_id
  order by t.audience,t.name;
end $$;
revoke all on function selection_reminder_targets() from public;

create function preview_selection_reminders() returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  perform need_perm('selection.remind');
  return (select jsonb_build_object('recipients',coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)) from selection_reminder_targets() t);
end $$;

create function send_selection_reminders() returns jsonb
language plpgsql security definer set search_path=public as $$
declare t record; lid bigint; oid bigint; queued integer:=0; skipped integer:=0;
begin
  perform need_perm('selection.remind');
  -- 序列化按钮连点/多位人事并发，唯一键保证同人同类每天最多入队一次。
  perform pg_advisory_xact_lock(152,1);
  for t in select * from selection_reminder_targets() loop
    if t.blocked is not null then skipped:=skipped+1;continue;end if;
    lid:=null;
    insert into selection_reminder_log(user_id,audience,remind_on,requested_by)
      values(t.user_id,t.audience,(now() at time zone 'Asia/Shanghai')::date,app_uid())
      on conflict(user_id,audience,remind_on) do nothing returning id into lid;
    if lid is null then skipped:=skipped+1;continue;end if;
    -- 使用现有正则飞书私信发件队列与卡片格式，不发送群通知。
    insert into feishu_outbox(target,payload,user_id)
      select coalesce(u.feishu_union_id,u.feishu_open_id),jsonb_build_object('text',t.message,
        'by',(select name from app_user where id=app_uid()),'at',to_char(now() at time zone 'Asia/Shanghai','MM-DD HH24:MI'),
        'url','#/select','btn','查看双选','selection_reminder',t.audience),u.id
      from app_user u where u.id=t.user_id returning id into oid;
    update selection_reminder_log set outbox_id=oid where id=lid;
    queued:=queued+1;
  end loop;
  return jsonb_build_object('queued',queued,'skipped',skipped);
end $$;
select expose('preview_selection_reminders()','send_selection_reminders()');
