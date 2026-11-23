-- 征名不预放候选：去掉开始时放进去的四个名字（连同投给它们的票），名字全部由成员提
delete from name_vote where option_id in (select id from name_option where proposed_by is null);
delete from name_option where proposed_by is null;
