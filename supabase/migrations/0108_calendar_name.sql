-- 中心日历可以填日历的名称（如「CLAIN日历」）：公开日历由正则按名称搜到编号，不必去找内部编号
create or replace function set_center_calendar(p_id text) returns void language plpgsql security definer set search_path = public as $$
declare v text := nullif(btrim(coalesce(p_id, '')), '');
begin
  if app_role() is distinct from 'director' then raise exception '由中心负责人填写' using errcode = '42501'; end if;
  if v is not null and (length(v) > 200 or v ~ '[[:cntrl:]]') then raise exception '日历名称或编号格式不对'; end if;
  update path_param set value = to_jsonb(v) where key = 'calendar_id';
end $$;
