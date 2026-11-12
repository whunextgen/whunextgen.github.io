import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetLine, type BudgetStage, type BudgetYear, type Card, type Me, type Project, type ProjectBudget } from '../api';
import { ActionDialog, Badge, Empty, Loading, Tile, day, money, num, today, type Field } from '../ui';
import { IssuePanel } from './Issue';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 年度预算走到第几步：1 申报，2 汇总报批，3 核定下达，4 以后是执行和决算
export const STEP_OF: Record<BudgetStage, number> = { declare: 1, summary: 2, approved: 2, applied: 2, granted: 3, fixed: 3, issued: 4, closed: 7 };
export const STAGE_TEXT: Record<BudgetStage, string> = {
  declare: '各项目申报中', summary: '财务岗汇总中', approved: '已批准，待报学校', applied: '已报学校，等批复',
  granted: '学校已批复，核定中', fixed: '已核定，待下达到经费卡', issued: '已下达，执行中', closed: '已决算',
};
export const KIND: Record<Project['kind'], string> = { project: '研究项目', line: '独立研究线', public: '中心公共开支' };
const PB: Record<ProjectBudget['status'] | 'none', [string, string]> = { none: ['未填', ''], draft: ['填写中', 'warn'], submitted: ['已提交', 'ok'], returned: ['被退回', 'bad'] };
const Q = ['q1', 'q2', 'q3', 'q4'] as const;
const QN = ['1–3 月', '4–6 月', '7–9 月', '10–12 月'];
const opt = (v: string | null) => (v == null ? '—' : money(v));

// 预算：一个年度从申报、汇总报批到核定下达，都在这一页。每一行并排三个数：申报数、申请数、核定数。
export function BudgetPage({ me, start }: { me: Me; start: string }) {
  const staff = me.role === 'finance' || me.role === 'director';
  const director = me.role === 'director';
  const { data, error, reload } = useViews<{ years: BudgetYear[]; projects: Project[]; cats: BudgetCategory[]; budgets: ProjectBudget[]; lines: BudgetLine[]; cards: Card[] }>({
    years: ['budget_year'], projects: ['project'], cats: ['budget_category'], budgets: ['project_budget'], lines: ['budget_line'], cards: ['card'],
  });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.map((y) => y.year).sort((a, b) => b - a);
  const next = Number(today().slice(0, 4)) + 1;
  const openAct = (y?: BudgetYear): Act => ({
    title: y ? `改 ${y.year} 年度预算的申报截止日` : '开始一个年度的预算', hint: '截止日之前各项目自己填、自己提交；到期由财务岗截止申报，进入汇总。',
    fields: [...(y ? [] : [{ name: 'year', label: '年度', type: 'number', value: String(next) } as Field]), { name: 'due', label: '申报截止日', type: 'date', value: y ? day(y.due_date) : '' }],
    run: (v) => rpc('open_budget_year', { year: y?.year ?? Math.round(Number(v.year)), due_date: v.due }).then(reload),
  });
  const dialog = act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={act.run} onClose={() => setAct(null)} />;
  if (years.length === 0) return (
    <>
      <div className="top"><h2>年度预算</h2>{staff && <button onClick={() => setAct(openAct())}>开始 {next} 年度预算</button>}</div>
      <Empty>还没有开始任何年度的预算。{staff ? '定一个申报截止日，各项目就可以开始填。' : '财务岗开始之后，这里会出现申报表。'}</Empty>
      {dialog}
    </>
  );
  const year = years.includes(Number(start)) ? Number(start) : years[0];
  const y = data.years.find((x) => x.year === year)!;
  const step = STEP_OF[y.stage];
  const cat = new Map(data.cats.map((c) => [c.id, c]));
  const lines = data.lines.filter((l) => l.year === year);
  const budget = new Map(data.budgets.filter((b) => b.year === year).map((b) => [b.project_id, b]));
  const projects = data.projects.filter((p) => p.active || budget.has(p.id))
    .sort((a, b) => Number(a.kind === 'public') - Number(b.kind === 'public') || a.code.localeCompare(b.code));
  const inSum = (l: BudgetLine) => budget.get(l.project_id)?.status === 'submitted';
  const tot = (rows: BudgetLine[], k: 'declared' | 'applied' | 'fixed' | typeof Q[number]) => rows.reduce((s, l) => s + num(l[k]), 0);
  const summed = lines.filter(inSum);
  const submitted = projects.filter((p) => budget.get(p.id)?.status === 'submitted').length;
  const go = (action: string, extra: Record<string, unknown> = {}) => rpc('advance_budget_year', { year, action, amount: null, on_date: null, ...extra }).then(reload);

  const lineAct = (p: Project, l?: BudgetLine): Act => ({
    title: l ? `改一行：${p.name}` : `加一行预算：${p.name}`, hint: '按三个月一期填。哪一期用就填在哪一期，不用的留空。',
    fields: [{ name: 'category', label: '科目', options: data.cats.filter((c) => c.active || c.id === l?.category_id).sort((a, b) => a.sort - b.sort).map((c) => [c.id, c.name]), value: l?.category_id },
      { name: 'purpose', label: '做什么用', value: l?.purpose },
      ...Q.map((k, i): Field => ({ name: k, label: `${QN[i]}（元）`, type: 'number', required: false, value: l && num(l[k]) > 0 ? String(num(l[k])) : '' }))],
    submitLabel: '保存',
    run: (v) => rpc('save_budget_line', { id: l?.id ?? null, year, project_id: p.id, category_id: v.category, purpose: v.purpose, q1: v.q1 || 0, q2: v.q2 || 0, q3: v.q3 || 0, q4: v.q4 || 0 }).then(reload),
  });
  const adjustAct = (p: Project, l: BudgetLine): Act => {
    const fixing = y.stage === 'granted';
    return { title: `${fixing ? '核定数' : '申请数'}：${p.name} · ${l.purpose}`,
      hint: fixing ? `申报 ${money(l.declared)}，申请 ${opt(l.applied)}。核定数按联席会议的决定填。` : `申报 ${money(l.declared)}。申请数和申报数不一样时要写原因，项目负责人看得到。`,
      fields: [{ name: 'amount', label: `${fixing ? '核定数' : '申请数'}（元）`, type: 'number', value: String(num(fixing ? l.fixed ?? l.applied : l.applied ?? l.declared)) },
        ...(fixing ? [] : [{ name: 'note', label: '调整原因', required: false, value: l.adjust_note ?? '' } as Field])],
      submitLabel: '保存', run: (v) => rpc('adjust_budget_line', { id: l.id, amount: v.amount, note: v.note ?? null }).then(reload) };
  };
  const setBudget = (p: Project, action: string, note: string | null = null) => rpc('set_project_budget', { year, project_id: p.id, action, note }).then(reload);

  // 经费来源核对：到期回收的卡必须花完；学校 4 月才批复，之前只能用可结转的卡
  const live = data.cards.filter((c) => c.status === 'active');
  const recall = live.filter((c) => c.end_rule === 'recall' && day(c.settle_date ?? c.cutoff_date) >= `${year}-01-01`).sort((a, b) => day(a.cutoff_date).localeCompare(day(b.cutoff_date)));
  const carry = live.filter((c) => c.end_rule !== 'recall' && day(c.cutoff_date) >= `${year}-01-01`);
  const base = step >= 3 ? 'fixed' : step === 2 ? 'applied' : 'declared';
  const baseName = { declared: '申报数', applied: '申请数', fixed: '核定数' }[base];
  const planned = tot(step === 1 ? lines : summed, base);
  const mustSpend = recall.reduce((s, c) => s + num(c.avail), 0);
  const early = tot(step === 1 ? lines : summed, 'q1');
  const carryAvail = carry.reduce((s, c) => s + num(c.avail), 0);

  const steps = [
    { no: '01', name: '申报', on: step === 1, done: step > 1, lines: [`截止 ${day(y.due_date)}`, `${submitted} / ${projects.length} 个项目已提交`] },
    { no: '02', name: '汇总报批', on: step === 2, done: step > 2, lines: step < 2 ? ['财务岗汇总成年度总预算草案', '中心负责人批准后报学校']
      : [y.approved_at ? `${y.approved_by_name ?? '中心负责人'} ${day(y.approved_at)} 批准` : '等中心负责人批准', y.applied_on ? `${day(y.applied_on)} 报学校` : '还没报学校'] },
    { no: '03', name: '核定下达', on: step === 3, done: step > 3, lines: step < 3 ? ['学校批复后，在批复总额内定各项目预算', '下达后才能支出']
      : [staff ? `学校批复 ${opt(y.granted_amount)}（${day(y.granted_on)}）` : `学校 ${day(y.granted_on)} 批复`, y.stage === 'granted' ? '各项目核定数待确定' : staff ? `年度总预算 ${opt(y.fixed_total)}` : '年度总预算已确定',
        ...(y.stage === 'fixed' ? ['待下达到经费卡'] : y.issued_at ? [`${day(y.issued_at)} 下达`] : [])] },
  ];

  return (
    <>
      <div className="top">
        <div className="crumb">{STAGE_TEXT[y.stage]}</div>
        <h2>{year} 年度预算</h2>
        {staff && <button className="ghost" onClick={() => setAct(openAct())}>开始新年度</button>}
      </div>
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 16 }}>{years.map((n) => <a key={n} className="btn sm" aria-current={n === year ? 'page' : undefined} href={`#/budget/${n}`}>{n}</a>)}</div>}

      <ol className="steps3">
        {steps.map((s) => (
          <li key={s.no} className={s.on ? 'on' : s.done ? 'done' : ''}>
            <span className="no">{s.no}</span><span className="nm">{s.name}{s.on && <Badge tone="pri">现在</Badge>}{s.done && <Badge tone="ok">完成</Badge>}</span>
            {s.lines.map((t) => <span key={t} className="ds">{t}</span>)}
          </li>
        ))}
      </ol>

      {staff && (
        <section className="card">
          <h3>这一步要做的</h3>
          {y.stage === 'declare' && <p className="hint">申报截止日 {day(y.due_date)}。到期后截止申报，没提交的项目不进汇总；截止前可以把填得不对的退回去重填。</p>}
          {y.stage === 'summary' && <p className="hint">在下面的表里逐行调整申请数，凑成报学校的年度总预算草案。{director ? '确认无误后批准。' : '调好后请中心负责人批准。'}</p>}
          {y.stage === 'approved' && <p className="hint">申请数已批准，合计 {money(tot(summed, 'applied'))}。到学校系统里报送后，在这里登记报送日期。</p>}
          {y.stage === 'applied' && <p className="hint">已于 {day(y.applied_on)} 报学校，申请数合计 {money(tot(summed, 'applied'))}。学校批复后录入批复数。</p>}
          {y.stage === 'granted' && <p className="hint">学校批复 {opt(y.granted_amount)}。按联席会议的决定逐行填核定数，合计不能超过年度总预算；{director ? '填好后确定年度总预算。' : '填好后请中心负责人确定年度总预算。'}</p>}
          {y.stage === 'fixed' && <p className="hint">年度总预算 {opt(y.fixed_total)} 已确定。在下面把每一行核定数对到经费卡上，全部对完后下达。</p>}
          {y.stage === 'issued' && <p className="hint">预算已于 {day(y.issued_at)} 下达，各项目按预算提交支出。每三个月复盘一次，年末做年度决算。<a href="#/review">去复盘与决算</a></p>}
          {y.stage === 'closed' && <p className="hint">{year} 年度已于 {day(y.closed_at)} 决算，未用的预算不结转。<a href="#/review">看决算</a></p>}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {y.stage === 'declare' && <>
              <button onClick={() => setAct({ title: `截止 ${year} 年度预算申报`, hint: `${submitted} 个项目已提交，${projects.length - submitted} 个没有提交。截止后没提交的不进汇总。`, fields: [], submitLabel: '截止申报', run: () => go('close') })}>截止申报，开始汇总</button>
              <button className="ghost" onClick={() => setAct(openAct(y))}>改截止日</button></>}
            {y.stage === 'summary' && <>
              {director && <button onClick={() => setAct({ title: `批准 ${year} 年度预算申请数`, hint: `申请数合计 ${money(tot(summed, 'applied'))}，申报数合计 ${money(tot(summed, 'declared'))}。批准后财务岗按这个数报学校。`, fields: [], submitLabel: '批准', run: () => go('approve') })}>批准申请数</button>}
              <button className="ghost" onClick={() => setAct({ title: '退回申报阶段', hint: '各项目可以重新修改和提交；已经调整的申请数会清空。', fields: [], danger: true, submitLabel: '退回', run: () => go('reopen') })}>退回申报阶段</button></>}
            {y.stage === 'approved' && <>
              <button onClick={() => setAct({ title: '登记已报学校', fields: [{ name: 'on', label: '报送日期', type: 'date', value: today() }], run: (v) => go('apply', { on_date: v.on }) })}>登记已报学校</button>
              {director && <button className="ghost" onClick={() => setAct({ title: '撤回批准', hint: '回到汇总阶段，财务岗可以继续调整申请数。', fields: [], danger: true, submitLabel: '撤回', run: () => go('reopen') })}>撤回批准</button>}</>}
            {(y.stage === 'applied' || y.stage === 'granted') &&
              <button className={y.stage === 'granted' ? 'ghost' : ''} onClick={() => setAct({ title: y.stage === 'granted' ? '改学校批复数' : '录入学校批复数', fields: [{ name: 'amount', label: '批复数（元）', type: 'number', value: y.granted_amount ? String(num(y.granted_amount)) : '' }, { name: 'on', label: '批复日期', type: 'date', value: day(y.granted_on) === '—' ? today() : day(y.granted_on) }],
                run: (v) => go('grant', { amount: v.amount, on_date: v.on }) })}>{y.stage === 'granted' ? '改批复数' : '录入学校批复数'}</button>}
            {y.stage === 'granted' && director &&
              <button onClick={() => setAct({ title: `确定 ${year} 年度总预算`, hint: `各项目核定数合计 ${money(tot(summed, 'fixed'))}，学校批复 ${opt(y.granted_amount)}。`, fields: [{ name: 'amount', label: '年度总预算（元）', type: 'number', value: String(num(y.granted_amount)) }], submitLabel: '确定',
                run: (v) => go('fix', { amount: v.amount }) })}>确定年度总预算</button>}
          </div>
        </section>
      )}

      {staff && (
        <>
          <div className="tiles">
            <Tile k="申报数" v={money(tot(step === 1 ? lines : summed, 'declared'))} f={step === 1 ? `含填写中的；已提交 ${money(tot(summed, 'declared'))}` : `${submitted} 个项目`} />
            <Tile k="申请数" v={step >= 2 ? money(tot(summed, 'applied')) : '—'} f={step >= 2 ? '报学校的数' : '截止申报后生成'} />
            <Tile k="学校批复" v={opt(y.granted_amount)} f={y.granted_on ? day(y.granted_on) : '学校一般 4 月批复'} />
            <Tile k="核定数" v={step >= 3 ? money(tot(summed, 'fixed')) : '—'} f={y.fixed_total ? `年度总预算 ${money(y.fixed_total)}` : '批复后确定'}
              tone={step >= 3 && y.granted_amount != null && tot(summed, 'fixed') > num(y.granted_amount) ? 'bad' : ''} />
          </div>
          <section className="card">
            <h3>经费来源核对</h3>
            <p className="hint">两件事要在编预算时就对上：到期回收的经费卡必须在节点前花完；学校的年度经费 4 月才批复下来，之前的支出只能从可结转的卡里出。下面用{baseName}来比。</p>
            <div className="scroll"><table>
              <thead><tr><th>核对项</th><th className="r">要求</th><th className="r">预算安排</th><th className="r">差额</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td>到期回收的卡要花完<span className="sub2">{recall.length === 0 ? '没有跨到这一年的回收卡' : recall.map((c) => `${c.name}（${day(c.settle_date ?? c.cutoff_date)}）`).join('、')}</span></td>
                  <td className="r">{money(mustSpend)}</td><td className="r">{money(planned)}</td>
                  <td className={`r ${planned < mustSpend ? 'neg' : ''}`}>{money(planned - mustSpend)}</td>
                  <td>{recall.length === 0 ? '—' : planned < mustSpend ? <Badge tone="bad">预算不够把回收卡花完</Badge> : <Badge tone="ok">够</Badge>}</td></tr>
                <tr><td>批复前（1–3 月）的支出<span className="sub2">只能从可结转的卡里出：{carry.length === 0 ? '没有可结转的卡' : carry.map((c) => c.name).join('、')}</span></td>
                  <td className="r">{money(early)}</td><td className="r">{money(carryAvail)}</td>
                  <td className={`r ${carryAvail < early ? 'neg' : ''}`}>{money(carryAvail - early)}</td>
                  <td>{early === 0 ? '—' : carryAvail < early ? <Badge tone="bad">可结转的钱不够垫</Badge> : <Badge tone="ok">够</Badge>}</td></tr>
              </tbody>
            </table></div>
            <p className="hint">回收卡的要求取各卡现在的可用额；1–3 月的预算安排取可结转卡现在的可用额。差额怎么处理由联席会议定。</p>
          </section>
          <section className="card">
            <h3>按科目汇总</h3>
            {summed.length + (step === 1 ? lines.length : 0) === 0 ? <Empty>还没有预算行。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>科目</th>{QN.map((n) => <th key={n} className="r">{n}</th>)}<th className="r">申报数</th><th className="r">申请数</th><th className="r">核定数</th></tr></thead>
                <tbody>{data.cats.slice().sort((a, b) => a.sort - b.sort).map((c) => {
                  const rows = (step === 1 ? lines : summed).filter((l) => l.category_id === c.id); if (rows.length === 0) return null;
                  return <tr key={c.id}><td>{c.name}{c.labor && <span className="sub2">劳务类</span>}</td>{Q.map((k) => <td key={k} className="r">{money(tot(rows, k))}</td>)}
                    <td className="r">{money(tot(rows, 'declared'))}</td><td className="r">{step >= 2 ? money(tot(rows, 'applied')) : '—'}</td><td className="r">{step >= 3 ? money(tot(rows, 'fixed')) : '—'}</td></tr>; })}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}

      {staff && step >= 3 && y.stage !== 'granted' && <IssuePanel me={me} y={y} projects={projects} cats={data.cats} onStage={reload} />}

      {!staff && projects.filter((p) => p.mine).length === 0 && <Empty>你名下没有项目。项目的年度预算由项目负责人填；需要新立项目请联系财务岗。</Empty>}

      {projects.filter((p) => p.mine).map((p) => {
        const b = budget.get(p.id); const rows = lines.filter((l) => l.project_id === p.id);
        const editable = y.stage === 'declare' && b?.status !== 'submitted';
        const adjustable = staff && b?.status === 'submitted' && (y.stage === 'summary' || y.stage === 'granted');
        const [st, tone] = PB[b?.status ?? 'none'];
        return (
          <section className="card" key={p.id} id={`p-${p.id}`}>
            <h3>{p.name} <Badge tone={tone}>{st}</Badge></h3>
            <p className="hint">{p.code} · {KIND[p.kind]}{p.owner_name ? ` · 负责人 ${p.owner_name}` : ''}{b?.submitted_at ? ` · ${b.submitted_by_name ?? ''} ${day(b.submitted_at)} 提交` : ''}</p>
            {b?.status === 'returned' && <div className="msg bad">财务岗退回：{b.return_note}</div>}
            {rows.length === 0 ? <Empty>{y.stage === 'declare' ? '还没有填。' : '这个项目没有申报。'}</Empty> : (
              <div className="scroll"><table className="tight">
                <thead><tr><th>科目</th><th>做什么用</th>{QN.map((n) => <th key={n} className="r">{n}</th>)}<th className="r">申报数</th><th className="r">申请数</th><th className="r">核定数</th><th /></tr></thead>
                <tbody>{rows.map((l) => (
                  <tr key={l.id}><td>{cat.get(l.category_id)?.name ?? '—'}</td>
                    <td className="wrap">{l.purpose}{l.adjust_note && <span className="sub2">申请数调整：{l.adjust_note}</span>}</td>
                    {Q.map((k) => <td key={k} className="r">{num(l[k]) > 0 ? money(l[k]) : '—'}</td>)}
                    <td className="r">{money(l.declared)}</td>
                    <td className={`r ${l.applied != null && num(l.applied) !== num(l.declared) ? 'chg' : ''}`}>{opt(l.applied)}</td>
                    <td className={`r ${l.fixed != null && num(l.fixed) !== num(l.applied) ? 'chg' : ''}`}>{opt(l.fixed)}</td>
                    <td className="r nowrap">
                      {editable && <><button className="ghost sm" onClick={() => setAct(lineAct(p, l))}>改</button>{' '}
                        <button className="ghost sm" onClick={() => setAct({ title: `删掉这一行：${l.purpose}`, fields: [], danger: true, submitLabel: '删除', run: () => rpc('delete_budget_line', { id: l.id }).then(reload) })}>删</button></>}
                      {adjustable && <button className="ghost sm" onClick={() => setAct(adjustAct(p, l))}>{y.stage === 'granted' ? '核定' : '调整'}</button>}
                    </td></tr>
                ))}</tbody>
                <tfoot><tr><td colSpan={2}>合计</td>{Q.map((k) => <td key={k} className="r">{money(tot(rows, k))}</td>)}
                  <td className="r">{money(tot(rows, 'declared'))}</td><td className="r">{rows.some((l) => l.applied != null) ? money(tot(rows, 'applied')) : '—'}</td>
                  <td className="r">{rows.some((l) => l.fixed != null) ? money(tot(rows, 'fixed')) : '—'}</td><td /></tr></tfoot>
              </table></div>
            )}
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              {editable && <button className="ghost" onClick={() => setAct(lineAct(p))}>加一行</button>}
              {editable && rows.length > 0 && <button onClick={() => setAct({ title: `提交 ${p.name} 的 ${year} 年度预算`, hint: `申报数合计 ${money(tot(rows, 'declared'))}。提交后不能再改；截止前可以撤回。`, fields: [], submitLabel: '提交', run: () => setBudget(p, 'submit') })}>提交</button>}
              {y.stage === 'declare' && b?.status === 'submitted' && <button className="ghost" onClick={() => setAct({ title: '撤回修改', hint: '撤回后可以修改，改完要重新提交。', fields: [], submitLabel: '撤回', run: () => setBudget(p, 'withdraw') })}>撤回修改</button>}
              {staff && y.stage === 'declare' && b?.status === 'submitted' &&
                <button className="ghost" onClick={() => setAct({ title: `退回 ${p.name} 的预算`, fields: [{ name: 'note', label: '退回原因' }], danger: true, submitLabel: '退回', run: (v) => setBudget(p, 'return', v.note) })}>退回重填</button>}
            </div>
          </section>
        );
      })}
      {dialog}
    </>
  );
}
