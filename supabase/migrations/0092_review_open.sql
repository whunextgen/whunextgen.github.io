-- 评审改为全中心可见（黄济民 2026-11-25）：凡登录的中心成员都看得到各研究单元的投稿、评分、质疑和评审原文。
-- 未登录、已停用的账号仍然看不到。四个视图沿用这个函数，不必重建。
create or replace function can_see_review(p_project uuid) returns boolean language sql stable security definer set search_path = public as $$
  select app_role() is not null
$$;
