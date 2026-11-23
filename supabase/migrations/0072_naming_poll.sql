-- 中台征名：成员可以提名字，也可以给已有的名字投票，每人一票，截止前可以改投。
-- 页面和接口都不给出谁提的、谁投的；库里记账号只为每人一票和限制提名数量。
create table name_poll (id boolean primary key default true check (id), closes_at timestamptz not null);
insert into name_poll (closes_at) values ('2026-11-23 20:00:00+08');
create table name_option (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  note text,
  proposed_by uuid references app_user(id),
  created_at timestamptz not null default now());
create table name_vote (
  user_id uuid primary key references app_user(id),
  option_id uuid not null references name_option(id),
  voted_at timestamptz not null default now());
alter table name_poll enable row level security;
alter table name_option enable row level security;
alter table name_vote enable row level security;

insert into name_option (name, note) values
  ('灵均', '《离骚》「名余曰正则兮，字余曰灵均」。屈原的字；均，调也。取分配均平、调度得当之意。'),
  ('正则', '《离骚》「名余曰正则兮，字余曰灵均」。屈原的名；正，平也，则，法也。取公平、有章法之意。'),
  ('绳墨', '《离骚》「背绳墨以追曲兮」。木工取直的墨线，指规矩和准绳。'),
  ('望舒', '《离骚》「前望舒使先驱兮」。为月驾车、在前开路的神，取先行引路之意。');

create function name_poll_open() returns boolean language sql stable security definer set search_path = public as
$$ select now() < (select closes_at from name_poll) $$;

create function propose_name(p_name text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, '')); t text := nullif(btrim(coalesce(p_note, '')), ''); oid uuid;
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if not name_poll_open() then raise exception '征名已截止'; end if;
  if n = '' then raise exception '请填写名字'; end if;
  if length(n) > 8 then raise exception '名字不得超过 8 个字'; end if;
  if t is null then raise exception '请填写出处或寓意'; end if;
  if length(t) > 200 then raise exception '出处或寓意不得超过 200 个字'; end if;
  if exists (select 1 from name_option where name = n) then raise exception '已有「%」这个名字，可以直接投票', n; end if;
  if (select count(*) from name_option where proposed_by = app_uid()) >= 3 then raise exception '每人最多提 3 个名字'; end if;
  insert into name_option (name, note, proposed_by) values (n, t, app_uid()) returning id into oid;
  return oid;
end $$;

create function vote_name(p_option uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_role() is null then raise exception '请先登录' using errcode = '42501'; end if;
  if not name_poll_open() then raise exception '征名已截止'; end if;
  if p_option is null then delete from name_vote where user_id = app_uid(); return; end if;
  if not exists (select 1 from name_option where id = p_option) then raise exception '没有这个名字'; end if;
  insert into name_vote (user_id, option_id) values (app_uid(), p_option)
  on conflict (user_id) do update set option_id = excluded.option_id, voted_at = now();
end $$;
select expose('propose_name(text, text)', 'vote_name(uuid)');

create view api.name_option as
  select o.id, o.name, o.note, o.created_at, (select count(*)::int from name_vote v where v.option_id = o.id) as votes,
         exists (select 1 from name_vote v where v.option_id = o.id and v.user_id = app_uid()) as mine,
         (select closes_at from name_poll) as closes_at, name_poll_open() as open,
         (select count(*)::int from name_vote) as total_votes
  from name_option o where app_role() is not null;
grant select on api.name_option to app_api;
