import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetLine, type BudgetStage, type BudgetYear, type Card, type Me, type Project, type ProjectBudget, type ResourcePick } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, Tile, day, money, num, today, type Field } from '../ui';
import { IssuePanel } from './Issue';
import { amt, parse } from './Import';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 年度预算走到第几步：1 申报，2 汇总报批，3 核定下达，4 以后是执行和决算
export const STEP_OF: Record<BudgetStage, number> = { declare: 1, summary: 2, approved: 2, applied: 2, granted: 3, fixed: 3, issued: 4, closed: 7 };
export const STAGE_TEXT: Record<BudgetStage, string> = {
  declare: '各研究单元申报中', summary: '财务岗汇总中', approved: '已批准，待报学校', applied: '已报学校，待批复',
  granted: '学校已批复，核定中', fixed: '已核定，待下达到经费卡', issued: '已下达，执行中', closed: '已决算',
};
export const KIND: Record<Project['kind'], string> = { project: '课题', line: '独立研究线', public: '中心公共开支' };
const PB: Record<ProjectBudget['status'] | 'none', [string, string]> = { none: ['未填报', ''], draft: ['填报中', 'warn'], submitted: ['已提交', 'ok'], returned: ['已退回', 'bad'] };
const Q = ['q1', 'q2', 'q3', 'q4'] as const;
const QN = ['1–3 月', '4–6 月', '7–9 月', '10–12 月'];
const opt = (v: string | null) => (v == null ? '—' : money(v));

// 预算：一个年度从申报、汇总报批到核定下达，都在这一页。每一行并排三个数：申报数、申请数、核定数。
export function BudgetPage({ me, start }: { me: Me; start: string }) {
  const staff = can(me, 'budget.compile');
  const director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ years: BudgetYear[]; projects: Project[]; cats: BudgetCategory[]; budgets: ProjectBudget[]; lines: BudgetLine[]; cards: Card[]; picks: ResourcePick[] }>({
    years: ['budget_year'], projects: ['project'], cats: ['budget_category'], budgets: ['project_budget'], lines: ['budget_line'], cards: ['card'], picks: ['resource_pick'],
  });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.map((y) => y.year).sort((a, b) => b - a);
  const next = Number(today().slice(0, 4)) + 1;
  const openAct = (y?: BudgetYear): Act => ({
    title: y ? `修改 ${y.year} 年度预算申报截止日` : '启动新年度预算', hint: '截止日前由各研究单元自行填报并提交；到期后由财务岗截止申报，进入汇总。',
    fields: [...(y ? [] : [{ name: 'year', label: '年度', type: 'number', value: String(next) } as Field]), { name: 'due', label: '申报截止日', type: 'date', value: y ? day(y.due_date) : '' }],
    run: (v) => rpc('open_budget_year', { year: y?.year ?? Math.round(Number(v.year)), due_date: v.due }).then(reload),
  });
  const dialog = act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={act.run} onClose={() => setAct(null)} />;
  if (years.length === 0) return (
    <>
      <div className="top"><h2>预算编制</h2>{staff && <button onClick={() => setAct(openAct())}>启动 {next} 年度预算</button>}</div>
      <Empty>暂无已启动的年度预算。{staff ? '设定申报截止日后，各研究单元即可开始填报。' : '财务岗启动后，此处显示申报表。'}</Empty>
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

  const resOpts = (p: Project) => data.picks.filter((r) => p.kind !== 'public' || r.kind === 'asset').map((r): [string, string] => [r.id, `${r.kind === 'api' ? '接口额度' : '资产'} · ${r.name}${r.unit ? `（${r.unit}）` : ''}`]);
  const planText = (l: BudgetLine) => `${l.resource_name} ${num(l.plan_qty).toLocaleString('zh-CN')}${l.resource_unit ? ` ${l.resource_unit}` : ''}`;
  const setPlan = (id: string, l: BudgetLine | undefined, v: Record<string, string>) =>
    (v.resource || l?.resource_id) && (v.resource !== (l?.resource_id ?? '') || Number(v.plan_qty || 0) !== num(l?.plan_qty))
      ? rpc('set_line_resource', { line_id: id, resource_id: v.resource || null, qty: v.resource ? v.plan_qty : null }) : null;
  const planFields = (p: Project, l?: BudgetLine): Field[] => [
    { name: 'resource', label: p.kind === 'public' ? '该预算行拟配置的公共设备（供博士后、博士、硕士、研究助理个人申领；不涉及的留空）' : '该预算行拟使用的资源（接口额度、设备；不涉及的留空）', options: resOpts(p), required: false, value: l?.resource_id ?? '' },
    { name: 'plan_qty', label: '全年计划数量（已选资源时必填）', type: 'number', required: false, value: l?.plan_qty != null ? String(num(l.plan_qty)) : '' }];
  const planAct = (p: Project, l: BudgetLine): Act => ({
    title: `资源计划：${p.name} · ${l.purpose}`, submitLabel: '保存',
    hint: '预算提交后，资源计划仅财务岗可调整，一般在季度复盘时修改。数量不得低于已申请数量；已有申请的计划不得取消或更换资源。',
    fields: planFields(p, l), run: async (v) => { await setPlan(l.id, l, v); reload(); },
  });
  const lineAct = (p: Project, l?: BudgetLine): Act => ({
    title: l ? `修改预算行：${p.name}` : `新增预算行：${p.name}`, hint: '按三个月一期填报。金额填入实际使用的期次，不使用的期次留空。该预算行用于购置接口额度、设备或耗材的，须同时填写资源和全年计划数量：此后的资源申请只能关联到有资源计划的预算行，数量不得超过计划。',
    fields: [{ name: 'category', label: '科目', options: data.cats.filter((c) => c.active || c.id === l?.category_id).sort((a, b) => a.sort - b.sort).map((c) => [c.id, c.name]), value: l?.category_id },
      { name: 'purpose', label: '用途', value: l?.purpose },
      ...Q.map((k, i): Field => ({ name: k, label: `${QN[i]}（元）`, type: 'number', required: false, value: l && num(l[k]) > 0 ? String(num(l[k])) : '' })),
      ...planFields(p, l)],
    submitLabel: '保存',
    run: async (v) => {
      if (v.resource && !(Number(v.plan_qty) > 0)) throw new Error('已选资源时须填写全年计划数量。');
      const id = await rpc('save_budget_line', { id: l?.id ?? null, year, project_id: p.id, category_id: v.category, purpose: v.purpose, q1: v.q1 || 0, q2: v.q2 || 0, q3: v.q3 || 0, q4: v.q4 || 0 });
      try { await setPlan(l?.id ?? String(id), l, v); } finally { reload(); }
    },
  });
  // 整表粘贴：一行一条预算，列依次是 科目、做什么用、四期金额；和下载的模板同一个格式
  const TEMPLATE = `data:text/csv;charset=utf-8,${encodeURIComponent(`\ufeff科目,用途,${QN.join(',')}\n${data.cats.filter((c) => c.active).sort((a, b) => a.sort - b.sort).map((c) => `${c.name},,,,,`).join('\n')}\n`)}`;
  const pasteAct = (p: Project): Act => ({
    title: `整表导入：${p.name}`, submitLabel: '导入',
    hint: `在 Excel 中按模板填写，选中数据复制后粘贴至此处。每行依次为：科目、用途、${QN.join('、')}。科目须与中台预算科目同名（${data.cats.filter((c) => c.active).map((c) => c.name).join('、')}）；表头行和金额全空的行自动跳过。导入为追加方式，不覆盖已填报的行。`,
    fields: [{ name: 'text', label: '粘贴内容', type: 'area' }],
    run: async (v) => {
      const cat = new Map(data.cats.filter((c) => c.active).map((c) => [c.name.trim(), c.id]));
      const rows = parse(v.text).filter((r) => r[0] !== '科目').map((r, i) => ({ i: i + 1, cat: cat.get(r[0] ?? ''), name: r[0], purpose: r[1] ?? '', q: [2, 3, 4, 5].map((k) => (r[k] ? amt(r[k]) : 0)) }))
        .filter((r) => r.q.some((x) => x !== 0));
      if (rows.length === 0) throw new Error('未读取到含金额的行。');
      const bad = rows.find((r) => !r.cat || !r.purpose || r.q.some((x) => x == null || x < 0));
      if (bad) throw new Error(`第 ${bad.i} 行：${!bad.cat ? `预算科目「${bad.name}」不存在` : !bad.purpose ? '未填写用途' : '金额非数字'}。全部未导入，请修改后重新粘贴。`);
      let n = 0;
      try { for (const r of rows) { await rpc('save_budget_line', { id: null, year, project_id: p.id, category_id: r.cat, purpose: r.purpose, q1: r.q[0], q2: r.q[1], q3: r.q[2], q4: r.q[3] }); n++; } }
      catch (e) { reload(); throw new Error(`第 ${rows[n].i} 行：${(e as Error).message}${n ? `（前 ${n} 行已导入）` : ''}`); }
      reload();
    },
  });
  const adjustAct = (p: Project, l: BudgetLine): Act => {
    const fixing = y.stage === 'granted';
    return { title: `${fixing ? '核定数' : '申请数'}：${p.name} · ${l.purpose}`,
      hint: fixing ? `申报 ${money(l.declared)}，申请 ${opt(l.applied)}。核定数按联席会议决定填写。` : `申报 ${money(l.declared)}。申请数与申报数不一致时须填写原因，研究单元负责人可见。`,
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
    { no: '01', name: '申报', on: step === 1, done: step > 1, lines: [`截止 ${day(y.due_date)}`, `${submitted} / ${projects.length} 个研究单元已提交`] },
    { no: '02', name: '汇总报批', on: step === 2, done: step > 2, lines: step < 2 ? ['财务岗汇总形成年度总预算草案', '中心负责人批准后报学校']
      : [y.approved_at ? `${y.approved_by_name ?? '中心负责人'} ${day(y.approved_at)} 批准` : '待中心负责人批准', y.applied_on ? `${day(y.applied_on)} 报学校` : '尚未报学校'] },
    { no: '03', name: '核定下达', on: step === 3, done: step > 3, lines: step < 3 ? ['学校批复后，在批复总额内核定各研究单元预算', '下达后方可支出']
      : [staff ? `学校批复 ${opt(y.granted_amount)}（${day(y.granted_on)}）` : `学校 ${day(y.granted_on)} 批复`, y.stage === 'granted' ? '各研究单元核定数待确定' : staff ? `年度总预算 ${opt(y.fixed_total)}` : '年度总预算已确定',
        ...(y.stage === 'fixed' ? ['待下达到经费卡'] : y.issued_at ? [`${day(y.issued_at)} 下达`] : [])] },
  ];

  return (
    <>
      <div className="top">
        <div className="crumb">{STAGE_TEXT[y.stage]}</div>
        <h2>{year} 年度预算</h2>
        {staff && <button className="ghost" onClick={() => setAct(openAct())}>启动新年度预算</button>}
      </div>
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 16 }}>{years.map((n) => <a key={n} className="btn sm" aria-current={n === year ? 'page' : undefined} href={`#/budget/${n}`}>{n}</a>)}</div>}

      <ol className="steps3">
        {steps.map((s) => (
          <li key={s.no} className={s.on ? 'on' : s.done ? 'done' : ''}>
            <span className="no">{s.no}</span><span className="nm">{s.name}{s.on && <Badge tone="pri">当前</Badge>}{s.done && <Badge tone="ok">已完成</Badge>}</span>
            {s.lines.map((t) => <span key={t} className="ds">{t}</span>)}
          </li>
        ))}
      </ol>

      {staff && (
        <section className="card">
          <h3>本阶段工作</h3>
          {y.stage === 'declare' && <p className="hint">申报截止日 {day(y.due_date)}。到期后截止申报，未提交的研究单元不纳入汇总；截止前可将填报有误的预算退回重新填报。</p>}
          {y.stage === 'summary' && <p className="hint">在下表中逐行调整申请数，形成报学校的年度总预算草案。{director ? '确认无误后批准。' : '调整完成后提请中心负责人批准。'}</p>}
          {y.stage === 'approved' && <p className="hint">申请数已批准，合计 {money(tot(summed, 'applied'))}。在学校系统报送后，在此登记报送日期。</p>}
          {y.stage === 'applied' && <p className="hint">已于 {day(y.applied_on)} 报学校，申请数合计 {money(tot(summed, 'applied'))}。学校批复后录入批复数。</p>}
          {y.stage === 'granted' && <p className="hint">学校批复 {opt(y.granted_amount)}。按联席会议决定逐行填写核定数，合计不得超过年度总预算；{director ? '填写完成后确定年度总预算。' : '填写完成后提请中心负责人确定年度总预算。'}</p>}
          {y.stage === 'fixed' && <p className="hint">年度总预算 {opt(y.fixed_total)} 已确定。在下方将各行核定数分配至经费卡，全部分配完毕后下达。</p>}
          {y.stage === 'issued' && <p className="hint">预算已于 {day(y.issued_at)} 下达，各研究单元按预算提交支出申请。每三个月复盘一次，年末办理年度决算。<a href="#/review">前往年度决算</a></p>}
          {y.stage === 'closed' && <p className="hint">{year} 年度已于 {day(y.closed_at)} 决算，未使用的预算不结转。<a href="#/review">查看决算</a></p>}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {y.stage === 'declare' && <>
              <button onClick={() => setAct({ title: `截止 ${year} 年度预算申报`, hint: `${submitted} 个研究单元已提交，${projects.length - submitted} 个尚未提交。截止后未提交的不纳入汇总。`, fields: [], submitLabel: '截止申报', run: () => go('close') })}>截止申报，开始汇总</button>
              <button className="ghost" onClick={() => setAct(openAct(y))}>修改截止日</button></>}
            {y.stage === 'summary' && <>
              {director && <button onClick={() => setAct({ title: `批准 ${year} 年度预算申请数`, hint: `申请数合计 ${money(tot(summed, 'applied'))}，申报数合计 ${money(tot(summed, 'declared'))}。批准后财务岗按此数报学校。`, fields: [], submitLabel: '批准', run: () => go('approve') })}>批准申请数</button>}
              <button className="ghost" onClick={() => setAct({ title: '退回申报阶段', hint: '各研究单元可重新修改并提交；已调整的申请数将清空。', fields: [], danger: true, submitLabel: '退回', run: () => go('reopen') })}>退回申报阶段</button></>}
            {y.stage === 'approved' && <>
              <button onClick={() => setAct({ title: '登记已报学校', fields: [{ name: 'on', label: '报送日期', type: 'date', value: today() }], run: (v) => go('apply', { on_date: v.on }) })}>登记已报学校</button>
              {director && <button className="ghost" onClick={() => setAct({ title: '撤回批准', hint: '退回汇总阶段，财务岗可继续调整申请数。', fields: [], danger: true, submitLabel: '撤回', run: () => go('reopen') })}>撤回批准</button>}</>}
            {(y.stage === 'applied' || y.stage === 'granted') &&
              <button className={y.stage === 'granted' ? 'ghost' : ''} onClick={() => setAct({ title: y.stage === 'granted' ? '修改学校批复数' : '录入学校批复数', fields: [{ name: 'amount', label: '批复数（元）', type: 'number', value: y.granted_amount ? String(num(y.granted_amount)) : '' }, { name: 'on', label: '批复日期', type: 'date', value: day(y.granted_on) === '—' ? today() : day(y.granted_on) }],
                run: (v) => go('grant', { amount: v.amount, on_date: v.on }) })}>{y.stage === 'granted' ? '修改批复数' : '录入学校批复数'}</button>}
            {y.stage === 'granted' && director &&
              <button onClick={() => setAct({ title: `确定 ${year} 年度总预算`, hint: `各研究单元核定数合计 ${money(tot(summed, 'fixed'))}，学校批复 ${opt(y.granted_amount)}。`, fields: [{ name: 'amount', label: '年度总预算（元）', type: 'number', value: String(num(y.granted_amount)) }], submitLabel: '确定',
                run: (v) => go('fix', { amount: v.amount }) })}>确定年度总预算</button>}
          </div>
        </section>
      )}

      {staff && (
        <>
          <div className="tiles">
            <Tile k="申报数" v={money(tot(step === 1 ? lines : summed, 'declared'))} f={step === 1 ? `含填报中的；已提交 ${money(tot(summed, 'declared'))}` : `${submitted} 个研究单元`} />
            <Tile k="申请数" v={step >= 2 ? money(tot(summed, 'applied')) : '—'} f={step >= 2 ? '报学校数' : '截止申报后生成'} />
            <Tile k="学校批复" v={opt(y.granted_amount)} f={y.granted_on ? day(y.granted_on) : '学校一般 4 月批复'} />
            <Tile k="核定数" v={step >= 3 ? money(tot(summed, 'fixed')) : '—'} f={y.fixed_total ? `年度总预算 ${money(y.fixed_total)}` : '批复后确定'}
              tone={step >= 3 && y.granted_amount != null && tot(summed, 'fixed') > num(y.granted_amount) ? 'bad' : ''} />
          </div>
          <section className="card">
            <h3>经费来源核对</h3>
            <p className="hint">编制预算时须核对两项：到期回收的经费卡须在节点前使用完毕；学校年度经费 4 月批复，此前的支出只能由可结转的经费卡列支。以下按{baseName}比较。</p>
            <div className="scroll"><table>
              <thead><tr><th>核对项</th><th className="r">要求</th><th className="r">预算安排</th><th className="r">差额</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td>到期回收的经费卡须使用完毕<span className="sub2">{recall.length === 0 ? '无跨入本年度的回收经费卡' : recall.map((c) => `${c.name}（${day(c.settle_date ?? c.cutoff_date)}）`).join('、')}</span></td>
                  <td className="r">{money(mustSpend)}</td><td className="r">{money(planned)}</td>
                  <td className={`r ${planned < mustSpend ? 'neg' : ''}`}>{money(planned - mustSpend)}</td>
                  <td>{recall.length === 0 ? '—' : planned < mustSpend ? <Badge tone="bad">预算不足以用完回收经费卡</Badge> : <Badge tone="ok">充足</Badge>}</td></tr>
                <tr><td>批复前（1–3 月）的支出<span className="sub2">只能由可结转的经费卡列支：{carry.length === 0 ? '无可结转的经费卡' : carry.map((c) => c.name).join('、')}</span></td>
                  <td className="r">{money(early)}</td><td className="r">{money(carryAvail)}</td>
                  <td className={`r ${carryAvail < early ? 'neg' : ''}`}>{money(carryAvail - early)}</td>
                  <td>{early === 0 ? '—' : carryAvail < early ? <Badge tone="bad">可结转资金不足以垫付</Badge> : <Badge tone="ok">充足</Badge>}</td></tr>
              </tbody>
            </table></div>
            <p className="hint">回收经费卡的要求取各卡当前可用额；1–3 月的预算安排取可结转经费卡当前可用额。差额的处理由联席会议决定。</p>
          </section>
          <section className="card">
            <h3>按科目汇总</h3>
            {summed.length + (step === 1 ? lines.length : 0) === 0 ? <Empty>暂无预算行。</Empty> : (
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

      {!staff && projects.filter((p) => p.mine).length === 0 && <Empty>本人名下暂无研究单元。研究单元年度预算由研究单元负责人填报；需新立研究单元请联系财务岗。</Empty>}

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
            {rows.length === 0 ? <Empty>{y.stage === 'declare' ? '尚未填报。' : '该研究单元未申报。'}</Empty> : (
              <div className="scroll"><table className="tight">
                <thead><tr><th>科目</th><th>用途</th>{QN.map((n) => <th key={n} className="r">{n}</th>)}<th className="r">申报数</th><th className="r">申请数</th><th className="r">核定数</th><th /></tr></thead>
                <tbody>{rows.map((l) => (
                  <tr key={l.id}><td>{cat.get(l.category_id)?.name ?? '—'}</td>
                    <td className="wrap">{l.purpose}{l.resource_id && <span className="sub2 blk">资源计划：{planText(l)}</span>}{l.adjust_note && <span className="sub2">申请数调整：{l.adjust_note}</span>}</td>
                    {Q.map((k) => <td key={k} className="r">{num(l[k]) > 0 ? money(l[k]) : '—'}</td>)}
                    <td className="r">{money(l.declared)}</td>
                    <td className={`r ${l.applied != null && num(l.applied) !== num(l.declared) ? 'chg' : ''}`}>{opt(l.applied)}</td>
                    <td className={`r ${l.fixed != null && num(l.fixed) !== num(l.applied) ? 'chg' : ''}`}>{opt(l.fixed)}</td>
                    <td className="r nowrap">
                      {editable && <><button className="ghost sm" onClick={() => setAct(lineAct(p, l))}>修改</button>{' '}
                        <button className="ghost sm" onClick={() => setAct({ title: `删除预算行：${l.purpose}`, fields: [], danger: true, submitLabel: '删除', run: () => rpc('delete_budget_line', { id: l.id }).then(reload) })}>删除</button></>}
                      {adjustable && <button className="ghost sm" onClick={() => setAct(adjustAct(p, l))}>{y.stage === 'granted' ? '核定' : '调整'}</button>}
                      {staff && !editable && b?.status === 'submitted' && y.stage !== 'closed' && <>{' '}<button className="ghost sm" onClick={() => setAct(planAct(p, l))}>资源计划</button></>}
                    </td></tr>
                ))}</tbody>
                <tfoot><tr><td colSpan={2}>合计</td>{Q.map((k) => <td key={k} className="r">{money(tot(rows, k))}</td>)}
                  <td className="r">{money(tot(rows, 'declared'))}</td><td className="r">{rows.some((l) => l.applied != null) ? money(tot(rows, 'applied')) : '—'}</td>
                  <td className="r">{rows.some((l) => l.fixed != null) ? money(tot(rows, 'fixed')) : '—'}</td><td /></tr></tfoot>
              </table></div>
            )}
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              {editable && <button className="ghost" onClick={() => setAct(lineAct(p))}>新增预算行</button>}
              {editable && <><button className="ghost" onClick={() => setAct(pasteAct(p))}>整表导入</button><a className="btn ghost" href={TEMPLATE} download={`年度预算模板-${year}.csv`}>下载模板</a></>}
              {editable && rows.length > 0 && <button onClick={() => setAct({ title: `提交 ${p.name} 的 ${year} 年度预算`, hint: `申报数合计 ${money(tot(rows, 'declared'))}。提交后不可修改；截止前可撤回。`, fields: [], submitLabel: '提交', run: () => setBudget(p, 'submit') })}>提交</button>}
              {y.stage === 'declare' && b?.status === 'submitted' && <button className="ghost" onClick={() => setAct({ title: '撤回修改', hint: '撤回后可修改，修改后须重新提交。', fields: [], submitLabel: '撤回', run: () => setBudget(p, 'withdraw') })}>撤回修改</button>}
              {staff && y.stage === 'declare' && b?.status === 'submitted' &&
                <button className="ghost" onClick={() => setAct({ title: `退回 ${p.name} 的预算`, fields: [{ name: 'note', label: '退回原因' }], danger: true, submitLabel: '退回', run: (v) => setBudget(p, 'return', v.note) })}>退回重新填报</button>}
            </div>
          </section>
        );
      })}
      {dialog}
    </>
  );
}
