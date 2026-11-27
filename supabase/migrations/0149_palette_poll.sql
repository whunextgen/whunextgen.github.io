-- 配色投票（issue #49，黄济民 2026-11-27「第三个出几个方案，然后和名字一样发大群投票」）
--   姜玥辰反馈按钮是黑的、整体像黄历。出几套配色，全中心投票，和征名一样：每人一票，截止前可以改投，不显示谁投的。
--   候选是固定的几套（代码与页面 palettes.ts 对应），不收新提名。
create table palette_poll (id boolean primary key default true check (id), closes_at timestamptz not null);
insert into palette_poll (closes_at) values ('2026-12-04 20:00:00+08');
create table palette_option (code text primary key, name text not null, note text not null, sort int not null);
create table palette_vote (
  user_id uuid primary key references app_user(id),
  code text not null references palette_option(code),
  voted_at timestamptz not null default now());
alter table palette_poll enable row level security;
alter table palette_option enable row level security;
alter table palette_vote enable row level security;

insert into palette_option (code, name, note, sort) values
  ('ochre', '赤陶 · 现行', '现在的配色：米白底、赤陶红点缀、黑色按钮，「我的事项」卡片用宋体和纸色。', 1),
  ('azure', '晴空 · 科技蓝', '冷白底、蓝色主色和按钮，卡片换成无衬线字体和浅蓝底，清爽、偏工具感。', 2),
  ('jade', '青碧 · 墨绿', '灰白底、墨绿主色和按钮，卡片浅青底，沉稳、不刺眼。', 3),
  ('night', '夜幕 · 深色', '深色底、亮蓝主色，适合长时间看屏幕和夜里使用。', 4);

create function palette_poll_open() returns boolean language sql stable security definer set search_path = public as
$$ select now() < (select closes_at from palette_poll) $$;

create function vote_palette(p_code text) returns void language plpgsql security definer set search_path = public as $$
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if not palette_poll_open() then raise exception '配色投票已截止'; end if;
  if p_code is null then delete from palette_vote where user_id = app_uid(); return; end if;
  if not exists (select 1 from palette_option where code = p_code) then raise exception '没有这套配色'; end if;
  insert into palette_vote (user_id, code) values (app_uid(), p_code)
  on conflict (user_id) do update set code = excluded.code, voted_at = now();
end $$;
select expose('vote_palette(text)');

create view api.palette_option as
  select o.code, o.name, o.note, o.sort, (select count(*)::int from palette_vote v where v.code = o.code) as votes,
         exists (select 1 from palette_vote v where v.code = o.code and v.user_id = app_uid()) as mine,
         (select closes_at from palette_poll) as closes_at, palette_poll_open() as open,
         (select count(*)::int from palette_vote) as total_votes
  from palette_option o where app_role() is not null;
grant select on api.palette_option to app_api;
