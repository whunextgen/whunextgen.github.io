-- add_workdays 遇到空日期时死循环：d + 1 仍为空，工作日计数永远不加一。
-- 研究单元申请走在线表决、不填会议和纪要日期时，api.unit_apply 的否决期一列就是 add_workdays(空, 3)，
-- 线上目前没有这样的申请，但第一笔不填日期的申请提交后，首页、课题管理等所有列研究单元申请的页面都会卡死（演示环境里复现）。
-- 现在：日期或天数为空时返回空。
create or replace function add_workdays(p_from date, p_n integer) returns date language plpgsql immutable as $$
declare d date := p_from; k int := 0;
begin
  if p_from is null or p_n is null then return null; end if;
  while k < p_n loop
    d := d + 1;
    if extract(isodow from d) < 6 then k := k + 1; end if;
  end loop;
  return d;
end $$;
