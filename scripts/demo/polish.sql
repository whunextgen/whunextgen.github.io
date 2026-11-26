-- 演示数据整理：测试跑完的数据库里，账号、课题、经费卡多是测试用的名字（「冒名」「旧账号」「测试卡改名」），
-- 截图前换成虚构的正常名称。全部为虚构，与中心真实人员、课题、经费无关。
reset role;

-- 主要角色的演示账号
update app_user set name = '周明远' where name = '负责人' and role = 'director';
update app_user set name = '林知行' where name = '项目负责人';
update app_user set name = '何静' where name = '财务岗' and role = 'finance';
update app_user set name = '唐书言' where name = '成员乙';
update app_user set name = '许若溪' where name = '成员甲';
update app_user set name = '陆一帆' where name = '普通成员';
update app_user set name = '沈可' where name = '助理';
update app_user set name = '苏晴' where name = '另一位成员';
update app_user set name = '韩立' where name = '评审成员';
-- 其余账号依次换成虚构人名
with n as (select id, row_number() over (order by created_at, id) i from app_user
           where name not in ('周明远','林知行','何静','唐书言','许若溪','陆一帆','沈可','苏晴','韩立')),
     pool as (select i, x from unnest(array['赵晨','钱逸','孙悦','李航','吴桐','郑岚','王朔','冯远','陈默','褚青','卫东','蒋南','韩雪','杨帆','朱琳','秦川',
       '尤佳','何畅','吕方','施然','张弛','孔令','曹宁','严歌','华章','金石','魏然','陶然','姜禾','戚远','谢安','邹平','喻言','柏舟','水清','窦宁']) with ordinality t(x, i))
update app_user u set name = pool.x from n join pool on pool.i = n.i where u.id = n.id;
update person p set name = u.name from app_user u where u.id = p.user_id;

-- 人事和资源岗的授权
insert into rbac_grant (user_id, role_id, from_date, note)
select u.id, r.id, current_date, '演示' from app_user u, rbac_role r where u.name = '苏晴' and r.code = 'hr'
  and not exists (select 1 from rbac_grant g where g.user_id = u.id and g.role_id = r.id);
insert into rbac_grant (user_id, role_id, from_date, note)
select u.id, r.id, current_date, '演示' from app_user u, rbac_role r where u.name = '韩立' and r.code = 'resource_admin'
  and not exists (select 1 from rbac_grant g where g.user_id = u.id and g.role_id = r.id);
update person set rank = 'assistant' where name = '苏晴';
update person set rank = 'researcher' where name = '韩立';

-- 课题和研究单元
update project set name = case code
  when 'P-01-01' then '触觉反馈下的抓取策略'
  when 'P-01-02' then '跨场景操作泛化'
  when 'P-01-03' then '具身任务基准构建'
  when 'P-09-01' then '大模型评测基准的可信度'
  when 'P-10' then '医学影像报告生成'
  when 'P-11' then '人机协作中的认知负荷'
  when 'P-T1' then '长程智能体的记忆机制'
  when 'P-T1-01' then '记忆检索的评测'
  when 'P-T1-02' then '情景记忆压缩'
  when 'P-T1-03' then '记忆写入策略'
  when 'P-T1-04' then '长对话一致性'
  else name end;

-- 经费卡
update fund_card set name = case name
  when '测试卡改名' then '横向合作项目'
  when '散卡' then '校级专项'
  when '散卡二项目' then '校级专项二期'
  when '结转在后' then '基础研究项目'
  when '上缴样例项目' then '学科建设项目'
  when '海外样例项目' then '国际合作项目'
  when '在途样例项目' then '青年基金项目'
  when '改回样例项目' then '面上基金项目'
  else name end;

-- 测试数据里只有 2029 年度已下达，日历上不是当年；把这一年已提交的课题预算标为按课题下达，成员才能演示提交支出申请
update project_budget set issued_at = now(), issue_note = '演示' where year = 2029 and status = 'submitted' and issued_at is null;

-- 中心助理的授权在测试数据里自 2032 年起生效；演示环境改为自今天起
update rbac_grant g set from_date = current_date from app_user u, rbac_role r
where g.user_id = u.id and g.role_id = r.id and u.name = '沈可' and r.code = 'assistant' and g.from_date > current_date;
