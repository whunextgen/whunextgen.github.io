import { useViews, type BudgetLine, type BudgetYear, type Card, type CardPick, type Project, type ProjectBudget, type FundEvent, type LineExec, type Me, type Node, type PettyCash, type Req, type ReqStatus, type ResourceRequest } from '../api';
import { Badge, Bar, Empty, END_RULE, Flow, Loading, can, REQ, ROLE, day, money, num, pct, today } from '../ui';
import { Hero, cardRisk, nodeState } from './Overview';
import { STAGE_TEXT, STEP_OF } from './Budget';

const wan = (x: number) => (Math.abs(x) >= 1e4 ? `${(x / 1e4).toFixed(Math.abs(x) >= 1e6 ? 0 : 1)} 万` : money(x));
const OPEN: ReqStatus[] = ['pending', 'committed', 'at_school', 'returned'];

// 首页：每个预算年度走到三段七步的哪一步，执行中的钱压在哪里，以及轮到当前这个人做什么
const STEPS = ['申报', '汇总报批', '核定下达', '申请', '承诺', '入账', '复盘结清'];
export function Home({ me }: { me: Me }) {
  const seesCards = can(me, 'read.finance', 'card.own') || me.scoped?.includes('card.read');
  const { data, error } = useViews<{ reqs: Req[]; picks: CardPick[]; cards: Card[]; nodes: Node[]; events: FundEvent[];
    years: BudgetYear[]; projects: Project[]; budgets: ProjectBudget[]; lines: BudgetLine[]; exec: LineExec[]; petty: PettyCash[]; res: ResourceRequest[] }>({
    reqs: ['request'], picks: ['card_pick'], cards: ['card'], nodes: ['node'], events: ['fund_event', { done: 'false' }],
    years: ['budget_year'], projects: ['project'], budgets: ['project_budget'], lines: ['budget_line'], exec: ['line_exec'], petty: ['petty_cash'], res: ['resource_request'],
  });
  if (!data) return <Loading error={error} />;
  const now = today();
  const active = data.cards.filter((c) => c.status === 'active');
  const sum = (k: 'cur' | 'actual' | 'commit' | 'avail') => active.reduce((s, c) => s + num(c[k]), 0);
  const of = (s: ReqStatus) => data.reqs.filter((r) => r.status === s);
  const amt = (rows: Req[]) => rows.reduce((s, r) => s + num(r.status === 'posted' ? r.posted_amount ?? r.amount : r.amount), 0);
  const pending = of('pending'), committed = of('committed'), atSchool = of('at_school'), returned = of('returned'), posted = of('posted');
  const buying = committed.filter((r) => r.path && r.stage != null && r.stages != null && r.stage < r.stages);
  const ready = committed.filter((r) => !buying.includes(r));
  const settled = data.cards.filter((c) => c.status === 'settled').length;
  const to = (path: string, status: ReqStatus) => (seesCards ? path : `#/requests/${status}`);

  const stages = [
    { name: '申请', desc: '先申请、后支出，等中心负责人批准', v: `${pending.length} 笔`, f: `待批准 ${money(amt(pending))}`, href: '#/requests/pending' },
    { name: '承诺', desc: '批准后占用额度；涉及采购的走完采购', v: `${committed.length} 笔`, f: `已占用 ${money(amt(committed))}${buying.length ? ` · ${buying.length} 笔采购中` : ''}`, href: to('#/procure', 'committed') },
    { name: '入账', desc: '单据交学校，学校正式入账才算决算', v: `${atSchool.length} 笔`, f: `学校审核中 ${money(amt(atSchool))}${returned.length ? ` · ${returned.length} 笔被退回` : ''} · 已入账 ${posted.length} 笔`, href: to('#/school', 'at_school') },
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
  void settled;

  // 轮到当前这个人做的事
  const byId = new Map(data.cards.map((c) => [c.card_id, c]));
  const todo: { tone: string; tag: string; text: string; go: string; href: string }[] = [];
  for (const y of data.years) {
    const b = new Map(data.budgets.filter((x) => x.year === y.year).map((x) => [x.project_id, x]));
    const href = `#/budget/${y.year}`;
    if (y.stage === 'declare') {
      for (const p of data.projects.filter((x) => x.active && x.owner_id === me.id)) {
        const st = b.get(p.id)?.status;
        if (st === 'returned') todo.push({ tone: 'bad', tag: '预算被退回', text: `${p.name} 的 ${y.year} 年度预算被财务岗退回：${b.get(p.id)!.return_note ?? ''}`, go: '去修改', href });
        else if (st !== 'submitted') todo.push({ tone: 'warn', tag: '待你申报', text: `${p.name} 的 ${y.year} 年度预算还没提交，${day(y.due_date)} 截止`, go: '去填', href });
      }
      if (can(me, 'budget.compile') && !can(me, 'budget.approve')) {
        const all = data.projects.filter((x) => x.active), done = all.filter((x) => b.get(x.id)?.status === 'submitted').length;
        todo.push({ tone: day(y.due_date) <= now ? 'warn' : 'pri', tag: '年度预算', text: `${y.year} 年度预算申报 ${day(y.due_date)} 截止，${done} / ${all.length} 个项目已提交`, go: day(y.due_date) <= now ? '去截止申报' : '看进度', href });
      }
    }
    const total = (k: 'applied' | 'fixed') => money(data.lines.filter((l) => l.year === y.year).reduce((s, l) => s + num(l[k]), 0));
    if (y.stage === 'summary') todo.push(can(me, 'budget.approve') ? { tone: 'warn', tag: '待你批准', text: `${y.year} 年度预算申请数合计 ${total('applied')}，等你批准后报学校`, go: '去批准', href }
      : can(me, 'budget.compile') ? { tone: 'pri', tag: '年度预算', text: `${y.year} 年度预算在汇总，申请数合计 ${total('applied')}，调好后请中心负责人批准`, go: '去汇总', href } : null!);
    if (y.stage === 'approved' && can(me, 'budget.compile') && !can(me, 'budget.approve')) todo.push({ tone: 'warn', tag: '待报学校', text: `${y.year} 年度预算申请数已批准，报学校后登记报送日期`, go: '去登记', href });
    if (y.stage === 'applied' && can(me, 'budget.compile') && !can(me, 'budget.approve')) todo.push({ tone: 'pri', tag: '等学校批复', text: `${y.year} 年度预算已于 ${day(y.applied_on)} 报学校，批复后录入批复数`, go: '去录入', href });
    if (y.stage === 'granted') todo.push(can(me, 'budget.approve') ? { tone: 'warn', tag: '待你确定', text: `${y.year} 年度学校已批复，各项目核定数合计 ${total('fixed')}，等你确定年度总预算`, go: '去确定', href }
      : can(me, 'budget.compile') ? { tone: 'warn', tag: '待核定', text: `${y.year} 年度学校已批复，按联席会议的决定填各项目核定数`, go: '去核定', href } : null!);
  }
  for (let i = todo.length - 1; i >= 0; i--) if (!todo[i]) todo.splice(i, 1);
  const add = (rows: Req[], tone: string, tag: string, what: string, go: string, href: string) => {
    if (rows.length > 0) todo.push({ tone, tag, text: `${rows.length} 笔${what}，合计 ${money(amt(rows))}`, go, href });
  };
  if (can(me, 'request.approve')) add(pending, 'warn', '待你批准', '支出申请等你批准', '去批准', '#/requests/pending');
  if (can(me, 'request.process')) {
    add(ready, 'warn', '待交学校', '已批准的申请等你把单据交学校', '去提交', '#/requests/committed');
    add(buying, 'pri', '采购中', '采购还没走到验收', '去推进', '#/procure');
    add(atSchool, 'pri', '待回写', '单据在学校审核，入账后回写', '去回写', '#/school');
  }
  if (can(me, 'request.process', 'request.adjust')) add(returned, 'bad', '被退回', '单据被学校退回，改卡或释放', '去处理', '#/requests/returned');
  if (can(me, 'card.fund') && data.events.length > 0) todo.push({ tone: 'warn', tag: '待办', text: `${data.events.length} 笔到账认领或借票核销未办`, go: '去处理', href: '#/school' });
  // 备用金和资源申请里轮到自己的
  const count = (n: number, tone: string, tag: string, text: string, go: string, href: string) => { if (n > 0) todo.push({ tone, tag, text: `${n} 笔${text}`, go, href }); };
  const pettyOf = (st: PettyCash['status']) => data.petty.filter((r) => r.status === st);
  const resOf = (st: ResourceRequest['status']) => data.res.filter((r) => r.status === st);
  if (can(me, 'petty.approve')) count(pettyOf('pending').length, 'warn', '待你审批', `备用金申请等你审批，合计 ${money(pettyOf('pending').reduce((t, r) => t + num(r.amount), 0))}`, '去审批', '#/petty');
  if (can(me, 'petty.settle')) {
    count(pettyOf('approved').length, 'pri', '待核销', `备用金已领用还没核销，合计 ${money(pettyOf('approved').reduce((t, r) => t + num(r.amount), 0))}`, '去核销', '#/petty');
    count(resOf('reviewed').length, 'warn', '资源待批准', '资源申请项目负责人已批示，等你批准', '去批准', '#/pool');
    count(resOf('approved').length, 'warn', '资源待分发', '资源申请已批准，等你分发', '去分发', '#/pool');
  }
  count(resOf('pending').filter((r) => r.my_project && r.requested_by !== me.id).length, 'warn', '待你批示', '资源申请挂在你负责的项目上，等你批示', '去批示', '#/resource');
  if (seesCards) {
    for (const c of active.filter((x) => num(x.avail) < 0))
      todo.push({ tone: 'bad', tag: '超支', text: `${c.name} 可用为 ${money(c.avail)}`, go: '看这张卡', href: `#/card/${c.card_id}` });
    for (const n of data.nodes.filter((x) => byId.get(x.card_id)?.status === 'active').sort((a, b) => a.node_date.localeCompare(b.node_date))) {
      const s = nodeState(n, now); if (s.gap <= 0) continue;
      todo.push({ tone: s.tone, tag: s.text, text: `${byId.get(n.card_id)!.name}：${day(n.node_date)} 节点要求 ${money(n.need)}，预测 ${money(n.forecast)}，差 ${money(s.gap)}`, go: '看这张卡', href: `#/card/${n.card_id}` });
    }
    for (const c of active) {
      const k = cardRisk(c, now); if (k.level !== 'bad') continue;
      todo.push({ tone: 'bad', tag: '执行滞后', text: `${c.name}：时间过了 ${k.timePct}，执行 ${k.execPct}，按现在的进度到截止日会剩 ${money(k.left)}（${END_RULE[c.end_rule]}）`, go: '看预警', href: '#/cards' });
    }
    for (const c of active.filter((x) => day(x.cutoff_date) >= now && (Date.parse(day(x.cutoff_date)) - Date.parse(now)) / 864e5 <= 30))
      todo.push({ tone: 'warn', tag: '临近截止', text: `${c.name} 单据截止 ${day(c.cutoff_date)}，还有可用 ${money(c.avail)}`, go: '看这张卡', href: `#/card/${c.card_id}` });
  }
  const mine = data.reqs.filter((r) => r.requested_by === me.id);
  const mineBack = mine.filter((r) => r.status === 'returned');
  if (!can(me, 'request.process', 'request.adjust')) add(mineBack, 'bad', '被退回', '你的申请被学校退回，财务岗在处理', '看申请', '#/requests/returned');
  const mineOpen = mine.filter((r) => OPEN.includes(r.status)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cardName = new Map(data.picks.map((c) => [c.id, c.name]));

  // 总览：执行中的年度预算按项目，在用的经费卡按截止日
  const execYear = [...data.years].filter((y) => y.stage === 'issued').sort((a, b) => b.year - a.year)[0];
  const planYear = [...data.years].filter((y) => STEP_OF[y.stage] <= 3).sort((a, b) => a.year - b.year)[0];
  const byProject = !execYear ? [] : data.projects.map((p) => { const rows = data.exec.filter((l) => l.year === execYear.year && l.project_id === p.id);
    const t = (k: 'fixed' | 'used' | 'actual') => rows.reduce((x, l) => x + num(l[k]), 0);
    return { p, n: rows.length, fixed: t('fixed'), used: t('used'), actual: t('actual') }; }).filter((r) => r.n > 0);
  const tot = (k: 'fixed' | 'used' | 'actual') => byProject.reduce((x, r) => x + r[k], 0);
  const planTotal = (k: 'requested' | 'applied' | 'fixed') => (planYear ? data.lines.filter((l) => l.year === planYear.year).reduce((x, l) => x + num((l as unknown as Record<string, string | null>)[k]), 0) : 0);
  const byCutoff = [...active].sort((a, b) => a.cutoff_date.localeCompare(b.cutoff_date));

  return (
    <>
      <div className="top">
        <div className="crumb">{now} · {me.name} · {ROLE[me.role]}</div>
        <h2>预算 · 执行 · 决算</h2>
        <a className="btn" href="#/requests/new">提交支出申请</a>
      </div>
      {seesCards && <Hero cur={sum('cur')} actual={sum('actual')} commit={sum('commit')} avail={sum('avail')} cards={active.length} now={now} />}

      <div className="yearline" aria-label="各预算年度走到哪一步">
        {yearRows.map((r) => (
          <a key={r.year} className="yr" href={r.href}>
            <span><span className="yn">{r.year}</span><span className="yt">{r.text}</span></span>
            <ol>{STEPS.map((n, i) => { const k = i + 1; const on = k >= r.at && k < r.at + r.span; return (
              <li key={n} className={`${on ? 'on' : k < r.at ? 'done' : ''}${i === 3 || i === 6 ? ' seg' : ''}`} aria-current={on ? 'step' : undefined}><i>0{k}</i>{n}</li>); })}</ol>
          </a>
        ))}
      </div>

      {(byProject.length > 0 || (planYear && seesCards)) && (
        <section className="card">
          <h3>年度预算</h3>
          {planYear && <p className="hint"><a href={`#/budget/${planYear.year}`}>{planYear.year} 年度预算</a>：{STAGE_TEXT[planYear.stage]}{planYear.stage === 'declare' ? `，${day(planYear.due_date)} 截止` : ''}。申报数合计 {money(planTotal('requested'))}{planTotal('applied') > 0 ? `，申请数 ${money(planTotal('applied'))}` : ''}{planTotal('fixed') > 0 ? `，核定数 ${money(planTotal('fixed'))}` : ''}。</p>}
          {byProject.length > 0 && execYear && (
            <div className="scroll"><table>
              <thead><tr><th>{execYear.year} 年度 · 项目</th><th className="r">核定数</th><th className="r">已入账</th><th className="r">在途</th><th className="r">还没用</th><th>执行</th></tr></thead>
              <tbody>{byProject.map((r) => (
                <tr key={r.p.id}><td><a href={`#/review/${execYear.year}`}>{r.p.name}</a><span className="sub2">{r.p.code}{r.p.owner_name ? ` · ${r.p.owner_name}` : ''}</span></td>
                  <td className="r">{money(r.fixed)}</td><td className="r">{money(r.actual)}</td><td className="r">{money(r.used - r.actual)}</td>
                  <td className={`r ${r.fixed - r.used < 0 ? 'neg' : ''}`}>{money(r.fixed - r.used)}</td>
                  <td style={{ minWidth: 150 }}><Bar cur={r.fixed} actual={r.actual} commit={r.used - r.actual} /><span className="sub2">入账 {pct(r.actual, r.fixed)}</span></td></tr>))}</tbody>
              <tfoot><tr><th scope="row">合计</th><td className="r">{money(tot('fixed'))}</td><td className="r">{money(tot('actual'))}</td><td className="r">{money(tot('used') - tot('actual'))}</td><td className="r">{money(tot('fixed') - tot('used'))}</td><td><span className="sub2">入账 {pct(tot('actual'), tot('fixed'))}</span></td></tr></tfoot>
            </table></div>)}
        </section>
      )}

      {seesCards && byCutoff.length > 0 && (
        <section className="card">
          <h3>经费卡</h3>
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>到期怎么办</th><th>单据截止</th><th className="r">现行预算</th><th className="r">已入账</th><th className="r">承诺</th><th className="r">可用</th><th>执行</th></tr></thead>
            <tbody>{byCutoff.map((c) => { const left = Math.round((Date.parse(day(c.cutoff_date)) - Date.parse(now)) / 864e5); return (
              <tr key={c.card_id}><td><a href={`#/card/${c.card_id}`}>{c.name}</a><span className="sub2">{c.card_no}</span></td>
                <td><Badge tone={c.end_rule === 'recall' && num(c.avail) > 0 ? 'warn' : ''}>{END_RULE[c.end_rule]}</Badge></td>
                <td>{day(c.cutoff_date)}<div className={`sub2 ${left < 0 ? 'neg' : ''}`}>{left < 0 ? `已过 ${-left} 天` : `还有 ${left} 天`}</div></td>
                <td className="r">{money(c.cur)}</td><td className="r">{money(c.actual)}</td><td className="r">{money(c.commit)}</td>
                <td className={`r ${num(c.avail) < 0 ? 'neg' : ''}`}>{money(c.avail)}{c.end_rule === 'recall' && num(c.avail) > 0 && <div className="sub2">到期前要花完</div>}</td>
                <td style={{ minWidth: 150 }}><Bar cur={num(c.cur)} actual={num(c.actual)} commit={num(c.commit)} /><span className="sub2">入账 {pct(num(c.actual), num(c.cur))}</span></td></tr>); })}</tbody>
          </table></div>
          <div className="legend"><span><i className="a" />已入账</span><span><i className="c" />承诺或在途</span></div>
        </section>
      )}

      <nav className="flowline three" aria-label="执行中的三步">
        {stages.map((s, i) => (
          <a key={s.name} className="stage" href={s.href}>
            <span className="no">0{i + 4}</span>
            <span className="nm">{s.name}</span>
            <span className="ds">{s.desc}</span>
            <span className="v">{s.v}</span>
            <span className="f">{s.f}</span>
          </a>
        ))}
      </nav>

      <section className="card">
        <h3>轮到你处理</h3>
        {todo.length === 0 ? <Empty>现在没有等你处理的事。</Empty> : (
          <ul className="todo">{todo.map((t, i) => (
            <li key={i}><a href={t.href}><Badge tone={t.tone}>{t.tag}</Badge><span>{t.text}</span><span className="go">{t.go} →</span></a></li>
          ))}</ul>
        )}
      </section>

      <section className="card">
        <h3>我提交的申请</h3>
        {mineOpen.length === 0 ? <Empty>你没有进行中的申请。{mine.length > 0 && <> <a href="#/requests/posted">看已入账的</a></>}</Empty> : (
          <ul className="mine">{mineOpen.map((r) => (
            <li key={r.id}><a href={`#/requests/${r.status}`}>
              <span className="t">{r.title}<span className="sub2">{[r.code, cardName.get(r.card_id), `预计 ${day(r.eta_date)} 入账`].filter(Boolean).join(' · ')}</span></span>
              <span className="m">{money(r.amount)}</span>
              <span className="s"><Badge tone={REQ[r.status][1]}>{REQ[r.status][0]}</Badge><Flow status={r.status} /></span>
            </a></li>
          ))}</ul>
        )}
      </section>
    </>
  );
}
