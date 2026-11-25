-- 录音补漏改为每天跑一次（黄济民 2026-11-26「会议结束取一次就行，一天跑一次」）：
-- 每天凌晨 4 点取散会的研讨会的逐字稿，每场会取到一次即止；妙记还没生成、取不到的，第二天再试，最多 3 天
create or replace function transcript_todo() returns table (event_id uuid, zoom_id text, minutes_link text)
language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select e.id, e.zoom_id, e.minutes_link from attend_event e left join meeting_transcript t on t.event_id = e.id
  where e.kind = 'seminar' and e.ended_at is not null and e.ended_at > now() - interval '4 days' and e.ended_at < now() - interval '1 hour'
    and (e.zoom_id is not null or e.minutes_link ~ '/minutes/')
    and (t.event_id is null or (t.body is null and t.tries < 3 and t.tried_at < now() - interval '20 hours'))
  order by e.ended_at desc limit 10;
end $$;

-- 提取质疑用的模型：「资源」里登记的、名为「录音补漏」的在用 API 资源（服务商、模型、备注里的接口地址），密钥按资源单独加密保存；
-- 由定时任务取用，每次取用记入密钥取用记录
create function transcript_llm() returns table (id uuid, provider text, model text, ref text, note text, cipher text)
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  select x.id, x.provider, x.model, x.ref, x.note, s.cipher into r from resource x join secret s on s.owner_kind = 'resource' and s.owner_id = x.id
  where x.kind = 'api' and x.active and x.name = '录音补漏' limit 1;
  if r.id is null then return; end if;
  insert into secret_access (owner_kind, owner_id, user_id) values ('resource', r.id, null);
  return query select r.id, r.provider, r.model, r.ref, r.note, r.cipher;
end $$;
