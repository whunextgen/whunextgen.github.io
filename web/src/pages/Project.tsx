import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetLine, type BudgetShift, type BudgetYear, type CapRequest, type LineExec, type Me, type PeoplePick, type Project, type ProjectAllocation, type ProjectAsset, type ProjectCap, type ProjectMember } from '../api';
import { ActionDialog, Badge, Empty, Loading, Tile, can, day, money, num, pct, today } from '../ui';
import { KIND, STAGE_TEXT } from './Budget';
import { CapReqTable, askAct, capAct, capped, type Act } from './Caps';

const q = (n: string | number | null | undefined, unit?: string | null) => (n == null ? '—' : `${num(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);
export const typeText = (r: Project) => r.layer === 'paper' ? '论文项目' : r.kind === 'project' ? '大项目' : KIND[r.kind];

// 项目页：一个项目的事都在这一页。预算和执行、下面的论文项目、行间调剂、成员名单、年度上限、出钱买的设备、发出去的接口额度。
export function ProjectPage({ me, id, start }: { me: Me; id: string; start: string }) {
  const director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ projects: Project[]; years: BudgetYear[]; lines: BudgetLine[]; exec: LineExec[]; cats: BudgetCategory[]; shifts: BudgetShift[];
    members: ProjectMember[]; people: PeoplePick[]; caps: ProjectCap[]; capreqs: CapRequest[]; assets: ProjectAsset[]; pallocs: ProjectAllocation[] }>({
    projects: ['project'], years: ['budget_year'], lines: ['budget_line'], exec: ['line_exec'], cats: ['budget_category'], shifts: ['budget_shift'],
    members: ['project_member'], people: ['people_pick'], caps: ['project_cap'], capreqs: ['cap_request'], assets: ['project_asset'], pallocs: ['project_allocation'],
  });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const r = data.projects.find((x) => x.id === id);
  if (!r) return <><div className="top"><h2>项目</h2></div><Empty>没有这个项目，或者你看不到它。<a href="#/projects">回到项目</a></Empty></>;
  const head = (
    <div className="top">
      <div className="crumb"><a href="#/projects">项目</a>{r.layer === 'paper' && r.parent_id && <> / {data.projects.some((x) => x.id === r.parent_id && x.seen) ? <a href={`#/project/${r.parent_id}`}>{r.parent_name}</a> : r.parent_name}</>} · {r.code} · {typeText(r)}{r.owner_name ? ` · 负责人 ${r.owner_name}` : ''}{r.active ? '' : ' · 已停用'}</div>
      <h2>{r.name}</h2>
    </div>
  );
  if (!r.seen) return <>{head}<Empty>这个项目的预算和执行只有项目负责人、财务岗和中心负责人能看。{r.member ? '你在成员名单里，可以到「支出申请」从它的预算行提支出。' : ''}</Empty></>;

  const years = data.years.slice().sort((a, b) => b.year - a.year);
  const cat = new Map(data.cats.map((c) => [c.id, c.name]));
  const kids = data.projects.filter((x) => x.parent_id === r.id).sort((a, c) => Number(c.active) - Number(a.active) || a.code.localeCompare(c.code));
  const has = (pid: string, yr: number) => data.lines.some((l) => l.project_id === pid && l.year === yr) || data.exec.some((l) => l.project_id === pid && l.year === yr);
  const y = years.find((x) => x.year === Number(start)) ?? years.find((x) => x.stage !== 'closed' && (has(r.id, x.year) || kids.some((k) => has(k.id, x.year)))) ?? years.find((x) => x.stage !== 'closed') ?? years[0];
  const year = y?.year ?? 0, run = y?.stage === 'issued' || y?.stage === 'closed';
  const execOf = (pid: string) => data.exec.filter((l) => l.project_id === pid && l.year === year);
  const linesOf = (pid: string) => data.lines.filter((l) => l.project_id === pid && l.year === year);
  const best = (l: BudgetLine) => num(l.fixed ?? l.applied ?? l.declared);
  // 一个项目这一年的预算、已用、已入账；下达之前只有预算
  const tot = (pid: string) => { const ex = execOf(pid), ls = linesOf(pid);
    return run && ex.length ? { budget: ex.reduce((s, l) => s + num(l.fixed), 0), used: ex.reduce((s, l) => s + num(l.used), 0), actual: ex.reduce((s, l) => s + num(l.actual), 0), n: ex.length }
      : { budget: ls.reduce((s, l) => s + best(l), 0), used: 0, actual: 0, n: ls.length }; };
  const own = tot(r.id), kt = kids.filter((k) => k.active || tot(k.id).n > 0).map((k) => ({ k, t: tot(k.id) }));
  const all = kt.reduce((s, x) => ({ budget: s.budget + x.t.budget, used: s.used + x.t.used, actual: s.actual + x.t.actual }), { budget: own.budget, used: own.used, actual: own.actual });
  const capOf = (yr: number) => data.caps.find((c) => c.project_id === r.id && c.year === yr);
  const cap = capped(r) ? capOf(year) : undefined;
  const rows = execOf(r.id), draft = linesOf(r.id);
  const stageWord = (l: BudgetLine) => l.fixed != null ? '核定数' : l.applied != null ? '申请数' : '申报数';

  // 调剂：项目内各预算行之间挪，全年累计不超过项目年度预算的 10% 负责人自己定，超过的交中心负责人批
  // 跨项目的调剂（大项目负责人在论文项目之间调）在调出、调入两个项目和大项目的页面上都列出来
  const fam = new Set([r.id, ...kids.map((k) => k.id)]);
  const shifts = data.shifts.filter((s) => s.year === year && (s.project_id === r.id || s.to_project_id === r.id || (!!s.to_project_id && fam.has(s.project_id)))).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const canShift = r.mine && r.kind !== 'public' && y?.stage === 'issued' && rows.length > 1 && !shifts.some((s) => s.status === 'pending');
  const famRows = r.layer === 'paper' ? [] : [r, ...kids.filter((k) => k.active)].flatMap((p) => execOf(p.id).map((l) => ({ p, l })));
  const canMove = r.mine && r.layer !== 'paper' && r.kind !== 'public' && y?.stage === 'issued' && new Set(famRows.map((x) => x.p.id)).size > 1;
  const moveAct = (): Act => ({ title: `在论文项目之间调预算：${r.name}`, submitLabel: '调',
    hint: `把 ${year} 年度的预算从一个项目的预算行挪到另一个项目的预算行，只能在这个大项目名下调。大项目连同论文项目的合计不变，不影响上限；调出行只能调还没用的部分。提交后直接生效，两行各留一笔版本记录，两边的负责人和财务岗会收到通知。同一个项目里两行之间的调剂到那个项目的页面做。`,
    fields: [{ name: 'from_line', label: '从哪一行调出', options: famRows.filter(({ l }) => num(l.fixed) - num(l.used) > 0).map(({ p, l }): [string, string] => [l.id, `${p.name} · ${l.purpose}，还剩 ${money(num(l.fixed) - num(l.used))}`]) },
      { name: 'to_line', label: '调到哪一行（要在另一个项目里）', options: famRows.map(({ p, l }): [string, string] => [l.id, `${p.name} · ${l.purpose}，核定 ${money(l.fixed)}`]) },
      { name: 'amount', label: '金额（元）', type: 'number' }, { name: 'note', label: '原因' }],
    run: (v) => rpc('move_budget', { from_line: v.from_line, to_line: v.to_line, amount: v.amount, note: v.note }) });
  const shiftAct = (): Act => { const total = rows.reduce((s, l) => s + num(l.fixed), 0);
    const done = shifts.filter((s) => s.status === 'applied' && !s.decided_by_name && !s.to_project_id).reduce((t, s) => t + num(s.amount), 0);
    return { title: `预算调剂：${r.name}`, submitLabel: '调剂',
      hint: `在这个项目 ${year} 年度的预算行之间挪，项目的核定数合计不变。调出行只能调还没用的部分。今年自己已经调了 ${money(done)}，累计不超过年度预算的 10%（${money(total * 0.1)}）直接生效；超过的交中心负责人批，批之前不生效。`,
      fields: [{ name: 'from_line', label: '从哪一行调出', options: rows.filter((l) => num(l.fixed) - num(l.used) > 0).map((l): [string, string] => [l.id, `${l.purpose}，还剩 ${money(num(l.fixed) - num(l.used))}`]) },
        { name: 'to_line', label: '调到哪一行', options: rows.map((l): [string, string] => [l.id, `${l.purpose}，核定 ${money(l.fixed)}`]) },
        { name: 'amount', label: '金额（元）', type: 'number' }, { name: 'note', label: '原因' }],
      run: (v) => rpc('shift_budget', { from_line: v.from_line, to_line: v.to_line, amount: v.amount, note: v.note }) }; };

  // 成员
  const members = data.members.filter((m) => m.project_id === r.id && !m.left_on).sort((a, b) => a.joined_on.localeCompare(b.joined_on));
  const gone = data.members.filter((m) => m.project_id === r.id && m.left_on);
  const inList = new Set(members.map((m) => m.user_id));
  const addAct: Act = { title: `加成员：${r.name}`, submitLabel: '加进名单',
    hint: '加进名单的人马上可以从这个项目的预算行提支出、申领这个项目的接口额度，不需要本人确认。',
    fields: [{ name: 'user_id', label: '成员', options: data.people.filter((u) => !inList.has(u.id)).map((u): [string, string] => [u.id, u.name]) }],
    run: (v) => rpc('add_project_member', { project_id: r.id, user_id: v.user_id }) };
  const removeAct = (m: ProjectMember): Act => ({ title: `移出名单：${m.user_name}`, submitLabel: '移出', danger: true,
    hint: `移出后 ${m.user_name} 不能再从「${r.name}」提支出和申领接口额度；已经提交的申请照常走完。${m.holding > 0 ? `${m.user_name} 名下还有 ${m.holding} 条这个项目的接口额度，要先在下面收回。` : ''}`,
    fields: [], run: () => rpc('remove_project_member', { project_id: r.id, user_id: m.user_id }) });
  const caps = years.map((yy) => ({ y: yy, c: capOf(yy.year) })).filter(({ y: yy, c }) => c || yy.stage !== 'closed');
  const capreqs = data.capreqs.filter((x) => x.project_id === r.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const assets = data.assets.filter((a) => a.project_id === r.id).sort((a, b) => b.received_on.localeCompare(a.received_on));
  const allocs = data.pallocs.filter((a) => a.project_id === r.id).sort((a, b) => Number(b.current) - Number(a.current) || b.from_date.localeCompare(a.from_date));
  const nav: [string, string][] = [['budget', '预算'], ...(kids.length ? [['papers', '论文项目'] as [string, string]] : []), ...(r.kind !== 'public' ? [['shift', '调剂'], ['members', '成员'], ...(capped(r) ? [['cap', '上限'] as [string, string]] : []), ['assets', '设备'], ['api', '接口额度']] as [string, string][] : [])];
  const jump = (k: string) => document.getElementById(`sec-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <>
      {head}
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 12 }}>{years.map((n) => <a key={n.year} className="btn sm" aria-current={n.year === year ? 'page' : undefined} href={`#/project/${r.id}/${n.year}`}>{n.year}</a>)}</div>}
      <div className="tabs" style={{ marginBottom: 16 }}>{nav.map(([k, label]) => <button key={k} className="ghost sm" onClick={() => jump(k)}>{label}</button>)}</div>

      {y && <div className="tiles">
        <Tile k={`${year} 年度预算`} v={own.n || kt.length ? money(all.budget) : '未填'} f={`${STAGE_TEXT[y.stage]}${kt.length ? ` · 连同 ${kt.length} 个论文项目` : ''}`} />
        <Tile k="已用（含在途）" v={run ? money(all.used) : '—'} f={run ? `占预算 ${pct(all.used, all.budget)}` : '下达之后才开始执行'} />
        <Tile k="已入账" v={run ? money(all.actual) : '—'} f={run ? `执行率 ${pct(all.actual, all.budget)}` : '只认学校正式入账'} />
        {cap ? <Tile k="年度上限" v={money(cap.amount)} f={`已排进预算 ${money(cap.used)}，还能排 ${money(num(cap.amount) - num(cap.used))}`} />
          : <Tile k="还没用" v={run ? money(all.budget - all.used) : '—'} f={capped(r) ? '这一年还没定上限' : '年末没用完的不结转'} />}
      </div>}

      <section className="card" id="sec-budget">
        <h3>预算 <span className="h3sub">{y ? `${year} 年度 · ${STAGE_TEXT[y.stage]}` : ''}</span></h3>
        {!y ? <Empty>还没有开始任何年度的预算。</Empty> : run && rows.length > 0 ? (
          <div className="scroll"><table>
            <thead><tr><th>预算行</th><th className="r">核定数</th><th className="r">已用（含在途）</th><th className="r">已入账</th><th className="r">剩余</th></tr></thead>
            <tbody>{rows.map((l) => { const left = num(l.fixed) - num(l.used); return (
              <tr key={l.id}><td className="wrap">{l.purpose}<div className="sub2">{cat.get(l.category_id) ?? '—'}</div></td>
                <td className="r">{money(l.fixed)}</td><td className="r">{money(l.used)}{num(l.pending) > 0 && <div className="sub2">另有待确认 {money(l.pending)}</div>}</td>
                <td className="r">{money(l.actual)}</td><td className={`r ${left < 0 ? 'neg' : ''}`}>{money(left)}</td></tr>); })}</tbody>
            <tfoot><tr><th scope="row">合计</th><td className="r">{money(own.budget)}</td><td className="r">{money(own.used)}</td><td className="r">{money(own.actual)}</td><td className="r">{money(own.budget - own.used)}</td></tr></tfoot>
          </table></div>
        ) : draft.length > 0 ? (
          <div className="scroll"><table>
            <thead><tr><th>预算行</th><th className="r">金额</th><th>是哪个数</th></tr></thead>
            <tbody>{draft.map((l) => <tr key={l.id}><td className="wrap">{l.purpose}<div className="sub2">{cat.get(l.category_id) ?? '—'}</div></td><td className="r">{money(best(l))}</td><td>{stageWord(l)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row">合计</th><td className="r">{money(own.budget)}</td><td /></tr></tfoot>
          </table></div>
        ) : <Empty>{year} 年度这个项目自己还没有预算行。{r.mine && y.stage === 'declare' ? '到年度预算页填报。' : ''}</Empty>}
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {y && <a className="btn ghost sm" href={`#/budget/${year}`}>{r.mine && y.stage === 'declare' ? '去年度预算页填报' : '在年度预算页看'}</a>}
          {y && run && rows.length > 0 && <a className="btn ghost sm" href={`#/review/${year}`}>看分期执行和复盘</a>}
        </div>
      </section>

      {kids.length > 0 && (
        <section className="card" id="sec-papers">
          <h3>论文项目 <span className="h3sub">{kids.length} 个 · {year} 年度</span></h3>
          <p className="hint">论文项目的预算算在这个大项目的上限里。申报期间大项目负责人可以在年度预算页直接改下面各论文项目的预算；预算下达之后，大项目负责人可以在各论文项目之间调，合计不变。</p>
          <div className="scroll"><table>
            <thead><tr><th>论文项目</th><th>负责人</th><th className="r">预算</th><th className="r">已用（含在途）</th><th className="r">已入账</th><th className="r">剩余</th></tr></thead>
            <tbody>
              {kids.map((k) => { const t = tot(k.id); return (
                <tr key={k.id} style={k.active ? undefined : { opacity: .55 }}><td><a href={`#/project/${k.id}/${year}`}>{k.name}</a><span className="sub2">{k.code}{k.active ? '' : ' · 已停用'}</span></td><td>{k.owner_name ?? '—'}</td>
                  <td className="r">{t.n ? money(t.budget) : <span className="sub2">未填</span>}</td><td className="r">{run && t.n ? money(t.used) : '—'}</td><td className="r">{run && t.n ? money(t.actual) : '—'}</td><td className="r">{run && t.n ? money(t.budget - t.used) : '—'}</td></tr>); })}
              <tr><td>大项目自己的预算行</td><td>{r.owner_name ?? '—'}</td><td className="r">{own.n ? money(own.budget) : <span className="sub2">未填</span>}</td><td className="r">{run && own.n ? money(own.used) : '—'}</td><td className="r">{run && own.n ? money(own.actual) : '—'}</td><td className="r">{run && own.n ? money(own.budget - own.used) : '—'}</td></tr>
            </tbody>
            <tfoot><tr><th scope="row">合计</th><td /><td className="r">{money(all.budget)}</td><td className="r">{run ? money(all.used) : '—'}</td><td className="r">{run ? money(all.actual) : '—'}</td><td className="r">{run ? money(all.budget - all.used) : '—'}</td></tr>
              {cap && <tr><th scope="row">离上限</th><td /><td className={`r ${num(cap.amount) - num(cap.used) <= 0 ? 'neg' : ''}`}>{money(num(cap.amount) - num(cap.used))}</td><td /><td /><td /></tr>}</tfoot>
          </table></div>
          {r.mine && r.kind !== 'public' && <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {canMove ? <button className="sm" onClick={() => setAct(moveAct())}>在论文项目之间调预算</button>
              : <span className="sub2">{y?.stage !== 'issued' ? '预算下达之后、决算之前才能在论文项目之间调。' : '要有两个以上的项目有预算行才能调。'}</span>}
          </div>}
        </section>
      )}

      {r.kind !== 'public' && <>
        <section className="card" id="sec-shift">
          <h3>调剂 <span className="h3sub">{year} 年度</span></h3>
          <p className="hint">预算下达之后，项目负责人可以在这个项目的预算行之间挪钱，项目的核定数合计不变。全年累计不超过项目年度预算 10% 的直接生效，超过的交中心负责人批。论文项目之间的调剂由大项目负责人在大项目的页面里做，直接生效，也列在这里。</p>
          {shifts.length === 0 ? <Empty>{year} 年度还没有调剂过。</Empty> : (
            <div className="scroll"><table><thead><tr><th>日期</th><th>调出</th><th>调入</th><th className="r">金额</th><th>原因</th><th>状态</th></tr></thead>
              <tbody>{shifts.map((s) => <tr key={s.id}><td>{day(s.created_at)}<span className="sub2">{s.requester_name ?? ''}</span></td><td className="wrap">{s.to_project_id ? `${s.project_name} · ` : ''}{s.from_purpose}</td><td className="wrap">{s.to_project_id ? `${s.to_project_name} · ` : ''}{s.to_purpose}</td><td className="r">{money(s.amount)}</td>
                <td className="wrap">{s.note}{s.decide_note && <div className="sub2">批示：{s.decide_note}</div>}</td>
                <td>{s.status === 'pending' ? <Badge tone="warn">等中心负责人批</Badge> : s.status === 'rejected' ? <Badge tone="bad">没同意</Badge> : <Badge tone="ok">{s.decided_by_name ? `${s.decided_by_name} 已同意` : '已生效'}</Badge>}</td></tr>)}</tbody></table></div>)}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {canShift ? <button className="sm" onClick={() => setAct(shiftAct())}>在预算行之间调剂</button>
              : r.mine && <span className="sub2">{y?.stage !== 'issued' ? '预算下达之后、决算之前才能调剂。' : rows.length < 2 ? '只有一行预算，没有可调的。' : '有一笔调剂在等中心负责人批，批完再提下一笔。'}</span>}
          </div>
        </section>

        <section className="card" id="sec-members">
          <h3>成员 <span className="h3sub">{members.length} 人</span></h3>
          <p className="hint">只有名单里的人能从这个项目的预算行提支出、申领这个项目的接口额度。负责人直接加人和移出，不需要本人确认；负责人和副手本来就算在内。</p>
          {members.length === 0 ? <Empty>名单里还没有人。{r.can_roster ? '先把参加这个项目的人加进来，他们才能提支出。' : ''}</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>成员</th><th>加入</th><th>加入人</th><th className="r">名下接口额度</th><th /></tr></thead>
              <tbody>{members.map((m) => (
                <tr key={m.id}><td>{m.user_name}{m.user_id === me.id && <span className="sub2">我</span>}</td><td>{day(m.joined_on)}</td><td>{m.added_by_name ?? '—'}</td>
                  <td className="r">{m.holding > 0 ? `${m.holding} 条` : '—'}</td>
                  <td className="r">{r.can_roster && <button className="ghost sm danger" onClick={() => setAct(removeAct(m))}>移出</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {gone.length > 0 && <p className="sub2">已移出：{gone.map((m) => `${m.user_name}（${day(m.left_on)}）`).join('、')}</p>}
          {r.can_roster && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(addAct)}>加成员</button></div>}
        </section>

        {capped(r) && (
          <section className="card" id="sec-cap">
            <h3>上限</h3>
            <p className="hint">上限由中心负责人按档定，管的是这个大项目连同下面论文项目一年的预算合计。不够用时负责人写理由申请提高，中心负责人批。</p>
            {caps.length === 0 ? <Empty>还没有年度。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>年度</th><th className="r">上限</th><th className="r">已排进预算</th><th className="r">还能排</th><th /></tr></thead>
                <tbody>{caps.map(({ y: yy, c }) => (
                  <tr key={yy.year}><td>{yy.year}<span className="sub2">{STAGE_TEXT[yy.stage]}</span></td>
                    <td className="r">{c ? money(c.amount) : <span className="sub2">没定</span>}</td><td className="r">{c ? money(c.used) : '—'}</td>
                    <td className={`r ${c && num(c.amount) - num(c.used) <= 0 ? 'neg' : ''}`}>{c ? money(num(c.amount) - num(c.used)) : '—'}</td>
                    <td className="r"><div className="acts">
                      {director && yy.stage !== 'closed' && <button className="ghost sm" onClick={() => setAct(capAct(r, yy.year, c))}>{c ? '改上限' : '定上限'}</button>}
                      {r.mine && !director && c && yy.stage !== 'closed' && !capreqs.some((x) => x.year === yy.year && x.status === 'pending') && <button className="ghost sm" onClick={() => setAct(askAct(r, yy.year, c))}>申请提高</button>}</div></td></tr>
                ))}</tbody>
              </table></div>
            )}
            {capreqs.length > 0 && <CapReqTable rows={capreqs} director={director} setAct={setAct} />}
          </section>
        )}

        <section className="card" id="sec-assets">
          <h3>设备 <span className="h3sub">这个项目出钱买的</span></h3>
          <p className="hint">设备由项目出钱，验收入库之后是中心的公共设备，记在公共设备台账上，谁要用都按身份申领；出钱的项目的成员申领时排在前面。</p>
          {assets.length === 0 ? <Empty>这个项目还没有出钱买过设备。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>验收日</th><th>设备</th><th className="r">数量</th><th className="r">单价</th><th>预算行</th><th>现在在谁手里</th></tr></thead>
              <tbody>{assets.map((a) => (
                <tr key={a.id}><td>{day(a.received_on)}</td><td>{a.resource_name}</td><td className="r">{q(a.qty, a.unit)}</td><td className="r">{a.unit_price != null ? money(a.unit_price) : '—'}</td>
                  <td className="wrap">{a.line_purpose ?? '—'}</td><td className="wrap">{a.holders ?? '在库'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>

        <section className="card" id="sec-api">
          <h3>接口额度 <span className="h3sub">发给成员的</span></h3>
          <p className="hint">接口额度记在项目名下，只发给名单里的人。人不在项目上了、额度用不着了，负责人在这里收回；收回后发给这位成员的密钥同时从中台删除。</p>
          {allocs.length === 0 ? <Empty>这个项目还没有发出去的接口额度。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>接口</th><th>使用人</th><th className="r">额度</th><th className="r">已用</th><th>起始</th><th>到期</th><th>状态</th><th /></tr></thead>
              <tbody>{allocs.map((a) => (
                <tr key={a.id}><td>{a.resource_name}</td><td>{a.user_name}</td><td className="r">{q(a.quota, a.unit)}</td>
                  <td className="r">{a.used == null ? '未回写' : q(a.used, a.unit)}{a.used_on && <div className="sub2">截至 {day(a.used_on)}</div>}</td>
                  <td>{day(a.from_date)}</td><td>{a.to_date ? day(a.to_date) : '长期'}</td>
                  <td>{a.returned_on ? <Badge>{day(a.returned_on)} 收回</Badge> : a.current ? <Badge tone="ok">在用</Badge> : <Badge tone="warn">已到期</Badge>}</td>
                  <td className="r">{r.can_roster && !a.returned_on && <button className="ghost sm danger" onClick={() => setAct({ title: `收回：${a.user_name} · ${a.resource_name}`, submitLabel: '收回', danger: true,
                    hint: `收回日记为今天（${today()}）。发给 ${a.user_name} 的密钥同时从中台删除；服务商那边的密钥要请财务岗另外停用或轮换。`, fields: [], run: () => rpc('recall_project_allocation', { id: a.id }) })}>收回</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
