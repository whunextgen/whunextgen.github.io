import React, { useState } from 'react';
import { useViews, type Resource, type CardSchoolSubject, type BudgetAlloc, type BudgetLine, type BudgetShift, type BudgetYear, type CapRequest, type Card, type CardPick, type Cell, type FundProject, type Project, type ProjectBudget, type ProjectCap, type FundEvent, type LineExec, type Me, type Node, type PettyCash, type Req, type ReqStatus, type ResourceRequest, type Task, type UnitApply } from '../api';
import { Badge, Empty, END_RULE, Flow, FUND_SOURCE, Loading, can, cardGap, cardGranted, cardTotal, reqBadge, ROLE, day, money, num, pct, today } from '../ui';
import { Track, TreeNode, execSegs, type Seg } from '../tree';
import { cardRisk, nodeState } from './Overview';
import { KIND, STAGE_TEXT, STEP_OF } from './Budget';
import { taskDue } from './Tasks';
import { TokenMine } from '../token';

const wan = (x: number) => `${(x / 1e4).toFixed(Math.abs(x) >= 1e6 ? 0 : 1)} 万`;
const OPEN: ReqStatus[] = ['pending', 'committed', 'at_school', 'returned'];

// 首页和各汇总页。首页按角色分流：中心负责人、财务岗进中心总览，课题和研究单元负责人进课题汇总，成员进「我的事项」。
// 各部分的待办列在该部分的汇总页里，不另设待办页。
const STEPS = ['申报', '汇总报批', '核定下达', '申请', '承诺', '入账', '复盘结清'];
export type HomeView = 'home' | 'mine' | 'center' | 'fund' | 'topic' | 'res';
// canUse：本人在已立项的课题或研究单元里，能用支出申请、备用金和资源申领
export function Home({ me, view: asked = 'home', canUse = true }: { me: Me; view?: HomeView; canUse?: boolean }) {
  const seesCards = can(me, 'read.finance') || me.scoped?.includes('card.read');
  const { data, error } = useViews<{ reqs: Req[]; picks: CardPick[]; cards: Card[]; nodes: Node[]; events: FundEvent[];
    years: BudgetYear[]; projects: Project[]; budgets: ProjectBudget[]; lines: BudgetLine[]; exec: LineExec[]; petty: PettyCash[]; res: ResourceRequest[]; caps: CapRequest[]; shifts: BudgetShift[]; tasks: Task[];
    funds: FundProject[]; cells: Cell[]; allocs: BudgetAlloc[]; pcaps: ProjectCap[]; school: CardSchoolSubject[]; resources: Resource[]; uapps: UnitApply[] }>({
    resources: ['resource'], uapps: ['unit_apply'],
    school: ['card_school_subject'],
    reqs: ['request'], picks: ['card_pick'], cards: ['card'], nodes: ['node'], events: ['fund_event', { done: 'false' }],
    years: ['budget_year'], projects: ['project'], budgets: ['project_budget'], lines: ['budget_line'], exec: ['line_exec'], petty: ['petty_cash'], res: ['resource_request'], caps: ['cap_request'], shifts: ['budget_shift'], tasks: ['task', { status: 'open' }],
    funds: ['fund_project'], cells: ['cell'], allocs: ['budget_alloc'], pcaps: ['project_cap'],
  });
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
  count(data.uapps.filter((u) => u.can_ok && u.proposed && !u.return_note && !u.parent_ok_at).length, 'warn', '待同意', '研究单元申请挂在本人负责的课题之下，待同意', '办理', '#/projects');
  if (can(me, 'budget.evaluate')) count(data.uapps.filter((u) => u.proposed && !u.return_note && !!u.parent_ok_at).length, 'warn', '待核对', '研究单元申请，待按联席会议纪要核对', '核对', '#/projects');
  count(data.uapps.filter((u) => u.mine && u.proposed && !!u.return_note).length, 'bad', '已退回', '研究单元申请已退回，待修改后重新提交', '查看', '#/projects');
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

  // ---------- 可用额度：有效期内的经费卡（在用，且今天不晚于单据截止日）。经费卡可以跨年度使用 ----------
  const live = (c: Card) => c.status === 'active' && day(c.cutoff_date) >= now;
  const yearCards = active.filter(live);
  const ysum = (k: 'actual' | 'commit') => yearCards.reduce((s, c) => s + num(c[k]), 0);
  // 当年下达连同上年结转；填了下达数的卡取所填的数，没填的取明细合计
  const cur = yearCards.reduce((s, c) => s + cardTotal(c), 0), actual = ysum('actual'), commit = ysum('commit'), avail = cur - actual - commit;
  const unassigned = yearCards.reduce((s, c) => s + cardGap(c), 0);
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
    const cs = data.cards.filter((c) => c.project_id === p.id).sort((a, b) => b.year - a.year || a.card_no.localeCompare(b.card_no));
    const granted = num(p.granted), quota = p.quota != null ? num(p.quota) : null;
    // 已结清且到期处理为到期回收的卡，回收的部分不占额度，图上只画实际留用的
    const segs: Seg[] = [...cs].reverse().map((c, i) => { const g = cardGranted(c) - (c.status === 'settled' && c.end_rule === 'recall' ? num(c.recalled ?? 0) : 0);
      return { cls: i % 2 ? 'sy1' : 'sy0', value: g, text: `${c.year} 年${c.name === p.name ? '' : ` ${c.name}`} ${wan(g)}`, tip: `${c.year} 年经费卡 ${c.card_no}${c.name === p.name ? '' : `（${c.name}）`}${c.status === 'settled' && c.end_rule === 'recall' && num(c.recalled ?? 0) > 0 ? `已结清，到期回收 ${money(c.recalled)}，占用额度` : '下达'} ${money(g)}${quota ? `，占额度 ${pct(g, quota)}` : ''}` }; });
    if (quota != null && quota > granted) segs.push({ cls: 'hatch', value: quota - granted, text: `额度剩余 ${wan(quota - granted)}`, tip: `额度剩余 ${money(quota - granted)}，占额度 ${pct(quota - granted, quota)}；尚未下达，不是可用经费` });
    const meta = [p.source && FUND_SOURCE[p.source], p.period_start || p.period_end ? `${day(p.period_start).slice(0, 4)}—${day(p.period_end).slice(0, 4)}` : '', p.owner_name && `负责人 ${p.owner_name}`].filter(Boolean).join(' · ');
    const noCard = !cs.some(live);
    const back = cs.filter((c) => c.status === 'settled' && c.end_rule === 'recall').reduce((t, c) => t + num(c.recalled ?? 0), 0);
    return (
      <TreeNode key={p.id} level={1} lv="项目" title={p.name} meta={meta} href={`#/fund/${p.id}`} open={pi === 0}
        chart={segs.length > 0 ? <Track cap={quota != null ? '额度构成 · 各经费卡占用与额度剩余（到期回收的结余已扣除）' : '各经费卡已下达 · 额度尚未填写'} segs={segs} /> : <div className="wb-bar"><div className="wb-cap">尚未开出经费卡</div></div>}
        num={quota != null ? `额度 ${money(quota)}` : '额度尚未填写'} sub={`占用额度 ${money(granted)}${back > 0 ? `（已扣到期回收 ${money(back)}）` : ''}${quota != null ? ` · 额度剩余 ${money(Math.max(quota - granted, 0))}` : ''}`}
        status={noCard ? ['warn', '当前没有在有效期内的经费卡，无可用经费'] : null}>
        {cs.map((c) => {
          const cells = data.cells.filter((x) => x.card_id === c.card_id && (num(x.cur) || num(x.commit) || num(x.actual))).sort((a, b) => a.sort - b.sort);
          const give = new Map<string, number>(); for (const a of data.allocs.filter((x) => x.card_id === c.card_id)) give.set(a.project_id, (give.get(a.project_id) ?? 0) + num(a.amount));
          const out = [...give.values()].reduce((s, v) => s + v, 0), total = cardTotal(c), gap = cardGap(c), left = total - num(c.actual) - num(c.commit);
          const mark = c.status === 'active' ? cardRisk(c, now).time : undefined;
          // 执行以学校明细账为准：按学校科目合并。明细是经费卡上按科目编的预算
          const bySchool = new Map<string, { school_name: string; n: number; amount: number }>();
          for (const r of data.school.filter((x) => x.card_id === c.card_id)) { const o = bySchool.get(r.school_name) ?? { school_name: r.school_name, n: 0, amount: 0 }; o.n += r.n; o.amount += num(r.amount); bySchool.set(r.school_name, o); }
          const posted = [...bySchool.values()].sort((a, b) => b.amount - a.amount);
          return (
            <TreeNode key={c.card_id} level={2} lv="经费卡" title={c.name === p.name ? `${c.year} 年下达` : `${c.year} 年下达 · ${c.name}`} meta={`${c.card_no} · 有效期 ${day(c.start_date)} 至 ${day(c.cutoff_date)}`} href={`#/card/${c.card_id}`} open={pi === 0 && live(c)}
              chart={<Track cap="执行" segs={execSegs(total, num(c.actual), num(c.commit), '下达数')} mark={mark} />}
              num={`下达 ${money(total)}`} sub={`执行 ${pct(num(c.actual) + num(c.commit), total)} · 可用 ${money(left)}`}
              status={cardStatus(c) ?? (gap >= 0.005 ? ['warn', `尚有 ${money(gap)} 未分到科目，暂不可支出`] : total <= 0 ? ['warn', '尚未填写下达数']
                : c.status === 'active' && c.fund_kind === 'horizontal' && num(c.received) < total ? ['warn', `已下达未到账 ${money(total - num(c.received))}，到账前不得支出`] : null)}>
              {cells.filter((x) => num(x.cur) > 0).map((x) => <TreeNode key={x.subject_id} level={3} lv="明细" title={x.subject_name}
                chart={<Track segs={execSegs(num(x.cur), num(x.actual), num(x.commit), '该明细')} scale={total} />} num={money(x.cur)} sub={`可用 ${money(x.avail)}`} status={num(x.avail) < 0 ? ['bad', '超支'] : null} />)}
              {posted.map((x) => <TreeNode key={`s-${x.school_name}`} level={3} lv="执行" title={x.school_name}
                chart={<Track segs={[{ cls: 'sa', value: x.amount, tip: `学校明细账 ${x.n} 笔，合计 ${money(x.amount)}，占下达数 ${pct(x.amount, total)}` }]} scale={total} />} num={money(x.amount)} sub={`学校明细账 ${x.n} 笔`} />)}
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

  // ---------- 各页共用的几块 ----------
  // 首页按角色分流
  const landing = asked === 'home';
  const view: HomeView = !landing ? (asked === 'center' && !seesCards ? 'mine' : asked) : seesCards ? 'center' : data.projects.some((p) => p.active && p.owner_id === me.id) ? 'topic' : 'mine';
  type Todo = (typeof todo)[number];
  // 待办按去处归到各部分：课题（预算、上限、决算）、支出（申请、报销、备用金）、资源、项目（经费卡）
  const secOf = (t: Todo): HomeView => /^#\/(budget|caps|review|requests|petty|plan)/.test(t.href) ? 'topic' : /^#\/(school|procure)/.test(t.href) ? 'fund' : /^#\/(pool|resource)/.test(t.href) ? 'res' : /^#\/(card|funds|settle|cards)/.test(t.href) ? 'fund' : 'mine';
  const risks = todo.filter((t) => t.href.startsWith('#/card/'));
  const todoTable = (rows: Todo[], none: string) => rows.length === 0 ? <Empty>{none}</Empty> : (
    <div className="scroll"><table className="wb-table">
      <thead><tr><th>类型</th><th>事项</th><th /></tr></thead>
      <tbody>{rows.map((t, i) => <tr key={i}><td><Badge tone={t.tone}>{t.tag}</Badge></td><td className="wrap">{t.text}</td><td className="r"><a className="wb-op" href={t.href}>{t.go}</a></td></tr>)}</tbody>
    </table></div>);
  interface Step { nm: string; ds?: string; v: string; f?: string; href: string; warn?: boolean; on?: boolean; no?: string }
  const strip = (items: Step[], label: string) => (
    <nav className="flowline n" aria-label={label} style={{ ['--n' as string]: items.length }}>
      {items.map((g, i) => (
        <a key={g.nm} className={`stage${g.on ? ' on' : ''}${g.warn ? ' warnline' : ''}`} href={g.href} aria-current={g.on ? 'step' : undefined}>
          <span className="no">{g.no ?? `0${i + 1}`}</span><span className="nm">{g.nm}</span>{g.ds && <span className="ds">{g.ds}</span>}<span className="v">{g.v}</span>{g.f && <span className="f">{g.f}</span>}
        </a>
      ))}
    </nav>);
  const hero = (eyebrow: string, label: string, value: number | string, unit: string, right: React.ReactNode, neg = false) => (
    <div className="wb-hero">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1><small>{label}</small><em className={neg ? 'neg' : ''}>{typeof value === 'number' ? big(value) : value}</em> {unit}</h1>
      </div>
      <div>{right}</div>
    </div>);
  const head = (no: string, title: string, path?: React.ReactNode) => <div className="wb-sh"><span className="no">{no}</span><h2>{title}</h2>{path && <span className="path">{path}</span>}</div>;
  const execTrack = (total: number, a: number, c: number, what: string) => total > 0 ? <Track segs={[
    { cls: 'sa big', value: a, text: `已入账 ${pct(a, total)}`, tip: `已入账 ${money(a)}，占${what} ${pct(a, total)}` },
    { cls: 'sc big', value: c, text: `已承诺 ${pct(c, total)}`, tip: `已承诺 ${money(c)}，占${what} ${pct(c, total)}` },
    { cls: 'sr big', value: Math.max(total - a - c, 0), text: `可用 ${pct(Math.max(total - a - c, 0), total)}`, tip: `可用 ${money(total - a - c)}，占${what} ${pct(Math.max(total - a - c, 0), total)}` }]} /> : null;
  const fundFacts = (
    <div className="wb-facts">
      <span>下达<b>{money(cur)}</b></span><span>已入账<b>{money(actual)}</b></span><span>已承诺<b>{money(commit)}</b></span>
      {quotaSum > 0 && <span>项目额度合计<b>{money(quotaSum)}</b></span>}{quotaSum > 0 && <span>额度剩余<b>{money(unapplied)}</b></span>}
      {unassigned >= 0.005 && <span className="w">尚未分到科目<b>{money(unassigned)}</b></span>}
      {recall >= 1 && <span className="w">预计到期回收<b>{money(recall)}</b></span>}
    </div>);

  // 课题这一侧本年度的合计
  const topicAll = tot(execYear ? data.exec.filter((l) => l.year === execYear.year && num(l.fixed) > 0) : []);
  const topicLeft = topicAll.fixed - topicAll.used;
  const openReqs = data.reqs.filter((r) => OPEN.includes(r.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const dueCards = active.filter((c) => day(c.cutoff_date) < now);
  const soonCards = active.filter((c) => day(c.cutoff_date) >= now && (Date.parse(day(c.cutoff_date)) - Date.parse(now)) / 864e5 <= 60);
  const ledgerN = data.school.reduce((t, r) => t + r.n, 0);
  const resLive = data.resources.filter((r) => r.active);
  const resAsk = data.res.filter((r) => ['pending', 'reviewed', 'approved'].includes(r.status));

  // ---------- 中心总览 ----------
  if (view === 'center') {
    const src: Seg[] = funds.filter((p) => num(p.granted) > 0).map((p, i) => ({ cls: `${i % 2 ? 'sy1' : 'sy0'} big`, value: num(p.granted), text: p.name, tip: `项目「${p.name}」占用额度 ${money(p.granted)}` }));
    if (unapplied > 0) src.push({ cls: 'hatch big', value: unapplied, text: `额度剩余 ${wan(unapplied)}`, tip: `各项目额度剩余合计 ${money(unapplied)}，尚未下达` });
    const give = new Map<string, number>();
    for (const a of data.allocs.filter((x) => yearCards.some((c) => c.card_id === x.card_id))) { const p = data.projects.find((x) => x.id === a.project_id); const top = p?.parent_id ?? a.project_id; give.set(top, (give.get(top) ?? 0) + num(a.amount)); }
    const out = [...give.values()].reduce((t, v) => t + v, 0);
    const dst: Seg[] = [...give.entries()].sort((a, b) => b[1] - a[1]).map(([id, v], i) => ({ cls: `u${i % 3} big`, value: v, text: data.projects.find((p) => p.id === id)?.name ?? '课题', tip: `下达到「${data.projects.find((p) => p.id === id)?.name ?? ''}」${money(v)}` }));
    if (cur > out) dst.push({ cls: 'hatch big', value: cur - out, text: `尚未下达到课题 ${wan(cur - out)}`, tip: `有效期内经费卡中尚未下达到课题的部分 ${money(cur - out)}` });
    return (
      <div className="wb">
        {hero(`中心总览 · ${thisYear} 年度`, '全中心有效期内可用经费', avail, '元', <>
          {src.length > 0 ? <Track cap="经费来源 · 各项目占用额度与额度剩余" segs={src} /> : <Empty>暂无项目。</Empty>}
          {dst.length > 0 && <div style={{ marginTop: 10 }}><Track cap="经费去向 · 已下达到各课题与尚未下达" segs={dst} /></div>}
          {fundFacts}
        </>, avail < 0)}
        <section className="wb-sec">
          {head('01', '各部分', '点进该部分的汇总页')}
          {strip([
            { no: '项目', nm: `${funds.length} 个项目 · ${active.length} 张经费卡`, v: money(avail), f: `有效期内可用 · ${ready.length} 笔待提交学校${returned.length ? ` · ${returned.length} 笔被退回` : ''}${dueCards.length ? ` · ${dueCards.length} 张到期待结清` : ''}`, href: '#/s-fund', warn: dueCards.length > 0 || returned.length > 0 },
            { no: '课题', nm: `${tops.length} 个课题 · ${data.projects.filter((p) => p.layer === 'paper' && p.active).length} 个研究单元`, v: execYear ? money(topicLeft) : '—', f: execYear ? `${execYear.year} 年度可用 · ${openReqs.length} 笔支出在途` : '暂无已下达的年度预算', href: '#/s-topic' },
            { no: '资源', nm: `${data.resources.length} 项资源`, v: `${resLive.length} 项在用`, f: `${resAsk.length} 项申领在办`, href: '#/s-res' },
          ], '各部分')}
        </section>
        <section className="wb-sec">
          {head('02', '年度进度', '各预算年度当前环节')}
          <div className="yearline" aria-label="各预算年度当前环节">
            {yearRows.map((r) => (
              <a key={r.year} className="yr" href={r.href}>
                <span><span className="yn">{r.year}</span><span className="yt">{r.text}</span></span>
                <ol>{STEPS.map((n, i) => { const k = i + 1; const on = k >= r.at && k < r.at + r.span; return (
                  <li key={n} className={`${on ? 'on' : k < r.at ? 'done' : ''}${i === 3 || i === 6 ? ' seg' : ''}`} aria-current={on ? 'step' : undefined}><i>0{k}</i>{n}</li>); })}</ol>
              </a>
            ))}
          </div>
        </section>
        <section className="wb-sec">
          {head('03', '风险与提醒', '全中心范围')}
          {todoTable(risks, '暂无风险提醒。')}
        </section>
      </div>
    );
  }

  // ---------- 项目汇总 ----------
  if (view === 'fund') {
    const canApply = funds.filter((p) => p.quota != null && num(p.quota) - num(p.granted) > 0);
    const noGrant = active.filter((c) => cardTotal(c) <= 0);
    const list = todo.filter((t) => secOf(t) === 'fund' || ['待提交学校', '已退回', '待回写'].includes(t.tag));
    return (
      <div className="wb">
        {hero(`项目 · 汇总 · ${funds.length} 个在执行的项目 · ${active.length} 张经费卡`, '有效期内经费卡可用额度', avail, '元', <>{execTrack(cur, actual, commit, '下达数') ?? <Empty>当前没有在有效期内的经费卡。</Empty>}{fundFacts}</>, avail < 0)}
        <section className="wb-sec">
          {head('01', '流程', '申请下达 › 学校下达 › 支出申请 › 提交报销 › 学校入账 › 到期结清')}
          {strip([
            { nm: '申请下达', ds: '连同提交学校的科目预算', v: `${canApply.length} 个项目`, f: `额度剩余 ${money(unapplied)}`, href: '#/funds' },
            { nm: '学校下达', ds: '开经费卡，登记下达数', v: `${active.length} 张`, f: noGrant.length ? `${noGrant.length} 张尚未填下达数` : '均已填下达数', href: '#/cards', warn: noGrant.length > 0 },
            { nm: '支出申请', ds: '批准后占用经费卡', v: `${pending.length + committed.length} 笔在途`, f: `已承诺 ${money(commit)}`, href: '#/requests' },
            { nm: '提交报销', ds: '报销材料交学校审核', v: `${ready.length} 笔待交`, f: `${atSchool.length} 笔学校审核中${returned.length ? ` · ${returned.length} 笔退回` : ''}`, href: '#/school', warn: returned.length > 0 },
            { nm: '学校入账', ds: '上传学校明细账校准', v: money(actual), f: ledgerN ? `学校明细账 ${ledgerN} 笔` : '尚未导入学校明细账', href: '#/ledger' },
            { nm: '到期结清', ds: '结余回收或结转', v: `${dueCards.length} 张到期`, f: `${soonCards.length} 张 60 天内到期`, href: '#/settle', warn: dueCards.length > 0 },
          ], '项目流程')}
        </section>
        <section className="wb-sec">{head('02', '待办', '只列这一部分的事项')}{todoTable(list, '这一部分暂无待办事项。')}</section>
      {seesCards && (
        <section className="wb-sec">
          <div className="wb-sh"><span className="no">03</span><h2>项目</h2><span className="path"><b>项目</b> › <b>经费卡</b> › <b>明细、执行</b>　点击逐级展开</span></div>
          <div className="wb-key"><span><i className="sy1" />各经费卡已下达</span><span><i className="hatch" />额度剩余 / 尚未下达</span><span><i className="sa" />已入账</span><span><i className="sc" />已承诺</span><span><i className="sr" />可用</span></div>
          {fundNodes.length === 0 ? <Empty>暂无项目。<a href="#/funds">前往项目管理</a>新建项目，并将经费卡归入项目。</Empty> : <div className="wb-acc">{fundNodes}</div>}
          {loose > 0 && <p className="hint">另有 {loose} 张经费卡尚未归入项目，未计入上图。<a href="#/funds">前往项目管理归入 →</a></p>}
        </section>
      )}

      </div>
    );
  }

  // ---------- 课题汇总 ----------
  if (view === 'topic') {
    const y = planYear ?? execYear;
    const at = !y ? 0 : y.stage === 'declare' ? 1 : ['summary', 'approved', 'applied'].includes(y.stage) ? 2 : ['granted', 'fixed'].includes(y.stage) ? 3 : y.stage === 'issued' ? 4 : 5;
    const sumOf = (k: 'declared' | 'applied' | 'fixed') => (y ? data.lines.filter((l) => l.year === y.year).reduce((t, l) => t + num(l[k]), 0) : 0);
    const subs = y ? data.budgets.filter((b) => b.year === y.year && b.status === 'submitted').length : 0;
    // 从课题预算行出的支出申请
    const tReq = (st: ReqStatus) => data.reqs.filter((q) => q.project_id != null && q.status === st);
    const resByTopic = data.res.filter((q) => q.project_id != null);
    return (
      <div className="wb">
        {hero(`课题 · 汇总${execYear ? ` · ${execYear.year} 年度` : ''} · ${tops.length} 个课题`, execYear ? '本年度各课题可用合计' : '年度预算', execYear ? topicLeft : '未下达', execYear ? '元' : '', <>
          {execTrack(topicAll.fixed, topicAll.actual, Math.max(topicAll.used - topicAll.actual, 0), '核定数') ?? <Empty>暂无已下达的年度预算。</Empty>}
          <div className="wb-facts"><span>核定数<b>{money(topicAll.fixed)}</b></span><span>已入账<b>{money(topicAll.actual)}</b></span><span>已承诺<b>{money(Math.max(topicAll.used - topicAll.actual, 0))}</b></span>
            {data.pcaps.filter((c) => c.year === execYear?.year).length > 0 && <span>上限合计<b>{money(data.pcaps.filter((c) => c.year === execYear?.year).reduce((t, c) => t + num(c.amount), 0))}</b></span>}</div>
        </>, topicLeft < 0)}
        <section className="wb-sec">
          {head('01', '流程', y ? `${y.year} 年度 · 申报 › 汇总报批 › 核定下达 › 支出申请 › 提交报销 › 学校入账 › 年度决算` : '申报 › 汇总报批 › 核定下达 › 支出申请 › 提交报销 › 学校入账 › 年度决算')}
          {strip([
            { nm: '申报', ds: '研究单元负责人填报', v: y ? `${subs} 个已提交` : '—', f: y ? `申报数 ${money(sumOf('declared'))}` : '暂无已启动的年度', href: y ? `#/budget/${y.year}` : '#/budget', on: at === 1 },
            { nm: '汇总报批', ds: '财务岗汇总，报学校', v: y && at >= 2 ? money(sumOf('applied')) : '—', f: '申请数', href: y ? `#/budget/${y.year}` : '#/budget', on: at === 2 },
            { nm: '核定下达', ds: '核定后下达到经费卡', v: y && at >= 3 ? money(sumOf('fixed')) : '—', f: '核定数', href: '#/caps', on: at === 3 },
            { nm: '支出申请', ds: '从预算行提交，批准后占用', v: `${tReq('pending').length + tReq('committed').length} 笔`, f: execYear ? `已用 ${money(topicAll.used)}，${pct(topicAll.used, topicAll.fixed)}` : '下达后开始执行', href: '#/requests', on: at === 4 },
            { nm: '提交报销', ds: '报销材料交学校审核', v: `${tReq('at_school').length} 笔审核中`, f: `${tReq('committed').length} 笔待提交${tReq('returned').length ? ` · ${tReq('returned').length} 笔退回` : ''}`, href: to('#/school', 'at_school'), on: at === 4, warn: tReq('returned').length > 0 },
            { nm: '学校入账', ds: '以学校明细账的入账为准', v: execYear ? money(topicAll.actual) : '—', f: `${tReq('posted').length} 笔已入账`, href: '#/requests/posted', on: at === 4 },
            { nm: '年度决算', ds: '年末未使用的不结转', v: at === 5 ? '已决算' : '未决算', f: execYear ? `未使用 ${money(topicLeft)}` : '', href: y ? `#/review/${y.year}` : '#/review', on: at === 5 },
          ], '课题流程')}
        </section>
        <section className="wb-sec">{head('02', '待办', '只列这一部分的事项')}{todoTable(todo.filter((t) => secOf(t) === 'topic'), '这一部分暂无待办事项。')}</section>
      {(topicNodes.length > 0 || orphans.length > 0 || planYear) && (
        <section className="wb-sec">
          <div className="wb-sh"><span className="no">03</span><h2>课题</h2><span className="path"><b>课题</b> › <b>研究单元</b> › <b>预算行</b>{execYear ? `　${execYear.year} 年度 · 点击逐级展开` : ''}</span></div>
          {planYear && <p className="hint"><a href={`#/budget/${planYear.year}`}>{planYear.year} 年度预算</a>：{STAGE_TEXT[planYear.stage]}{planYear.stage === 'declare' ? `，${day(planYear.due_date)} 截止` : ''}。申报数合计 {money(planTotal('requested'))}{planTotal('applied') > 0 ? `，申请数 ${money(planTotal('applied'))}` : ''}{planTotal('fixed') > 0 ? `，核定数 ${money(planTotal('fixed'))}` : ''}。</p>}
          {topicNodes.length + orphans.length === 0 ? <Empty>暂无已下达的年度预算。年度预算下达后，此处按课题、研究单元、预算行显示核定数与执行情况。</Empty> : (
            <>
              <div className="wb-key"><span><i className="sy1" />各研究单元核定数</span><span><i className="hatch" />上限内未核定</span><span><i className="sa" />已入账</span><span><i className="sc" />已承诺</span><span><i className="sr" />可用</span></div>
              <div className="wb-acc">{topicNodes}{orphans.map((u, i) => unitNode(u, topicNodes.length === 0 && i === 0))}</div>
            </>
          )}
        </section>
      )}

        <section className="wb-sec">
          {head('04', '资源', '各课题、研究单元的资源申领')}
          {strip([
            { nm: '申领在办', v: `${resByTopic.filter((q) => ['pending', 'reviewed', 'approved'].includes(q.status)).length} 项`, f: '待批示、待批准、待分发', href: '#/resource' },
            { nm: '已分发', v: `${resByTopic.filter((q) => q.status === 'fulfilled').length} 项`, f: '已发放额度或交付设备', href: '#/s-res' },
            { nm: '在用资源', v: `${resLive.length} 项`, f: '接口额度与资产', href: '#/s-res' },
          ], '课题的资源')}
          <p className="hint">每个课题、研究单元名下的设备、接口额度和申领记录，在它自己的页面里。</p>
        </section>
        {!(topicNodes.length > 0 || orphans.length > 0 || planYear) && <section className="wb-sec">{head('03', '课题')}<Empty>暂无课题。<a href="#/projects">前往课题管理</a></Empty></section>}
      </div>
    );
  }

  // ---------- 资源汇总 ----------
  if (view === 'res') {
    const api = resLive.filter((r) => r.kind === 'api'), asset = resLive.filter((r) => r.kind === 'asset');
    const st = (k: string) => data.res.filter((r) => r.status === k).length;
    return (
      <div className="wb">
        {hero(`资源 · 汇总 · ${data.resources.length} 项资源`, '在用资源', `${resLive.length}`, '项', <>
          {resLive.length > 0 ? <Track cap="在用资源 · 按类别" segs={[{ cls: 'sy0 big', value: api.length, text: `接口额度 ${api.length} 项`, tip: `接口额度 ${api.length} 项` }, { cls: 'sy1 big', value: asset.length, text: `资产 ${asset.length} 项`, tip: `资产 ${asset.length} 项` }]} /> : <Empty>暂无在用资源。</Empty>}
          <div className="wb-facts"><span>申领在办<b>{resAsk.length} 项</b></span><span>已停用<b>{data.resources.length - resLive.length} 项</b></span><a className="btn" href="#/resource">申领资源</a></div>
        </>)}
        <section className="wb-sec">
          {head('01', '流程', '申领 › 批示 › 批准 › 分发 › 使用与盘点')}
          {strip([
            { nm: '申领', ds: '成员提出申领', v: `${st('pending')} 项`, f: '待研究单元负责人批示', href: '#/resource' },
            { nm: '批示', ds: '研究单元负责人批示', v: `${st('reviewed')} 项`, f: '待批准', href: seesCards ? '#/pool' : '#/resource', warn: st('reviewed') > 0 },
            { nm: '批准', ds: '批准后待分发', v: `${st('approved')} 项`, f: '待分发', href: seesCards ? '#/pool' : '#/resource', warn: st('approved') > 0 },
            { nm: '分发', ds: '发放额度或交付设备', v: `${data.res.length - resAsk.length} 项`, f: '已办结', href: seesCards ? '#/pool' : '#/resource' },
            { nm: '使用与盘点', ds: '定期盘点，到期回收', v: `${resLive.length} 项在用`, f: '资产盘点', href: seesCards ? '#/stock' : '#/resource' },
          ], '资源流程')}
        </section>
        <section className="wb-sec">{head('02', '待办', '只列这一部分的事项')}{todoTable(todo.filter((t) => secOf(t) === 'res'), '这一部分暂无待办事项。')}</section>
        <section className="wb-sec">
          {head('03', '资源', `${data.resources.length} 项`)}
          {data.resources.length === 0 ? <Empty>暂无可查看的资源。</Empty> : (
            <div className="scroll"><table className="wb-table">
              <thead><tr><th>资源</th><th>类别</th><th className="r">总量</th><th style={{ minWidth: 200 }}>分配情况</th><th>状态</th></tr></thead>
              <tbody>{[...data.resources].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh')).map((r) => { const total = num(r.total ?? 0), used = num(r.allocated ?? 0); return (
                <tr key={r.id} style={r.active ? undefined : { opacity: .55 }}><td><a href={`#/res/${r.id}`}>{r.name}</a></td><td>{r.kind === 'api' ? '接口额度' : '资产'}</td><td className="r">{r.total != null ? `${total.toLocaleString('zh-CN')}${r.unit ? ` ${r.unit}` : ''}` : '—'}</td>
                  <td>{total > 0 ? <Track segs={[{ cls: 'sa', value: Math.min(used, total), tip: `已分配 ${used.toLocaleString('zh-CN')}` }, { cls: 'sr', value: Math.max(total - used, 0), tip: `未分配 ${(total - used).toLocaleString('zh-CN')}` }]} /> : <span className="sub2">已分配 {used.toLocaleString('zh-CN')}</span>}</td>
                  <td>{r.active ? <Badge tone="ok">在用</Badge> : <Badge>已停用</Badge>}</td></tr>); })}</tbody>
            </table></div>)}
        </section>
      </div>
    );
  }

  // ---------- 成员的首页「我的事项」和全部待办 ----------
  const myPetty = data.petty.filter((r) => r.requested_by === me.id && (r.status === 'pending' || r.status === 'approved'));
  const myRes = data.res.filter((r) => r.requested_by === me.id && ['pending', 'reviewed', 'approved'].includes(r.status));
  const mineTable = mineOpen.length === 0 ? <Empty>暂无进行中的支出申请。{mine.length > 0 && <> <a href="#/requests/posted">查看已入账申请</a></>}</Empty> : (
    <div className="scroll"><table className="wb-table">
      <thead><tr><th>单据</th><th>所属</th><th className="r">金额</th><th>状态</th><th /></tr></thead>
      <tbody>{mineOpen.map((r) => <tr key={r.id}><td className="wrap">{r.title}<span className="sub2">{[r.code, `预计 ${day(r.eta_date)} 入账`].filter(Boolean).join(' · ')}</span></td>
        <td>{r.project_name ?? cardName.get(r.card_id ?? '') ?? '—'}</td><td className="r">{money(r.amount)}</td>
        <td><Badge tone={reqBadge(r)[1]}>{reqBadge(r)[0]}</Badge> <Flow status={r.status} /></td><td className="r"><a className="wb-op" href={`#/req/${r.id}`}>查看</a></td></tr>)}</tbody>
    </table></div>);
  return (
    <div className="wb">
      {hero(`我的事项 · ${me.name} · ${ROLE[me.role]}`, '本人发起、进行中', `${mineOpen.length + myPetty.length + myRes.length}`, '项', <>
        <div className="wb-facts"><span>支出申请<b>{mineOpen.length} 笔</b></span><span>备用金<b>{myPetty.length} 笔</b></span><span>资源申领<b>{myRes.length} 项</b></span></div>
        {canUse ? <div className="wb-facts"><a className="btn" href="#/requests/new">提交支出申请</a><a className="btn ghost" href="#/resource">申领资源</a><a className="btn ghost" href="#/petty">申请备用金</a></div>
          : <div className="wb-facts"><span>本人尚不在已立项的课题或研究单元中，暂不能提交支出申请、申领资源和申请备用金。可请研究单元负责人将本人加入名单；成立研究单元须先经联席会议通过，通过后在「立项与延续申请」中提交申请。</span><a className="btn" href="#/plan">立项与延续申请</a></div>}
      </>)}
      <section className="wb-sec">{head('00', '本期时间去向', '代币试行 · 每两周登记一次')}<TokenMine me={me} /></section>
      <section className="wb-sec">{head('01', '本人的支出申请', <a href="#/requests">全部申请 →</a>)}{mineTable}</section>
      <section className="wb-sec">
        {head('02', '本人的备用金和资源申领')}
        {myPetty.length + myRes.length === 0 ? <Empty>暂无在办的备用金和资源申领。</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>类型</th><th>事项</th><th>所属</th><th /></tr></thead>
            <tbody>
              {myPetty.map((r) => <tr key={r.id}><td><Badge tone={r.status === 'pending' ? 'warn' : 'pri'}>{r.status === 'pending' ? '备用金待审批' : '备用金待核销'}</Badge></td><td className="wrap">{r.purpose}，{money(r.amount)}</td><td>{r.project_name ?? '—'}</td><td className="r"><a className="wb-op" href={`#/petty/${r.id}`}>查看</a></td></tr>)}
              {myRes.map((r) => <tr key={r.id}><td><Badge tone="warn">{r.status === 'pending' ? '申领待批示' : r.status === 'reviewed' ? '申领待批准' : '申领待分发'}</Badge></td><td className="wrap">{r.resource_name ?? '资源'}：{r.purpose}</td><td>{r.project_name ?? '—'}</td><td className="r"><a className="wb-op" href="#/resource">查看</a></td></tr>)}
            </tbody>
          </table></div>)}
      </section>
    </div>
  );
}
