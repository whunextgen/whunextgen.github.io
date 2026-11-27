-- 人员经费只能从已有人员档案中选人（issue #79，黄济民 2026-11-27「只能选已有档案」）
--   原来人员经费页的「新增人员」只填姓名就写进人员档案，产生没有类别、未经人事确认的档案，与「人员档案以人事登记为准」冲突；
--   「修改人员」也能在这里改档案里的姓名。现在两样都不在这里办：新人由人事在「人员档案」页登记，改名同样在那里办。
create or replace function save_person(p_id uuid, p_name text) returns uuid language plpgsql security definer set search_path = public as $$
begin
  perform need_role('finance','director');
  raise exception '人员档案由人事在「人员档案」页登记和修改；人员经费只从已有档案中选人';
end $$;
