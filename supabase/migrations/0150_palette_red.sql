-- 配色投票改为四套都以红色为主色（黄济民 2026-11-27：「红色必须是主色？」→ 选「红色保留为主色」）
--   标志是红底甲骨文「正」，主色与标志一致；四套的区别在底色、按钮、侧栏和字体。投票尚未有人投（0 票），直接换候选。
delete from palette_vote where code in ('azure', 'jade', 'night');
delete from palette_option where code in ('azure', 'jade', 'night');
update palette_option set note = '现在的配色：米白底、赤陶红点缀、黑色按钮，「我的事项」卡片用宋体和纸色。' where code = 'ochre';
insert into palette_option (code, name, note, sort) values
  ('vermilion', '朱红 · 冷白', '冷白底、朱红按钮，「我的事项」卡片换成白底和无衬线字体，去掉纸色和宋体，清爽现代。', 2),
  ('inkside', '朱红 · 墨侧栏', '同「朱红 · 冷白」，侧栏换成深色，导航和内容分得更开。', 3),
  ('night', '朱红 · 深色', '深色底、朱红点缀，适合长时间看屏幕和夜里使用。', 4);
