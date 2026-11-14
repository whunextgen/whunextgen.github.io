import { useState } from 'react';
import { rpc, useViews, type BudgetAlloc, type BudgetCategory, type BudgetReview, type BudgetRevision, type BudgetShift, type BudgetYear, type LineExec, type Me, type Project, type YearCheck } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, Tile, day, money, num, pct, today, type Field } from '../ui';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const Q = ['q1', 'q2', 'q3', 'q4'] as const, A = ['a1', 'a2', 'a3', 'a4'] as const;
const QN = ['1–3 月', '4–6 月', '7–9 月', '10–12 月'];

// 07 复盘与决算：每三个月按研究单元对一次计划和实际，复盘时可以调整核定数；年末做年度决算，未用的预算不结转。
export function Review({ me, start }: { me: Me; start: string }) {
  const staff = can(me, 'budget.review'), director = can(me, 'budget.approve'), seesCards = can(me, 'read.finance');
  const { data, error, reload } = useViews<{ years: BudgetYear[]; projects: Project[]; cats: BudgetCategory[]; exec: LineExec[]; allocs: BudgetAlloc[]; revisions: BudgetRevision[]; reviews: BudgetReview[]; shifts: BudgetShift[]; checks: YearCheck[] }>({
    years: ['budget_year'], projects: ['project'], cats: ['budget_category'], exec: ['line_exec'], allocs: ['budget_alloc'], revisions: ['budget_revision'], reviews: ['budget_review'], shifts: ['budget_shift'], checks: ['year_check'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [open, setOpen] = useState('');
  if (!data) return <Loading error={error} />;
  const years = data.years.filter((x) => x.stage === 'issued' || x.stage === 'closed').sort((a, b) => b.year - a.year);
  if (years.length === 0) return (
    <>
      <div className="top"><h2>年度决算</h2></div>
      <Empty>尚未下达年度预算。预算下达后，在此按研究单元查看执行情况，每三个月复盘一次，年末办理年度决算。</Empty>
    </>
  );
  const y = years.find((x) => x.year === Number(start)) ?? years[0];
  const year = y.year, now = today(), thisYear = Number(now.slice(0, 4));
  const quarter = year < thisYear ? 4 : year > thisYear ? 0 : Math.ceil(Number(now.slice(5, 7)) / 3);
  const cat = new Map(data.cats.map((c) => [c.id, c.name]));
  const lines = data.exec.filter((l) => l.year === year);
  const sum = (rows: LineExec[], k: 'fixed' | 'used' | 'actual' | 'pending' | 'allocated') => rows.reduce((s, l) => s + num(l[k]), 0);
  // 分期计划是申报时填的；核定数和申报数不一样时，按各期原来的比例摊到核定数上
  const qp = (l: LineExec, i: number) => { const d = Q.reduce((t, k) => t + num(l[k]), 0); return d > 0 ? Math.round(num(l.fixed) * num(l[Q[i]]) / d * 100) / 100 : num(l.fixed) / 4; };
  const plan = (rows: LineExec[], upto: number) => rows.reduce((s, l) => s + Q.slice(0, upto).reduce((t, _, i) => t + qp(l, i), 0), 0);
  const projects = data.projects.map((p) => ({ p, rows: lines.filter((l) => l.project_id === p.id) })).filter((x) => x.rows.length > 0)
    .sort((a, b) => Number(a.p.kind === 'public') - Number(b.p.kind === 'public') || a.p.code.localeCompare(b.p.code));
  const reviewOf = (pid: string, q: number) => data.reviews.find((r) => r.year === year && r.project_id === pid && r.quarter === q);
  const fixed = sum(lines, 'fixed'), used = sum(lines, 'used'), actual = sum(lines, 'actual'), pending = sum(lines, 'pending');
  const editable = y.stage === 'issued';

  const reviewAct = (p: Project, rows: LineExec[]): Act => { const q = Math.max(quarter, 1); const old = reviewOf(p.id, q); return {
    title: `复盘：${p.name}`, submitLabel: '保存',
    hint: `截至本期末计划累计 ${money(plan(rows, q))}，已入账 ${money(sum(rows, 'actual'))}，在途 ${money(sum(rows, 'used') - sum(rows, 'actual'))}。请写明偏差原因及下一期措施；需调整核定数的，另在预算行上调整。`,
    fields: [{ name: 'quarter', label: '预算期', options: QN.map((n, i): [string, string] => [String(i + 1), `第 ${i + 1} 期（${n}）`]), value: String(q) }, { name: 'note', label: '复盘结论', value: old?.note ?? '' }],
    run: (v) => rpc('review_project', { year, quarter: Number(v.quarter), project_id: p.id, note: v.note }).then(reload) }; };
  const reviseAct = (p: Project, l: LineExec): Act => ({
    title: `调整核定数：${p.name} · ${l.purpose}`, submitLabel: '调整',
    hint: `当前核定 ${money(l.fixed)}，已用 ${money(l.used)}（含在途）。调减不得低于已用，超额下达部分自动从经费卡收回；调增部分须在「预算编制」补充下达。各研究单元核定数合计不得超过年度总预算。`,
    fields: [{ name: 'amount', label: '新核定数（元）', type: 'number', value: String(num(l.fixed)) }, { name: 'note', label: '调整原因' }],
    run: (v) => rpc('revise_fixed', { id: l.id, amount: v.amount, note: v.note }).then(reload) });
  const pendingShifts = data.shifts.filter((s) => s.year === year && s.status === 'pending');
  const checked = data.checks.filter((k) => k.year === year && k.actual != null), off = checked.filter((k) => num(k.diff) !== 0);

  return (
    <>
      <div className="top">
        <div className="crumb">{y.stage === 'closed' ? `${day(y.closed_at)} 已决算` : quarter > 0 ? `执行中 · 当前为第 ${quarter} 期（${QN[quarter - 1]}）` : '已下达，尚未开始执行'}</div>
        <h2>{year} 年度决算</h2>
      </div>
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 16 }}>{years.map((n) => <a key={n.year} className="btn sm" aria-current={n.year === year ? 'page' : undefined} href={`#/review/${n.year}`}>{n.year}</a>)}</div>}

      {projects.length === 0 ? <Empty>本人名下暂无 {year} 年度有预算的研究单元。研究单元的执行和复盘情况仅研究单元负责人、财务岗和中心负责人可查看。</Empty> : (
        <>
          <div className="tiles">
            <Tile k={staff ? '核定数合计' : '本人研究单元核定数'} v={money(fixed)} f={`${projects.length} 个研究单元，${lines.length} 行`} />
            <Tile k="已用（含在途）" v={money(used)} f={`占核定数 ${pct(used, fixed)}${pending > 0 ? ` · 待审批 ${money(pending)}` : ''}`} />
            <Tile k="已入账" v={money(actual)} f={`执行率 ${pct(actual, fixed)}`} />
            <Tile k={y.stage === 'closed' ? '未用（不结转）' : '未使用'} v={money(fixed - used)} f={y.stage === 'closed' ? '年度决算时作废' : '年末未用完部分不结转'} />
          </div>

          <section className="card">
            <h3>按研究单元复盘</h3>
            <p className="hint">每三个月核对一次：截至本期末的计划支出与学校实际入账。各期计划按申报时的分期比例分摊至核定数。入账不足计划 70% 的标为落后。复盘结论由财务岗和中心负责人记录，研究单元负责人可查看。预算行之间的调剂在研究单元详情页办理，点击研究单元名称进入。</p>
            <div className="scroll"><table>
              <thead><tr><th>研究单元</th><th className="r">核定数</th><th className="r">已入账</th><th>进度</th><th>本期复盘</th><th /></tr></thead>
              <tbody>{projects.map(({ p, rows }) => { const pl = plan(rows, Math.max(quarter, 1)), ac = sum(rows, 'actual'), rv = reviewOf(p.id, Math.max(quarter, 1)); return (
                <tr key={p.id}><td><a href={`#/project/${p.id}/${year}`}>{p.name}</a><span className="sub2">{p.code}{p.owner_name ? ` · ${p.owner_name}` : ''}</span></td>
                  <td className="r">{money(sum(rows, 'fixed'))}</td><td className="r">{money(ac)}<div className="sub2">在途 {money(sum(rows, 'used') - ac)}</div></td>
                  <td>{quarter === 0 || pl === 0 ? '—' : ac < pl * 0.7 ? <Badge tone="bad">落后，差额 {money(pl - ac)}</Badge> : <Badge tone="ok">正常</Badge>}{quarter > 0 && pl > 0 && <div className="sub2">截至第 {quarter} 期末计划 {money(pl)}</div>}</td>
                  <td className="wrap">{rv ? <><Badge tone="ok">已复盘</Badge><span className="sub2">{rv.reviewed_by_name ?? ''} {day(rv.reviewed_at)}</span></> : quarter === 0 ? '—' : <Badge tone="warn">尚未复盘</Badge>}</td>
                  <td><div className="acts"><button className="sm ghost" aria-pressed={open === p.id} onClick={() => setOpen(open === p.id ? '' : p.id)}>明细</button>
                    {staff && editable && quarter > 0 && <button className="sm ghost" onClick={() => setAct(reviewAct(p, rows))}>{rv ? '修改复盘' : '填写复盘'}</button>}</div></td></tr>); })}</tbody>
            </table></div>
          </section>

          {pendingShifts.length > 0 && (
            <section className="card">
              <h3>待审批的预算调剂 <span className="h3sub">全年累计超过研究单元年度预算 10% 的，由中心负责人审批</span></h3>
              <div className="scroll"><table>
                <thead><tr><th>提交日期</th><th>研究单元</th><th>调出</th><th>调入</th><th className="r">金额</th><th>原因</th><th /></tr></thead>
                <tbody>{pendingShifts.map((s) => (
                  <tr key={s.id}><td>{day(s.created_at)}<span className="sub2">{s.requester_name ?? ''}</span></td><td>{s.project_name}</td><td className="wrap">{s.from_purpose}</td><td className="wrap">{s.to_purpose}</td>
                    <td className="r">{money(s.amount)}</td><td className="wrap">{s.note}</td>
                    <td><div className="acts">{director ? <>
                      <button className="sm" onClick={() => setAct({ title: `同意调剂：${s.project_name}`, submitLabel: '同意', hint: `从「${s.from_purpose}」调剂 ${money(s.amount)} 至「${s.to_purpose}」。原因：${s.note}。同意后两条预算行的核定数即时调整。`,
                        fields: [{ name: 'note', label: '批示（选填）', required: false }], run: (v) => rpc('decide_budget_shift', { id: s.id, ok: true, note: v.note || null }).then(reload) })}>同意</button>
                      <button className="sm ghost danger" onClick={() => setAct({ title: `不同意调剂：${s.project_name}`, submitLabel: '不同意', danger: true, hint: `从「${s.from_purpose}」调剂 ${money(s.amount)} 至「${s.to_purpose}」。原因：${s.note}`,
                        fields: [{ name: 'note', label: '原因' }], run: (v) => rpc('decide_budget_shift', { id: s.id, ok: false, note: v.note }).then(reload) })}>不同意</button></>
                      : <Badge tone="warn">待中心负责人审批</Badge>}</div></td></tr>
                ))}</tbody>
              </table></div>
            </section>
          )}

          {projects.filter(({ p }) => p.id === open).map(({ p, rows }) => {
            const revs = data.revisions.filter((r) => r.year === year && r.project_id === p.id).sort((a, b) => b.revised_at.localeCompare(a.revised_at));
            const notes = data.reviews.filter((r) => r.year === year && r.project_id === p.id).sort((a, b) => a.quarter - b.quarter);
            const shifts = data.shifts.filter((s) => s.year === year && s.project_id === p.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
            return (
              <section className="card" key={p.id}>
                <h3>{p.name}：各预算行执行情况</h3>
                <div className="scroll"><table className="tight">
                  <thead><tr><th>预算行</th>{QN.map((n) => <th key={n} className="r">{n}<span className="sub2">计划 / 入账</span></th>)}<th className="r">核定数</th><th className="r">剩余</th>{seesCards && <th>经费卡</th>}<th /></tr></thead>
                  <tbody>{rows.map((l) => { const left = num(l.fixed) - num(l.used); const al = data.allocs.filter((a) => a.line_id === l.id); return (
                    <tr key={l.id}><td className="wrap">{l.purpose}<div className="sub2">{cat.get(l.category_id) ?? '—'}</div></td>
                      {Q.map((k, i) => <td key={k} className="r">{qp(l, i) > 0 ? money(qp(l, i)) : '—'}<div className="sub2">{num(l[A[i]]) > 0 ? money(l[A[i]]) : '—'}</div></td>)}
                      <td className="r">{money(l.fixed)}{num(l.fixed) > num(l.allocated) && <span className="sub2 neg">{money(num(l.fixed) - num(l.allocated))} 待下达</span>}</td>
                      <td className={`r ${left < 0 ? 'neg' : ''}`}>{money(left)}<div className="sub2">已用 {money(l.used)}</div></td>
                      {seesCards && <td className="wrap">{al.length === 0 ? '—' : al.map((a) => <div key={a.id}>{a.card_name ?? '—'}<span className="sub2">{money(a.amount)}，已用 {money(a.used)}</span></div>)}</td>}
                      <td className="r">{director && editable && <button className="ghost sm" onClick={() => setAct(reviseAct(p, l))}>调整</button>}</td></tr>); })}</tbody>
                </table></div>
                <h4>复盘记录</h4>
                {notes.length === 0 ? <Empty>暂无复盘记录。</Empty> : (
                  <div className="scroll"><table><thead><tr><th>预算期</th><th>结论</th><th>记录人</th><th>日期</th></tr></thead>
                    <tbody>{notes.map((r) => <tr key={r.id}><td>第 {r.quarter} 期<span className="sub2">{QN[r.quarter - 1]}</span></td><td className="wrap">{r.note}</td><td>{r.reviewed_by_name ?? '—'}</td><td>{day(r.reviewed_at)}</td></tr>)}</tbody></table></div>)}
                {shifts.length > 0 && <>
                  <h4>预算调剂记录</h4>
                  <div className="scroll"><table><thead><tr><th>日期</th><th>调出</th><th>调入</th><th className="r">金额</th><th>原因</th><th>状态</th></tr></thead>
                    <tbody>{shifts.map((s) => <tr key={s.id}><td>{day(s.created_at)}<span className="sub2">{s.requester_name ?? ''}</span></td><td className="wrap">{s.from_purpose}</td><td className="wrap">{s.to_purpose}</td><td className="r">{money(s.amount)}</td>
                      <td className="wrap">{s.note}{s.decide_note && <div className="sub2">批示：{s.decide_note}</div>}</td>
                      <td>{s.status === 'pending' ? <Badge tone="warn">待中心负责人审批</Badge> : s.status === 'rejected' ? <Badge tone="bad">未同意</Badge> : <Badge tone="ok">{s.decided_by_name ? `${s.decided_by_name} 已同意` : '已生效'}</Badge>}</td></tr>)}</tbody></table></div></>}
                {revs.length > 0 && <>
                  <h4>核定数调整记录</h4>
                  <div className="scroll"><table><thead><tr><th>日期</th><th>预算行</th><th className="r">原核定数</th><th className="r">新核定数</th><th>原因</th><th>调整人</th></tr></thead>
                    <tbody>{revs.map((r) => <tr key={r.id}><td>{day(r.revised_at)}</td><td className="wrap">{r.purpose}</td><td className="r">{money(r.old_amount)}</td><td className="r chg">{money(r.new_amount)}</td><td className="wrap">{r.note}</td><td>{r.revised_by_name ?? '—'}</td></tr>)}</tbody></table></div></>}
              </section>
            ); })}

          <section className="card">
            <h3>年度决算</h3>
            <p className="hint">{y.stage === 'closed' ? `${year} 年度已于 ${day(y.closed_at)} 决算。决算数仅以学校正式入账为准；未用完的预算作废，不结转至下一年度。`
              : `年度结束且全部支出申请审批完毕后，由中心负责人办理年度决算。决算后 ${year} 年度预算不可再支出，未用完部分不结转；年末尚未入账的在途支出照常在经费卡上办结。`}</p>
            <div className="scroll"><table>
              <thead><tr><th>研究单元</th><th className="r">核定数</th><th className="r">决算数（已入账）</th><th className="r">在途</th><th className="r">未用</th><th className="r">执行率</th></tr></thead>
              <tbody>{projects.map(({ p, rows }) => { const f = sum(rows, 'fixed'), a = sum(rows, 'actual'), u = sum(rows, 'used'); return (
                <tr key={p.id}><td>{p.name}</td><td className="r">{money(f)}</td><td className="r">{money(a)}</td><td className="r">{money(u - a)}</td><td className="r">{money(f - u)}</td><td className="r">{pct(a, f)}</td></tr>); })}</tbody>
              <tfoot><tr><th scope="row">合计</th><td className="r">{money(fixed)}</td><td className="r">{money(actual)}</td><td className="r">{money(used - actual)}</td><td className="r">{money(fixed - used)}</td><td className="r">{pct(actual, fixed)}</td></tr></tfoot>
            </table></div>
            {editable && staff && <div className="actions" style={{ justifyContent: 'flex-start' }}>
              {year >= thisYear ? <span className="sub2">{year} 年度结束后方可办理年度决算。</span>
                : pending > 0 ? <span className="sub2">尚有 {money(pending)} 的支出申请未审批，审批完毕后方可决算。</span>
                : director ? <button className="danger" onClick={() => setAct({ title: `${year} 年度决算`, danger: true, submitLabel: '确认决算', fields: [],
                    hint: `核定 ${money(fixed)}，已入账 ${money(actual)}，在途 ${money(used - actual)}，未用 ${money(fixed - used)} 不结转。决算后不可撤回。`,
                    run: () => rpc('advance_budget_year', { year, action: 'final', amount: null, on_date: null }).then(reload) })}>办理年度决算</button>
                : <span className="sub2">已具备决算条件，请中心负责人确认。</span>}
            </div>}
          </section>

          {can(me, 'read.resource') && (
            <section className="card">
              <h3>年末盘点差异 <span className="h3sub">{checked.length === 0 ? '尚未盘点' : `已盘 ${checked.length} 项，${off.length} 项不一致`}</span><a className="more" href="#/stock">资产盘点 →</a></h3>
              <p className="hint">年末对接口额度和设备进行实盘，与账面不一致的列示于此，决算前须有说明。盘点在「资产盘点」中登记。</p>
              {checked.length === 0 ? <Empty>{year} 年末盘点尚未登记。</Empty> : off.length === 0 ? <Empty>已盘的 {checked.length} 项与账面均一致。</Empty> : (
                <div className="scroll"><table>
                  <thead><tr><th>资源</th><th>类型</th><th className="r">账面</th><th className="r">实盘</th><th className="r">差异</th><th>说明</th><th>盘点</th></tr></thead>
                  <tbody>{off.map((k) => (
                    <tr key={k.resource_id}><td>{k.resource_name}</td><td>{k.kind === 'api' ? '接口额度' : '设备'}</td>
                      <td className="r">{num(k.book)}{k.unit ? ` ${k.unit}` : ''}</td><td className="r">{num(k.actual)}{k.unit ? ` ${k.unit}` : ''}</td>
                      <td className="r neg">{num(k.diff) > 0 ? '+' : ''}{num(k.diff)}</td><td className="wrap">{k.note ?? <Badge tone="warn">尚未填写说明</Badge>}</td>
                      <td>{k.checked_by_name ?? '—'}<span className="sub2">{k.checked_at ? day(k.checked_at) : ''}</span></td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
          )}
        </>
      )}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={act.run} onClose={() => setAct(null)} />}
    </>
  );
}
