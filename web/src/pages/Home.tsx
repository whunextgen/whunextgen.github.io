import { useState } from 'react';
import { useViews, type BudgetAlloc, type BudgetLine, type BudgetShift, type BudgetYear, type CapRequest, type Card, type CardPick, type Cell, type FundProject, type Project, type ProjectBudget, type ProjectCap, type FundEvent, type LineExec, type Me, type Node, type PettyCash, type Req, type ReqStatus, type ResourceRequest, type Task } from '../api';
import { Badge, Empty, END_RULE, Flow, FUND_SOURCE, Loading, can, reqBadge, ROLE, day, money, num, pct, today } from '../ui';
import { Track, TreeNode, execSegs, type Seg } from '../tree';
import { cardRisk, nodeState } from './Overview';
import { KIND, STAGE_TEXT, STEP_OF } from './Budget';
import { taskDue } from './Tasks';

const wan = (x: number) => `${(x / 1e4).toFixed(Math.abs(x) >= 1e6 ? 0 : 1)} 万`;
const OPEN: ReqStatus[] = ['pending', 'committed', 'at_school', 'returned'];

// 工作台：先是本年度可用额度和待办事项，再按层级展开 项目 › 经费卡 › 明细 和 课题 › 研究单元 › 预算行
const STEPS = ['申报', '汇总报批', '核定下达', '申请', '承诺', '入账', '复盘结清'];
export function Home({ me }: { me: Me }) {
  const seesCards = can(me, 'read.finance') || me.scoped?.includes('card.read');
  const { data, error } = useViews<{ reqs: Req[]; picks: CardPick[]; cards: Card[]; nodes: Node[]; events: FundEvent[];
    years: BudgetYear[]; projects: Project[]; budgets: ProjectBudget[]; lines: BudgetLine[]; exec: LineExec[]; petty: PettyCash[]; res: ResourceRequest[]; caps: CapRequest[]; shifts: BudgetShift[]; tasks: Task[];
    funds: FundProject[]; cells: Cell[]; allocs: BudgetAlloc[]; pcaps: ProjectCap[] }>({
    reqs: ['request'], picks: ['card_pick'], cards: ['card'], nodes: ['node'], events: ['fund_event', { done: 'false' }],
    years: ['budget_year'], projects: ['project'], budgets: ['project_budget'], lines: ['budget_line'], exec: ['line_exec'], petty: ['petty_cash'], res: ['resource_request'], caps: ['cap_request'], shifts: ['budget_shift'], tasks: ['task', { status: 'open' }],
    funds: ['fund_project'], cells: ['cell'], allocs: ['budget_alloc'], pcaps: ['project_cap'],
  });
  const [tab, setTab] = useState<'todo' | 'mine'>('todo');
  if (!data) return <Loading error={error} />;
  const now = today();
  const active = data.cards.filter((c) => c.status === 'active');
  const of = (s: ReqStatus) => data.reqs.filter((r) => r.status === s);
  const amt = (rows: Req[]) => rows.reduce((s, r) => s + num(r.status === 'posted' ? r.posted_amount ?? r.amount : r.amount), 0);
  const pending = of('pending'), committed = of('committed'), atSchool = of('at_school'), returned = of('returned'), posted = of('posted');
  const buying = committed.filter((r) => r.path && r.stage != null && r.stages != null && r.stage < r.stages);
  const ready = committed.filter((r) => !buying.includes(r));
  const to = (path: string, status: ReqStatus) => (seesCards ? path : `#/requests/${status}`);

  const stages = [
    { name: '申请', desc: '先申请、后支出；研究单元负责人确认，财务岗核对', v: `${pending.length} 笔`, f: `待确认、核对 ${money(amt(pending))}`, href: '#/requests/pending' },
    { name: '承诺', desc: '批准后占用额度；涉及采购的完成采购', v: `${committed.length} 笔`, f: `已占用 ${money(amt(committed))}${buying.length ? ` · ${buying.length} 笔采购中` : ''}`, href: to('#/school/procure', 'committed') },
    { name: '入账', desc: '单据提交学校，以学校正式入账计入决算', v: `${atSchool.length} 笔`, f: `学校审核中 ${money(amt(atSchool))}${returned.length ? ` · ${returned.length} 笔已退回` : ''} · 已入账 ${posted.length} 笔`, href: to('#/school', 'at_school') },
  ];

  // 每个预算年度走到哪一步。今年没有走过预算编制的，按执行中算
  const thisYear = Number(now.slice(0, 4));
  const yearRows = [...new Set([thisYear, ...data.years.map((y) => y.year)])].sort((a, b) => b - a).map((year) => {
    const y = data.years.find((x) => x.year === year);
    const budgeting = y && STEP_OF[y.stage] <= 3;
    const at = budgeting ? STEP_OF[y.stage] : year > thisYear ? 3 : year < thisYear ? 7 : 4;
    const span = budgeting ? 1 : year === thisYear ? 3 : 1;   // 执行的三步同时在走
    const text = budgeting ? `${STAGE_TEXT[y.stage]}${y.stage === 'declare' ? `，${day(y.due_date)} 截止` : ''}` : year === thisYear ? '执行中' : year < thisYear ? '已结束' : STAGE_TEXT[y!.stage];
    return { year, at, span, text, href: budgeting ? `#/budget/${year}` : year === thisYear ? '#/requests' : seesCards ? '#/settle' : `#/budget/${year}` };
  });

  // 轮到当前这个人做的事
  const byId = new Map(data.cards.map((c) => [c.card_id, c]));
  const todo: { tone: string; tag: string; text: string; go: string; href: string }[] = [];
  // 派给自己的任务排在最前，先到期的在上
  for (const t of data.tasks.filter((x) => x.mine).sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))) {
    const [dueText, dueTone] = taskDue(t, now);
    todo.push({ tone: dueTone || 'pri', tag: '任务', text: `${t.title}${t.steps > 0 ? `，${t.steps_done} / ${t.steps} 步` : ''}，${dueText}${t.created_by !== me.id && t.creator_name ? ` · ${t.creator_name} 指派` : ''}`, go: '办理', href: '#/tasks' });
  }
  for (const y of data.years) {
    const b = new Map(data.budgets.filter((x) => x.year === y.year).map((x) => [x.project_id, x]));
    const href = `#/budget/${y.year}`;
    if (y.stage === 'declare') {
      for (const p of data.projects.filter((x) => x.active && x.owner_id === me.id)) {
        const st = b.get(p.id)?.status;
        if (st === 'returned') todo.push({ tone: 'bad', tag: '预算已退回', text: `${p.name} 的 ${y.year} 年度预算被财务岗退回：${b.get(p.id)!.return_note ?? ''}`, go: '修改', href });
        else if (st !== 'submitted') todo.push({ tone: 'warn', tag: '待申报', text: `${p.name} 的 ${y.year} 年度预算尚未提交，${day(y.due_date)} 截止`, go: '填报', href });
      }
      if (can(me, 'budget.compile') && !can(me, 'budget.approve')) {
        const all = data.projects.filter((x) => x.active), done = all.filter((x) => b.get(x.id)?.status === 'submitted').length;
        todo.push({ tone: day(y.due_date) <= now ? 'warn' : 'pri', tag: '年度预算', text: `${y.year} 年度预算申报 ${day(y.due_date)} 截止，${done} / ${all.length} 个研究单元已提交`, go: day(y.due_date) <= now ? '截止申报' : '查看进度', href });
      }
    }
    const total = (k: 'applied' | 'fixed') => money(data.lines.filter((l) => l.year === y.year).reduce((s, l) => s + num(l[k]), 0));
    if (y.stage === 'summary') todo.push(can(me, 'budget.approve') ? { tone: 'warn', tag: '待审批', text: `${y.year} 年度预算申请数合计 ${total('applied')}，待审批后报学校`, go: '审批', href }
      : can(me, 'budget.compile') ? { tone: 'pri', tag: '年度预算', text: `${y.year} 年度预算汇总中，申请数合计 ${total('applied')}，调整后提请中心负责人批准`, go: '汇总', href } : null!);
    if (y.stage === 'approved' && can(me, 'budget.compile') && !can(me, 'budget.approve')) todo.push({ tone: 'warn', tag: '待报学校', text: `${y.year} 年度预算申请数已批准，报学校后登记报送日期`, go: '登记', href });
    if (y.stage === 'applied' && can(me, 'budget.compile') && !can(me, 'budget.approve')) todo.push({ tone: 'pri', tag: '待学校批复', text: `${y.year} 年度预算已于 ${day(y.applied_on)} 报学校，批复后录入批复数`, go: '录入', href });
    if (y.stage === 'granted') todo.push(can(me, 'budget.approve') ? { tone: 'warn', tag: '待确认', text: `${y.year} 年度学校已批复，各研究单元核定数合计 ${total('fixed')}，待确认年度总预算`, go: '确认', href }
      : can(me, 'budget.compile') ? { tone: 'warn', tag: '待核定', text: `${y.year} 年度学校已批复，按联席会议决定填写各研究单元核定数`, go: '核定', href } : null!);
  }
  for (let i = todo.length - 1; i >= 0; i--) if (!todo[i]) todo.splice(i, 1);
  const add = (rows: Req[], tone: string, tag: string, what: string, go: string, href: string) => {
    if (rows.length > 0) todo.push({ tone, tag, text: `${rows.length} 笔${what}，合计 ${money(amt(rows))}`, go, href });
  };
  add(pending.filter((r) => r.can_confirm), 'warn', '待确认', '支出申请属本人负责的研究单元，待确认', '确认', '#/requests/mine');
  if (can(me, 'request.approve')) {
    add(pending.filter((r) => r.step === 'director' && num(r.over_amount) > 0), 'bad', '超预算待批', '支出超出预算行，待审批', '审批', '#/requests/mine');
    add(pending.filter((r) => !r.step || (r.step === 'director' && !(num(r.over_amount) > 0))), 'warn', '待审批', '支出申请待审批', '审批', '#/requests/mine');
  }
  if (can(me, 'budget.approve')) {
    for (const c of data.caps.filter((x) => x.status === 'pending')) todo.push({ tone: 'warn', tag: '上限调整', text: `${c.project_name} 申请将 ${c.year} 年上限由 ${money(c.cap)} 调整为 ${money(c.amount)}`, go: '审批', href: '#/caps' });
    for (const s of data.shifts.filter((x) => x.status === 'pending')) todo.push({ tone: 'warn', tag: '预算调剂', text: `${s.project_name} 申请由「${s.from_purpose}」调剂 ${money(s.amount)} 至「${s.to_purpose}」，全年累计超过年度预算的 10%`, go: '审批', href: `#/review/${s.year}` });
  }
  if (can(me, 'request.process')) {
    add(pending.filter((r) => r.step === 'check'), 'warn', '待核对', '支出申请研究单元负责人已确认，待核对', '核对', '#/requests/mine');
    add(ready, 'warn', '待提交学校', '已核对的申请待提交单据至学校', '提交', '#/requests/committed');
    add(buying, 'pri', '采购中', '采购尚未进入验收', '推进', '#/school/procure');
    add(atSchool, 'pri', '待回写', '单据在学校审核，入账后回写', '回写', '#/school');
  }
  if (can(me, 'request.process', 'request.adjust')) add(returned, 'bad', '已退回', '单据学校退回，变更经费卡或释放', '处理', '#/requests/returned');
  if (can(me, 'card.fund') && data.events.length > 0) todo.push({ tone: 'warn', tag: '待办', text: `${data.events.length} 笔到账认领或借票核销未办理`, go: '处理', href: '#/school' });
  // 备用金和资源申请里轮到自己的
  const count = (n: number, tone: string, tag: string, text: string, go: string, href: string) => { if (n > 0) todo.push({ tone, tag, text: `${n} 笔${text}`, go, href }); };
  const pettyOf = (st: PettyCash['status']) => data.petty.filter((r) => r.status === st);
  const resOf = (st: ResourceRequest['status']) => data.res.filter((r) => r.status === st);
  if (can(me, 'petty.approve')) count(pettyOf('pending').length, 'warn', '待审批', `备用金申请待审批，合计 ${money(pettyOf('pending').reduce((t, r) => t + num(r.amount), 0))}`, '审批', '#/petty');
  if (can(me, 'petty.settle')) {
    count(pettyOf('approved').length, 'pri', '待核销', `备用金已领用尚未核销，合计 ${money(pettyOf('approved').reduce((t, r) => t + num(r.amount), 0))}`, '核销', '#/petty');
    count(resOf('reviewed').length, 'warn', '资源待批准', '资源申请研究单元负责人已批示，待批准', '审批', '#/pool');
    count(resOf('approved').length, 'warn', '资源待分发', '资源申请已批准，待分发', '分发', '#/pool');
  }
  count(resOf('pending').filter((r) => r.my_project && r.requested_by !== me.id).length, 'warn', '待批示', '资源申请属本人负责的研究单元，待批示', '批示', '#/resource');
  if (seesCards) {
    for (const c of active.filter((x) => num(x.avail) < 0))
      todo.push({ tone: 'bad', tag: '超支', text: `${c.name} ${c.year} 年经费卡可用为 ${money(c.avail)}`, go: '查看', href: `#/card/${c.card_id}` });
    for (const n of data.nodes.filter((x) => byId.get(x.card_id)?.status === 'active').sort((a, b) => a.node_date.localeCompare(b.node_date))) {
      const s = nodeState(n, now); if (s.gap <= 0) continue;
      todo.push({ tone: s.tone, tag: s.text, text: `${byId.get(n.card_id)!.name}：${day(n.node_date)} 节点要求 ${money(n.need)}，预测 ${money(n.forecast)}，差额 ${money(s.gap)}`, go: '查看', href: `#/card/${n.card_id}` });
    }
    for (const c of active) {
      const k = cardRisk(c, now); if (k.level !== 'bad') continue;
      todo.push({ tone: 'bad', tag: '执行预警', text: `${c.name} ${c.year} 年经费卡：时间进度 ${k.timePct}，执行 ${k.execPct}，预计至截止日结余 ${money(k.left)}（${END_RULE[c.end_rule]}）`, go: '查看', href: `#/card/${c.card_id}` });
    }
    for (const c of active.filter((x) => day(x.cutoff_date) >= now && (Date.parse(day(x.cutoff_date)) - Date.parse(now)) / 864e5 <= 30))
      todo.push({ tone: 'warn', tag: '临近截止', text: `${c.name} ${c.year} 年经费卡单据截止 ${day(c.cutoff_date)}，尚有可用 ${money(c.avail)}`, go: '查看', href: `#/card/${c.card_id}` });
  }
  const mine = data.reqs.filter((r) => r.requested_by === me.id);
  const mineBack = mine.filter((r) => r.status === 'returned');
  if (!can(me, 'request.process', 'request.adjust')) add(mineBack, 'bad', '已退回', '本人申请学校退回，财务岗处理中', '查看', '#/requests/returned');
  const mineOpen = mine.filter((r) => OPEN.includes(r.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cardName = new Map(data.picks.map((c) => [c.id, c.name]));

  // ---------- 本年度可用额度 ----------
  const yearCards = active.filter((c) => c.year === thisYear);
  const ysum = (k: 'cur' | 'actual' | 'commit' | 'avail') => yearCards.reduce((s, c) => s + num(c[k]), 0);
  const cur = ysum('cur'), actual = ysum('actual'), commit = ysum('commit'), avail = ysum('avail');
  const y0 = Date.parse(`${thisYear}-01-01`), y1 = Date.parse(`${thisYear + 1}-01-01`);
  const timeNow = Math.min(1, Math.max(0, (Date.parse(now) - y0) / (y1 - y0)));
  const funds = data.funds.filter((p) => !p.auto && p.status === 'active');
  const quotaSum = funds.reduce((s, p) => s + num(p.quota), 0), unapplied = funds.reduce((s, p) => s + (p.quota != null ? Math.max(num(p.quota) - num(p.granted), 0) : 0), 0);
  const recall = yearCards.filter((c) => c.end_rule !== 'carry').reduce((s, c) => s + cardRisk(c, now).left, 0);

  // ---------- 项目 › 经费卡 › 明细 ----------
  const loose = data.cards.filter((c) => data.funds.find((p) => p.id === c.project_id)?.auto).length;
  const projName = new Map(data.projects.map((p) => [p.id, p.name]));
  const cardStatus = (c: Card): [string, string] | null => {
    if (c.status === 'settled') return ['', num(c.carried_out) > 0 ? `已结清，结转 ${money(c.carried_out)}` : num(c.recalled) > 0 ? `已结清，回收 ${money(c.recalled)}` : '已结清'];
    if (num(c.avail) < 0) return ['bad', `超支 ${money(-num(c.avail))}`];
    const k = cardRisk(c, now);
    if (k.level === 'bad') return ['bad', `执行进度滞后，预计结余 ${money(k.left)}（${END_RULE[c.end_rule]}）`];
    if (k.level === 'warn') return ['warn', '执行进度偏慢'];
    return null;
  };
  const fundNodes = [...funds].sort((a, b) => (a.period_end ?? '9').localeCompare(b.period_end ?? '9') || a.name.localeCompare(b.name, 'zh')).map((p, pi) => {
    const cs = data.cards.filter((c) => c.project_id === p.id).sort((a, b) => b.year - a.year);
    const granted = num(p.granted), quota = p.quota != null ? num(p.quota) : null;
    const segs: Seg[] = [...cs].reverse().map((c, i) => { const g = num(c.orig) - num(c.carried_in);
      return { cls: i % 2 ? 'sy1' : 'sy0', value: g, text: `${c.year} 年 ${wan(g)}`, tip: `${c.year} 年经费卡下达 ${money(g)}${quota ? `，占额度 ${pct(g, quota)}` : ''}` }; });
    if (quota != null && quota > granted) segs.push({ cls: 'hatch', value: quota - granted, text: `尚未申请 ${wan(quota - granted)}`, tip: `尚未申请 ${money(quota - granted)}，占额度 ${pct(quota - granted, quota)}；不属于当年可用经费` });
    const meta = [p.source && FUND_SOURCE[p.source], p.period_start || p.period_end ? `${day(p.period_start).slice(0, 4)}—${day(p.period_end).slice(0, 4)}` : '', p.owner_name && `负责人 ${p.owner_name}`].filter(Boolean).join(' · ');
    const noCard = !cs.some((c) => c.year === thisYear);
    return (
      <TreeNode key={p.id} level={1} lv="项目" title={p.name} meta={meta} open={pi === 0}
        chart={segs.length > 0 ? <Track cap={quota != null ? '额度构成 · 各年度已下达与尚未申请' : '各年度已下达 · 额度尚未填写'} segs={segs} /> : <div className="wb-bar"><div className="wb-cap">尚未开出经费卡</div></div>}
        num={quota != null ? `额度 ${money(quota)}` : '额度尚未填写'} sub={`已下达 ${money(granted)}${quota != null ? ` · 尚未申请 ${money(Math.max(quota - granted, 0))}` : ''}`}
        status={noCard ? ['warn', `${thisYear} 年经费卡尚未开出，本年度无可用经费`] : null}>
        {cs.map((c) => {
          const cells = data.cells.filter((x) => x.card_id === c.card_id && (num(x.cur) || num(x.commit) || num(x.actual))).sort((a, b) => a.sort - b.sort);
          const give = new Map<string, number>(); for (const a of data.allocs.filter((x) => x.card_id === c.card_id)) give.set(a.project_id, (give.get(a.project_id) ?? 0) + num(a.amount));
          const out = [...give.values()].reduce((s, v) => s + v, 0), total = num(c.cur);
          const mark = c.status === 'active' && c.year === thisYear ? cardRisk(c, now).time : undefined;
          return (
            <TreeNode key={c.card_id} level={2} lv="经费卡" title={`${c.year} 年`} meta={`${c.card_no}${c.year === thisYear ? ' · 本年度' : ''}`} href={`#/card/${c.card_id}`} open={pi === 0 && c.year === thisYear}
              chart={<Track cap={c.year === thisYear ? '当年执行' : '执行'} segs={execSegs(total, num(c.actual), num(c.commit), '当年下达')} mark={mark} />}
              num={`下达 ${money(total)}`} sub={`执行 ${pct(num(c.actual) + num(c.commit), total)} · 可用 ${money(c.avail)}`} status={cardStatus(c)}>
              {cells.map((x) => <TreeNode key={x.subject_id} level={3} lv="明细" title={x.subject_name}
                chart={<Track segs={execSegs(num(x.cur), num(x.actual), num(x.commit), '该明细')} scale={total} />} num={money(x.cur)} sub={`可用 ${money(x.avail)}`} status={num(x.avail) < 0 ? ['bad', '超支'] : null} />)}
              {give.size > 0 && <div className="wb-give">
                <div className="wb-cap">下达去向 · 已下达 {money(out)}，尚未下达 {money(Math.max(total - out, 0))}</div>
                <Track segs={[...[...give.entries()].sort((a, b) => b[1] - a[1]).map(([id, v], i): Seg => ({ cls: `u${i % 3}`, value: v, text: `${projName.get(id) ?? '研究单元'} ${wan(v)}`, tip: `研究单元「${projName.get(id) ?? ''}」自本经费卡下达 ${money(v)}，占 ${pct(v, total)}` })),
                  { cls: 'hatch', value: Math.max(total - out, 0), text: '尚未下达', tip: `尚未下达 ${money(Math.max(total - out, 0))}` }]} />
              </div>}
            </TreeNode>
          );
        })}
      </TreeNode>
    );
  });

  // ---------- 课题 › 研究单元 › 预算行 ----------
  const execYear = [...data.years].filter((y) => y.stage === 'issued').sort((a, b) => b.year - a.year)[0];
  const planYear = [...data.years].filter((y) => STEP_OF[y.stage] <= 3).sort((a, b) => a.year - b.year)[0];
  const rowsOf = (pid: string) => (execYear ? data.exec.filter((l) => l.year === execYear.year && l.project_id === pid && num(l.fixed) > 0) : []);
  const tot = (rows: LineExec[]) => ({ fixed: rows.reduce((s, l) => s + num(l.fixed), 0), actual: rows.reduce((s, l) => s + num(l.actual), 0), used: rows.reduce((s, l) => s + num(l.used), 0) });
  const lineNode = (l: LineExec, scale: number) => <TreeNode key={l.id} level={3} lv="预算行" title={l.purpose}
    chart={<Track segs={execSegs(num(l.fixed), num(l.actual), num(l.used) - num(l.actual), '该预算行')} scale={scale} />} num={money(l.fixed)} sub={`可用 ${money(num(l.fixed) - num(l.used))}`}
    status={num(l.pending) > 0 ? ['warn', `在途申请 ${money(l.pending)}`] : num(l.fixed) - num(l.used) < 0 ? ['bad', '超出核定数'] : null} />;
  const unitNode = (u: Project, open: boolean) => { const rows = rowsOf(u.id), t = tot(rows);
    return (
      <TreeNode key={u.id} level={2} lv="研究单元" title={u.name} meta={u.owner_name ? `负责人 ${u.owner_name}` : ''} href={`#/project/${u.id}/${execYear!.year}`} open={open}
        chart={<Track cap="执行" segs={execSegs(t.fixed, t.actual, t.used - t.actual, '核定数')} />} num={`核定 ${money(t.fixed)}`} sub={`执行 ${pct(t.used, t.fixed)} · 可用 ${money(t.fixed - t.used)}`}
        status={t.fixed - t.used < 0 ? ['bad', '超出核定数'] : null}>
        {rows.map((l) => lineNode(l, t.fixed))}
      </TreeNode>
    ); };
  const tops = !execYear ? [] : data.projects.filter((p) => p.layer !== 'paper').map((p) => ({ p, own: rowsOf(p.id), units: data.projects.filter((u) => u.parent_id === p.id && rowsOf(u.id).length > 0) }))
    .filter((x) => x.own.length > 0 || x.units.length > 0);
  // 所属课题看不到、只负责其中某个研究单元的，研究单元单独列出
  const orphans = !execYear ? [] : data.projects.filter((u) => u.layer === 'paper' && rowsOf(u.id).length > 0 && !tops.some((x) => x.p.id === u.parent_id));
  const topicNodes = tops.map(({ p, own, units }, ti) => {
    const ownT = tot(own), all = tot([...own, ...units.flatMap((u) => rowsOf(u.id))]);
    const cap = data.pcaps.find((c) => c.year === execYear!.year && c.project_id === p.id); const capAmt = cap ? num(cap.amount) : null;
    const segs: Seg[] = units.map((u, i) => { const f = tot(rowsOf(u.id)).fixed; return { cls: i % 2 ? 'sy1' : 'sy0', value: f, text: `${u.name} ${wan(f)}`, tip: `研究单元「${u.name}」核定 ${money(f)}，占${capAmt ? '上限' : '核定数'} ${pct(f, capAmt ?? all.fixed)}` }; });
    if (ownT.fixed > 0) segs.push({ cls: units.length % 2 ? 'sy1' : 'sy0', value: ownT.fixed, text: `${units.length ? '自身预算行' : p.name} ${wan(ownT.fixed)}`, tip: `${units.length ? '课题自身的预算行' : p.name}核定 ${money(ownT.fixed)}` });
    if (capAmt != null && capAmt > all.fixed) segs.push({ cls: 'hatch', value: capAmt - all.fixed, text: `未核定 ${wan(capAmt - all.fixed)}`, tip: `上限内未核定 ${money(capAmt - all.fixed)}` });
    const asking = data.caps.find((c) => c.status === 'pending' && c.project_id === p.id);
    return (
      <TreeNode key={p.id} level={1} lv={p.kind === 'project' ? '课题' : KIND[p.kind]} title={p.name} meta={p.owner_name ? `负责人 ${p.owner_name}` : ''} href={`#/project/${p.id}/${execYear!.year}`} open={ti === 0}
        chart={<Track cap={capAmt != null ? '上限构成 · 各研究单元核定数与未核定部分' : '核定数构成'} segs={segs} />}
        num={`核定 ${money(all.fixed)}`} sub={`${capAmt != null ? `上限 ${money(capAmt)}` : '不设上限'} · 可用 ${money(all.fixed - all.used)}`}
        status={asking ? ['warn', `已申请将上限调整为 ${money(asking.amount)}`] : all.fixed - all.used < 0 ? ['bad', '超出核定数'] : null}>
        {units.map((u, i) => unitNode(u, ti === 0 && i === 0))}
        {own.map((l) => lineNode(l, all.fixed))}
      </TreeNode>
    );
  });

  const planTotal = (k: 'requested' | 'applied' | 'fixed') => (planYear ? data.lines.filter((l) => l.year === planYear.year).reduce((x, l) => x + num((l as unknown as Record<string, string | null>)[k]), 0) : 0);
  const big = (x: number) => { const [i, d] = money(x).split('.'); return <>{i}<small>.{d}</small></>; };

  return (
    <div className="wb">
      <div className="wb-hero">
        <div>
          <div className="eyebrow">工作台 · {me.name} · {ROLE[me.role]}</div>
          {seesCards
            ? <h1><small>{thisYear} 年度可用额度</small><em className={avail < 0 ? 'neg' : ''}>{big(avail)}</em> 元</h1>
            : <h1><small>待办事项</small><em>{todo.length}</em> 项</h1>}
        </div>
        {seesCards ? (
          <div>
            {cur > 0 ? <Track segs={[
              { cls: 'sa big', value: actual, text: `已入账 ${pct(actual, cur)}`, tip: `已入账 ${money(actual)}，占当年下达 ${pct(actual, cur)}` },
              { cls: 'sc big', value: commit, text: `已承诺 ${pct(commit, cur)}`, tip: `已承诺 ${money(commit)}，占当年下达 ${pct(commit, cur)}` },
              { cls: 'sr big', value: Math.max(avail, 0), text: `可用 ${pct(Math.max(avail, 0), cur)}`, tip: `可用 ${money(avail)}，占当年下达 ${pct(Math.max(avail, 0), cur)}` }]} mark={timeNow} />
              : <Empty>{thisYear} 年尚无在用的经费卡。</Empty>}
            <div className="wb-facts">
              <span>当年下达<b>{money(cur)}</b></span><span>已入账<b>{money(actual)}</b></span><span>已承诺<b>{money(commit)}</b></span>
              {quotaSum > 0 && <span>项目额度合计<b>{money(quotaSum)}</b></span>}{quotaSum > 0 && <span>尚未申请<b>{money(unapplied)}</b></span>}
              {recall >= 1 && <span className="w">预计年末回收<b>{money(recall)}</b></span>}
            </div>
          </div>
        ) : <div className="wb-facts"><a className="btn" href="#/requests/new">提交支出申请</a></div>}
      </div>

      <section className="wb-sec">
        <div className="wb-sh"><span className="no">01</span><h2>待办事项</h2>{seesCards && <a className="btn" href="#/requests/new">提交支出申请</a>}</div>
        <div className="tabs" style={{ marginBottom: 8 }}>
          <button className="sm" aria-pressed={tab === 'todo'} onClick={() => setTab('todo')}>待办 {todo.length}</button>
          <button className="sm" aria-pressed={tab === 'mine'} onClick={() => setTab('mine')}>本人发起 {mineOpen.length}</button>
          <a className="more" href="#/track">全部在途事项 →</a>
        </div>
        {tab === 'todo' ? (todo.length === 0 ? <Empty>暂无待办事项。</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>类型</th><th>事项</th><th /></tr></thead>
            <tbody>{todo.map((t, i) => <tr key={i}><td><Badge tone={t.tone}>{t.tag}</Badge></td><td className="wrap">{t.text}</td><td className="r"><a className="wb-op" href={t.href}>{t.go}</a></td></tr>)}</tbody>
          </table></div>
        )) : (mineOpen.length === 0 ? <Empty>暂无进行中的申请。{mine.length > 0 && <> <a href="#/requests/posted">查看已入账申请</a></>}</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>单据</th><th>所属</th><th className="r">金额</th><th>状态</th><th /></tr></thead>
            <tbody>{mineOpen.map((r) => <tr key={r.id}><td className="wrap">{r.title}<span className="sub2">{[r.code, `预计 ${day(r.eta_date)} 入账`].filter(Boolean).join(' · ')}</span></td>
              <td>{r.project_name ?? cardName.get(r.card_id ?? '') ?? '—'}</td><td className="r">{money(r.amount)}</td>
              <td><Badge tone={reqBadge(r)[1]}>{reqBadge(r)[0]}</Badge> <Flow status={r.status} /></td><td className="r"><a className="wb-op" href={`#/requests/${r.status}`}>查看</a></td></tr>)}</tbody>
          </table></div>
        ))}
      </section>

      {seesCards && (
        <section className="wb-sec">
          <div className="wb-sh"><span className="no">02</span><h2>项目</h2><span className="path"><b>项目</b> › <b>经费卡</b> › <b>明细</b>　点击逐级展开</span></div>
          <div className="wb-key"><span><i className="sy1" />各年度已下达</span><span><i className="hatch" />尚未申请 / 尚未下达</span><span><i className="sa" />已入账</span><span><i className="sc" />已承诺</span><span><i className="sr" />可用</span></div>
          {fundNodes.length === 0 ? <Empty>暂无项目。<a href="#/funds">前往项目管理</a>新建项目，并将经费卡归入项目。</Empty> : <div className="wb-acc">{fundNodes}</div>}
          {loose > 0 && <p className="hint">另有 {loose} 张经费卡尚未归入项目，未计入上图。<a href="#/funds">前往项目管理归入 →</a></p>}
        </section>
      )}

      {(topicNodes.length > 0 || orphans.length > 0 || planYear) && (
        <section className="wb-sec">
          <div className="wb-sh"><span className="no">{seesCards ? '03' : '02'}</span><h2>课题</h2><span className="path"><b>课题</b> › <b>研究单元</b> › <b>预算行</b>{execYear ? `　${execYear.year} 年度 · 点击逐级展开` : ''}</span></div>
          {planYear && <p className="hint"><a href={`#/budget/${planYear.year}`}>{planYear.year} 年度预算</a>：{STAGE_TEXT[planYear.stage]}{planYear.stage === 'declare' ? `，${day(planYear.due_date)} 截止` : ''}。申报数合计 {money(planTotal('requested'))}{planTotal('applied') > 0 ? `，申请数 ${money(planTotal('applied'))}` : ''}{planTotal('fixed') > 0 ? `，核定数 ${money(planTotal('fixed'))}` : ''}。</p>}
          {topicNodes.length + orphans.length === 0 ? <Empty>暂无已下达的年度预算。年度预算下达后，此处按课题、研究单元、预算行显示核定数与执行情况。</Empty> : (
            <>
              <div className="wb-key"><span><i className="sy1" />各研究单元核定数</span><span><i className="hatch" />上限内未核定</span><span><i className="sa" />已入账</span><span><i className="sc" />已承诺</span><span><i className="sr" />可用</span></div>
              <div className="wb-acc">{topicNodes}{orphans.map((u, i) => unitNode(u, topicNodes.length === 0 && i === 0))}</div>
            </>
          )}
        </section>
      )}

      {seesCards && (
        <section className="wb-sec">
          <div className="wb-sh"><span className="no">04</span><h2>年度进度</h2><span className="path">各预算年度当前环节与在途支出</span></div>
          <div className="yearline" aria-label="各预算年度当前环节">
            {yearRows.map((r) => (
              <a key={r.year} className="yr" href={r.href}>
                <span><span className="yn">{r.year}</span><span className="yt">{r.text}</span></span>
                <ol>{STEPS.map((n, i) => { const k = i + 1; const on = k >= r.at && k < r.at + r.span; return (
                  <li key={n} className={`${on ? 'on' : k < r.at ? 'done' : ''}${i === 3 || i === 6 ? ' seg' : ''}`} aria-current={on ? 'step' : undefined}><i>0{k}</i>{n}</li>); })}</ol>
              </a>
            ))}
          </div>
          <nav className="flowline three" aria-label="执行中的三步" style={{ marginTop: 16 }}>
            {stages.map((s, i) => (
              <a key={s.name} className="stage" href={s.href}>
                <span className="no">0{i + 4}</span><span className="nm">{s.name}</span><span className="ds">{s.desc}</span><span className="v">{s.v}</span><span className="f">{s.f}</span>
              </a>
            ))}
          </nav>
        </section>
      )}
    </div>
  );
}
