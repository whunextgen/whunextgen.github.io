import { useState } from 'react';
import { rpc, useViews, type BudgetAlloc, type BudgetCategory, type BudgetYear, type Card, type CategorySubject, type Cell, type LineExec, type Me, type Project, type Subject } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, Loading, can, day, money, num, type Field } from '../ui';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const RANK: Record<Card['end_rule'], number> = { recall: 0, return: 1, carry: 2 };
const endOf = (c: Card) => day(c.settle_date ?? c.cutoff_date);

// 03 下达：把每一行的核定数对到经费卡的学校科目上。到期回收的卡先填满，填不满的缺口在这里标出来。
export function IssuePanel({ me, y, projects, cats, onStage }: { me: Me; y: BudgetYear; projects: Project[]; cats: BudgetCategory[]; onStage: () => void }) {
  const year = y.year, director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ exec: LineExec[]; allocs: BudgetAlloc[]; map: CategorySubject[]; subjects: Subject[]; cards: Card[]; cells: Cell[] }>({
    exec: ['line_exec', { year: String(year) }], allocs: ['budget_alloc', { year: String(year) }], map: ['category_subject'], subjects: ['subject'], cards: ['card'], cells: ['cell'],
  }, String(year));
  const [act, setAct] = useState<Act | null>(null);
  const [note, setNote] = useState('');
  if (!data) return <Loading error={error} />;
  const editable = y.stage === 'fixed' || y.stage === 'issued';
  const lines = data.exec.filter((l) => num(l.fixed) > 0);
  const cat = new Map(cats.map((c) => [c.id, c]));
  const subject = new Map(data.subjects.map((s) => [s.id, s]));
  const cell = new Map(data.cells.map((c) => [`${c.card_id}|${c.subject_id}`, c]));
  const inYear = data.cards.filter((c) => c.status === 'active' && day(c.start_date) <= `${year}-12-31` && day(c.cutoff_date) >= `${year}-01-01`)
    .sort((a, b) => RANK[a.end_rule] - RANK[b.end_rule] || endOf(a).localeCompare(endOf(b)) || a.card_no.localeCompare(b.card_no));
  const rest = (a: BudgetAlloc) => Math.max(num(a.amount) - num(a.used), 0);
  // 一个格子上别的行已经下达、还没用掉的预算
  const held = (key: string, except: string) => data.allocs.filter((a) => `${a.card_id}|${a.subject_id}` === key && a.line_id !== except).reduce((s, a) => s + rest(a), 0);
  const mapped = new Set(data.map.map((m) => m.category_id));
  const unmapped = [...new Set(lines.map((l) => l.category_id))].filter((c) => !mapped.has(c)).map((c) => cat.get(c)?.name ?? '');
  const open = lines.filter((l) => num(l.fixed) > num(l.allocated));
  const gap = open.reduce((s, l) => s + num(l.fixed) - num(l.allocated), 0);
  const fixedSum = lines.reduce((s, l) => s + num(l.fixed), 0), allocSum = lines.reduce((s, l) => s + num(l.allocated), 0);
  const go = (action: string) => rpc('advance_budget_year', { year, action, amount: null, on_date: null }).then(() => { reload(); onStage(); });

  const allocAct = (l: LineExec, p?: Project): Act => {
    const mine = data.allocs.filter((a) => a.line_id === l.id);
    const subs = new Set(data.map.filter((m) => m.category_id === l.category_id).map((m) => m.subject_id));
    const cand = inYear.flatMap((c) => data.subjects.filter((s) => s.template_id === c.template_id && subs.has(s.id)).sort((a, b) => a.sort - b.sort).map((s) => ({ c, s })));
    const keys = new Set(cand.map(({ c, s }) => `${c.card_id}|${s.id}`));
    const extra = mine.filter((a) => !keys.has(`${a.card_id}|${a.subject_id}`));
    const fields: Field[] = [
      ...cand.map(({ c, s }): Field => { const k = `${c.card_id}|${s.id}`; const free = num(cell.get(k)?.avail) - held(k, l.id); const cur = mine.find((a) => `${a.card_id}|${a.subject_id}` === k);
        return { name: k, type: 'number', required: false, value: cur ? String(num(cur.amount)) : '',
          label: `${c.name} · ${s.name}（${END_RULE[c.end_rule]}，${endOf(c)} 止；还能放 ${money(free)}${cur && num(cur.used) > 0 ? `，这一行已用 ${money(cur.used)}` : ''}）` }; }),
      ...extra.map((a): Field => ({ name: `${a.card_id}|${a.subject_id}`, type: 'number', required: false, value: String(num(a.amount)), label: `${a.card_name} · ${a.subject_name}（不在科目对应里）` })),
    ];
    return { title: `下达：${p?.name ?? ''} · ${l.purpose}`, submitLabel: '保存', fields,
      hint: fields.length === 0 ? `「${cat.get(l.category_id)?.name ?? ''}」还没有对应的学校科目，或者没有在 ${year} 年内有效的经费卡。先到财务工作台设置科目对应。`
        : `核定数 ${money(l.fixed)}。把它分到下面的卡上，合计不能超过核定数；不用的卡留空。到期回收的卡排在前面，先填它们。`,
      run: (v) => rpc('allocate_line', { id: l.id, parts: Object.entries(v).filter(([, x]) => Number(x) > 0).map(([k, x]) => { const [card_id, subject_id] = k.split('|'); return { card_id, subject_id, amount: Number(x) }; }) }).then(reload) };
  };

  const recall = inYear.filter((c) => c.end_rule === 'recall');
  const onCard = (id: string) => data.allocs.filter((a) => a.card_id === id).reduce((s, a) => s + rest(a), 0);
  const byProject = projects.map((p) => ({ p, rows: lines.filter((l) => l.project_id === p.id) })).filter((x) => x.rows.length > 0);

  return (
    <>
      <section className="card" id="issue">
        <h3>下达到经费卡 {y.stage === 'fixed' ? <Badge tone="warn">待下达</Badge> : y.stage === 'issued' ? <Badge tone="ok">已下达</Badge> : <Badge>已决算</Badge>}</h3>
        <p className="hint">{y.stage === 'fixed' ? '年度总预算确定后，每一行核定数都要对到经费卡的学校科目上，全部对完才能下达；下达之后各项目才能按预算提交支出。'
          : y.stage === 'issued' ? `${day(y.issued_at)} 已下达。复盘时调增了核定数的行要在这里补下达；调减的系统已经自动收回。` : `${year} 年度已经决算，下达记录只读。`}</p>
        {unmapped.length > 0 && <div className="msg bad">这些预算科目还没有对应的学校科目，自动对卡会跳过它们：{unmapped.join('、')}。<a href="#/desk">去财务工作台设置</a></div>}
        {note && <div className="msg ok" role="status">{note}</div>}
        <div className="tiles">
          <div className="tile"><div className="k">核定数合计</div><div className="v">{money(fixedSum)}</div><div className="f">{lines.length} 行预算</div></div>
          <div className="tile"><div className="k">已对到经费卡</div><div className="v">{money(allocSum)}</div><div className="f">{lines.length - open.length} 行对完</div></div>
          <div className="tile"><div className="k">还没对上</div><div className={`v ${gap > 0 ? 'bad' : ''}`}>{money(gap)}</div><div className="f">{open.length} 行</div></div>
        </div>
        {editable && <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {open.length > 0 && <button onClick={() => setAct({ title: '按科目对应自动对卡', submitLabel: '自动对卡', fields: [],
            hint: `给还没对完的 ${open.length} 行找卡：先填到期回收的卡（结清日早的在前），再填结余上缴的，最后是可结转的。放不下的行留给你手工处理，已经对好的不动。`,
            run: () => rpc('auto_allocate', { year }).then((n) => { setNote(`这次对完了 ${n} 行。`); reload(); }) })}>自动对卡</button>}
          {y.stage === 'fixed' && <button className={open.length > 0 ? 'ghost' : ''} disabled={open.length > 0} title={open.length > 0 ? '还有行没对完' : undefined}
            onClick={() => setAct({ title: `下达 ${year} 年度预算`, submitLabel: '下达', fields: [], hint: `${lines.length} 行预算、合计 ${money(fixedSum)} 已全部对到经费卡。下达后各项目可以按预算提交支出。`, run: () => go('issue') })}>下达</button>}
          {y.stage === 'fixed' && director && allocSum === 0 && <button className="ghost" onClick={() => setAct({ title: '退回核定', danger: true, submitLabel: '退回', fields: [], hint: '回到核定阶段，可以重新调整各行核定数和年度总预算。', run: () => go('reopen') })}>退回核定</button>}
        </div>}
      </section>

      <section className="card">
        <h3>到期回收的卡要花完</h3>
        <p className="hint">回收卡上的钱到期没花完会被学校收回。下达时先把预算对到这些卡上；对完之后卡上还有没被预算覆盖的可用额，就是会被收回的缺口，要么追加预算去花，要么提前向学校申请调整。</p>
        {recall.length === 0 ? <Empty>{year} 年内没有到期回收的经费卡。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>到期</th><th className="r">现在可用</th><th className="r">已下达到这张卡（未用）</th><th className="r">没有预算覆盖</th><th /></tr></thead>
            <tbody>{recall.map((c) => { const a = num(c.avail), h = onCard(c.card_id), d = a - h; return (
              <tr key={c.card_id}><td><a href={`#/card/${c.card_id}`}>{c.name}</a><span className="sub2">{c.card_no}</span></td><td>{endOf(c)}</td>
                <td className="r">{money(a)}</td><td className="r">{money(h)}</td><td className={`r ${d > 0.005 ? 'neg' : ''}`}>{money(Math.max(d, 0))}</td>
                <td>{d > 0.005 ? <Badge tone="bad">会被收回 {money(d)}</Badge> : <Badge tone="ok">预算能花完</Badge>}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>各行对到哪张卡</h3>
        {byProject.length === 0 ? <Empty>没有核定数大于 0 的预算行。</Empty> : (
          <div className="scroll"><table className="tight">
            <thead><tr><th>项目</th><th>科目</th><th>做什么用</th><th className="r">核定数</th><th className="r">已对上</th><th>经费卡 · 学校科目</th><th /></tr></thead>
            <tbody>{byProject.flatMap(({ p, rows }) => rows.map((l, i) => { const mine = data.allocs.filter((a) => a.line_id === l.id).sort((a, b) => RANK[a.end_rule] - RANK[b.end_rule]); const d = num(l.fixed) - num(l.allocated); return (
              <tr key={l.id}>{i === 0 && <td rowSpan={rows.length}>{p.name}<span className="sub2">{p.code}</span></td>}
                <td>{cat.get(l.category_id)?.name ?? '—'}</td><td className="wrap">{l.purpose}</td><td className="r">{money(l.fixed)}</td>
                <td className={`r ${d > 0.005 ? 'neg' : ''}`}>{money(l.allocated)}{d > 0.005 && <span className="sub2">差 {money(d)}</span>}</td>
                <td className="wrap">{mine.length === 0 ? <span className="sub2">还没对</span> : mine.map((a) => (
                  <div key={a.id}>{a.card_name} · {subject.get(a.subject_id)?.name ?? a.subject_name} <b>{money(a.amount)}</b>{a.end_rule === 'recall' && <> <Badge tone="warn">回收</Badge></>}
                    {num(a.used) > 0 && <span className="sub2">已用 {money(a.used)}</span>}</div>))}</td>
                <td className="r">{editable && <button className="ghost sm" onClick={() => setAct(allocAct(l, p))}>{mine.length ? '改' : '对卡'}</button>}</td></tr>); }))}</tbody>
          </table></div>
        )}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={act.run} onClose={() => setAct(null)} />}
    </>
  );
}
