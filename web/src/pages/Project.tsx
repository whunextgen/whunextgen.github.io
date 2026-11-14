import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetLine, type BudgetShift, type BudgetYear, type CapRequest, type LineExec, type Me, type PeoplePick, type Project, type ProjectAllocation, type ProjectAsset, type ProjectCap, type ProjectMember } from '../api';
import { ActionDialog, Badge, Empty, Loading, Tile, can, day, money, num, pct, today } from '../ui';
import { KIND, STAGE_TEXT } from './Budget';
import { CapReqTable, askAct, capAct, capped, type Act } from './Caps';

const q = (n: string | number | null | undefined, unit?: string | null) => (n == null ? '—' : `${num(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);
export const typeText = (r: Project) => r.layer === 'paper' ? '研究单元' : r.kind === 'project' ? '课题' : KIND[r.kind];

// 详情页：一个课题或研究单元的事都在这一页。预算和执行、下面的研究单元、行间调剂、成员名单、年度上限、出钱买的设备、发出去的接口额度。
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
  if (!r) return <><div className="top"><h2>课题管理</h2></div><Empty>课题或研究单元不存在或无权查看。<a href="#/projects">返回课题管理</a></Empty></>;
  const un = typeText(r);   // 本页是课题、研究单元、独立研究线还是中心公共开支
  const head = (
    <div className="top">
      <div className="crumb"><a href="#/projects">课题管理</a>{r.layer === 'paper' && r.parent_id && <> / {data.projects.some((x) => x.id === r.parent_id && x.seen) ? <a href={`#/project/${r.parent_id}`}>{r.parent_name}</a> : r.parent_name}</>} · {r.code} · {typeText(r)}{r.owner_name ? ` · 负责人 ${r.owner_name}` : ''}{r.active ? '' : ' · 已停用'}</div>
      <h2>{r.name}</h2>
    </div>
  );
  if (!r.seen) return <>{head}<Empty>该{un}的预算和执行情况仅负责人、财务岗和中心负责人可查看。{r.member ? `本人在成员名单中，可在「支出申请」中从该${un}的预算行提交支出申请。` : ''}</Empty></>;

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
  const nav: [string, string][] = [['budget', '预算'], ...(kids.length ? [['papers', '研究单元'] as [string, string]] : []), ...(r.kind !== 'public' ? [['shift', '调剂'], ['members', '成员'], ...(capped(r) ? [['cap', '上限'] as [string, string]] : []), ['assets', '设备'], ['api', '接口额度']] as [string, string][] : [])];
  const jump = (k: string) => document.getElementById(`sec-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <>
      {head}
      {years.length > 1 && <div className="tabs" style={{ marginBottom: 12 }}>{years.map((n) => <a key={n.year} className="btn sm" aria-current={n.year === year ? 'page' : undefined} href={`#/project/${r.id}/${n.year}`}>{n.year}</a>)}</div>}
      <div className="tabs" style={{ marginBottom: 16 }}>{nav.map(([k, label]) => <button key={k} className="ghost sm" onClick={() => jump(k)}>{label}</button>)}</div>

      {y && <div className="tiles">
        <Tile k={`${year} 年度预算`} v={own.n || kt.length ? money(all.budget) : '未填报'} f={`${STAGE_TEXT[y.stage]}${kt.length ? ` · 连同 ${kt.length} 个研究单元` : ''}`} />
        <Tile k="已用（含在途）" v={run ? money(all.used) : '—'} f={run ? `占预算 ${pct(all.used, all.budget)}` : '下达后开始执行'} />
        <Tile k="已入账" v={run ? money(all.actual) : '—'} f={run ? `执行率 ${pct(all.actual, all.budget)}` : '以学校正式入账为准'} />
        {cap ? <Tile k="年度上限" v={money(cap.amount)} f={`已编入预算 ${money(cap.used)}，剩余可排 ${money(num(cap.amount) - num(cap.used))}`} />
          : <Tile k="未使用" v={run ? money(all.budget - all.used) : '—'} f={capped(r) ? '本年度尚未设定上限' : '年末未使用的不结转'} />}
      </div>}

      <section className="card" id="sec-budget">
        <h3>预算 <span className="h3sub">{y ? `${year} 年度 · ${STAGE_TEXT[y.stage]}` : ''}</span></h3>
        {!y ? <Empty>暂无已启动的年度预算。</Empty> : run && rows.length > 0 ? (
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
            <thead><tr><th>预算行</th><th className="r">金额</th><th>统计口径</th></tr></thead>
            <tbody>{draft.map((l) => <tr key={l.id}><td className="wrap">{l.purpose}<div className="sub2">{cat.get(l.category_id) ?? '—'}</div></td><td className="r">{money(best(l))}</td><td>{stageWord(l)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row">合计</th><td className="r">{money(own.budget)}</td><td /></tr></tfoot>
          </table></div>
        ) : <Empty>{year} 年度本{un}自身暂无预算行。{r.mine && y.stage === 'declare' ? '请到预算编制页面填报。' : ''}</Empty>}
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {y && <a className="btn ghost sm" href={`#/budget/${year}`}>{r.mine && y.stage === 'declare' ? '前往预算编制填报' : '在预算编制中查看'}</a>}
          {y && run && rows.length > 0 && <a className="btn ghost sm" href={`#/review/${year}`}>查看分期执行和复盘</a>}
        </div>
      </section>

      {kids.length > 0 && (
        <section className="card" id="sec-papers">
          <h3>研究单元 <span className="h3sub">{kids.length} 个 · {year} 年度</span></h3>
          <p className="hint">研究单元的预算计入本课题的上限。申报期间课题负责人可在预算编制页面直接修改下属各研究单元的预算；预算下达后，课题负责人可在各研究单元之间调剂，合计不变。</p>
          <div className="scroll"><table>
            <thead><tr><th>研究单元</th><th>负责人</th><th className="r">预算</th><th className="r">已用（含在途）</th><th className="r">已入账</th><th className="r">剩余</th></tr></thead>
            <tbody>
              {kids.map((k) => { const t = tot(k.id); return (
                <tr key={k.id} style={k.active ? undefined : { opacity: .55 }}><td><a href={`#/project/${k.id}/${year}`}>{k.name}</a><span className="sub2">{k.code}{k.active ? '' : ' · 已停用'}</span></td><td>{k.owner_name ?? '—'}</td>
                  <td className="r">{t.n ? money(t.budget) : <span className="sub2">未填报</span>}</td><td className="r">{run && t.n ? money(t.used) : '—'}</td><td className="r">{run && t.n ? money(t.actual) : '—'}</td><td className="r">{run && t.n ? money(t.budget - t.used) : '—'}</td></tr>); })}
              <tr><td>课题自身的预算行</td><td>{r.owner_name ?? '—'}</td><td className="r">{own.n ? money(own.budget) : <span className="sub2">未填报</span>}</td><td className="r">{run && own.n ? money(own.used) : '—'}</td><td className="r">{run && own.n ? money(own.actual) : '—'}</td><td className="r">{run && own.n ? money(own.budget - own.used) : '—'}</td></tr>
            </tbody>
            <tfoot><tr><th scope="row">合计</th><td /><td className="r">{money(all.budget)}</td><td className="r">{run ? money(all.used) : '—'}</td><td className="r">{run ? money(all.actual) : '—'}</td><td className="r">{run ? money(all.budget - all.used) : '—'}</td></tr>
              {cap && <tr><th scope="row">距上限</th><td /><td className={`r ${num(cap.amount) - num(cap.used) <= 0 ? 'neg' : ''}`}>{money(num(cap.amount) - num(cap.used))}</td><td /><td /><td /></tr>}</tfoot>
          </table></div>
          {r.mine && r.kind !== 'public' && <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {canMove ? <button className="sm" onClick={() => setAct(moveAct())}>研究单元间预算调剂</button>
              : <span className="sub2">{y?.stage !== 'issued' ? '预算下达后、决算前方可在研究单元之间调剂。' : '须有两个以上研究单元有预算行方可调剂。'}</span>}
          </div>}
        </section>
      )}

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

        <section className="card" id="sec-members">
          <h3>成员 <span className="h3sub">{members.length} 人</span></h3>
          <p className="hint">仅名单内人员可从本{un}的预算行提交支出申请、申领本{un}的接口额度。负责人可直接新增和移出成员，无需本人确认；负责人和副手默认在名单内。</p>
          {members.length === 0 ? <Empty>名单暂无成员。{r.can_roster ? `请先将参与本${un}的人员加入名单，加入后方可提交支出申请。` : ''}</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>成员</th><th>加入日期</th><th>加入人</th><th className="r">名下接口额度</th><th /></tr></thead>
              <tbody>{members.map((m) => (
                <tr key={m.id}><td>{m.user_name}{m.user_id === me.id && <span className="sub2">本人</span>}</td><td>{day(m.joined_on)}</td><td>{m.added_by_name ?? '—'}</td>
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
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
