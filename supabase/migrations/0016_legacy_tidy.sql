-- 旧资产目录的规格型号导入时放进了编号一栏，太长；挪到备注里，编号留给资产编号。
update resource set note = left(concat_ws('；', ref, note), 300), ref = null
where legacy_id is not null and kind = 'asset' and ref is not null;
