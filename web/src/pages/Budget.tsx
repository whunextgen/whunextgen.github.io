import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetLine, type BudgetModule, type BudgetPlan, type BudgetSource, type BudgetStage, type BudgetTier, type BudgetYear, type Card, type Me, type ModuleTopic, type Project, type ProjectBudget, type ResourcePick, type TierPick } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, Tile, day, money, num, today, type Field } from '../ui';
import { IssuePanel } from './Issue';
import { BudgetFlow, flowState } from './BudgetFlow';
import { amt, parse } from './Import';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 年度预算走到第几步：1 编方案、课题申请和评定，3 评定完成待下达，4 以后是执行和决算（2 是旧流程里报学校的几步，现已不用）
export const STEP_OF: Record<BudgetStage, number> = { declare: 1, summary: 2, approved: 2, applied: 2, granted: 3, fixed: 3, issued: 4, closed: 7 };
export const STAGE_TEXT: Record<BudgetStage, string> = {
  declare: '方案编制与课题申请中', summary: '财务岗汇总中', approved: '已批准，待报学校', applied: '已报学校，待批复',
  granted: '学校已批复，核定中', fixed: '评定完成，待下达到经费卡', issued: '已下达，执行中', closed: '已决算',
};
export const KIND: Record<Project['kind'], string> = { project: '课题', public: '中心公共开支' };
const PB: Record<ProjectBudget['status'] | 'none', [string, string]> = { none: ['未填报', ''], draft: ['填报中', 'warn'], submitted: ['已提交', 'ok'], returned: ['已退回', 'bad'] };
const Q = ['q1', 'q2', 'q3', 'q4'] as const;
const QN = ['1–3 月', '4–6 月', '7–9 月', '10–12 月'];
const opt = (v: string | null) => (v == null ? '—' : money(v));

// 预算编制：各课题、研究单元在这里填年度预算的明细。流程是：财务岗测算总预算、编档次，中心负责人批准方案；
// 课题申请档次并提交明细（明细须符合所选档次的金额和限制）；联席会议评定；评定完成后档次即上限、明细即核定的预算行，再下达到经费卡。
// 方案和评定在「总预算与档次」办，这一页办明细和下达。
export function BudgetPage({ me, start }: { me: Me; start: string }) {
  const staff = can(me, 'budget.compile');
  const director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ years: BudgetYear[]; projects: Project[]; cats: BudgetCategory[]; budgets: ProjectBudget[]; lines: BudgetLine[]; cards: Card[]; picks: ResourcePick[]; sopen: { year: number; project_id: string; can_withdraw: boolean }[];
    plans: BudgetPlan[]; sources: BudgetSource[]; modules: BudgetModule[]; tiers: BudgetTier[]; tpicks: TierPick[]; mtopics: ModuleTopic[] }>({
    plans: ['budget_plan'], sources: ['budget_source'], modules: ['budget_module'], tiers: ['budget_tier'], tpicks: ['tier_pick'], mtopics: ['module_topic'],
    years: ['budget_year'], projects: ['project'], cats: ['budget_category'], budgets: ['project_budget'], lines: ['budget_line'], cards: ['card'], picks: ['resource_pick'],
    sopen: ['special_budget_open'],
  });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.map((y) => y.year).sort((a, b) => b - a);
  const next = Number(today().slice(0, 4)) + 1;
  const openAct = (y?: BudgetYear): Act => ({
    title: y ? `修改 ${y.year} 年度预算申报截止日` : '启动新年度预算', submitLabel: y ? '保存' : '启动', hint: '启动后，财务岗在「总预算与档次」中测算总预算、编档次，中心负责人批准方案；截止日前各课题申请档次并提交明细，由联席会议评定。',
    fields: [...(y ? [] : [{ name: 'year', label: '年度', type: 'number', value: String(next) } as Field]), { name: 'due', label: '申报截止日', type: 'date', value: y ? day(y.due_date) : '' }],
    run: (v) => rpc('open_budget_year', { year: y?.year ?? Math.round(Number(v.year)), due_date: v.due }).then(reload),
  });
  const dialog = act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={act.run} onClose={() => setAct(null)} />;
  if (years.length === 0) return (
    <>
      <div className="top"><h2>预算编制</h2>{staff && <button onClick={() => setAct(openAct())}>启动 {next} 年度预算</button>}</div>
      <Empty>暂无已启动的年度预算。{staff ? '启动后先在「总预算与档次」中编制预算方案，方案批准后各课题申请档次并在此填报明细。' : '财务岗启动后，在此填报明细。'}</Empty>
      {dialog}
    </>
  );
  const year = years.includes(Number(start)) ? Number(start) : years[0];
  const y = data.years.find((x) => x.year === year)!;
  const step = STEP_OF[y.stage];
  const cat = new Map(data.cats.map((c) => [c.id, c]));
  const lines = data.lines.filter((l) => l.year === year);
  const budget = new Map(data.budgets.filter((b) => b.year === year).map((b) => [b.project_id, b]));
  // 本人负责的研究单元：研究单元不设预算行，在页上指明由所属课题的负责人填报
  const myUnits = data.projects.filter((p) => p.layer === 'paper' && p.active && p.owner_id === me.id && !budget.has(p.id));
  const projects = data.projects.filter((p) => (p.layer !== 'paper' || budget.has(p.id)) && (p.active || budget.has(p.id)))
    .sort((a, b) => Number(a.kind === 'public') - Number(b.kind === 'public') || a.code.localeCompare(b.code));
  const inSum = (l: BudgetLine) => budget.get(l.project_id)?.status === 'submitted';
  const tot = (rows: BudgetLine[], k: 'declared' | 'applied' | 'fixed' | typeof Q[number]) => rows.reduce((s, l) => s + num(l[k]), 0);
  const summed = lines.filter(inSum);
  const submitted = projects.filter((p) => budget.get(p.id)?.status === 'submitted').length;
  // 新流程：方案、档次、申请和评定
  const plan = data.plans.find((x) => x.year === year);
  const tiers = data.tiers.filter((t) => t.year === year), tpicks = data.tpicks.filter((k) => k.year === year);
  const modules = data.modules.filter((m) => m.year === year), sources = data.sources.filter((x) => x.year === year);
  const flow = flowState(y, plan, modules, tiers, tpicks);
  const legacy = ['summary', 'approved', 'applied', 'granted'].includes(y.stage);   // 旧流程里报学校的几步，只为已有的年度保留
  const tierOf = (id: string | null) => tiers.find((t) => t.id === id);
  // 某个课题或研究单元所属课题的档次情况
  const topicInfo = (p: Project) => {
    const big = p.parent_id ?? p.id;
    const filled = tot(lines.filter((l) => { const q = data.projects.find((x) => x.id === l.project_id); return l.project_id === big || q?.parent_id === big; }), 'declared');
    const direct = data.mtopics.find((m) => m.year === year && m.project_id === big);
    const k = tpicks.find((x) => x.project_id === big);
    return { big, filled, direct, k };
  };
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
  // 核定之后、整体下达之前：财务岗调整未下达课题的核定数（#111）
  const fixAct = (p: Project, l: BudgetLine): Act => ({ title: `调整核定数：${p.name} · ${l.purpose}`,
    hint: `申报 ${money(l.declared)}，当前核定 ${opt(l.fixed)}。调整后课题连同研究单元的核定数合计不得超过档次金额；调减到低于已分配到经费卡的数额时，自动收回多出的分配。调整记入预算调剂记录，课题负责人可见。`,
    fields: [{ name: 'amount', label: '核定数（元）', type: 'number', value: String(num(l.fixed ?? l.declared)) }, { name: 'note', label: '调整原因' }],
    submitLabel: '保存', run: (v) => rpc('adjust_fixed', { id: l.id, amount: v.amount, note: v.note }).then(reload) });
  const setBudget = (p: Project, action: string, note: string | null = null) => rpc('set_project_budget', { year, project_id: p.id, action, note }).then(reload);

  // 经费来源核对：到期回收的卡必须花完；学校 4 月才批复，之前只能用可结转的卡
  const live = data.cards.filter((c) => c.status === 'active');
  const recall = live.filter((c) => c.end_rule === 'recall' && day(c.settle_date ?? c.cutoff_date) >= `${year}-01-01`).sort((a, b) => day(a.cutoff_date).localeCompare(day(b.cutoff_date)));
  const carry = live.filter((c) => c.end_rule !== 'recall' && day(c.cutoff_date) >= `${year}-01-01`);
  const base = step >= 3 ? 'fixed' : step === 2 ? 'applied' : 'declared';
  const baseName = { declared: '明细合计', applied: '申请数', fixed: '核定数' }[base];
  const planned = tot(step === 1 ? lines : summed, base);
  const mustSpend = recall.reduce((s, c) => s + num(c.avail), 0);
  const early = tot(step === 1 ? lines : summed, 'q1');
  const carryAvail = carry.reduce((s, c) => s + num(c.avail), 0);


  return (
    <>
      <div className="top">
        <div className="crumb">{legacy ? STAGE_TEXT[y.stage] : flow.text}</div>
        <h2>{year} 年度预算</h2>
        {staff && <button className="ghost" onClick={() => setAct(openAct())}>启动新年度预算</button>}
      </div>
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 16 }}>{years.map((n) => <a key={n} className="btn sm" aria-current={n === year ? 'page' : undefined} href={`#/budget/${n}`}>{n}</a>)}</div>}

      <BudgetFlow y={y} staff={staff} plan={plan} sources={sources} modules={modules} tiers={tiers} picks={tpicks} />

      {staff && (
        <section className="card">
          <h3>本阶段工作</h3>
          {y.stage === 'declare' && !flow.published && <p className="hint">预算方案尚未批准。请先在「<a href={`#/plan/${year}`}>总预算与档次</a>」中测算总预算、给中心公共开支这样的课题直接确定金额、编好档次，由中心负责人批准后公布；批准后各课题才能申请档次。明细可以先填。</p>}
          {y.stage === 'declare' && flow.published && <p className="hint">方案已批准，申报截止日 {day(y.due_date)}。各课题在「<a href="#/apply">立项与延续申请</a>」中选档次，在本页填明细并提交；提交时按所选档次的金额和限制校验，填报有误的可退回重新填报。联席会议的评定结果由中心助理录入，中心负责人在「总预算与档次」中确认评定完成后，档次金额即课题的年度上限、提交的明细即核定的预算行，转入下达。已有 {tpicks.length} 个课题申请，{flow.undecided} 个待评定；{submitted} / {projects.length} 个课题和研究单元已提交明细。</p>}
          {y.stage === 'summary' && <p className="hint">在下表中逐行调整申请数，形成报学校的年度总预算草案。{director ? '确认无误后批准。' : '调整完成后提请中心负责人批准。'}</p>}
          {y.stage === 'approved' && <p className="hint">申请数已批准，合计 {money(tot(summed, 'applied'))}。在学校系统报送后，在此登记报送日期。</p>}
          {y.stage === 'applied' && <p className="hint">已于 {day(y.applied_on)} 报学校，申请数合计 {money(tot(summed, 'applied'))}。学校批复后录入批复数。</p>}
          {y.stage === 'granted' && <p className="hint">学校批复 {opt(y.granted_amount)}。按联席会议决定逐行填写核定数，合计不得超过年度总预算；{director ? '填写完成后确定年度总预算。' : '填写完成后提请中心负责人确定年度总预算。'}</p>}
          {y.stage === 'fixed' && <p className="hint">评定已完成，年度总预算 {opt(y.fixed_total)}。在下方将各行核定数分配至经费卡，全部分配完毕后下达。</p>}
          {y.stage === 'issued' && <p className="hint">预算已于 {day(y.issued_at)} 下达，各研究单元按预算提交支出申请。每三个月复盘一次，年末办理年度决算。<a href="#/review">前往年度决算</a></p>}
          {y.stage === 'closed' && <p className="hint">{year} 年度已于 {day(y.closed_at)} 决算，未使用的预算不结转。<a href="#/review">查看决算</a></p>}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {y.stage === 'declare' && <>
              <a className="btn" href={`#/plan/${year}`}>前往总预算与档次</a>
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
            {legacy ? <>
              <Tile k="申报数" v={money(tot(summed, 'declared'))} f={`${submitted} 个研究单元`} />
              <Tile k="申请数" v={money(tot(summed, 'applied'))} f="报学校数" />
              <Tile k="学校批复" v={opt(y.granted_amount)} f={y.granted_on ? day(y.granted_on) : '—'} />
              <Tile k="核定数" v={step >= 3 ? money(tot(summed, 'fixed')) : '—'} f={y.fixed_total ? `年度总预算 ${money(y.fixed_total)}` : '批复后确定'} />
            </> : <>
              <Tile k="年度总预算" v={flow.total > 0 ? money(flow.total) : '—'} f={flow.published ? '方案已批准' : '方案编制中'} />
              <Tile k="明细合计" v={money(tot(step === 1 ? lines : summed, 'declared'))} f={step === 1 ? `含填报中的；已提交 ${money(tot(summed, 'declared'))}` : `${submitted} 个课题和研究单元`}
                tone={flow.total > 0 && tot(summed, 'declared') > flow.total ? 'bad' : ''} />
              <Tile k="申请档次" v={`${tpicks.length} 个课题`} f={tpicks.length > 0 ? `已评定 ${tpicks.length - flow.undecided}，待评定 ${flow.undecided}` : flow.published ? '尚无课题申请' : '方案批准后开始'} />
              <Tile k="核定数" v={step >= 3 ? money(tot(summed, 'fixed')) : '—'} f={y.fixed_total ? `年度总预算 ${money(y.fixed_total)}` : '评定完成后确定'} />
            </>}
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
                <thead><tr><th>科目</th>{QN.map((n) => <th key={n} className="r">{n}</th>)}<th className="r">明细</th>{legacy && <th className="r">申请数</th>}<th className="r">核定数</th></tr></thead>
                <tbody>{data.cats.slice().sort((a, b) => a.sort - b.sort).map((c) => {
                  const rows = (step === 1 ? lines : summed).filter((l) => l.category_id === c.id); if (rows.length === 0) return null;
                  return <tr key={c.id}><td>{c.name}{c.labor && <span className="sub2">劳务类</span>}</td>{Q.map((k) => <td key={k} className="r">{money(tot(rows, k))}</td>)}
                    <td className="r">{money(tot(rows, 'declared'))}</td>{legacy && <td className="r">{money(tot(rows, 'applied'))}</td>}<td className="r">{step >= 3 ? money(tot(rows, 'fixed')) : '—'}</td></tr>; })}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}

      {staff && step >= 3 && y.stage !== 'granted' && <IssuePanel me={me} y={y} projects={projects} cats={data.cats} onStage={reload} />}

      {myUnits.length > 0 && <section className="card"><h3>本人负责的研究单元</h3>
        <p className="hint">年度预算只编在课题上，研究单元不单独填报。请把研究单元的预算交给所属课题的负责人，由其在课题的年度预算中填报。</p>
        <ul>{myUnits.map((u) => <li key={u.id}>{u.code} {u.name}：所属课题 <a href={`#/project/${u.parent_id}/${year}`}>{u.parent_code} {u.parent_name}</a>
          {(() => { const t = data.projects.find((x) => x.id === u.parent_id); return t?.owner_name ? `，负责人 ${t.owner_name}` : ''; })()}
          {(() => { const st = budget.get(u.parent_id ?? '')?.status; return st ? <> <Badge tone={PB[st][1]}>{PB[st][0]}</Badge></> : null; })()}</li>)}</ul>
      </section>}

      {!staff && myUnits.length === 0 && projects.filter((p) => p.mine).length === 0 && <Empty>本人名下暂无课题。年度预算只编在课题上，由课题负责人填报，研究单元使用所属课题的预算；新课题请在「<a href="#/apply">立项与延续申请</a>」中申请立项。</Empty>}

      {projects.filter((p) => p.mine).map((p) => {
        const b = budget.get(p.id); const rows = lines.filter((l) => l.project_id === p.id);
        // 已评定档次或特批的课题：年度核定后、下达前仍可补填明细，提交即核定（#92）
        const so = data.sopen.find((x) => x.year === y.year && x.project_id === p.id);
        const special = !!so && (b?.status !== 'submitted' || so.can_withdraw);
        const editable = (y.stage === 'declare' || special) && b?.status !== 'submitted';
        const adjustable = staff && b?.status === 'submitted' && (y.stage === 'summary' || y.stage === 'granted');
        const refixable = staff && y.stage === 'fixed' && b?.status === 'submitted' && !b.issued_at;
        const isPublic = p.kind === 'public';
        const [st, tone] = PB[b?.status ?? 'none'];
        const ti = topicInfo(p), kt = tierOf(ti.k?.tier_id ?? null), dt = tierOf(ti.k?.decided_tier_id ?? null);
        return (
          <section className="card" key={p.id} id={`p-${p.id}`}>
            <h3>{p.name} <Badge tone={tone}>{st}</Badge></h3>
            <p className="hint">{p.code} · {KIND[p.kind]}{p.owner_name ? ` · 负责人 ${p.owner_name}` : ''}{b?.submitted_at ? ` · ${b.submitted_by_name ?? ''} ${day(b.submitted_at)} ${b.status === 'submitted' ? '提交' : '提交过，已撤回或退回'}` : ''}</p>
            {!legacy && (ti.direct
              ? <p className="hint">金额由预算方案直接确定：{money(ti.direct.amount)}，不参加档次评定。课题连同研究单元已填明细 {money(ti.filled)}，合计不得超过这个金额。</p>
              : ti.k ? <p className="hint">{ti.k.kind === 'new' ? '立项' : '延续'}申请「{kt?.name ?? '—'}」{kt ? money(kt.amount) : ''}，
                  {ti.k.rejected ? <Badge tone="bad">联席会议不予通过</Badge> : dt ? <Badge tone="ok">已评定为「{dt.name}」{money(dt.amount)}</Badge> : <Badge tone="warn">待评定</Badge>}
                  {' '}课题连同研究单元已填明细 {money(ti.filled)}；提交时按{dt ? '评定' : '所选'}档次的金额和限制校验。</p>
              : y.stage === 'declare' && p.kind !== 'public' ? <div className="msg warn" role="status">{flow.published
                  ? <>该课题尚未申请档次。请先在「<a href="#/apply">立项与延续申请</a>」中选择档次，再提交明细。</>
                  : '预算方案尚未批准公布，批准后才能申请档次。明细可以先填，申请档次后再提交。'}</div> : null)}
            {b?.status === 'returned' && <div className="msg bad">财务岗退回：{b.return_note}</div>}
            {special && (isPublic
              ? <div className="msg warn" role="status">公共课题不评档次，申报截止后由财务岗补填明细；提交即按明细核定，下达前可以撤回修改。</div>
              : <div className="msg warn" role="status">本课题的档次已评定（或由中心负责人特批），年度预算下达前可以补填明细；提交时按档次的金额和限制校验，通过即核定，下达时与其他课题一并分到经费卡上。</div>)}
            {staff && y.stage === 'fixed' && b?.issued_at && <p className="hint">本课题已按课题下达。如需调整核定数，请先在下方「按课题审核下达」中撤销下达（尚无支出时可以撤销），调整后再审核下达。</p>}
            {rows.length === 0 ? <Empty>{y.stage === 'declare' ? '尚未填报明细。' : '未填报明细。'}</Empty> : (
              <div className="scroll"><table className="tight">
                <thead><tr><th>科目</th><th>用途</th>{QN.map((n) => <th key={n} className="r">{n}</th>)}<th className="r">明细</th>{legacy && <th className="r">申请数</th>}<th className="r">核定数</th><th /></tr></thead>
                <tbody>{rows.map((l) => (
                  <tr key={l.id}><td>{cat.get(l.category_id)?.name ?? '—'}</td>
                    <td className="wrap">{l.purpose}{l.resource_id && <span className="sub2 blk">资源计划：{planText(l)}</span>}{l.adjust_note && <span className="sub2">调整：{l.adjust_note}</span>}</td>
                    {Q.map((k) => <td key={k} className="r">{num(l[k]) > 0 ? money(l[k]) : '—'}</td>)}
                    <td className="r">{money(l.declared)}</td>
                    {legacy && <td className={`r ${l.applied != null && num(l.applied) !== num(l.declared) ? 'chg' : ''}`}>{opt(l.applied)}</td>}
                    <td className={`r ${l.fixed != null && num(l.fixed) !== num(l.declared) ? 'chg' : ''}`}>{opt(l.fixed)}</td>
                    <td className="r nowrap">
                      {editable && <><button className="ghost sm" onClick={() => setAct(lineAct(p, l))}>修改</button>{' '}
                        <button className="ghost sm" onClick={() => setAct({ title: `删除预算行：${l.purpose}`, fields: [], danger: true, submitLabel: '删除', run: () => rpc('delete_budget_line', { id: l.id }).then(reload) })}>删除</button></>}
                      {adjustable && <button className="ghost sm" onClick={() => setAct(adjustAct(p, l))}>{y.stage === 'granted' ? '核定' : '调整'}</button>}
                      {refixable && <button className="ghost sm" onClick={() => setAct(fixAct(p, l))}>调整核定数</button>}
                      {staff && !editable && b?.status === 'submitted' && y.stage !== 'closed' && <>{' '}<button className="ghost sm" onClick={() => setAct(planAct(p, l))}>资源计划</button></>}
                    </td></tr>
                ))}</tbody>
                <tfoot><tr><td colSpan={2}>合计</td>{Q.map((k) => <td key={k} className="r">{money(tot(rows, k))}</td>)}
                  <td className="r">{money(tot(rows, 'declared'))}</td>{legacy && <td className="r">{rows.some((l) => l.applied != null) ? money(tot(rows, 'applied')) : '—'}</td>}
                  <td className="r">{rows.some((l) => l.fixed != null) ? money(tot(rows, 'fixed')) : '—'}</td><td /></tr></tfoot>
              </table></div>
            )}
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              {editable && <button className="ghost" onClick={() => setAct(lineAct(p))}>新增预算行</button>}
              {editable && <><button className="ghost" onClick={() => setAct(pasteAct(p))}>整表导入</button><a className="btn ghost" href={TEMPLATE} download={`年度预算模板-${year}.csv`}>下载模板</a></>}
              {editable && rows.length > 0 && <button onClick={() => setAct({ title: `提交 ${p.name} 的 ${year} 年度预算`, hint: `明细合计 ${money(tot(rows, 'declared'))}。提交时按所申请档次的金额和限制校验；提交后不可修改，评定完成前可撤回。`, fields: [], submitLabel: '提交', run: () => setBudget(p, 'submit') })}>提交</button>}
              {(y.stage === 'declare' || !!so?.can_withdraw) && b?.status === 'submitted' && <button className="ghost" onClick={() => setAct({ title: '撤回修改', hint: '撤回后可修改，修改后须重新提交。', fields: [], submitLabel: '撤回', run: () => setBudget(p, 'withdraw') })}>撤回修改</button>}
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
