import { useState } from 'react';
import { ObjHead, Stages, Track, execSegs } from '../tree';
import { unitStage } from './Apply';
import { rpc, useViews, type BudgetCoinExchange, type CoinQuarter, type ProjectTag, type UnitExec, type Req, type ResourceRequest, type BudgetCategory, type BudgetLine, type BudgetShift, type BudgetYear, type CapRequest, type LineExec, type Me, type PeoplePick, type Project, type ProjectAllocation, type ProjectAsset, type ProjectCap, type ProjectMember, type UnitApply } from '../api';
import { ActionDialog, Badge, Empty, Loading, Scholar, Tile, can, day, money, num, pct, today } from '../ui';
import { KIND, STAGE_TEXT } from './Budget';
import { CapReqTable, askAct, capAct, capped, type Act } from './Caps';
import { RequestTable } from './Requests';
import { UnitToken, type UnitShare } from '../token';
import { UnitIterate } from '../iterate';
import { UnitArr } from '../arr';
import { UnitReviews } from '../review';
import { KIND as RES_KIND, RES_REQ, qty } from './Resource';

const q = (n: string | number | null | undefined, unit?: string | null) => (n == null ? '—' : `${num(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);
export const typeText = (r: Project) => r.layer === 'paper' ? '研究单元' : r.kind === 'project' ? '课题' : KIND[r.kind];

// 详情页：一个课题或研究单元的事都在这一页。预算和执行、下面的研究单元、行间调剂、成员名单、年度上限、出钱买的设备、发出去的接口额度。
export function ProjectPage({ me, id, start }: { me: Me; id: string; start: string }) {
  const director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ projects: Project[]; years: BudgetYear[]; lines: BudgetLine[]; exec: LineExec[]; cats: BudgetCategory[]; shifts: BudgetShift[];
    members: ProjectMember[]; people: PeoplePick[]; shares: UnitShare[]; ustatus: { project_id: string; status: 'active' | 'stalled' | 'terminate' }[]; caps: ProjectCap[]; capreqs: CapRequest[]; assets: ProjectAsset[]; pallocs: ProjectAllocation[]; tags: ProjectTag[]; uexec: UnitExec[]; reqs: Req[]; resreqs: ResourceRequest[]; uapps: UnitApply[]; cqs: CoinQuarter[]; cxs: BudgetCoinExchange[] }>({
    reqs: ['request'], resreqs: ['resource_request'], uapps: ['unit_apply'], cqs: ['coin_quarter'], cxs: ['budget_coin_exchange'],
    tags: ['project_tag'], uexec: ['unit_exec'],
    projects: ['project'], years: ['budget_year'], lines: ['budget_line'], exec: ['line_exec'], cats: ['budget_category'], shifts: ['budget_shift'],
    members: ['project_member'], people: ['people_pick'], shares: ['unit_share'], ustatus: ['unit_status'], caps: ['project_cap'], capreqs: ['cap_request'], assets: ['project_asset'], pallocs: ['project_allocation'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [showPosted, setShowPosted] = useState(false);
  if (!data) return <Loading error={error} />;
  const r = data.projects.find((x) => x.id === id);
  if (!r) return <><div className="top"><h2>课题管理</h2></div><Empty>课题或研究单元不存在或无权查看。<a href="#/projects">返回课题管理</a></Empty></>;
  const un = typeText(r);   // 本页是课题、研究单元还是中心公共开支
  const renameAct = (): Act => ({ title: `修改名称：${r.name}`, submitLabel: '保存',
    hint: `只改名称，编号 ${r.code}、负责人和${r.layer === 'paper' ? '所挂课题' : '名下的研究单元'}不变。${r.layer === 'paper' ? '改名后通知所挂课题的负责人。' : '改名后通知中心负责人。'}`,
    fields: [{ name: 'name', label: '名称', value: r.name }], run: (v) => rpc('rename_project', { id: r.id, name: v.name }) });
  const head = (
    <div className="top">
      <div className="crumb"><a href="#/projects">课题管理</a>{r.layer === 'paper' && r.parent_id && <> / {data.projects.some((x) => x.id === r.parent_id && x.seen) ? <a href={`#/project/${r.parent_id}`}>{r.parent_name}</a> : r.parent_name}</>} · {r.code} · {typeText(r)}{r.owner_name ? ` · 负责人 ${r.owner_name}` : ''}{r.active ? '' : ' · 已停用'}</div>
      <h2>{r.name}{r.mine && r.active && r.kind !== 'public' && !data.tags.some((t) => t.id === r.id && t.proposed) && <button className="ghost sm" style={{ marginLeft: 12, verticalAlign: 'middle' }} onClick={() => setAct(renameAct())}>修改名称</button>}</h2>
    </div>
  );
  if (!r.seen) return <>{head}<Empty>该{un}的预算和执行情况仅负责人、财务岗和中心负责人可查看。{r.member ? `本人在成员名单中，可在「支出申请」中从该${un}的预算行提交支出申请。` : ''}</Empty>{r.layer === 'paper' && <UnitReviews unit={r} me={me} />}</>;

  const years = data.years.slice().sort((a, b) => b.year - a.year);
  const cat = new Map(data.cats.map((c) => [c.id, c.name]));
  const kids = data.projects.filter((x) => x.parent_id === r.id).sort((a, c) => Number(c.active) - Number(a.active) || a.code.localeCompare(c.code));
  const has = (pid: string, yr: number) => data.lines.some((l) => l.project_id === pid && l.year === yr) || data.exec.some((l) => l.project_id === pid && l.year === yr);
  const y = years.find((x) => x.year === Number(start)) ?? years.find((x) => x.stage !== 'closed' && (has(r.id, x.year) || kids.some((k) => has(k.id, x.year)))) ?? years.find((x) => x.stage !== 'closed') ?? years[0];
  const year = y?.year ?? 0, run = y?.stage === 'issued' || y?.stage === 'closed';
  const execOf = (pid: string) => data.exec.filter((l) => l.project_id === pid && l.year === year);
  const linesOf = (pid: string) => data.lines.filter((l) => l.project_id === pid && l.year === year);
  const best = (l: BudgetLine) => num(l.fixed ?? l.applied ?? l.declared);
  // 一个研究单元这一年的预算、已用、已入账；下达之前只有预算
  const tot = (pid: string) => { const ex = execOf(pid), ls = linesOf(pid);
    return run && ex.length ? { budget: ex.reduce((s, l) => s + num(l.fixed), 0), used: ex.reduce((s, l) => s + num(l.used), 0), actual: ex.reduce((s, l) => s + num(l.actual), 0), n: ex.length }
      : { budget: ls.reduce((s, l) => s + best(l), 0), used: 0, actual: 0, n: ls.length }; };
  const own = tot(r.id), kt = kids.filter((k) => k.active || tot(k.id).n > 0).map((k) => ({ k, t: tot(k.id) }));
  const all = kt.reduce((s, x) => ({ budget: s.budget + x.t.budget, used: s.used + x.t.used, actual: s.actual + x.t.actual }), { budget: own.budget, used: own.used, actual: own.actual });
  const capOf = (yr: number) => data.caps.find((c) => c.project_id === r.id && c.year === yr);
  const cap = capped(r) ? capOf(year) : undefined;
  const rows = execOf(r.id), draft = linesOf(r.id);
  const stageWord = (l: BudgetLine) => l.fixed != null ? '核定数' : l.applied != null ? '申请数' : '申报数';

  // 调剂：研究单元内各预算行之间挪，全年累计不超过研究单元年度预算的 10% 负责人自己定，超过的交中心负责人批
  // 跨研究单元的调剂（课题负责人在研究单元之间调）在调出、调入两个研究单元和课题的页面上都列出来
  const fam = new Set([r.id, ...kids.map((k) => k.id)]);
  const shifts = data.shifts.filter((s) => s.year === year && (s.project_id === r.id || s.to_project_id === r.id || (!!s.to_project_id && fam.has(s.project_id)))).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const canShift = r.mine && r.kind !== 'public' && y?.stage === 'issued' && rows.length > 1 && !shifts.some((s) => s.status === 'pending');
  const famRows = r.layer === 'paper' ? [] : [r, ...kids.filter((k) => k.active)].flatMap((p) => execOf(p.id).map((l) => ({ p, l })));
  const canMove = r.mine && r.layer !== 'paper' && r.kind !== 'public' && y?.stage === 'issued' && new Set(famRows.map((x) => x.p.id)).size > 1;
  const moveAct = (): Act => ({ title: `研究单元间预算调剂：${r.name}`, submitLabel: '调剂',
    hint: `将 ${year} 年度预算从一个研究单元的预算行调至另一个研究单元的预算行，仅限本课题名下。课题连同研究单元的合计不变，不影响上限；调出预算行只能调出尚未使用的部分。提交后直接生效，两行各保留一条版本记录，双方负责人和财务岗将收到通知。同一研究单元内两行之间的调剂在该研究单元页面办理。`,
    fields: [{ name: 'from_line', label: '调出预算行', options: famRows.filter(({ l }) => num(l.fixed) - num(l.used) > 0).map(({ p, l }): [string, string] => [l.id, `${p.name} · ${l.purpose}，剩余 ${money(num(l.fixed) - num(l.used))}`]) },
      { name: 'to_line', label: '调入预算行（须属于另一个研究单元）', options: famRows.map(({ p, l }): [string, string] => [l.id, `${p.name} · ${l.purpose}，核定 ${money(l.fixed)}`]) },
      { name: 'amount', label: '金额（元）', type: 'number' }, { name: 'note', label: '原因' }],
    run: (v) => rpc('move_budget', { from_line: v.from_line, to_line: v.to_line, amount: v.amount, note: v.note }) });
  const shiftAct = (): Act => { const total = rows.reduce((s, l) => s + num(l.fixed), 0);
    const done = shifts.filter((s) => s.status === 'applied' && !s.decided_by_name && !s.to_project_id).reduce((t, s) => t + num(s.amount), 0);
    return { title: `预算调剂：${r.name}`, submitLabel: '调剂',
      hint: `在本${un} ${year} 年度的预算行之间调剂，核定数合计不变。调出预算行只能调出尚未使用的部分。本年度已自行调剂 ${money(done)}，累计不超过年度预算的 10%（${money(total * 0.1)}）直接生效；超过的报中心负责人审批，审批前不生效。`,
      fields: [{ name: 'from_line', label: '调出预算行', options: rows.filter((l) => num(l.fixed) - num(l.used) > 0).map((l): [string, string] => [l.id, `${l.purpose}，剩余 ${money(num(l.fixed) - num(l.used))}`]) },
        { name: 'to_line', label: '调入预算行', options: rows.map((l): [string, string] => [l.id, `${l.purpose}，核定 ${money(l.fixed)}`]) },
        { name: 'amount', label: '金额（元）', type: 'number' }, { name: 'note', label: '原因' }],
      run: (v) => rpc('shift_budget', { from_line: v.from_line, to_line: v.to_line, amount: v.amount, note: v.note }) }; };

  // 成员
  const members = data.members.filter((m) => m.project_id === r.id && !m.left_on).sort((a, b) => a.joined_on.localeCompare(b.joined_on));
  const gone = data.members.filter((m) => m.project_id === r.id && m.left_on);
  const inList = new Set(members.map((m) => m.user_id));
  const addAct: Act = { title: `新增成员：${r.name}`, submitLabel: '加入名单',
    hint: `加入名单的人员即可从本${un}的预算行提交支出申请、申领本${un}的接口额度，无需本人确认。`,
    fields: [{ name: 'user_id', label: '成员', options: data.people.filter((u) => !inList.has(u.id)).map((u): [string, string] => [u.id, u.name]) }],
    run: (v) => rpc('add_project_member', { project_id: r.id, user_id: v.user_id }) };
  const removeAct = (m: ProjectMember): Act => ({ title: `移出名单：${m.user_name}`, submitLabel: '移出', danger: true,
    hint: `移出后 ${m.user_name} 不能再从「${r.name}」提交支出申请和申领接口额度；已提交的申请照常办理。${m.holding > 0 ? `${m.user_name} 名下尚有 ${m.holding} 条本${un}的接口额度，须先在下方收回。` : ''}`,
    fields: [], run: () => rpc('remove_project_member', { project_id: r.id, user_id: m.user_id }) });
  const caps = years.map((yy) => ({ y: yy, c: capOf(yy.year) })).filter(({ y: yy, c }) => c || yy.stage !== 'closed');
  const capreqs = data.capreqs.filter((x) => x.project_id === r.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const assets = data.assets.filter((a) => a.project_id === r.id).sort((a, b) => b.received_on.localeCompare(a.received_on));
  const allocs = data.pallocs.filter((a) => a.project_id === r.id).sort((a, b) => Number(b.current) - Number(a.current) || b.from_date.localeCompare(a.from_date));
  const nav: [string, string][] = [['budget', '预算'], ['spend', '支出与报销'], ...(kids.length ? [['papers', '研究单元'] as [string, string]] : []), ...(r.kind !== 'public' ? [['shift', '调剂'], ['members', '成员'], ...(capped(r) ? [['cap', '上限'] as [string, string]] : []), ['assets', '设备'], ['api', '接口额度'], ['resreq', '资源申领']] as [string, string][] : [])];
  const jump = (k: string) => document.getElementById(`sec-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 流程：申报 → 核定下达 → 支出申请 → 学校入账 → 年度决算
  const stepNo = !y ? 1 : y.stage === 'closed' ? 7 : y.stage === 'issued' ? (all.actual > 0 ? 5 : 3) : y.stage === 'declare' ? 1 : 2;
  const pendingAmt = Math.max(all.used - all.actual, 0);
  // 本课题连同研究单元（或本研究单元）的支出申请：从申请到学校入账
  const mineReqs = data.reqs.filter((q) => q.project_id != null && fam.has(q.project_id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rq = (st: Req['status']) => mineReqs.filter((q) => q.status === st);
  const rsum = (list: Req[]) => list.reduce((t, q) => t + num(q.status === 'posted' ? q.posted_amount ?? q.amount : q.amount), 0);
  const openReqs = mineReqs.filter((q) => ['pending', 'committed', 'at_school', 'returned'].includes(q.status));
  const resReqs = data.resreqs.filter((q) => q.project_id != null && fam.has(q.project_id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const isUnit = r.layer === 'paper';
  // 课题预算兑换名义币（0164、0180）：「算力与模型接口」科目由课题负责人按季度兑成研究单元的名义币，当季作废，兑满即止
  const coinCats = new Set(data.cats.filter((c) => c.coin).map((c) => c.id));
  const cq = data.cqs.find((q) => q.current);
  const cqLeft = cq ? num(cq.total) - num(cq.exchanged) : 0;
  const coinUnits = kids.filter((k) => k.active && !data.tags.some((t) => t.id === k.id && t.proposed));
  const myX = data.cxs.filter((x) => x.topic_id === r.id || x.unit_id === r.id).sort((a, b) => b.at.localeCompare(a.at));
  const canX = (l: LineExec) => !isUnit && r.mine && run && !!y && y.stage !== 'closed' && coinCats.has(l.category_id) && num(l.fixed) - num(l.used) > 0 && coinUnits.length > 0;
  const xAct = (l: LineExec): Act => ({ title: `兑换名义币：${l.purpose}`, submitLabel: '兑换',
    hint: !cq ? '本季度的兑换总额和比例尚未公布，请等财务岗公布。'
      : `本季度 1 元预算兑 ${num(cq.rate)} 名义币，全中心还可兑 ${money(cqLeft)}，兑满即止。这一行还可兑 ${money(num(l.fixed) - num(l.used))}。兑得的名义币记入所选研究单元的账上，由研究单元负责人换 API 额度或 GPU 卡时；只能单向兑换，不能兑回预算。`,
    fields: [{ name: 'unit_id', label: '记入研究单元', options: coinUnits.map((k): [string, string] => [k.id, `${k.code} ${k.name}`]) }, { name: 'amount', label: '兑掉的预算（元）', type: 'number' }],
    run: (v) => rpc('exchange_budget', { line_id: l.id, unit_id: v.unit_id, amount: v.amount }) });
  return (
    <div className="wb obj">
      <ObjHead crumb={<><a href="#/projects">课题管理</a>{isUnit && r.parent_id && <> › {data.projects.some((x) => x.id === r.parent_id && x.seen) ? <a href={`#/project/${r.parent_id}`}>{r.parent_name}</a> : r.parent_name}</>} › {r.name}</>}
        eyebrow={`${un} · ${r.code}${r.owner_name ? ` · 负责人 ${r.owner_name}` : ''}${y ? ` · ${year} 年度` : ''}`} title={r.name} badge={<>{data.tags.some((t) => t.id === r.id && t.proposed) && <Badge tone="warn">待立项</Badge>}{data.tags.some((t) => t.id === r.id && t.morningstar) && <> <Badge>晨星</Badge></>}{r.active === false && <> <Badge>已停用</Badge></>}{(() => { const st = data.ustatus.find((x) => x.project_id === r.id)?.status; return st === 'stalled' ? <> <Badge tone="warn">停滞</Badge></> : st === 'terminate' ? <> <Badge tone="bad">应予终止</Badge></> : null; })()}</>}
        label={run ? '可用' : `${year || ''} 年度预算`.trim()} value={!y ? '未启动' : run ? all.budget - all.used : own.n || kt.length ? all.budget : '未填报'} neg={run && all.budget - all.used < 0}
        chart={run && all.budget > 0 ? <Track cap="执行 · 已入账、已承诺、可用" segs={execSegs(all.budget, all.actual, pendingAmt, '核定数').map((g) => ({ ...g, cls: `${g.cls} big` }))} />
          : !isUnit && kt.length > 0 && all.budget > 0 ? <Track cap="预算构成 · 各研究单元与课题自身" segs={[...kt.map(({ k, t }, i) => ({ cls: `u${i % 3} big`, value: t.budget, text: k.name, tip: `研究单元「${k.name}」预算 ${money(t.budget)}，占 ${pct(t.budget, all.budget)}` })), { cls: 'sy0 big', value: own.budget, text: '课题自身', tip: `课题自身的预算行 ${money(own.budget)}` }]} />
          : <Empty>{y ? '预算下达后显示执行情况。' : '暂无已启动的年度预算。'}</Empty>}
        facts={[[`${year || ''} 年度预算`.trim(), own.n || kt.length ? money(all.budget) : '未填报'], ['已入账', run ? money(all.actual) : '—'], ['已承诺', run ? money(pendingAmt) : '—'],
          ...(cap ? [['年度上限', money(cap.amount)] as [string, string], ['上限内剩余可排', money(num(cap.amount) - num(cap.used))] as [string, string]] : []),
          ...(!isUnit && kids.length ? [['研究单元', `${kids.length} 个`] as [string, string]] : [])]} />
      {y && <Stages path="立项或延续申请 › 评定下达 › 支出申请 › 提交报销 › 学校入账 › 年度决算" at={stepNo} items={[
        { nm: '立项或延续申请', ds: '每年申请档次并提交明细', v: own.n || kt.length ? `${own.n + kt.reduce((t, x) => t + x.t.n, 0)} 行` : '未填报', f: run ? '已申请' : STAGE_TEXT[y.stage] },
        { nm: '评定下达', ds: '联席会议评定后下达到经费卡', v: run ? money(all.budget) : '—', f: run ? '核定数' : '尚未下达' },
        { nm: '支出申请', ds: '从预算行提交，批准后占用预算', v: run ? `${rq('pending').length + rq('committed').length} 笔` : '—', f: run ? `待确认 ${rq('pending').length} 笔 · 已承诺 ${money(pendingAmt)}` : '下达后方可申请' },
        { nm: '提交报销', ds: '财务岗将报销材料交学校', v: run ? `${rq('at_school').length} 笔审核中` : '—', f: run ? `${rq('committed').length} 笔待提交${rq('returned').length ? ` · ${rq('returned').length} 笔退回` : ''}` : '' },
        { nm: '学校入账', ds: '以学校明细账的入账为准', v: run ? money(all.actual) : '—', f: run ? `${rq('posted').length} 笔 · 执行率 ${pct(all.actual, all.budget)}` : '' },
        { nm: '年度决算', ds: '年末未使用的不结转', v: y.stage === 'closed' ? '已决算' : '未决算', f: run ? `未使用 ${money(all.budget - all.used)}` : '' },
      ]} />}
      {isUnit && r.active && !data.tags.some((t) => t.id === r.id && t.proposed) && <UnitIterate unit={r} me={me} />}
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 12 }}>{years.map((n) => <a key={n.year} className="btn sm" aria-current={n.year === year ? 'page' : undefined} href={`#/project/${r.id}/${n.year}`}>{n.year}</a>)}</div>}
      <div className="tabs" style={{ marginBottom: 16 }}>{nav.map(([k, label]) => <button key={k} className="ghost sm" onClick={() => jump(k)}>{label}</button>)}</div>
      <section className="card" id="sec-budget">
        <h3>预算 <span className="h3sub">{y ? `${year} 年度 · ${STAGE_TEXT[y.stage]}` : ''}</span></h3>
        {!y ? <Empty>暂无已启动的年度预算。</Empty> : run && rows.length > 0 ? (
          <div className="scroll"><table>
            <thead><tr><th>预算行</th><th className="r">核定数</th><th style={{ minWidth: 180 }}>执行</th><th className="r">已用（含在途）</th><th className="r">已入账</th><th className="r">剩余</th></tr></thead>
            <tbody>{rows.map((l) => { const left = num(l.fixed) - num(l.used); return (
              <tr key={l.id}><td className="wrap">{l.purpose}<div className="sub2">{cat.get(l.category_id) ?? '—'}{coinCats.has(l.category_id) && ' · 兑换名义币'}</div>{canX(l) && <button className="sm ghost" disabled={!cq || cqLeft <= 0} title={!cq ? '本季度尚未公布' : cqLeft <= 0 ? '本季度全中心已兑满' : undefined} onClick={() => setAct(xAct(l))}>兑换名义币</button>}</td>
                <td className="r">{money(l.fixed)}</td><td>{num(l.fixed) > 0 && <Track segs={execSegs(num(l.fixed), num(l.actual), Math.max(num(l.used) - num(l.actual), 0), '核定数')} scale={Math.max(...rows.map((x) => num(x.fixed)))} />}</td><td className="r">{money(l.used)}{num(l.pending) > 0 && <div className="sub2">另有待确认 {money(l.pending)}</div>}</td>
                <td className="r">{money(l.actual)}</td><td className={`r ${left < 0 ? 'neg' : ''}`}>{money(left)}</td></tr>); })}</tbody>
            <tfoot><tr><th scope="row">合计</th><td className="r">{money(own.budget)}</td><td /><td className="r">{money(own.used)}</td><td className="r">{money(own.actual)}</td><td className="r">{money(own.budget - own.used)}</td></tr></tfoot>
          </table></div>
        ) : draft.length > 0 ? (
          <div className="scroll"><table>
            <thead><tr><th>预算行</th><th className="r">金额</th><th>统计口径</th></tr></thead>
            <tbody>{draft.map((l) => <tr key={l.id}><td className="wrap">{l.purpose}<div className="sub2">{cat.get(l.category_id) ?? '—'}</div></td><td className="r">{money(best(l))}</td><td>{stageWord(l)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row">合计</th><td className="r">{money(own.budget)}</td><td /></tr></tfoot>
          </table></div>
        ) : <Empty>{year} 年度本{un}自身暂无预算行。{r.mine && y.stage === 'declare' ? (r.layer === 'paper' ? '研究单元使用所属课题的预算，由课题负责人在预算编制页面填报。' : '请到预算编制页面填报。') : ''}</Empty>}
        {myX.length > 0 && <div className="scroll" style={{ marginTop: 12 }}><table>
          <thead><tr><th>兑换日期</th><th>预算行</th><th>记入研究单元</th><th className="r">兑掉的预算</th><th className="r">名义币</th><th>经办</th></tr></thead>
          <tbody>{myX.map((x) => <tr key={x.id}><td>{day(x.at)}</td><td>{x.line_purpose}</td><td>{x.unit_code} {x.unit_name}</td><td className="r">{money(x.amount)}</td><td className="r">{num(x.coins)}</td><td>{x.by_name ?? '—'}</td></tr>)}</tbody>
        </table></div>}
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {y && <a className="btn ghost sm" href={`#/budget/${year}`}>{r.mine && r.layer !== 'paper' && y.stage === 'declare' ? '前往预算编制填报' : '在预算编制中查看'}</a>}
          {y && run && rows.length > 0 && <a className="btn ghost sm" href={`#/review/${year}`}>查看分期执行和复盘</a>}
        </div>
      </section>

      <section className="card" id="sec-spend">
        <h3>支出与报销 <span className="h3sub">本{un}{kids.length ? '连同研究单元' : ''}的支出申请，从申请到学校入账</span></h3>
        <div className="tiles">
          <Tile k="待确认、核对" v={`${rq('pending').length} 笔`} f={money(rsum(rq('pending')))} tone={rq('pending').length ? 'warn' : ''} />
          <Tile k="待提交学校" v={`${rq('committed').length} 笔`} f={`已批准 ${money(rsum(rq('committed')))}`} />
          <Tile k="学校审核中" v={`${rq('at_school').length} 笔`} f={rq('returned').length ? `另有 ${rq('returned').length} 笔被退回` : money(rsum(rq('at_school')))} tone={rq('returned').length ? 'bad' : ''} />
          <Tile k="已入账" v={`${rq('posted').length} 笔`} f={money(rsum(rq('posted')))} />
        </div>
        {openReqs.length === 0 ? <Empty>暂无在途的支出申请。</Empty>
          : <RequestTable me={me} rows={openReqs} onChange={reload} />}
        {rq('posted').length > 0 && <p className="hint"><button className="sm ghost" onClick={() => setShowPosted(!showPosted)}>{showPosted ? '收起已入账的' : `显示已入账的 ${rq('posted').length} 笔`}</button></p>}
        {showPosted && <RequestTable me={me} rows={rq('posted')} onChange={reload} />}
        <div className="actions" style={{ justifyContent: 'flex-start' }}><a className="btn ghost sm" href="#/requests/new">提交支出申请</a><a className="btn ghost sm" href="#/requests">全部支出申请</a></div>
      </section>

      {kids.length > 0 && (() => {
        // 研究单元都用课题的钱：预算行都在课题上，这里按申请记在谁名下分列执行
        const waiting = new Set(data.tags.filter((t) => t.proposed).map((t) => t.id));
        const ue = data.uexec.filter((x) => x.topic_id === r.id && x.year === year);
        const of = (pid: string) => { const x = ue.find((e) => e.project_id === pid); return { n: x?.n ?? 0, used: num(x?.used ?? 0), actual: num(x?.actual ?? 0) }; };
        const sum = ue.reduce((t, x) => ({ n: t.n + x.n, used: t.used + num(x.used), actual: t.actual + num(x.actual) }), { n: 0, used: 0, actual: 0 });
        const cells = (t: { n: number; used: number; actual: number }) => <>
          <td className="r">{run ? t.n : '—'}</td>
          <td>{run && sum.used > 0 && t.used > 0 ? <Track segs={execSegs(sum.used, t.actual, Math.max(t.used - t.actual, 0), '课题已用')} scale={sum.used} /> : null}</td>
          <td className="r">{run ? money(t.used) : '—'}</td><td className="r">{run ? money(t.actual) : '—'}</td>
          <td className="r">{run && sum.used > 0 ? pct(t.used, sum.used) : '—'}</td></>;
        return (
        <section className="card" id="sec-papers">
          <h3>研究单元 <span className="h3sub">{kids.length} 个 · {year} 年度</span></h3>
          <p className="hint">研究单元使用本课题的预算，不单独编预算。支出申请记在所属研究单元名下，由该研究单元的负责人确认；下表按研究单元分列本课题预算的执行，只列汇总数。{run ? '' : '预算下达后开始有执行数。'}</p>
          <div className="scroll"><table>
            <thead><tr><th>研究单元</th><th>负责人</th><th className="r">成员</th><th className="r">支出申请</th><th style={{ minWidth: 180 }}>执行</th><th className="r">已用（含在途）</th><th className="r">已入账</th><th className="r">占课题已用</th></tr></thead>
            <tbody>
              {kids.map((k) => (
                <tr key={k.id} style={k.active ? undefined : { opacity: .55 }}><td>{k.seen ? <a href={`#/project/${k.id}/${year}`}>{k.name}</a> : k.name}<span className="sub2">{k.code}{k.active ? '' : ' · 已停用'}</span>{waiting.has(k.id) && (() => { const ua = data.uapps.find((x) => x.id === k.id); const [lb, tn] = ua ? unitStage(ua) : ['待立项', 'warn'] as const; return <> <Badge tone={tn}><a href={`#/projects/${k.id}`}>{lb}</a></Badge></>; })()}</td>
                  <td>{k.owner_name ?? '—'}</td><td className="r">{k.members}</td>{cells(of(k.id))}</tr>))}
              <tr><td>记在课题名下</td><td>{r.owner_name ?? '—'}</td><td className="r">{r.members}</td>{cells(of(r.id))}</tr>
            </tbody>
            <tfoot><tr><th scope="row">合计</th><td /><td /><td className="r">{run ? sum.n : '—'}</td><td /><td className="r">{run ? money(sum.used) : '—'}</td><td className="r">{run ? money(sum.actual) : '—'}</td><td /></tr>
              {cap && <tr><th scope="row">距上限</th><td /><td /><td /><td /><td className={`r ${num(cap.amount) - num(cap.used) <= 0 ? 'neg' : ''}`}>{money(num(cap.amount) - num(cap.used))}</td><td /><td /></tr>}</tfoot>
          </table></div>
        </section>); })()}

      {r.kind !== 'public' && <>
        <section className="card" id="sec-shift">
          <h3>调剂 <span className="h3sub">{year} 年度</span></h3>
          <p className="hint">预算下达后，负责人可在本{un}的预算行之间调剂，核定数合计不变。全年累计不超过年度预算 10% 的直接生效，超过的报中心负责人审批。研究单元之间的调剂由课题负责人在课题页面办理，直接生效，同时列示于此。</p>
          {shifts.length === 0 ? <Empty>{year} 年度暂无调剂记录。</Empty> : (
            <div className="scroll"><table><thead><tr><th>日期</th><th>调出</th><th>调入</th><th className="r">金额</th><th>原因</th><th>状态</th></tr></thead>
              <tbody>{shifts.map((s) => <tr key={s.id}><td>{day(s.created_at)}<span className="sub2">{s.requester_name ?? ''}</span></td><td className="wrap">{s.to_project_id ? `${s.project_name} · ` : ''}{s.from_purpose}</td><td className="wrap">{s.to_project_id ? `${s.to_project_name} · ` : ''}{s.to_purpose}</td><td className="r">{money(s.amount)}</td>
                <td className="wrap">{s.note}{s.decide_note && <div className="sub2">批示：{s.decide_note}</div>}</td>
                <td>{s.status === 'pending' ? <Badge tone="warn">待中心负责人审批</Badge> : s.status === 'rejected' ? <Badge tone="bad">未同意</Badge> : <Badge tone="ok">{s.decided_by_name ? `${s.decided_by_name} 已同意` : '已生效'}</Badge>}</td></tr>)}</tbody></table></div>)}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {canShift ? <button className="sm" onClick={() => setAct(shiftAct())}>在预算行之间调剂</button>
              : r.mine && <span className="sub2">{y?.stage !== 'issued' ? '预算下达后、决算前方可调剂。' : rows.length < 2 ? '仅有一行预算，无可调剂的预算行。' : '有一笔调剂待中心负责人审批，审批完成后方可提交下一笔。'}</span>}
          </div>
        </section>

        {isUnit && r.active && !data.tags.some((t) => t.id === r.id && t.proposed) && <UnitToken me={me} unit={r} />}
        {isUnit && r.active && !data.tags.some((t) => t.id === r.id && t.proposed) && <UnitArr me={me} unit={r} />}
        {isUnit && <UnitReviews unit={r} me={me} />}

        <section className="card" id="sec-members">
          <h3>{isUnit ? '成员' : '直属成员'} <span className="h3sub">{members.length} 人</span></h3>
          {!isUnit && <p className="hint">此处维护课题直属名单；双选页和课题列表的总人数另包含下属有效研究单元成员，并按账号去重。研究单元成员不会因此自动进入本课题的直属名单。</p>}
          <p className="hint">仅名单内人员可从本{un}的预算行提交支出申请、申领本{un}的接口额度。负责人可直接新增和移出成员，无需本人确认；负责人和副手默认在名单内。</p>
          {members.length === 0 ? <Empty>名单暂无成员。{r.can_roster ? `请先将参与本${un}的人员加入名单，加入后方可提交支出申请。` : ''}</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>成员</th><th>加入日期</th><th>加入人</th>{isUnit && <><th className="r">池子份额</th><th className="r">占比</th></>}<th className="r">名下接口额度</th><th /></tr></thead>
              <tbody>{members.map((m) => (
                <tr key={m.id}><td>{m.user_name}{m.user_id === me.id && <span className="sub2">本人</span>}<span className="sub2">{[m.user_id === r.owner_id ? '负责人' : '', m.rank_label ?? ''].filter(Boolean).join(' · ')}</span><Scholar url={m.scholar_url} /></td><td>{day(m.joined_on)}</td><td>{m.added_by_name ?? '—'}</td>
                  {isUnit && (() => { const sh = data.shares.find((x) => x.project_id === r.id && x.user_id === m.user_id); return <><td className="r">{sh ? num(sh.coins).toLocaleString('zh-CN') : '—'}</td><td className="r">{sh?.share ? `${Math.round(num(sh.share) * 100)}%` : '—'}</td></>; })()}
                  <td className="r">{m.holding > 0 ? `${m.holding} 条` : '—'}</td>
                  <td className="r">{r.can_roster && <button className="ghost sm danger" onClick={() => setAct(removeAct(m))}>移出</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {gone.length > 0 && <p className="sub2">已移出：{gone.map((m) => `${m.user_name}（${day(m.left_on)}）`).join('、')}</p>}
          {r.can_roster && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(addAct)}>新增成员</button></div>}
        </section>

        {capped(r) && (
          <section className="card" id="sec-cap">
            <h3>上限</h3>
            <p className="hint">上限由中心负责人按档设定，约束本课题连同下属研究单元的年度预算合计。上限不足时由负责人填写申请理由申请提高，中心负责人审批。</p>
            {caps.length === 0 ? <Empty>暂无年度。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>年度</th><th className="r">上限</th><th className="r">已编入预算</th><th className="r">剩余可排</th><th /></tr></thead>
                <tbody>{caps.map(({ y: yy, c }) => (
                  <tr key={yy.year}><td>{yy.year}<span className="sub2">{STAGE_TEXT[yy.stage]}</span></td>
                    <td className="r">{c ? money(c.amount) : <span className="sub2">未设定</span>}</td><td className="r">{c ? money(c.used) : '—'}</td>
                    <td className={`r ${c && num(c.amount) - num(c.used) <= 0 ? 'neg' : ''}`}>{c ? money(num(c.amount) - num(c.used)) : '—'}</td>
                    <td className="r"><div className="acts">
                      {director && yy.stage !== 'closed' && <button className="ghost sm" onClick={() => setAct(capAct(r, yy.year, c))}>{c ? '修改上限' : '设定上限'}</button>}
                      {r.mine && !director && c && yy.stage !== 'closed' && !capreqs.some((x) => x.year === yy.year && x.status === 'pending') && <button className="ghost sm" onClick={() => setAct(askAct(r, yy.year, c))}>申请提高</button>}</div></td></tr>
                ))}</tbody>
              </table></div>
            )}
            {capreqs.length > 0 && <CapReqTable rows={capreqs} director={director} setAct={setAct} />}
          </section>
        )}

        <section className="card" id="sec-assets">
          <h3>设备 <span className="h3sub">本{un}出资购置</span></h3>
          <p className="hint">设备由{un}出资，验收入库后为中心公共设备，记入公共设备台账，使用人按身份申领；出资方的成员申领时优先。</p>
          {assets.length === 0 ? <Empty>本{un}暂无出资购置的设备。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>验收日</th><th>设备</th><th className="r">数量</th><th className="r">单价</th><th>预算行</th><th>当前使用人</th></tr></thead>
              <tbody>{assets.map((a) => (
                <tr key={a.id}><td>{day(a.received_on)}</td><td>{a.resource_name}</td><td className="r">{q(a.qty, a.unit)}</td><td className="r">{a.unit_price != null ? money(a.unit_price) : '—'}</td>
                  <td className="wrap">{a.line_purpose ?? '—'}</td><td className="wrap">{a.holders ?? '在库'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>

        <section className="card" id="sec-api">
          <h3>接口额度 <span className="h3sub">已发放给成员</span></h3>
          <p className="hint">接口额度记在{un}名下，仅发放给名单内人员。成员离开或不再需要额度时，由负责人在此收回；收回后发放给该成员的密钥同时从中台删除。</p>
          {allocs.length === 0 ? <Empty>本{un}暂无已发放的接口额度。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>接口</th><th>使用人</th><th className="r">额度</th><th className="r">已用</th><th>起始</th><th>到期</th><th>状态</th><th /></tr></thead>
              <tbody>{allocs.map((a) => (
                <tr key={a.id}><td>{a.resource_name}</td><td>{a.user_name}</td><td className="r">{q(a.quota, a.unit)}</td>
                  <td className="r">{a.used == null ? '未回写' : q(a.used, a.unit)}{a.used_on && <div className="sub2">截至 {day(a.used_on)}</div>}</td>
                  <td>{day(a.from_date)}</td><td>{a.to_date ? day(a.to_date) : '长期'}</td>
                  <td>{a.returned_on ? <Badge>{day(a.returned_on)} 收回</Badge> : a.current ? <Badge tone="ok">在用</Badge> : <Badge tone="warn">已到期</Badge>}</td>
                  <td className="r">{r.can_roster && !a.returned_on && <button className="ghost sm danger" onClick={() => setAct({ title: `收回：${a.user_name} · ${a.resource_name}`, submitLabel: '收回', danger: true,
                    hint: `收回日记为当日（${today()}）。发放给 ${a.user_name} 的密钥同时从中台删除；服务商侧的密钥须请财务岗另行停用或轮换。`, fields: [], run: () => rpc('recall_project_allocation', { id: a.id }) })}>收回</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </>}
      {r.kind !== 'public' && (
        <section className="card" id="sec-resreq">
          <h3>资源申领 <span className="h3sub">本{un}{kids.length ? '连同研究单元' : ''}的申领记录</span></h3>
          {resReqs.length === 0 ? <Empty>暂无资源申领记录。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>提交日期</th><th>申请人</th><th>资源</th><th className="r">申领</th><th>用途</th><th>状态</th></tr></thead>
              <tbody>{resReqs.map((q) => <tr key={q.id}><td>{day(q.created_at)}</td><td>{q.requester_name}</td>
                <td>{q.resource_id ? <a href={`#/res/${q.resource_id}`}>{q.resource_name}</a> : `${RES_KIND[q.kind]}（未指定）`}</td><td className="r">{qty(q.amount, q.unit)}</td>
                <td className="wrap">{q.purpose}</td><td><Badge tone={RES_REQ[q.status][1]}>{RES_REQ[q.status][0]}</Badge></td></tr>)}</tbody>
            </table></div>
          )}
          <div className="actions" style={{ justifyContent: 'flex-start' }}><a className="btn ghost sm" href="#/resource">申领资源</a><a className="btn ghost sm" href="#/s-res">资源汇总</a></div>
        </section>
      )}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
