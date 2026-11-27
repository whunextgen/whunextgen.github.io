import { useState } from 'react';
import { rpc, subjectsOf, useViews, type BudgetAlloc, type BudgetCategory, type BudgetYear, type Card, type CategorySubject, type Cell, type ExpenseType, type LineExec, type Rule, type Me, type Project, type Subject } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, Loading, can, day, money, num, type Field } from '../ui';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const RANK: Record<Card['end_rule'], number> = { recall: 0, carry: 2 };
const endOf = (c: Card) => day(c.settle_date ?? c.cutoff_date);

// 03 下达：把每一行的核定数对到经费卡的学校科目上。到期回收的卡先填满，填不满的缺口在这里标出来。
// 分课题下达：财务岗审核通过一个课题的预算即下达，这个课题随即可以支出
interface TopicIssue { year: number; project_id: string; code: string; name: string; status: string; issued_at: string | null; issued_by_name: string | null; issue_note: string | null;
  fixed: string; allocated: string; can_issue: boolean; can_unissue: boolean }
const BST: Record<string, string> = { draft: '草稿', submitted: '已提交', returned: '已退回' };

export function IssuePanel({ me, y, projects, cats, onStage }: { me: Me; y: BudgetYear; projects: Project[]; cats: BudgetCategory[]; onStage: () => void }) {
  const year = y.year, director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ exec: LineExec[]; allocs: BudgetAlloc[]; map: CategorySubject[]; subjects: Subject[]; cards: Card[]; cells: Cell[]; topics: TopicIssue[]; rules: Rule[]; types: ExpenseType[] }>({
    exec: ['line_exec', { year: String(year) }], allocs: ['budget_alloc', { year: String(year) }], map: ['category_subject'], subjects: ['subject'], cards: ['card'], cells: ['cell'], topics: ['topic_issue', { year: String(year) }], rules: ['rule'], types: ['expense_type'],
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

  // 经费卡上已答复可报销的支出类型，供财务岗判断这张卡能不能列支这一行的支出
  const typeName = new Map(data.types.map((t) => [t.id, t.name]));
  const canPay = (cardId: string) => { const ok = data.rules.filter((r) => r.card_id === cardId && (r.verdict === 'yes' || r.verdict === 'conditional')).map((r) => `${typeName.get(r.expense_type_id) ?? ''}${r.verdict === 'conditional' ? '（有条件）' : ''}`);
    return ok.length ? `可报销：${ok.join('、')}` : '尚无可报销答复'; };
  type Suggest = { parts: { card_id: string; subject_id: string; amount: string | number }[]; short: string | number } | null;
  // 经费卡由财务岗手动匹配，系统按算法推荐（0142）：尚未分配的行按推荐预填，已分配的保持原样、推荐写在说明里
  const allocAct = (l: LineExec, p?: Project, sug: Suggest = null): Act => {
    const mine = data.allocs.filter((a) => a.line_id === l.id);
    const rec = new Map((sug?.parts ?? []).map((x) => [`${x.card_id}|${x.subject_id}`, num(x.amount)]));
    const prefill = mine.length === 0;
    const subs = new Set(data.map.filter((m) => m.category_id === l.category_id).map((m) => m.subject_id));
    const cand = inYear.flatMap((c) => subjectsOf(data.subjects, { id: c.card_id, template_id: c.template_id }).filter((s) => subs.has(s.id)).map((s) => ({ c, s })));
    const keys = new Set(cand.map(({ c, s }) => `${c.card_id}|${s.id}`));
    const extra = mine.filter((a) => !keys.has(`${a.card_id}|${a.subject_id}`));
    const fields: Field[] = [
      ...cand.map(({ c, s }): Field => { const k = `${c.card_id}|${s.id}`; const free = num(cell.get(k)?.avail) - held(k, l.id); const cur = mine.find((a) => `${a.card_id}|${a.subject_id}` === k);
        const r = rec.get(k);
        return { name: k, type: 'number', required: false, value: cur ? String(num(cur.amount)) : prefill && r ? String(r) : '',
          label: `${r ? '【推荐 ' + money(r) + '】' : ''}${c.name} · ${s.name}（${END_RULE[c.end_rule]}，${endOf(c)} 止；尚可分配 ${money(free)}${cur && num(cur.used) > 0 ? `，该行已用 ${money(cur.used)}` : ''}；${canPay(c.card_id)}）` }; }),
      ...extra.map((a): Field => ({ name: `${a.card_id}|${a.subject_id}`, type: 'number', required: false, value: String(num(a.amount)), label: `${a.card_name} · ${a.subject_name}（不在科目对应范围内）` })),
    ];
    return { title: `下达：${p?.name ?? ''} · ${l.purpose}`, submitLabel: '保存', fields,
      hint: fields.length === 0 ? `「${cat.get(l.category_id)?.name ?? ''}」尚未对应学校科目，或没有有效期覆盖 ${year} 年的经费卡。请先在「预算参数」中设置科目对应，并在「项目管理」中开出经费卡。`
        : `核定数 ${money(l.fixed)}。由财务岗决定分配到哪些经费卡，合计不得超过核定数，不使用的经费卡留空。${rec.size ? (prefill ? '已按系统推荐预填（标有【推荐】），' : '系统推荐见标有【推荐】的经费卡，') + '推荐只按到期回收优先和可用余额计算，不看能否列支，请对照每张卡的可报销答复核对后修改。' : '系统没有可推荐的经费卡。'}${sug && num(sug.short) > 0 ? `可用余额不足，推荐后仍差 ${money(sug.short)}。` : ''}`,
      run: (v) => rpc('allocate_line', { id: l.id, parts: Object.entries(v).filter(([, x]) => Number(x) > 0).map(([k, x]) => { const [card_id, subject_id] = k.split('|'); return { card_id, subject_id, amount: Number(x) }; }) }).then(reload) };
  };

  const recall = inYear.filter((c) => c.end_rule === 'recall');
  const onCard = (id: string) => data.allocs.filter((a) => a.card_id === id).reduce((s, a) => s + rest(a), 0);
  const byProject = projects.map((p) => ({ p, rows: lines.filter((l) => l.project_id === p.id) })).filter((x) => x.rows.length > 0);

  return (
    <>
      <section className="card" id="issue">
        <h3>下达至经费卡 {y.stage === 'fixed' ? <Badge tone="warn">待下达</Badge> : y.stage === 'issued' ? <Badge tone="ok">已下达</Badge> : <Badge>已决算</Badge>}</h3>
        <p className="hint">{y.stage === 'fixed' ? '可以按课题审核下达（见下一节），审核通过的课题即可支出；也可以等各行核定数全部分配至经费卡的学校科目后，整个年度一并下达。'
          : y.stage === 'issued' ? `${day(y.issued_at)} 已下达。复盘时调增核定数的行须在此补充下达；调减部分系统已自动收回。` : `${year} 年度已决算，下达记录仅供查看。`}</p>
        {unmapped.length > 0 && <div className="msg bad">以下预算科目尚未对应学校科目，推荐分配时无法匹配经费卡：{unmapped.join('、')}。<a href="#/desk">前往预算参数设置</a></div>}
        {note && <div className="msg ok" role="status">{note}</div>}
        <div className="tiles">
          <div className="tile"><div className="k">核定数合计</div><div className="v">{money(fixedSum)}</div><div className="f">{lines.length} 行预算</div></div>
          <div className="tile"><div className="k">已分配至经费卡</div><div className="v">{money(allocSum)}</div><div className="f">{lines.length - open.length} 行分配完毕</div></div>
          <div className="tile"><div className="k">尚未分配</div><div className={`v ${gap > 0 ? 'bad' : ''}`}>{money(gap)}</div><div className="f">{open.length} 行</div></div>
        </div>
        {editable && <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {y.stage === 'fixed' && <button className={open.length > 0 ? 'ghost' : ''} disabled={open.length > 0} title={open.length > 0 ? '尚有预算行未分配完毕' : undefined}
            onClick={() => setAct({ title: `下达 ${year} 年度预算`, submitLabel: '下达', fields: [], hint: `${lines.length} 行预算、合计 ${money(fixedSum)} 已全部分配至经费卡。下达后各研究单元可按预算提交支出申请。`, run: () => go('issue') })}>下达</button>}
          {y.stage === 'fixed' && director && allocSum === 0 && <button className="ghost" onClick={() => setAct({ title: '退回核定', danger: true, submitLabel: '退回', fields: [], hint: '退回核定阶段，可重新调整各行核定数和年度总预算。', run: () => go('reopen') })}>退回核定</button>}
        </div>}
      </section>

      {y.stage === 'fixed' && <section className="card">
        <h3>按课题审核下达 <span className="h3sub">财务岗审核通过一个课题的预算即下达，这个课题及其研究单元随即可以提交支出申请，不等其他课题，也不等年度整体下达</span></h3>
        {data.topics.length === 0 ? <Empty>还没有课题提交 {year} 年度预算。</Empty> : (
          <div className="scroll"><table className="tight">
            <thead><tr><th>课题</th><th>预算</th><th className="r">核定数</th><th className="r">已分配至经费卡</th><th>下达</th><th /></tr></thead>
            <tbody>{[...data.topics].sort((a, b) => a.code.localeCompare(b.code)).map((t) => (
              <tr key={t.project_id}><td>{t.name}<span className="sub2">{t.code}</span></td><td>{BST[t.status] ?? t.status}</td>
                <td className="r">{money(t.fixed)}</td><td className="r">{money(t.allocated)}</td>
                <td>{t.issued_at ? <><Badge tone="ok">已下达</Badge><span className="sub2">{t.issued_by_name} {day(t.issued_at)}{t.issue_note ? ` · ${t.issue_note}` : ''}</span></> : t.status === 'submitted' ? <Badge tone="warn">待审核</Badge> : <span className="sub2">待课题提交</span>}</td>
                <td className="r">{t.can_issue && num(t.allocated) < num(t.fixed) && <span className="sub2">先在下方逐行分配到经费卡</span>}
                  {t.can_issue && num(t.allocated) >= num(t.fixed) && <button className="sm" onClick={() => setAct({ title: `审核下达：${t.name}`, submitLabel: '审核通过并下达', fields: [{ name: 'n', label: '审核意见（选填）', required: false }],
                    hint: `核定数 ${money(t.fixed)}。各行已由财务岗分配到经费卡，合计 ${money(t.allocated)}。审核通过即下达，下达后课题负责人和研究单元成员会收到通知。`,
                    run: (v) => rpc('issue_topic', { year, project: t.project_id, note: v.n || null }).then(() => { setNote(`已下达：${t.name}`); reload(); }) })}>审核通过并下达</button>}
                  {t.can_unissue && <button className="ghost sm" onClick={() => setAct({ title: `撤销下达：${t.name}`, submitLabel: '撤销', danger: true, fields: [], hint: '只能在还没有任何支出或在办申请时撤销；撤销后收回分配到经费卡的数额。',
                    run: () => rpc('unissue_topic', { year, project: t.project_id }).then(() => { setNote(`已撤销下达：${t.name}`); reload(); }) })}>撤销下达</button>}</td></tr>))}</tbody>
          </table></div>)}
      </section>}

      <section className="card">
        <h3>到期回收的经费卡须使用完毕</h3>
        <p className="hint">到期回收经费卡的资金到期未使用完毕将由学校收回。下达时优先将预算分配至此类经费卡；分配后仍未被预算覆盖的可用额即为将被收回的缺口，应追加预算安排支出，或提前向学校申请调整。</p>
        {recall.length === 0 ? <Empty>{year} 年内暂无到期回收的经费卡。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>到期日</th><th className="r">当前可用</th><th className="r">已下达至该经费卡（未用）</th><th className="r">无预算覆盖</th><th /></tr></thead>
            <tbody>{recall.map((c) => { const a = num(c.avail), h = onCard(c.card_id), d = a - h; return (
              <tr key={c.card_id}><td><a href={`#/card/${c.card_id}`}>{c.name}</a><span className="sub2">{c.card_no}</span></td><td>{endOf(c)}</td>
                <td className="r">{money(a)}</td><td className="r">{money(h)}</td><td className={`r ${d > 0.005 ? 'neg' : ''}`}>{money(Math.max(d, 0))}</td>
                <td>{d > 0.005 ? <Badge tone="bad">将被收回 {money(d)}</Badge> : <Badge tone="ok">预算可用完</Badge>}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>各预算行分配情况</h3>
        {byProject.length === 0 ? <Empty>暂无核定数大于 0 的预算行。</Empty> : (
          <div className="scroll"><table className="tight">
            <thead><tr><th>研究单元</th><th>科目</th><th>用途</th><th className="r">核定数</th><th className="r">已分配</th><th>经费卡 · 学校科目</th><th /></tr></thead>
            <tbody>{byProject.flatMap(({ p, rows }) => rows.map((l, i) => { const mine = data.allocs.filter((a) => a.line_id === l.id).sort((a, b) => RANK[a.end_rule] - RANK[b.end_rule]); const d = num(l.fixed) - num(l.allocated); return (
              <tr key={l.id}>{i === 0 && <td rowSpan={rows.length}>{p.name}<span className="sub2">{p.code}</span></td>}
                <td>{cat.get(l.category_id)?.name ?? '—'}</td><td className="wrap">{l.purpose}</td><td className="r">{money(l.fixed)}</td>
                <td className={`r ${d > 0.005 ? 'neg' : ''}`}>{money(l.allocated)}{d > 0.005 && <span className="sub2">差额 {money(d)}</span>}</td>
                <td className="wrap">{mine.length === 0 ? <span className="sub2">尚未分配</span> : mine.map((a) => (
                  <div key={a.id}>{a.card_name} · {subject.get(a.subject_id)?.name ?? a.subject_name} <b>{money(a.amount)}</b>{a.end_rule === 'recall' && <> <Badge tone="warn">回收</Badge></>}
                    {num(a.used) > 0 && <span className="sub2">已用 {money(a.used)}</span>}</div>))}</td>
                <td className="r">{editable && <button className="ghost sm" onClick={async () => { let sug: Suggest = null; try { sug = await rpc('suggest_allocation', { id: l.id }) as Suggest; } catch { sug = null; } setAct(allocAct(l, p, sug)); }}>{mine.length ? '修改' : '分配'}</button>}</td></tr>); }))}</tbody>
          </table></div>
        )}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={act.run} onClose={() => setAct(null)} />}
    </>
  );
}
