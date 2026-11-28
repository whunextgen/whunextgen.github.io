-- 0184 反馈分工放进正则（黄济民 2026-11-28「助理已经重新调整了，重新确定@人的逻辑」「你重新分一下，放正则」）
--   原来写死在 feedback_owner() 里（0153、0156）；陈秀栋、肖梦溪、唐逸航 11-28 离岗退出协助群后，反馈仍分给他们。
--   现在按页面存在 feedback_route 表里，中心负责人在「系统 › 反馈分工」改；不在表里的页面由济民（中台程序）处理，不 @ 人。
--   页面「*」是兜底人：分到的人已停用，或正则发协助群时发现他不在群里，改 @ 兜底人。
--   11-28 重新分工：况紫嫣 年度预算、立项、课题与双周表、人事与双选；王菲 支出、报销、经费卡与项目；张睿宇 资源与代币；曲保杰 会议、快照与质疑、培养；兜底 况紫嫣。
create table feedback_route (
  page       text primary key,
  label      text not null,
  owner_id   uuid references app_user(id),
  sort       int not null default 100,
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now()
);
insert into feedback_route (page, label, owner_id, sort)
select v.page, v.label, (select id from app_user where name = v.who and active order by created_at limit 1), v.sort from (values
  ('*', '兜底（负责人已停用或不在协助群时）', '况紫嫣', 0),
  ('plan', '年度档次、总预算与档次', '况紫嫣', 10),
  ('budget', '预算编制', '况紫嫣', 20),
  ('caps', '预算控制', '况紫嫣', 30),
  ('review', '年度决算', '况紫嫣', 40),
  ('desk', '预算参数', '况紫嫣', 50),
  ('apply', '立项与延续申请', '况紫嫣', 60),
  ('projects', '课题管理', '况紫嫣', 70),
  ('project', '课题页、研究单元页', '况紫嫣', 80),
  ('s-topic', '课题汇总（入口）', '况紫嫣', 90),
  ('biweekly', '双周表', '况紫嫣', 100),
  ('people', '人员档案', '况紫嫣', 110),
  ('staff', '人员经费', '况紫嫣', 120),
  ('members', '加入与考核', '况紫嫣', 130),
  ('select', '双选', '况紫嫣', 140),
  ('tasks', '任务管理', '况紫嫣', 150),
  ('requests', '支出申请', '王菲', 160),
  ('req', '支出申请详情', '王菲', 170),
  ('petty', '备用金管理', '王菲', 180),
  ('rules', '采购与报销要求', '王菲', 190),
  ('ask', '报销咨询', '王菲', 200),
  ('school', '报销与入账', '王菲', 210),
  ('settle', '经费结清', '王菲', 220),
  ('procure', '采购', '王菲', 230),
  ('cards', '经费卡管理', '王菲', 240),
  ('card', '经费卡详情', '王菲', 250),
  ('funds', '项目管理', '王菲', 260),
  ('fund', '项目详情', '王菲', 270),
  ('ledger', '明细账校准', '王菲', 280),
  ('s-fund', '项目汇总', '王菲', 290),
  ('s-spend', '课题汇总', '王菲', 300),
  ('track', '在途事项', '王菲', 310),
  ('history', '历史数据', '王菲', 320),
  ('resource', '资源申领', '张睿宇', 330),
  ('res', '资源详情', '张睿宇', 340),
  ('pool', '资源调配', '张睿宇', 350),
  ('stock', '资产盘点', '张睿宇', 360),
  ('s-res', '资源汇总', '张睿宇', 370),
  ('token', '代币系统', '张睿宇', 380),
  ('live', '会议现场', '曲保杰', 390),
  ('seminar', '主题研讨会', '曲保杰', 400),
  ('council', '联席会议', '曲保杰', 410),
  ('iterate', '快照与质疑', '曲保杰', 420),
  ('snapshot', '快照详情', '曲保杰', 430),
  ('query', '质疑详情', '曲保杰', 440),
  ('courses', '训练课程', '曲保杰', 450),
  ('path', '成长主线', '曲保杰', 460),
  ('palette', '配色投票', '曲保杰', 470),
  ('naming', '中台征名', '曲保杰', 480)
) v(page, label, who, sort);

create or replace function feedback_owner(p_page text) returns text language sql stable security definer set search_path = public as $$
  select u.name from feedback_route r join app_user u on u.id = r.owner_id and u.active
  where r.page = split_part(regexp_replace(coalesce(p_page, ''), '^#?/+', ''), '/', 1) and r.page <> '*'
  union all
  select u.name from feedback_route r join app_user u on u.id = r.owner_id and u.active
  where r.page = '*' and exists (select 1 from feedback_route x where x.page = split_part(regexp_replace(coalesce(p_page, ''), '^#?/+', ''), '/', 1) and x.page <> '*')
  limit 1
$$;
create function feedback_fallback() returns text language sql stable security definer set search_path = public as $$
  select u.name from feedback_route r join app_user u on u.id = r.owner_id and u.active where r.page = '*'
$$;

create function set_feedback_route(p_page text, p_owner uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  perform need_role('director');
  if p_owner is not null and not exists (select 1 from app_user where id = p_owner and active) then raise exception '负责人须是在用的账号'; end if;
  update feedback_route set owner_id = p_owner, updated_by = app_uid(), updated_at = now() where page = p_page;
  if not found then raise exception '没有这个页面'; end if;
end $$;
select expose('set_feedback_route(text, uuid)');

create view api.feedback_route as
  select r.page, r.label, r.owner_id, u.name as owner_name, r.sort, b.name as updated_by_name, r.updated_at
  from feedback_route r left join app_user u on u.id = r.owner_id left join app_user b on b.id = r.updated_by
  where app_role() is not null;
grant select on api.feedback_route to app_api;

CREATE OR REPLACE FUNCTION public.feedback_issue_save(p_id uuid, p_number integer, p_url text, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare f feedback; b text; q record; seqs int[]; nums int[]; oid text; txt text; u text;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  update feedback set issue_number = p_number, issue_url = p_url, tries = tries + 1, tried_at = now(), last_error = left(p_error, 300) where id = p_id returning * into f;
  if p_number is not null then
    u := case when p_url ~ '^https://github\.com/' then p_url end;
    select id, payload into q from feishu_outbox where user_id = f.user_id and status = 'queued' and payload->>'merge' = 'feedback' order by id desc limit 1 for update;
    if found then
      select array_agg(x order by x) into seqs from (select jsonb_array_elements_text(q.payload->'seqs')::int x union select f.seq) s;
      select array_agg(x order by x) into nums from (select jsonb_array_elements_text(q.payload->'nums')::int x union select p_number) s;
    else
      seqs := array[f.seq]; nums := array[p_number];
    end if;
    txt := format('反馈已收到：你的第 %s 号反馈已转为议题 %s，处理进展可在「反馈」里查看',
      array_to_string(seqs, '、'), (select string_agg('#' || x, '、') from unnest(nums) x));
    if q.id is not null then
      update feishu_outbox set payload = payload || jsonb_strip_nulls(jsonb_build_object('text', txt, 'seqs', to_jsonb(seqs), 'nums', to_jsonb(nums), 'url', u, 'btn', case when u is not null then '查看议题' end)) where id = q.id;
    else
      select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = f.user_id and active;
      if oid is not null then
        insert into feishu_outbox (target, payload, user_id)
        values (oid, jsonb_strip_nulls(jsonb_build_object('text', txt, 'by', '正则', 'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'),
          'merge', 'feedback', 'seqs', to_jsonb(seqs), 'nums', to_jsonb(nums), 'url', u, 'btn', case when u is not null then '查看议题' end)), f.user_id);
      end if;
    end if;
    b := replace(btrim(f.body), E'\r', '');
    insert into github_delivery (id) values ('feedback:' || f.seq) on conflict do nothing;
    if found then
      insert into feishu_outbox (target, payload) values ('assist', jsonb_strip_nulls(jsonb_build_object(
        'text', left(format(E'新反馈 #%s（第 %s 号）：%s\n提交人 %s · 页面 %s\n负责：%s，请在议题下回复「认领」并写预计完成时间',
          p_number, f.seq, case when length(b) > 300 then left(b, 300) || '……' else b end,
          coalesce((select name from app_user where id = f.user_id), '—'), coalesce(nullif(f.page_title, ''), f.page, '—'),
          coalesce(feedback_owner(f.page), '济民（中台程序）')), 1500),
        'url', u, 'btn', '查看议题', 'kind', 'post', 'thread', 'issue:' || p_number, 'plain', true,
        'mention', case when feedback_owner(f.page) is not null then jsonb_build_array(feedback_owner(f.page)) end,
        'fallback', feedback_fallback(),
        'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'))));
    end if;
  end if;
end $function$;
