-- 没有候选时也要能知道征名是否进行中、何时截止
create view api.name_poll as
  select closes_at, name_poll_open() as open, (select count(*)::int from name_vote) as total_votes from name_poll where app_role() is not null;
grant select on api.name_poll to app_api;
