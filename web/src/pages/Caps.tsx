import { useState } from 'react';
import { rpc, useViews, type BudgetYear, type CapRequest, type Me, type Project, type ProjectCap } from '../api';
import { ActionDialog, Badge, Empty, Loading, Tile, can, day, money, num, pct, type Field } from '../ui';
import { STAGE_TEXT } from './Budget';

export interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
export const TIERS = '1 千、5 千、2 万、5 万、20 万、50 万，50 万以上按实际数填';
export const CAP_REQ: Record<string, [string, string]> = { pending: ['等中心负责人批', 'warn'], approved: ['已同意', 'ok'], rejected: ['没同意', 'bad'] };
export const capped = (r: Project) => r.layer !== 'paper' && r.kind !== 'public';

// 定上限、申请提高上限：上限页和项目页共用
export const capAct = (r: Project, year: number, c?: ProjectCap): Act => ({ title: `${year} 年度上限：${r.name}`, submitLabel: '保存',
  hint: `大项目连同它下面的论文项目，这一年的预算合计不能超过上限。按档定：${TIERS}。${c ? `现在的上限 ${money(c.amount)}，已经排进预算 ${money(c.used)}，新的上限不能低于这个数。留空保存就是取消上限。` : ''}各大项目上限合计不能超过年度总预算。`,
  fields: [{ name: 'amount', label: '上限（元）', type: 'number', required: !c, value: c ? String(num(c.amount)) : '' }],
  run: (v) => rpc('set_project_cap', { year, project_id: r.id, amount: v.amount || null }) });
export const askAct = (r: Project, year: number, c: ProjectCap): Act => ({ title: `申请提高 ${year} 年度上限：${r.name}`, submitLabel: '提交申请',
  hint: `现在的上限 ${money(c.amount)}，已经排进预算 ${money(c.used)}。新的上限按档填：${TIERS}。提交后由中心负责人批，批之前上限不变。`,
  fields: [{ name: 'amount', label: '想提到多少（元）', type: 'number' }, { name: 'reason', label: '理由（为什么不够、多出来的钱做什么）', type: 'area' }],
  run: (v) => rpc('request_cap', { year, project_id: r.id, amount: v.amount, reason: v.reason }) });

// 提高上限的申请：中心负责人在这里同意或不同意
export function CapReqTable({ rows, director, setAct, withProject }: { rows: CapRequest[]; director: boolean; setAct: (a: Act) => void; withProject?: boolean }) {
  return (
    <div className="scroll"><table>
      <thead><tr><th>提交</th>{withProject && <th>项目</th>}<th>年度</th><th className="r">想提到</th><th>理由</th><th>状态</th><th /></tr></thead>
      <tbody>{rows.map((x) => (
        <tr key={x.id}><td>{day(x.created_at)}<span className="sub2">{x.requester_name ?? ''}</span></td>{withProject && <td><a href={`#/project/${x.project_id}`}>{x.project_name}</a></td>}<td>{x.year}</td>
          <td className="r">{money(x.amount)}{x.status === 'pending' && <div className="sub2">现在 {money(x.cap)}</div>}</td>
          <td className="wrap">{x.reason}{x.decide_note && <div className="sub2">批示：{x.decide_note}</div>}</td>
          <td><Badge tone={CAP_REQ[x.status][1]}>{CAP_REQ[x.status][0]}</Badge></td>
          <td className="r"><div className="acts">{director && x.status === 'pending' && <>
            <button className="sm" onClick={() => setAct({ title: `同意提高上限：${x.project_name} ${x.year} 年度`, submitLabel: '同意',
              hint: `${x.requester_name ?? '负责人'} 申请从 ${money(x.cap)} 提到 ${money(x.amount)}。理由：${x.reason}。可以批一个比申请少的数，按档填：${TIERS}。`,
              fields: [{ name: 'amount', label: '批准的上限（元）', type: 'number', value: String(num(x.amount)) }, { name: 'note', label: '批示（可不填）', required: false }],
              run: (v) => rpc('decide_cap_request', { id: x.id, ok: true, amount: v.amount, note: v.note || null }) })}>同意</button>
            <button className="sm ghost danger" onClick={() => setAct({ title: `不同意提高上限：${x.project_name} ${x.year} 年度`, submitLabel: '不同意', danger: true,
              hint: `${x.requester_name ?? '负责人'} 申请从 ${money(x.cap)} 提到 ${money(x.amount)}。理由：${x.reason}`,
              fields: [{ name: 'note', label: '原因' }], run: (v) => rpc('decide_cap_request', { id: x.id, ok: false, amount: null, note: v.note }) })}>不同意</button></>}</div></td></tr>
      ))}</tbody>
    </table></div>
  );
}

// 上限与机动：中心负责人给每个大项目定一年的上限；各项目上限合计和年度总预算之间的差是机动，留在中心负责人手里。
export function CapsPage({ me, start }: { me: Me; start: string }) {
  const director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ years: BudgetYear[]; projects: Project[]; caps: ProjectCap[]; reqs: CapRequest[] }>({
    years: ['budget_year'], projects: ['project'], caps: ['project_cap'], reqs: ['cap_request'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.slice().sort((a, b) => b.year - a.year);
  if (years.length === 0) return <><div className="top"><h2>预算控制</h2></div><Empty>还没有开始任何年度的预算。年度开始之后，在这里给每个大项目定上限。</Empty></>;
  const y = years.find((x) => x.year === Number(start)) ?? years.find((x) => x.stage !== 'closed') ?? years[0];
  const year = y.year, open = y.stage !== 'closed';
  const bigs = data.projects.filter((p) => capped(p) && p.active).sort((a, b) => a.code.localeCompare(b.code));
  const capOf = (p: Project) => data.caps.find((c) => c.project_id === p.id && c.year === year);
  const total = y.fixed_total ?? y.granted_amount, sumCap = bigs.reduce((s, p) => s + num(capOf(p)?.amount), 0), sumUsed = bigs.reduce((s, p) => s + num(capOf(p)?.used), 0);
  const spare = total == null ? null : num(total) - sumCap;
  const unset = bigs.filter((p) => !capOf(p)).length;
  const pending = data.reqs.filter((x) => x.status === 'pending'), past = data.reqs.filter((x) => x.status !== 'pending' && x.year === year).sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <>
      <div className="top"><div className="crumb">{STAGE_TEXT[y.stage]}</div><h2>{year} 年度预算控制</h2></div>
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 16 }}>{years.map((n) => <a key={n.year} className="btn sm" aria-current={n.year === year ? 'page' : undefined} href={`#/caps/${n.year}`}>{n.year}</a>)}</div>}
      <p className="lede">每个大项目一年能排多少预算，由中心负责人按档定上限；大项目连同下面论文项目的预算合计不能超过它。各项目上限合计比年度总预算少的那一块是机动，留给年中提高上限和超预算的支出。</p>
      <div className="tiles">
        <Tile k="年度总预算" v={total == null ? '还没定' : money(total)} f={y.fixed_total != null ? '核定数合计' : y.granted_amount != null ? '学校批复数' : '学校批复之后才有'} />
        <Tile k="各大项目上限合计" v={money(sumCap)} f={`${bigs.length} 个大项目${unset ? `，${unset} 个还没定` : ''}`} />
        <Tile k="机动" v={spare == null ? '—' : money(spare)} f={spare == null ? '总预算定了之后才算得出' : spare < 0 ? '上限合计已经超过总预算' : `占总预算 ${pct(spare, num(total))}`} />
        <Tile k="已排进预算" v={money(sumUsed)} f={`占上限合计 ${pct(sumUsed, sumCap)}`} />
      </div>

      {pending.length > 0 && (
        <section className="card">
          <h3>等批的提高上限申请 <span className="h3sub">{pending.length} 条</span></h3>
          <CapReqTable rows={pending} director={director} setAct={setAct} withProject />
        </section>
      )}

      <section className="card">
        <h3>各大项目</h3>
        {bigs.length === 0 ? <Empty>还没有在用的大项目。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>大项目</th><th>负责人</th><th className="r">上限</th><th className="r">已排进预算</th><th className="r">还能排</th><th /></tr></thead>
            <tbody>{bigs.map((p) => { const c = capOf(p); const left = c ? num(c.amount) - num(c.used) : null; return (
              <tr key={p.id}><td><a href={`#/project/${p.id}`}>{p.name}</a><span className="sub2">{p.code}</span></td><td>{p.owner_name ?? '—'}</td>
                <td className="r">{c ? money(c.amount) : <span className="sub2">没定</span>}</td><td className="r">{c ? money(c.used) : '—'}</td>
                <td className={`r ${left != null && left <= 0 ? 'neg' : ''}`}>{left != null ? money(left) : '—'}</td>
                <td className="r">{director && open && <button className="ghost sm" onClick={() => setAct(capAct(p, year, c))}>{c ? '改上限' : '定上限'}</button>}</td></tr>); })}</tbody>
            <tfoot><tr><th scope="row">合计</th><td /><td className="r">{money(sumCap)}</td><td className="r">{money(sumUsed)}</td><td className="r">{money(sumCap - sumUsed)}</td><td /></tr>
              {spare != null && <tr><th scope="row">机动（总预算减上限合计）</th><td /><td className={`r ${spare < 0 ? 'neg' : ''}`}>{money(spare)}</td><td /><td /><td /></tr>}</tfoot>
          </table></div>
        )}
        <p className="hint">上限按档定：{TIERS}。论文项目不单独定上限，算在所属大项目里；中心公共开支不设上限。{director ? '' : '上限由中心负责人定。'}</p>
      </section>

      {past.length > 0 && (
        <section className="card">
          <h3>{year} 年度批过的申请</h3>
          <CapReqTable rows={past} director={false} setAct={setAct} withProject />
        </section>
      )}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
