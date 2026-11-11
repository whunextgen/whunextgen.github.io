import { useState } from 'react';
import { rpc, useViews, type Allocation, type Me, type Resource, type User } from '../api';
import { LegacyResource } from './Legacy';
import { ActionDialog, Badge, Empty, Loading, day, num, today, type Field } from '../ui';

interface Act { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const KIND: Record<string, string> = { api: '接口配额', asset: '资产' };
const qty = (v: string | null, unit: string | null) => (v == null ? '—' : `${num(v).toLocaleString('zh-CN')}${unit ? ` ${unit}` : ''}`);

// 资源使用权：谁在用哪个接口配额、哪台设备。密钥本身不进系统，这里只记保管库编号或掩码。
export function ResourcePage({ me }: { me: Me }) {
  const staff = me.role === 'finance' || me.role === 'director';
  const { data, error, reload } = useViews<{ resources: Resource[]; allocs: Allocation[]; users: User[] }>({
    resources: ['resource'], allocs: ['allocation'], users: ['users'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [past, setPast] = useState(false);
  if (!data) return <Loading error={error} />;

  const users = data.users.filter((u) => u.active).map((u): [string, string] => [u.id, u.name]);
  const mine = data.allocs.filter((a) => a.user_id === me.id && a.current);
  const shown = data.allocs.filter((a) => past || a.current).sort((a, b) => Number(b.current) - Number(a.current) || b.from_date.localeCompare(a.from_date));
  const resAct = (r?: Resource): Act => ({
    label: r ? '修改' : '登记资源', title: r ? `修改资源：${r.name}` : '登记资源',
    hint: '接口配额填总量和单位（例如 元/月、万 token）。资产分两种：单件的（一台设备）不填总量，一次只能在一个人名下；成批的（同一型号多件）填库存数量，按件发给多人。编号一栏只填保管库里的编号或掩码，不要填密钥本身。',
    fields: [...(r ? [] : [{ name: 'kind', label: '类型', options: Object.entries(KIND) } as Field]), { name: 'name', label: '名称', value: r?.name },
      { name: 'ref', label: '编号或掩码（可不填）', required: false, value: r?.ref ?? '' },
      { name: 'total', label: '总配额或库存数量（不限量、单件资产不填）', type: 'number', required: false, value: r?.total != null ? String(num(r.total)) : '' },
      { name: 'unit', label: '单位（可不填）', required: false, value: r?.unit ?? '' }, { name: 'note', label: '备注（可不填）', required: false, value: r?.note ?? '' },
      ...(r ? [{ name: 'active', label: '在用（取消勾选即停用，不能再分配）', type: 'check', value: String(r.active) } as Field] : [])],
    run: (v) => rpc('save_resource', { id: r?.id ?? null, kind: r?.kind ?? v.kind, name: v.name, ref: v.ref, total: v.total, unit: v.unit, note: v.note, active: r ? v.active === 'true' : true }),
  });
  const giveAct = (r: Resource): Act => ({
    label: '分配', title: `分配：${r.name}`,
    hint: r.total != null ? `${r.kind === 'asset' ? '库存' : '总配额'} ${qty(r.total, r.unit)}，已分出 ${qty(r.allocated, r.unit)}。` : r.kind === 'asset' ? '资产一次只能在一个人名下，换人前先登记归还。' : undefined,
    fields: [{ name: 'user_id', label: '使用人', options: users },
      ...(r.kind === 'api' ? [{ name: 'quota', label: `配额${r.unit ? `（${r.unit}）` : ''}`, type: 'number', required: r.total != null } as Field]
        : r.total != null ? [{ name: 'quota', label: `数量${r.unit ? `（${r.unit}）` : ''}`, type: 'number', value: '1' } as Field] : []),
      { name: 'from_date', label: '起始日', type: 'date', value: today() }, { name: 'to_date', label: '到期日（长期的不填）', type: 'date', required: false },
      { name: 'note', label: '用途（可不填）', required: false }],
    run: (v) => rpc('allocate_resource', { resource_id: r.id, user_id: v.user_id, quota: v.quota ?? null, from_date: v.from_date, to_date: v.to_date, note: v.note }),
  });

  return (
    <>
      <div className="top"><h2>资源使用权</h2>
        {staff && <button onClick={() => setAct(resAct())}>登记资源</button>}</div>

      <section className="card">
        <h3>我名下的资源</h3>
        <p className="hint">接口密钥本身不在这个系统里，由财务岗从保管库单独发放；这里只记谁有使用权、配额多少、到什么时候。</p>
        {mine.length === 0 ? <Empty>你名下现在没有资源。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>资源</th><th>类型</th><th>编号</th><th className="r">配额</th><th>起始</th><th>到期</th><th>用途</th></tr></thead>
            <tbody>{mine.map((a) => (
              <tr key={a.id}><td>{a.resource_name}</td><td>{KIND[a.kind]}</td><td className="code">{a.ref ?? '—'}</td><td className="r">{qty(a.quota, a.unit)}</td>
                <td>{day(a.from_date)}</td><td>{a.to_date ? day(a.to_date) : '长期'}</td><td className="wrap">{a.note ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {staff && (
        <>
          <section className="card">
            <h3>资源</h3>
            {data.resources.length === 0 ? <Empty>还没有登记资源。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>名称</th><th>类型</th><th>编号</th><th className="r">总配额 / 库存</th><th className="r">已分出</th><th className="r">在用人数</th><th>状态</th><th /></tr></thead>
                <tbody>{[...data.resources].sort((a, b) => Number(b.active) - Number(a.active) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh')).map((r) => (
                  <tr key={r.id}><td>{r.name}{r.note && <div className="sub2">{r.note}</div>}</td><td>{KIND[r.kind]}</td><td className="code">{r.ref ?? '—'}</td>
                    <td className="r">{r.total == null ? (r.kind === 'asset' ? '单件' : '不限') : qty(r.total, r.unit)}</td><td className="r">{r.kind === 'api' || r.total != null ? qty(r.allocated, r.unit) : '—'}</td><td className="r">{r.holders}</td>
                    <td>{r.active ? <Badge tone="ok">在用</Badge> : <Badge>已停用</Badge>}</td>
                    <td><div className="acts">{r.active && <button className="sm ghost" onClick={() => setAct(giveAct(r))}>分配</button>}
                      <button className="sm ghost" onClick={() => setAct(resAct(r))}>修改</button></div></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section className="card">
            <h3>分配记录</h3>
            <div className="tabs" style={{ marginBottom: 12 }}>
              <button className="sm" aria-pressed={!past} onClick={() => setPast(false)}>在用 {data.allocs.filter((a) => a.current).length}</button>
              <button className="sm" aria-pressed={past} onClick={() => setPast(true)}>全部 {data.allocs.length}</button>
            </div>
            {shown.length === 0 ? <Empty>没有分配记录。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>资源</th><th>使用人</th><th className="r">配额</th><th>起始</th><th>到期</th><th>用途</th><th>状态</th><th /></tr></thead>
                <tbody>{shown.map((a) => (
                  <tr key={a.id}><td>{a.resource_name}</td><td>{a.user_name}</td><td className="r">{qty(a.quota, a.unit)}</td><td>{day(a.from_date)}</td>
                    <td>{a.to_date ? day(a.to_date) : '长期'}</td><td className="wrap">{a.note ?? '—'}</td>
                    <td>{a.returned_on ? <Badge>{day(a.returned_on)} 收回</Badge> : a.current ? <Badge tone="ok">在用</Badge> : <Badge tone="warn">已到期</Badge>}</td>
                    <td><div className="acts">{!a.returned_on && <button className="sm ghost" onClick={() => setAct({ label: '收回', title: `收回：${a.resource_name}`,
                      hint: `${a.user_name} 名下的使用权到收回日为止。接口密钥要另外在服务商那边停用或轮换。`,
                      fields: [{ name: 'returned_on', label: '收回日', type: 'date', value: today() }], run: (v) => rpc('return_allocation', { id: a.id, returned_on: v.returned_on }) })}>收回</button>}</div></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
      <LegacyResource />
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
