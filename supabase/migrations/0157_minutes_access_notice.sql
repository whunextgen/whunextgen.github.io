-- 妙记取不到时自动提醒（黄济民 2026-11-27：「妙计link正则自己找不到吗？」→「Yes, both」）
--   正则能自己找到会议的妙记链接，但妙记默认只有录制人能看，正则取逐字稿会被飞书拒绝（2091005）。
--   现在：第一次被拒时，正则私信开会的人和该研讨会的组织者，请录制人把妙记共享给协助群并开放导出；
--   被拒的妙记每小时重试一次（两天内），共享之后一小时内就能取到，不必等原来的 20 小时。
create or replace function transcript_save(p_event uuid, p_source text, p_body text, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare b text := nullif(btrim(coalesce(p_body, '')), ''); t meeting_transcript; e attend_event; who uuid;
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  insert into meeting_transcript (event_id, source, body, fetched_at, tries, tried_at, note)
  values (p_event, p_source, b, case when b is not null then now() end, 1, now(), left(p_note, 300))
  on conflict (event_id) do update set source = coalesce(excluded.source, meeting_transcript.source), body = coalesce(excluded.body, meeting_transcript.body),
    fetched_at = coalesce(excluded.fetched_at, meeting_transcript.fetched_at), tries = meeting_transcript.tries + 1, tried_at = now(), note = excluded.note
  returning * into t;
  if b is null and p_source = 'feishu' and coalesce(p_note, '') like '%2091005%' and t.tries = 1 then
    select * into e from attend_event where id = p_event;
    for who in select distinct x from (select e.recorded_by x union select o.user_id from seminar_organizer o where o.seminar = e.seminar) z where x is not null loop
      perform notify_sys(who, format('妙记取不到：%s %s研讨会的飞书妙记 %s 正则没有读取权限，逐字稿取不到，没法整理会上提的质疑。请录制人（妙记的所有者）打开妙记点右上角「分享」，添加「clain协助管理群」（正则在群里）为可阅读并允许导出；共享后一小时内正则会自动取到并整理。',
        to_char(e.held_on, 'MM-DD'), coalesce((select name from seminar where code = e.seminar), ''), e.minutes_link));
    end loop;
  end if;
end $$;

create or replace function transcript_todo() returns table(event_id uuid, zoom_id text, minutes_link text) language plpgsql security definer set search_path = public as $$
begin
  if app_uid() is not null then raise exception '当前角色不能执行此操作' using errcode = '42501'; end if;
  return query select e.id, e.zoom_id, e.minutes_link from attend_event e left join meeting_transcript t on t.event_id = e.id
  where e.kind = 'seminar' and e.ended_at is not null and e.ended_at > now() - interval '4 days' and e.ended_at < now() - interval '1 hour'
    and (e.zoom_id is not null or e.minutes_link ~ '/minutes/')
    and (t.event_id is null
      or (t.body is null and t.tries < 3 and t.tried_at < now() - interval '20 hours')
      -- 妙记没共享给正则：两天内每小时再试
      or (t.body is null and t.note like '%2091005%' and t.tries < 60 and t.tried_at < now() - interval '1 hour' and e.ended_at > now() - interval '2 days'))
  order by e.ended_at desc limit 10;
end $$;
