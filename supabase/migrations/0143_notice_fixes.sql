-- 飞书通知的几处问题（姜玥辰反馈 #126 #127 #139 #140）
--   #139 同一条「研究单元申请待同意」推了两次：申请人 18 秒内提交了两次，每次都通知。现在同一人 10 分钟内同样的话只发一次。
--   #140 反馈批量转议题时一次推来 7 张「反馈已收到」且顺序错乱：同一轮转好的合并成一张；发送队列按入队顺序发。
--   #126 「反馈已收到」的「前往查看」只打开首页：改为直达 GitHub 议题。
--   #127 「研究单元已成立」的「前往查看」打开的是全部清单：改为直达该研究单元。通知可以带站内链接（#/ 开头），卡片按钮直达。

-- 同一人 10 分钟内收到过同样的话（未发或已发），不再重复入队
create function notice_dup(p_user uuid, p_text text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from feishu_outbox where user_id = p_user and payload->>'text' = p_text and status in ('queued','sent') and created_at > now() - interval '10 minutes')
$$;
revoke execute on function notice_dup(uuid, text) from public;

create or replace function notify_user(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
begin
  perform notify_user_link(p_user, p_text, null, null);
end $$;

-- 带链接的个人通知：p_url 为站内路径（#/ 开头）或 https 链接，卡片按钮直达
create function notify_user_link(p_user uuid, p_text text, p_url text, p_btn text default null) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if app_uid() is null or p_user is null or p_user = app_uid() then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null or notice_dup(p_user, p_text) then return; end if;
  insert into feishu_outbox (target, payload, user_id)
  values (oid, jsonb_strip_nulls(jsonb_build_object('text', p_text, 'by', (select name from app_user where id = app_uid()),
                                  'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'), 'url', p_url, 'btn', p_btn)), p_user);
end $$;

create or replace function notify_user_act(p_act jsonb, p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if app_uid() is null or p_user is null or p_user = app_uid() then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null or notice_dup(p_user, p_text) then return; end if;
  insert into feishu_outbox (target, payload, user_id)
  values (oid, jsonb_build_object('text', p_text, 'by', (select name from app_user where id = app_uid()),
                                  'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI'), 'act', p_act), p_user);
end $$;

create or replace function notify_sys(p_user uuid, p_text text) returns void language plpgsql security definer set search_path = public as $$
declare oid text;
begin
  if p_user is null then return; end if;
  select coalesce(feishu_union_id, feishu_open_id) into oid from app_user where id = p_user and active;
  if oid is null or notice_dup(p_user, p_text) then return; end if;
  insert into feishu_outbox (target, payload, user_id)
  values (oid, jsonb_build_object('text', p_text, 'by', '正则', 'at', to_char(now() at time zone 'Asia/Shanghai', 'MM-DD HH24:MI')), p_user);
end $$;

-- 发送队列按入队顺序取（update ... returning 的次序不确定）
create or replace function outbox_take(p_limit integer default 20) returns table(msg_id bigint, target_id text, body jsonb) language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色无权执行此操作' using errcode = '42501'; end if;
  update feishu_outbox set status = 'failed', last_error = '超过 24 小时未发送，已作废'
  where status = 'queued' and created_at < now() - interval '24 hours';
  return query
    with t as (
      update feishu_outbox o set attempts = o.attempts + 1
      where o.id in (select q.id from feishu_outbox q where q.status = 'queued' order by q.id limit greatest(1, least(coalesce(p_limit, 20), 50)) for update skip locked)
      returning o.id, o.target, o.payload)
    select * from t order by t.id;
end $$;

-- 反馈转议题：同一人还没发出的「反馈已收到」合并成一张，编号从小到大；按钮直达议题（多条时为最新一条）
create or replace function feedback_issue_save(p_id uuid, p_number integer, p_url text, p_error text) returns void language plpgsql security definer set search_path = public as $$
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
    perform github_notice('feedback:' || f.seq, format(E'新反馈 #%s（第 %s 号）：%s\n提交人 %s · 页面 %s',
      p_number, f.seq, case when length(b) > 300 then left(b, 300) || '……' else b end,
      coalesce((select name from app_user where id = f.user_id), '—'), coalesce(nullif(f.page_title, ''), f.page, '—')),
      u, '查看议题', 'issue:' || p_number);
  end if;
end $$;

-- 研究单元成立的通知直达该研究单元
do $$
declare d text := pg_get_functiondef('public.confirm_unit(uuid)'::regprocedure); n text := d;
begin
  n := replace(n, $a$perform notify_user(u.owner_id, format('研究单元「%s」已成立，挂在课题「%s」之下。本人为负责人，可管理成员名单', u.name, par.name));$a$,
                  $b$perform notify_user_link(u.owner_id, format('研究单元「%s」已成立，挂在课题「%s」之下。本人为负责人，可管理成员名单', u.name, par.name), '#/project/' || u.id);$b$);
  n := replace(n, $a$perform notify_user(par.owner_id, format('课题「%s」之下新成立研究单元「%s」，负责人 %s', par.name, u.name, (select name from app_user where id = u.owner_id)));$a$,
                  $b$perform notify_user_link(par.owner_id, format('课题「%s」之下新成立研究单元「%s」，负责人 %s', par.name, u.name, (select name from app_user where id = u.owner_id)), '#/project/' || u.id);$b$);
  n := replace(n, $a$perform notify_user(m.user_id, format('你已加入研究单元「%s」的成员名单，可使用课题「%s」的预算提交支出申请、申领资源', u.name, par.name))$a$,
                  $b$perform notify_user_link(m.user_id, format('你已加入研究单元「%s」的成员名单，可使用课题「%s」的预算提交支出申请、申领资源', u.name, par.name), '#/project/' || u.id)$b$);
  if n = d or (length(n) - length(replace(n, 'notify_user_link', ''))) / length('notify_user_link') <> 3 then raise exception 'confirm_unit 没有改上'; end if;
  execute n;
end $$;
