import { useState } from 'react';
import { rpc, useViews, type BudgetLine, type BudgetYear, type CapRequest, type LineExec, type Me, type PeoplePick, type Project, type ProjectAllocation, type ProjectAsset, type ProjectBudget, type ProjectCap, type ProjectMember, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, money, num, today, type Field } from '../ui';
import { KIND, STAGE_TEXT } from './Budget';

interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const TIERS = '1 千、5 千、2 万、5 万、20 万、50 万，50 万以上按实际数填';
const CAP_REQ: Record<string, [string, string]> = { pending: ['等中心负责人批', 'warn'], approved: ['已同意', 'ok'], rejected: ['没同意', 'bad'] };
const q = (n: string | number | null | undefined, unit?: string | null) => (n == null ? '—' : `${num(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`);

// 项目：钱按项目管。项目分两层：大项目下面挂论文项目。每个项目一行，看它各年度的预算走到哪一步、三个数各是多少。
// 点开一个项目看它的成员名单、年度上限、买的设备和发出去的接口额度。
const typeText = (r: Project) => r.layer === 'paper' ? '论文项目' : r.kind === 'project' ? '大项目' : KIND[r.kind];
export function Projects({ me }: { me: Me }) {
  const staff = can(me, 'budget.setup'), director = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ projects: Project[]; years: BudgetYear[]; budgets: ProjectBudget[]; lines: BudgetLine[]; exec: LineExec[]; users: User[];
    members: ProjectMember[]; people: PeoplePick[]; caps: ProjectCap[]; capreqs: CapRequest[]; assets: ProjectAsset[]; pallocs: ProjectAllocation[] }>({
    projects: ['project'], years: ['budget_year'], budgets: ['project_budget'], lines: ['budget_line'], exec: ['line_exec'], users: ['users'],
    members: ['project_member'], people: ['people_pick'], caps: ['project_cap'], capreqs: ['cap_request'], assets: ['project_asset'], pallocs: ['project_allocation'],
  });
  const [edit, setEdit] = useState<Project | 'new' | { under: Project } | null>(null);
  const [open, setOpen] = useState('');
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.slice().sort((a, b) => b.year - a.year);
  const bigs = data.projects.filter((x) => x.layer !== 'paper').sort((a, b) => Number(b.active) - Number(a.active) || Number(a.kind === 'public') - Number(b.kind === 'public') || a.code.localeCompare(b.code));
  const kids = (b: Project) => data.projects.filter((x) => x.parent_id === b.id).sort((a, c) => Number(c.active) - Number(a.active) || a.code.localeCompare(c.code));
  // 论文项目跟在所属大项目后面；大项目自己看不到的（比如只负责其中一篇论文），论文项目单独列在最后
  const rows = [...bigs.flatMap((b) => [b, ...kids(b)]), ...data.projects.filter((x) => x.layer === 'paper' && !bigs.some((b) => b.id === x.parent_id))];
  const sum = (p: Project, year: number, k: 'declared' | 'applied' | 'fixed') => {
    const l = data.lines.filter((x) => x.project_id === p.id && x.year === year);
    return l.length === 0 || (k !== 'declared' && l.every((x) => x[k] == null)) ? null : l.reduce((s, x) => s + num(x[k]), 0);
  };
  const under = edit && edit !== 'new' && 'under' in edit ? edit.under : null;
  const p = edit === 'new' || under ? null : edit as Project | null;
  const paper = !!under || p?.layer === 'paper';
  const best = (r: Project, year: number) => sum(r, year, 'fixed') ?? sum(r, year, 'applied') ?? sum(r, year, 'declared');
  const capOf = (r: Project, year: number) => data.caps.find((c) => c.project_id === r.id && c.year === year);
  const fields: Field[] = [
    ...(paper ? [{ name: 'parent', label: '所属大项目', options: bigs.filter((b) => b.kind !== 'public' && (b.active || b.id === p?.parent_id)).map((b) => [b.id, `${b.name}（${b.code}）`] as [string, string]), value: p?.parent_id ?? under?.id ?? '' } as Field] : []),
    { name: 'name', label: paper ? '论文项目名称' : '名称', value: p?.name },
    { name: 'code', label: paper ? '编号（不填就按大项目编号加序号自动编）' : '编号', required: !paper, value: p?.code },
    ...(paper ? [] : [{ name: 'kind', label: '类型', options: [['project', '大项目'], ['line', KIND.line], ['public', KIND.public]], value: p?.kind ?? 'project' } as Field]),
    { name: 'owner', label: paper ? '负责人' : '负责人（中心公共开支可以不选）', required: paper, options: data.users.filter((u) => u.active).map((u) => [u.id, u.name]), value: p?.owner_id ?? '' },
    ...(p ? [{ name: 'active', label: '在用', type: 'check', value: String(p.active) } as Field] : [])];

  // ---------- 点开的项目 ----------
  const o = data.projects.find((x) => x.id === open);
  const capped = (r: Project) => r.layer !== 'paper' && r.kind !== 'public';
  const detail = (r: Project) => {
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
    const caps = years.map((y) => ({ y, c: capOf(r, y.year) })).filter(({ y, c }) => c || y.stage !== 'closed');
    const capAct = (year: number, c?: ProjectCap): Act => ({ title: `${year} 年度上限：${r.name}`, submitLabel: '保存',
      hint: `大项目连同它下面的论文项目，这一年的预算合计不能超过上限。按档定：${TIERS}。${c ? `现在的上限 ${money(c.amount)}，已经排进预算 ${money(c.used)}，新的上限不能低于这个数。留空保存就是取消上限。` : ''}各大项目上限合计不能超过年度总预算。`,
      fields: [{ name: 'amount', label: '上限（元）', type: 'number', required: !c, value: c ? String(num(c.amount)) : '' }],
      run: (v) => rpc('set_project_cap', { year, project_id: r.id, amount: v.amount || null }) });
    const askAct = (year: number, c: ProjectCap): Act => ({ title: `申请提高 ${year} 年度上限：${r.name}`, submitLabel: '提交申请',
      hint: `现在的上限 ${money(c.amount)}，已经排进预算 ${money(c.used)}。新的上限按档填：${TIERS}。提交后由中心负责人批，批之前上限不变。`,
      fields: [{ name: 'amount', label: '想提到多少（元）', type: 'number' }, { name: 'reason', label: '理由（为什么不够、多出来的钱做什么）', type: 'area' }],
      run: (v) => rpc('request_cap', { year, project_id: r.id, amount: v.amount, reason: v.reason }) });
    const capreqs = data.capreqs.filter((x) => x.project_id === r.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const assets = data.assets.filter((a) => a.project_id === r.id).sort((a, b) => b.received_on.localeCompare(a.received_on));
    const allocs = data.pallocs.filter((a) => a.project_id === r.id).sort((a, b) => Number(b.current) - Number(a.current) || b.from_date.localeCompare(a.from_date));
    return (
      <section className="card wide" key={r.id}>
        <h3>{r.name} <span className="h3sub">{r.code} · {typeText(r)}{r.owner_name ? ` · 负责人 ${r.owner_name}` : ''}</span></h3>

        <h4>成员名单 <span className="h3sub">{members.length} 人</span></h4>
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

        {capped(r) && <>
          <h4>年度上限</h4>
          <p className="hint">上限由中心负责人按档定，管的是这个大项目连同下面论文项目一年的预算合计。不够用时负责人写理由申请提高，中心负责人批。</p>
          {caps.length === 0 ? <Empty>还没有年度。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>年度</th><th className="r">上限</th><th className="r">已排进预算</th><th className="r">还能排</th><th /></tr></thead>
              <tbody>{caps.map(({ y, c }) => (
                <tr key={y.year}><td>{y.year}<span className="sub2">{STAGE_TEXT[y.stage]}</span></td>
                  <td className="r">{c ? money(c.amount) : <span className="sub2">没定</span>}</td><td className="r">{c ? money(c.used) : '—'}</td>
                  <td className={`r ${c && num(c.amount) - num(c.used) <= 0 ? 'neg' : ''}`}>{c ? money(num(c.amount) - num(c.used)) : '—'}</td>
                  <td className="r"><div className="acts">
                    {director && y.stage !== 'closed' && <button className="ghost sm" onClick={() => setAct(capAct(y.year, c))}>{c ? '改上限' : '定上限'}</button>}
                    {r.mine && !director && c && y.stage !== 'closed' && !capreqs.some((x) => x.year === y.year && x.status === 'pending') && <button className="ghost sm" onClick={() => setAct(askAct(y.year, c))}>申请提高</button>}</div></td></tr>
              ))}</tbody>
            </table></div>
          )}
          {capreqs.length > 0 && (
            <div className="scroll"><table>
              <thead><tr><th>提交</th><th>年度</th><th className="r">想提到</th><th>理由</th><th>状态</th><th /></tr></thead>
              <tbody>{capreqs.map((x) => (
                <tr key={x.id}><td>{day(x.created_at)}<span className="sub2">{x.requester_name ?? ''}</span></td><td>{x.year}</td>
                  <td className="r">{money(x.amount)}{x.status === 'pending' && <div className="sub2">现在 {money(x.cap)}</div>}</td>
                  <td className="wrap">{x.reason}{x.decide_note && <div className="sub2">批示：{x.decide_note}</div>}</td>
                  <td><Badge tone={CAP_REQ[x.status][1]}>{CAP_REQ[x.status][0]}</Badge></td>
                  <td className="r"><div className="acts">{director && x.status === 'pending' && <>
                    <button className="sm" onClick={() => setAct({ title: `同意提高上限：${r.name} ${x.year} 年度`, submitLabel: '同意',
                      hint: `${x.requester_name ?? '负责人'} 申请从 ${money(x.cap)} 提到 ${money(x.amount)}。理由：${x.reason}。可以批一个比申请少的数，按档填：${TIERS}。`,
                      fields: [{ name: 'amount', label: '批准的上限（元）', type: 'number', value: String(num(x.amount)) }, { name: 'note', label: '批示（可不填）', required: false }],
                      run: (v) => rpc('decide_cap_request', { id: x.id, ok: true, amount: v.amount, note: v.note || null }) })}>同意</button>
                    <button className="sm ghost danger" onClick={() => setAct({ title: `不同意提高上限：${r.name} ${x.year} 年度`, submitLabel: '不同意', danger: true,
                      hint: `${x.requester_name ?? '负责人'} 申请从 ${money(x.cap)} 提到 ${money(x.amount)}。理由：${x.reason}`,
                      fields: [{ name: 'note', label: '原因' }], run: (v) => rpc('decide_cap_request', { id: x.id, ok: false, amount: null, note: v.note }) })}>不同意</button></>}</div></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </>}

        <h4>这个项目出钱买的设备</h4>
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

        <h4>发给成员的接口额度</h4>
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
    );
  };

  return (
    <>
      <div className="top"><h2>项目</h2>{staff && <button onClick={() => setEdit('new')}>新立大项目</button>}</div>
      <p className="lede">经费按项目管理，不按人分配。项目分两层：论文项目挂在大项目下面，都由财务岗建。年度预算由项目负责人申报；中心公共开支由财务岗列。谁能从项目提支出看成员名单，名单由项目负责人管。</p>
      <section className="card">
        <h3>{staff ? '全部项目' : '项目'}</h3>
        {rows.length === 0 ? <Empty>还没有项目。{staff && '先新立大项目并指定负责人，再在它下面加论文项目。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>项目</th><th>类型</th><th>负责人</th>{years.map((y) => <th key={y.year} className="r">{y.year} 年度<span className="sub2">{STAGE_TEXT[y.stage]}</span></th>)}<th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} style={r.active ? undefined : { opacity: .55 }}>
                <td style={r.layer === 'paper' ? { paddingLeft: 28 } : undefined}>{r.name}<span className="sub2">{r.code}{r.active ? '' : ' · 已停用'}{r.layer === 'paper' && !bigs.some((b) => b.id === r.parent_id) ? ` · 挂在 ${r.parent_name}` : ''}</span>
                  {r.kind !== 'public' && <div className="sub2" style={{ marginLeft: 0 }}>成员 {r.members} 人{r.member && r.owner_id !== me.id ? ' · 我在名单里' : ''}</div>}</td><td>{typeText(r)}</td>
                <td>{r.owner_name ?? '—'}{r.owner_id === me.id && <span className="sub2">我</span>}</td>
                {years.map((y) => { const b = data.budgets.find((x) => x.project_id === r.id && x.year === y.year);
                  const d = sum(r, y.year, 'declared'), a = sum(r, y.year, 'applied'), f = sum(r, y.year, 'fixed');
                  const ex = data.exec.filter((x) => x.project_id === r.id && x.year === y.year), run = y.stage === 'issued' || y.stage === 'closed';
                  const ks = r.layer === 'paper' ? [] : kids(r).filter((k) => k.active), kn = ks.map((k) => best(k, y.year)).filter((n): n is number => n != null);
                  const cp = capped(r) ? capOf(r, y.year) : undefined;
                  const capLine = cp && <div className="sub2" style={{ marginLeft: 0 }}>上限 {money(cp.amount)}，已排 {money(cp.used)}</div>;
                  const all = kn.length > 0 && <div className="sub2" style={{ marginLeft: 0 }}>连同 {ks.length} 个论文项目合计 {money(kn.reduce((s, n) => s + n, 0) + (best(r, y.year) ?? 0))}</div>;
                  if (d == null && !ex.length && (all || capLine) && r.seen) return <td key={y.year} className="r">{all}{capLine}</td>;
                  if (run && r.seen && ex.length > 0) { const fx = ex.reduce((s, x) => s + num(x.fixed), 0), us = ex.reduce((s, x) => s + num(x.used), 0), ac = ex.reduce((s, x) => s + num(x.actual), 0);
                    return <td key={y.year} className="r"><a href={`#/review/${y.year}`}>{money(fx)}<span className="sub2">已用 {money(us)} · 入账 {money(ac)} · 剩 {money(fx - us)}</span></a>{all}{capLine}</td>; }
                  return <td key={y.year} className="r">{!r.seen ? <span className="sub2">只有负责人和财务岗能看</span> : d == null ? <span className="sub2">未填</span> : (
                    <a href={`#/budget/${y.year}`}>{money(f ?? a ?? d)}<span className="sub2">{f != null ? '核定数' : a != null ? '申请数' : '申报数'}
                      {b && b.status !== 'submitted' && <> · <Badge tone={b.status === 'returned' ? 'bad' : 'warn'}>{b.status === 'returned' ? '被退回' : '未提交'}</Badge></>}</span></a>)}{r.seen && d != null && all}{r.seen && d != null && capLine}</td>; })}
                <td className="r"><div className="acts">
                  {r.kind !== 'public' && r.seen && <button className="ghost sm" aria-pressed={open === r.id} onClick={() => setOpen(open === r.id ? '' : r.id)}>成员和资产</button>}
                  {staff && r.layer !== 'paper' && r.kind !== 'public' && r.active && <button className="ghost sm" onClick={() => setEdit({ under: r })}>加论文项目</button>}{staff && <button className="ghost sm" onClick={() => setEdit(r)}>修改</button>}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="hint">年度预算下达之后，支出申请按项目的预算行提交，花的钱记在项目上。已下达的年度这里显示核定数和执行，点进去看各行明细和复盘；没有下达的年度显示申报数、申请数或核定数。点「成员和资产」看这个项目的成员名单、年度上限、买的设备和发出去的接口额度。</p>
      </section>
      {o && detail(o)}
      {edit && <ActionDialog title={p ? `修改${paper ? '论文项目' : '项目'}：${p.name}` : under ? `在「${under.name}」下面加论文项目` : '新立大项目'} fields={fields} submitLabel="保存" onClose={() => setEdit(null)}
        onSubmit={(v) => rpc('save_project', { id: p?.id ?? null, code: v.code ?? '', name: v.name, kind: paper ? null : v.kind, owner_id: v.owner || null, active: p ? v.active === 'true' : true, parent_id: paper ? v.parent : null }).then(reload)} />}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
