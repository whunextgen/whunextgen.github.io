-- 代币的其余参数：试行期先把数定在系统里，供成员和各岗位查看；铸造相关的在转入市场经济时期后才起作用。
--   split    评定与成果的比例：每年资源容量里按档次评定发的占比，其余留给成果
--   reserve  预备占容量的比例
--   levels   成果各级的系数：一级对花掉的实际币等额、对时间打折；二、三、四级在此之上追加
--   resubmit 投稿与重投：低一档去向的折扣、每多投一轮的折扣、最多几轮、每轮追加投入不超过首轮池子的比例
--   rate     挂牌铸造率：每一点铸多少实际币；试行期为空，不铸造
--   valid    铸造所得的实际币多少个月内有效
alter table token_param drop constraint token_param_key_check;
alter table token_param add constraint token_param_key_check check (key in ('nominal', 'phase', 'split', 'reserve', 'levels', 'resubmit', 'rate', 'valid'));
insert into token_param (key, value) values
  ('split', '{"eval": 0.9}'),
  ('reserve', '0.1'),
  ('levels', '{"r1": 1.0, "t1": 0.3, "l2": 0.3, "l3": 1.0, "l4": 3.0}'),
  ('resubmit', '{"lower": 0.4, "decay": 0.8, "rounds": 3, "extra": 0.3}'),
  ('rate', 'null'),
  ('valid', '12');

create or replace function set_token_param(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare k text; v text; n numeric;
  function_keys constant jsonb := '{"levels": ["r1", "t1", "l2", "l3", "l4"], "resubmit": ["lower", "decay", "rounds", "extra"], "split": ["eval"]}';
begin
  perform need_perm('budget.approve');
  if p_key = 'nominal' then
    if jsonb_typeof(p_value) <> 'object' then raise exception '各身份的名义币格式有误'; end if;
    for k, v in select * from jsonb_each_text(p_value) loop
      if k not in ('postdoc', 'phd', 'master', 'ra', 'ri', 'visitor') then raise exception '身份有误'; end if;
      if v !~ '^\d+(\.\d+)?$' or v::numeric > 1000 then raise exception '名义币须为 0 到 1000 之间的数'; end if;
    end loop;
  elsif p_key in ('levels', 'resubmit', 'split') then
    if jsonb_typeof(p_value) <> 'object' then raise exception '参数格式有误'; end if;
    for k in select jsonb_array_elements_text(function_keys -> p_key) loop
      if not (p_value ? k) or jsonb_typeof(p_value -> k) <> 'number' then raise exception '参数不完整'; end if;
    end loop;
    if (select count(*) from jsonb_object_keys(p_value)) <> jsonb_array_length(function_keys -> p_key) then raise exception '参数有多余的项'; end if;
    if p_key = 'levels' then
      if exists (select 1 from jsonb_each_text(p_value) e where e.value::numeric < 0 or e.value::numeric > 20) then raise exception '各级系数须在 0 到 20 之间'; end if;
    elsif p_key = 'split' then
      n := (p_value ->> 'eval')::numeric;
      if n < 0.3 or n > 1 then raise exception '按档次评定发的比例须在 30%% 到 100%% 之间'; end if;
    else
      if (p_value ->> 'lower')::numeric not between 0 and 1 or (p_value ->> 'decay')::numeric not between 0 and 1 or (p_value ->> 'extra')::numeric not between 0 and 1 then
        raise exception '折扣和比例须在 0 到 1 之间';
      end if;
      if (p_value ->> 'rounds')::numeric not between 1 and 6 or (p_value ->> 'rounds')::numeric <> trunc((p_value ->> 'rounds')::numeric) then raise exception '最多投稿轮数须为 1 到 6 的整数'; end if;
    end if;
  elsif p_key = 'reserve' then
    if jsonb_typeof(p_value) <> 'number' or p_value::text::numeric not between 0 and 0.5 then raise exception '预备的比例须在 0 到 50%% 之间'; end if;
  elsif p_key = 'valid' then
    if jsonb_typeof(p_value) <> 'number' or p_value::text::numeric not between 1 and 36 then raise exception '有效期须在 1 到 36 个月之间'; end if;
  elsif p_key = 'rate' then
    if (select value from token_param where key = 'phase') = '"plan"' and jsonb_typeof(p_value) <> 'null' then raise exception '计划经济时期不铸造，挂牌铸造率须为空'; end if;
    if jsonb_typeof(p_value) not in ('null', 'number') or (jsonb_typeof(p_value) = 'number' and p_value::text::numeric <= 0) then raise exception '挂牌铸造率须大于 0'; end if;
  else
    raise exception '该参数不可在此修改';
  end if;
  update token_param set value = p_value, updated_by = app_uid(), updated_at = now() where key = p_key;
end $$;
