import { useViews, type Allocation, type Me, type Resource, type ResourceRequest, type ResourceStock } from '../api';
import { Badge, Empty, Loading, can, day, money, num } from '../ui';
import { ObjHead, Stages, Track } from '../tree';
import { KIND, RES_REQ, qty } from './Resource';

// 资源页：一项接口额度或资产从入库、分配、使用到盘点回收的全过程。分配、回收和入库在「资源调配」「资产盘点」办理
export function ResourceOne({ me, id }: { me: Me; id: string }) {
  const { data, error } = useViews<{ res: Resource[]; allocs: Allocation[]; stock: ResourceStock[]; reqs: ResourceRequest[] }>({
    res: ['resource', { id }], allocs: ['allocation', { resource_id: id }], stock: ['resource_stock', { resource_id: id }], reqs: ['resource_request', { resource_id: id }],
  }, id);
  if (!data) return <Loading error={error} />;
  const r = data.res[0];
  if (!r) return <><div className="top"><h2>资源</h2></div><Empty>该资源不存在或无权查看。<a href="#/s-res">返回资源汇总</a></Empty></>;
  const staff = can(me, 'read.resource');
  const total = r.total != null ? num(r.total) : null, given = num(r.allocated ?? 0), used = num(r.used ?? 0);
  const cur = data.allocs.filter((a) => a.current).sort((a, b) => a.user_name.localeCompare(b.user_name, 'zh'));
  const past = data.allocs.filter((a) => !a.current).sort((a, b) => (b.returned_on ?? b.to_date ?? '').localeCompare(a.returned_on ?? a.to_date ?? ''));
  const stock = [...data.stock].sort((a, b) => b.received_on.localeCompare(a.received_on));
  const reqs = [...data.reqs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const asking = reqs.filter((q) => ['pending', 'reviewed', 'approved'].includes(q.status));
  const spec = [r.provider, r.model, r.category, r.spec].filter(Boolean).join(' · ');
  const at = !r.active ? 6 : cur.length > 0 ? 3 : stock.length > 0 || total != null ? 2 : 1;
  return (
    <div className="wb obj">
      <ObjHead crumb={<>{staff ? <><a href="#/s-res">财务 › 资源</a> › <a href="#/pool">资源调配</a></> : r.kind === 'asset' ? <a href="#/equipment">设备申领</a> : <a href="#/resource">接口额度申领</a>} › {r.name}</>}
        eyebrow={['资源', KIND[r.kind], spec].filter(Boolean).join(' · ')} title={r.name} badge={r.active ? <Badge tone="ok">在用</Badge> : <Badge>已停用</Badge>}
        label={total != null ? '未分配' : '已分配'} value={total != null ? qty(total - given, r.unit) : qty(given, r.unit)} neg={total != null && total - given < 0}
        chart={total != null && total > 0 ? <Track cap="分配情况 · 已分配与未分配" segs={[
          { cls: 'sa big', value: Math.min(given, total), text: `已分配 ${qty(given, r.unit)}`, tip: `已分配 ${qty(given, r.unit)}` },
          { cls: 'sr big', value: Math.max(total - given, 0), text: `未分配 ${qty(total - given, r.unit)}`, tip: `未分配 ${qty(total - given, r.unit)}` }]} />
          : <Empty>该资源未设总量，按实际分配记录。</Empty>}
        facts={[['总量', total != null ? qty(total, r.unit) : '未设'], ['已分配', qty(given, r.unit)], ['当前持有', `${cur.length} 人`], ...(r.kind === 'api' ? [['已使用', qty(used, r.unit)] as [string, string]] : []),
          ...(r.balance != null ? [['账户余额', `${num(r.balance).toLocaleString('zh-CN')}${r.currency ? ` ${r.currency}` : ''}${r.balance_on ? `（${day(r.balance_on)}）` : ''}`] as [string, string]] : []),
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
        {staff && <p className="hint">分配、调整和回收在「<a href="#/pool">资源调配</a>」办理{r.kind === 'asset' ? '，盘点在「' : ''}{r.kind === 'asset' && <a href="#/stock">资产盘点</a>}{r.kind === 'asset' ? '」办理' : ''}。</p>}
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
          {stock.length === 0 ? <Empty>暂无入库记录。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>入库日期</th><th className="r">数量</th><th className="r">单价</th><th>供应方</th><th>出资</th><th>说明</th></tr></thead>
              <tbody>{stock.map((s) => <tr key={s.id}><td>{day(s.received_on)}</td><td className="r">{qty(s.qty, r.unit)}</td><td className="r">{s.unit_price != null ? money(s.unit_price) : '—'}</td><td>{s.supplier ?? '—'}</td>
                <td>{s.expense_request_id ? <a href={`#/req/${s.expense_request_id}`}>{s.project_name ?? '支出申请'}{s.line_purpose ? ` · ${s.line_purpose}` : ''}</a> : s.project_name ?? '—'}</td><td className="wrap">{s.note ?? '—'}</td></tr>)}</tbody>
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
    </div>
  );
}
