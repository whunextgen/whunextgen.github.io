-- 学期考核：合作者只看可写短评的那几条（issue #59，黄济民 2026-11-27「只看可写短评的几条」）
--   原来同在一个课题或研究单元的合作者能看到别人完整的考核意见、改进目标和本人书面申辩，与页面「有表决权的成员和主持人看得到全部」不符。
--   现在：本人、有表决权的成员、主持人、中心负责人、考核人看全部；合作者只看到还在考核中、可以写匿名短评的条目，
--   且只有姓名、身份、方向、状态和本人短评，结论、意见、目标、申辩一律不给。

create or replace view api.term_review as
  select t.id, t.term, t.person_id, t.user_id, u.name as user_name, rank_label(user_rank(t.user_id)) as rank_label, t.track, t.status,
         case when f.full then t.conclusion end as conclusion, case when f.full then term_conclusion_label(t.conclusion) end as conclusion_label,
         case when t.conclusion is null or t.status <> 'open' or exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) or council_chair() then case when f.full then t.opinion end end as opinion,
         case when f.full then t.goals end as goals, case when f.full then t.goals_due end as goals_due, case when f.full then t.goals_met end as goals_met, case when f.full then t.goals_note end as goals_note, case when f.full then t.goals_at end as goals_at,
         case when f.full then (select name from app_user where id = t.drafted_by) end as drafted_by_name, case when f.full then t.drafted_at end as drafted_at,
         case when f.full then t.defense end as defense, case when f.full then t.defense_at end as defense_at, case when f.full then t.decided_at end as decided_at, case when f.full then t.decided_note end as decided_note,
         (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'signed', x.signed_at is not null) order by a.name), '[]')
            from term_reviewer x join app_user a on a.id = x.user_id where x.review_id = t.id) as reviewers,
         exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) as am_reviewer,
         exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid() and x.signed_at is not null) as i_signed,
         (t.user_id = app_uid()) as mine,
         (t.status = 'open' and t.user_id <> app_uid() and not exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid())
           and collaborates(app_uid(), t.user_id)) as can_comment,
         (select body from term_comment c where c.review_id = t.id and c.author_id = app_uid()) as my_comment,
         (select count(*)::int from term_comment c where c.review_id = t.id) as comment_count,
         -- 匿名短评只给考核人和主持人看，不给作者
         case when exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid()) or council_chair()
              then (select coalesce(jsonb_agg(c.body order by md5(c.author_id::text || t.id::text)), '[]') from term_comment c where c.review_id = t.id) end as comments,
         (select id from motion m where m.ref_kind = 'term_review' and m.ref_id = t.id order by m.created_at desc limit 1) as motion_id,
         (select seq from motion m where m.ref_kind = 'term_review' and m.ref_id = t.id order by m.created_at desc limit 1) as motion_seq,
         case when f.full then (select p.conclusion from term_review p where p.person_id = t.person_id and p.term < t.term order by p.term desc limit 1) end as prev_conclusion,
         case when f.full then (select p.goals_met from term_review p where p.person_id = t.person_id and p.term < t.term order by p.term desc limit 1) end as prev_goals_met,
         (t.status = 'leave_pending' and app_role() = 'director') as can_decide,
         council_chair() as can_chair
  from term_review t join app_user u on u.id = t.user_id
  cross join lateral (select (t.user_id = app_uid() or council_voter(app_uid()) or council_chair() or app_role() = 'director' or exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid())) as full) f
  where app_role() is not null and (t.user_id = app_uid() or council_voter(app_uid()) or council_chair() or app_role() = 'director'
    or exists (select 1 from term_reviewer x where x.review_id = t.id and x.user_id = app_uid())
    -- 合作者只看到还在考核、可以写匿名短评的那几条，不看考核意见、目标和申辩（#59）
    or (t.status = 'open' and collaborates(app_uid(), t.user_id)));
