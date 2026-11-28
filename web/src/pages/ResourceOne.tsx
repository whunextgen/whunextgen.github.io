import { useState } from 'react';
import { rpc, useViews, type Allocation, type Me, type Resource, type ResourceRequest, type ResourceStock } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, money, num, today, type Field } from '../ui';
import { ObjHead, Stages, Track } from '../tree';
import { KIND, RES_REQ, qty } from './Resource';

// 资源页：一项接口额度或资产从入库、分配、使用到盘点回收的全过程。申领的批准和分发在「资源调配」，入库、直接分配、收回和盘点在「资产盘点」
export function ResourceOne({ me, id }: { me: Me; id: string }) {
  const [act, setAct] = useState<{ title: string; hint: string; label: string; fields: Field[]; run: (v: Record<string, string>) => Promise<unknown> } | null>(null);
  const { data, error, reload } = useViews<{ res: Resource[]; allocs: Allocation[]; stock: ResourceStock[]; reqs: ResourceRequest[] }>({
    res: ['resource', { id }], allocs: ['allocation', { resource_id: id }], stock: ['resource_stock', { resource_id: id }], reqs: ['resource_request', { resource_id: id }],
  }, id);
  if (!data) return <Loading error={error} />;
  const r = data.res[0];
  if (!r) return <><div className="top"><h2>资源</h2></div><Empty>该资源不存在或无权查看。<a href="#/s-res">返回资源汇总</a></Empty></>;
  const staff = can(me, 'read.resource');
  const total = r.total != null ? num(r.total) : null, given = num(r.allocated ?? 0) + num(r.unit_granted ?? 0), used = num(r.used ?? 0);
  const cur = data.allocs.filter((a) => a.current).sort((a, b) => a.user_name.localeCompare(b.user_name, 'zh'));
  const past = data.allocs.filter((a) => !a.current).sort((a, b) => (b.returned_on ?? b.to_date ?? '').localeCompare(a.returned_on ?? a.to_date ?? ''));
  const stock = [...data.stock].sort((a, b) => b.received_on.localeCompare(a.received_on));
  const reqs = [...data.reqs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const asking = reqs.filter((q) => ['pending', 'reviewed', 'approved'].includes(q.status));
  const spec = [r.provider, r.model, r.category, r.spec].filter(Boolean).join(' · ');
  const at = !r.active ? 6 : cur.length > 0 ? 3 : stock.length > 0 || total != null ? 2 : 1;
  return (
    <div className="wb obj">
      <ObjHead crumb={<>{staff ? <><a href="#/s-res">财务 › 资源</a> › <a href="#/stock">资产盘点</a></> : <a href="#/resource">资源申领</a>} › {r.name}</>}
        eyebrow={['资源', KIND[r.kind], spec].filter(Boolean).join(' · ')} title={r.name} badge={r.active ? <Badge tone="ok">在用</Badge> : <Badge>已停用</Badge>}
        label={total != null ? '未分配' : '已分配'} value={total != null ? qty(total - given, r.unit) : qty(given, r.unit)} neg={total != null && total - given < 0}
        chart={total != null && total > 0 ? <Track cap="分配情况 · 已分配与未分配" segs={[
          { cls: 'sa big', value: Math.min(given, total), text: `已分配 ${qty(given, r.unit)}`, tip: `已分配 ${qty(given, r.unit)}` },
          { cls: 'sr big', value: Math.max(total - given, 0), text: `未分配 ${qty(total - given, r.unit)}`, tip: `未分配 ${qty(total - given, r.unit)}` }]} />
          : <Empty>该资源未设总量，按实际分配记录。</Empty>}
        facts={[['总量', total != null ? qty(total, r.unit) : '未设'], ['已分配', qty(given, r.unit)], ...(num(r.unit_granted) > 0 ? [['其中换给研究单元', qty(r.unit_granted ?? null, r.unit)] as [string, string]] : []), ['当前持有', `${cur.length} 人`], ...(r.kind === 'api' ? [['已使用', qty(used, r.unit)] as [string, string]] : []),
          ...(r.balance != null ? [['账户余额', `${num(r.balance).toLocaleString('zh-CN')}${r.currency ? ` ${r.currency}` : ''}${r.balance_on ? `（${day(r.balance_on)}）` : ''}`] as [string, string]] : []),
          ...(r.fx_rate != null ? [['折算汇率', `1 ${r.unit} = ${num(r.fx_rate)} 元${r.fx_on ? `（${day(r.fx_on)}）` : ''}`] as [string, string]] : []),
          ...(r.unit_price != null ? [['单价', money(r.unit_price)] as [string, string]] : []), ...(r.location ? [['存放地点', r.location] as [string, string]] : [])]} />
      <Stages path="入库 › 申领 › 分配 › 使用与盘点 › 回收" at={at} items={[
        { nm: '入库', ds: r.kind === 'api' ? '购置或充值后登记' : '购置验收后登记', v: `${stock.length} 次`, f: stock[0] ? `最近 ${day(stock[0].received_on)}` : '暂无入库记录' },
        { nm: '申领', ds: '研究单元成员提出申领', v: `${reqs.length} 笔`, f: asking.length ? `${asking.length} 笔在办` : '暂无在办的申领' },
        { nm: '分配', ds: r.kind === 'api' ? '发放额度和密钥' : '交付并登记持有人', v: `${cur.length} 人持有`, f: `已分配 ${qty(given, r.unit)}` },
        { nm: '使用与盘点', ds: '定期登记用量、盘点在位', v: r.kind === 'api' ? qty(used, r.unit) : `${cur.length} 件在位`, f: r.balance_on ? `${day(r.balance_on)} 登记余额` : r.kind === 'api' ? '已使用' : '按年盘点' },
        { nm: '回收', ds: '到期或离岗后回收', v: `${past.length} 次`, f: r.active ? '' : '该资源已停用' },
      ]} />

      <section className="card">
        <h3>当前分配 <span className="h3sub">{cur.length} 人</span></h3>
        {cur.length === 0 ? <Empty>当前没有分配给任何人。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>持有人</th><th className="r">{r.kind === 'api' ? '额度' : '数量'}</th><th style={{ minWidth: 180 }}>使用</th><th>起止</th><th>说明</th></tr></thead>
            <tbody>{cur.map((a) => { const q = num(a.quota ?? 0), u = num(a.used ?? 0); return (
              <tr key={a.id}><td>{a.user_name}</td><td className="r">{qty(a.quota, r.unit)}</td>
                <td>{r.kind === 'api' && q > 0 ? <Track segs={[{ cls: 'sa', value: Math.min(u, q), tip: `已使用 ${qty(u, r.unit)}` }, { cls: 'sr', value: Math.max(q - u, 0), tip: `剩余 ${qty(q - u, r.unit)}` }]} /> : <span className="sub2">{a.asset_no ? `资产编号 ${a.asset_no}` : '—'}</span>}</td>
                <td>{day(a.from_date)}{a.to_date ? ` 至 ${day(a.to_date)}` : ' 起'}</td><td className="wrap">{[a.location, a.note].filter(Boolean).join(' · ') || '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
        {staff && <p className="hint">申领的批准和分发在「<a href="#/pool">资源调配</a>」办理；入库、直接分配、调整和收回、盘点在「<a href="#/stock">资产盘点</a>」办理。</p>}
      </section>

      <section className="card">
        <h3>申领记录 <span className="h3sub">{reqs.length} 笔</span></h3>
        {reqs.length === 0 ? <Empty>暂无申领记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>提交日期</th><th>申请人</th><th>研究单元</th><th className="r">申领</th><th>用途</th><th>状态</th></tr></thead>
            <tbody>{reqs.map((q) => <tr key={q.id}><td>{day(q.created_at)}</td><td>{q.requester_name}</td><td>{q.project_name ?? '—'}</td><td className="r">{qty(q.amount, q.unit)}</td>
              <td className="wrap">{q.purpose}</td><td><Badge tone={RES_REQ[q.status][1]}>{RES_REQ[q.status][0]}</Badge></td></tr>)}</tbody>
          </table></div>
        )}
      </section>

      {staff && (
        <section className="card">
          <h3>入库记录 <span className="h3sub">{stock.length} 次</span></h3>
          {/* 期初余额（0170）：旧门户、往年充值剩下的，按平台后台余额录一次；外币计价的填折算汇率，申请和发放按该单位 */}
          {can(me, 'resource.manage') && r.kind === 'api' && <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
            {!stock.some((s) => s.source === 'opening') && <button className="sm" onClick={() => setAct({ title: `录入期初余额：${r.name}`, label: '录入',
              hint: '按平台后台显示的账户余额录一次，作为这项额度的期初库存，之后的充值按支出入库。平台按美元等外币计价的，计价单位填该外币并填折算汇率（1 单位合多少元，按市场汇率），之后的申请、批准、发放和密钥额度都按这个单位；和课题预算比时按汇率折人民币。已有在办申请或在用额度的，不能改计价单位。',
              fields: [{ name: 'qty', label: '平台账户余额', type: 'number' }, { name: 'unit', label: '计价单位（如 美元、元）', value: r.unit && r.unit !== 'CNY' ? r.unit : '美元' }, { name: 'fx', label: '折算汇率：1 单位合多少元（人民币计价的留空）', type: 'number', required: false },
                { name: 'on', label: '截至日期', type: 'date', value: today() }, { name: 'note', label: '来源（如：旧门户充值和 11-26 入账的充值，截至平台后台余额）' }],
              run: (v) => rpc('stock_opening', { resource: r.id, qty: v.qty, on: v.on, unit: v.unit, fx: v.fx || null, note: v.note }) })}>录入期初余额</button>}
            {r.fx_rate != null && <button className="sm ghost" onClick={() => setAct({ title: `更新折算汇率：${r.name}`, label: '保存', hint: `现行 1 ${r.unit} = ${num(r.fx_rate)} 元。按市场汇率更新，只影响此后和课题预算的折算。`,
              fields: [{ name: 'fx', label: `1 ${r.unit} 合多少元`, type: 'number', value: String(num(r.fx_rate)) }], run: (v) => rpc('set_resource_fx', { resource: r.id, fx: v.fx }) })}>更新汇率</button>}
          </div>}
          {stock.length === 0 ? <Empty>暂无入库记录。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>入库日期</th><th className="r">数量</th><th className="r">单价</th><th>供应方</th><th>出资</th><th>说明</th></tr></thead>
              <tbody>{stock.map((s) => <tr key={s.id}><td>{day(s.received_on)}</td><td className="r">{qty(s.qty, r.unit)}</td><td className="r">{s.unit_price != null ? money(s.unit_price) : '—'}</td><td>{s.supplier ?? '—'}</td>
                <td>{s.source === 'opening' ? <Badge>期初余额</Badge> : s.expense_request_id ? <a href={`#/req/${s.expense_request_id}`}>{s.project_name ?? '支出申请'}{s.line_purpose ? ` · ${s.line_purpose}` : ''}</a> : s.project_name ?? '—'}</td><td className="wrap">{s.note ?? '—'}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
      )}

      {past.length > 0 && (
        <section className="card">
          <h3>已回收的分配 <span className="h3sub">{past.length} 次</span></h3>
          <div className="scroll"><table>
            <thead><tr><th>持有人</th><th className="r">{r.kind === 'api' ? '额度' : '数量'}</th><th>起止</th><th>回收日期</th></tr></thead>
            <tbody>{past.map((a) => <tr key={a.id}><td>{a.user_name}</td><td className="r">{qty(a.quota, r.unit)}</td><td>{day(a.from_date)}{a.to_date ? ` 至 ${day(a.to_date)}` : ''}</td><td>{a.returned_on ? day(a.returned_on) : '—'}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
