import { useState } from 'react';
import { rpc, useViews, type ProjectTag, type BudgetLine, type BudgetYear, type LineExec, type Me, type Project, type ProjectBudget, type ProjectCap, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, Scholar, can, money, num, type Field } from '../ui';
import { KIND, STAGE_TEXT } from './Budget';
import { capped } from './Caps';
import { typeText } from './Project';
import { UnitApplyCard } from './Apply';

// 课题和研究单元：预算按它们管。研究单元挂在课题下面。每个一行，看它各年度的预算走到哪一步。
// 点名称进详情页，预算、成员、上限、调剂、设备、接口额度都在那一页。
export function Projects({ me }: { me: Me }) {
  const staff = can(me, 'budget.setup');
  const { data, error, reload } = useViews<{ projects: Project[]; years: BudgetYear[]; budgets: ProjectBudget[]; lines: BudgetLine[]; exec: LineExec[]; users: User[]; caps: ProjectCap[]; tags: ProjectTag[] }>({
    tags: ['project_tag'],
    projects: ['project'], years: ['budget_year'], budgets: ['project_budget'], lines: ['budget_line'], exec: ['line_exec'], users: ['users'], caps: ['project_cap'],
  });
  const [edit, setEdit] = useState<Project | 'new' | { under: Project } | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.slice().sort((a, b) => b.year - a.year);
  const bigs = data.projects.filter((x) => x.layer !== 'paper').sort((a, b) => Number(b.active) - Number(a.active) || Number(a.kind === 'public') - Number(b.kind === 'public') || a.code.localeCompare(b.code));
  const kids = (b: Project) => data.projects.filter((x) => x.parent_id === b.id).sort((a, c) => Number(c.active) - Number(a.active) || a.code.localeCompare(c.code));
  // 研究单元跟在所属课题后面；课题自己看不到的（比如只负责其中一篇论文），研究单元单独列在最后
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
    ...(paper ? [{ name: 'parent', label: '所属课题', options: bigs.filter((b) => b.kind !== 'public' && (b.active || b.id === p?.parent_id)).map((b) => [b.id, `${b.name}（${b.code}）`] as [string, string]), value: p?.parent_id ?? under?.id ?? '' } as Field] : []),
    { name: 'name', label: '名称', value: p?.name },
    { name: 'code', label: paper ? '编号（留空则按课题编号加序号自动生成）' : '编号（留空则自动生成）', required: false, value: p?.code },
    ...(paper ? [] : [{ name: 'kind', label: '类型', options: [['project', KIND.project], ['public', KIND.public]], value: p?.kind ?? 'project' } as Field]),
    { name: 'owner', label: paper ? '负责人' : '负责人（中心公共开支可留空）', required: paper, options: data.users.filter((u) => u.active).map((u) => [u.id, u.name]), value: p?.owner_id ?? '' },
    ...(p ? [{ name: 'active', label: '在用', type: 'check', value: String(p.active) } as Field] : [])];

  const tagged = new Set(data.tags.filter((t) => t.morningstar).map((t) => t.id));
  return (
    <>
      <div className="top"><h2>课题管理</h2>{staff && <button onClick={() => setEdit('new')}>新立课题</button>}</div>
      <p className="lede">预算按课题管理，不按人员分配。课题通过立项申请成立，每年申请延续，由联席会议评定档次；研究单元隶属于课题，全年随时可以申请，不参加评定。立项与延续在「<a href="#/apply">立项与延续申请</a>」中办理，研究单元在本页下方申请。点击名称进入详情页，可查看预算、成员、上限、调剂、设备和接口额度。</p>
      <section className="card">
        <h3>全部课题和研究单元</h3>
        {rows.length === 0 ? <Empty>{staff ? '暂无课题。请先新立课题并指定负责人，再在其下新增研究单元。' : '暂无课题。新课题请在「立项与延续申请」中申请立项。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>课题 / 研究单元</th><th>类型</th><th>负责人</th>{years.map((y) => <th key={y.year} className="r">{y.year} 年度<span className="sub2">{STAGE_TEXT[y.stage]}</span></th>)}{staff && <th />}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} style={r.active ? undefined : { opacity: .55 }}>
                <td style={r.layer === 'paper' ? { paddingLeft: 28 } : undefined}>{r.seen ? <a href={`#/project/${r.id}`}>{r.name}</a> : r.name}{data.tags.some((t) => t.id === r.id && t.proposed) && <> <Badge tone="warn">待立项</Badge></>}{tagged.has(r.id) && <> <Badge>晨星</Badge></>}<span className="sub2">{r.code}{r.active ? '' : ' · 已停用'}{r.layer === 'paper' && !bigs.some((b) => b.id === r.parent_id) ? ` · 隶属 ${r.parent_name}` : ''}</span>
                  {r.kind !== 'public' && <div className="sub2" style={{ marginLeft: 0 }}>成员 {r.members} 人{r.member && r.owner_id !== me.id ? ' · 本人在名单中' : ''}</div>}</td><td>{typeText(r)}</td>
                <td>{r.owner_name ?? '—'}{r.owner_id === me.id && <span className="sub2">本人</span>}<Scholar url={r.owner_scholar_url} /></td>
                {years.map((y) => { const b = data.budgets.find((x) => x.project_id === r.id && x.year === y.year);
                  const d = sum(r, y.year, 'declared'), a = sum(r, y.year, 'applied'), f = sum(r, y.year, 'fixed');
                  const ex = data.exec.filter((x) => x.project_id === r.id && x.year === y.year), run = y.stage === 'issued' || y.stage === 'closed';
                  const ks = r.layer === 'paper' ? [] : kids(r).filter((k) => k.active), kn = ks.map((k) => best(k, y.year)).filter((n): n is number => n != null);
                  const cp = capped(r) ? capOf(r, y.year) : undefined;
                  const capLine = cp && <div className="sub2" style={{ marginLeft: 0 }}>上限 {money(cp.amount)}，已编入 {money(cp.used)}</div>;
                  const all = kn.length > 0 && <div className="sub2" style={{ marginLeft: 0 }}>连同 {ks.length} 个研究单元合计 {money(kn.reduce((s, n) => s + n, 0) + (best(r, y.year) ?? 0))}</div>;
                  if (d == null && !ex.length && (all || capLine) && r.seen) return <td key={y.year} className="r">{all}{capLine}</td>;
                  if (run && r.seen && ex.length > 0) { const fx = ex.reduce((s, x) => s + num(x.fixed), 0), us = ex.reduce((s, x) => s + num(x.used), 0), ac = ex.reduce((s, x) => s + num(x.actual), 0);
                    return <td key={y.year} className="r"><a href={`#/project/${r.id}/${y.year}`}>{money(fx)}<span className="sub2">已用 {money(us)} · 入账 {money(ac)} · 剩余 {money(fx - us)}</span></a>{all}{capLine}</td>; }
                  return <td key={y.year} className="r">{!r.seen ? <span className="sub2">待立项，评定通过后公开</span> : d == null ? <span className="sub2">未填报</span> : (
                    <a href={`#/budget/${y.year}`}>{money(f ?? a ?? d)}<span className="sub2">{f != null ? '核定数' : a != null ? '申请数' : '申报数'}
                      {b && b.status !== 'submitted' && <> · <Badge tone={b.status === 'returned' ? 'bad' : 'warn'}>{b.status === 'returned' ? '已退回' : '未提交'}</Badge></>}</span></a>)}{r.seen && d != null && all}{r.seen && d != null && capLine}</td>; })}
                {staff && <td className="r"><div className="acts">
                  {r.layer !== 'paper' && r.kind !== 'public' && r.active && <button className="ghost sm" onClick={() => setEdit({ under: r })}>新增研究单元</button>}{r.kind !== 'public' && <button className="ghost sm" onClick={() => rpc('set_project_morningstar', { id: r.id, on: !tagged.has(r.id) }).then(reload)}>{tagged.has(r.id) ? '取消晨星标签' : '标为晨星'}</button>}<button className="ghost sm" onClick={() => setEdit(r)}>修改</button></div></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="hint">已下达的年度显示核定数和执行情况，未下达的年度显示申报数、申请数或核定数。课题对全体成员公开：已立项的课题和研究单元，其预算、执行、成员、设备和接口额度所有人均可查看；逐笔的支出申请仅申请人、该课题负责人、财务岗和中心负责人可见。待立项的课题在评定通过前不公开金额。</p>
      </section>
      <UnitApplyCard me={me} onChange={reload} />
      {edit && <ActionDialog title={p ? `修改${paper ? '研究单元' : '课题'}：${p.name}` : under ? `在「${under.name}」下新增研究单元` : '新立课题'} fields={fields} submitLabel="保存" onClose={() => setEdit(null)}
        onSubmit={(v) => rpc('save_project', { id: p?.id ?? null, code: v.code ?? '', name: v.name, kind: paper ? null : v.kind, owner_id: v.owner || null, active: p ? v.active === 'true' : true, parent_id: paper ? v.parent : null }).then(reload)} />}
    </>
  );
}
