import { useState } from 'react';
import { rpc, useViews, type BudgetLine, type BudgetYear, type LineExec, type Me, type Project, type ProjectBudget, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, money, num, type Field } from '../ui';
import { KIND, STAGE_TEXT } from './Budget';

// 项目：钱按项目管。每个项目一行，看它各年度的预算走到哪一步、三个数各是多少。
export function Projects({ me }: { me: Me }) {
  const staff = me.role === 'finance' || me.role === 'director';
  const { data, error, reload } = useViews<{ projects: Project[]; years: BudgetYear[]; budgets: ProjectBudget[]; lines: BudgetLine[]; exec: LineExec[]; users: User[] }>({
    projects: ['project'], years: ['budget_year'], budgets: ['project_budget'], lines: ['budget_line'], exec: ['line_exec'], users: ['users'],
  });
  const [edit, setEdit] = useState<Project | 'new' | null>(null);
  if (!data) return <Loading error={error} />;
  const years = data.years.slice().sort((a, b) => b.year - a.year);
  const rows = data.projects.slice().sort((a, b) => Number(b.active) - Number(a.active) || Number(a.kind === 'public') - Number(b.kind === 'public') || a.code.localeCompare(b.code));
  const sum = (p: Project, year: number, k: 'declared' | 'applied' | 'fixed') => {
    const l = data.lines.filter((x) => x.project_id === p.id && x.year === year);
    return l.length === 0 || (k !== 'declared' && l.every((x) => x[k] == null)) ? null : l.reduce((s, x) => s + num(x[k]), 0);
  };
  const p = edit === 'new' ? null : edit;
  const fields: Field[] = [
    { name: 'code', label: '编号', value: p?.code }, { name: 'name', label: '名称', value: p?.name },
    { name: 'kind', label: '类型', options: Object.entries(KIND), value: p?.kind ?? 'project' },
    { name: 'owner', label: '负责人（中心公共开支可以不选）', required: false, options: data.users.filter((u) => u.active).map((u) => [u.id, u.name]), value: p?.owner_id ?? '' },
    ...(p ? [{ name: 'active', label: '在用', type: 'check', value: String(p.active) } as Field] : [])];
  return (
    <>
      <div className="top"><h2>项目</h2>{staff && <button onClick={() => setEdit('new')}>新立项目</button>}</div>
      <p className="lede">经费按项目管理，不按人分配。年度预算由项目负责人申报；中心公共开支由财务岗列。</p>
      <section className="card">
        <h3>{staff ? '全部项目' : '项目'}</h3>
        {rows.length === 0 ? <Empty>还没有项目。{staff && '先新立项目并指定负责人，负责人就能申报年度预算。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>项目</th><th>类型</th><th>负责人</th>{years.map((y) => <th key={y.year} className="r">{y.year} 年度<span className="sub2">{STAGE_TEXT[y.stage]}</span></th>)}<th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} style={r.active ? undefined : { opacity: .55 }}>
                <td>{r.name}<span className="sub2">{r.code}{r.active ? '' : ' · 已停用'}</span></td><td>{KIND[r.kind]}</td>
                <td>{r.owner_name ?? '—'}{r.owner_id === me.id && <span className="sub2">我</span>}</td>
                {years.map((y) => { const b = data.budgets.find((x) => x.project_id === r.id && x.year === y.year);
                  const d = sum(r, y.year, 'declared'), a = sum(r, y.year, 'applied'), f = sum(r, y.year, 'fixed');
                  const ex = data.exec.filter((x) => x.project_id === r.id && x.year === y.year), run = y.stage === 'issued' || y.stage === 'closed';
                  if (run && r.mine && ex.length > 0) { const fx = ex.reduce((s, x) => s + num(x.fixed), 0), us = ex.reduce((s, x) => s + num(x.used), 0), ac = ex.reduce((s, x) => s + num(x.actual), 0);
                    return <td key={y.year} className="r"><a href={`#/review/${y.year}`}>{money(fx)}<span className="sub2">已用 {money(us)} · 入账 {money(ac)} · 剩 {money(fx - us)}</span></a></td>; }
                  return <td key={y.year} className="r">{!r.mine ? <span className="sub2">只有负责人和财务岗能看</span> : d == null ? <span className="sub2">未填</span> : (
                    <a href={`#/budget/${y.year}`}>{money(f ?? a ?? d)}<span className="sub2">{f != null ? '核定数' : a != null ? '申请数' : '申报数'}
                      {b && b.status !== 'submitted' && <> · <Badge tone={b.status === 'returned' ? 'bad' : 'warn'}>{b.status === 'returned' ? '被退回' : '未提交'}</Badge></>}</span></a>)}</td>; })}
                <td className="r">{staff && <button className="ghost sm" onClick={() => setEdit(r)}>修改</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="hint">年度预算下达之后，支出申请按项目的预算行提交，花的钱记在项目上。已下达的年度这里显示核定数和执行，点进去看各行明细和复盘；没有下达的年度显示申报数、申请数或核定数。</p>
      </section>
      {edit && <ActionDialog title={p ? `修改项目：${p.name}` : '新立项目'} fields={fields} submitLabel="保存" onClose={() => setEdit(null)}
        onSubmit={(v) => rpc('save_project', { id: p?.id ?? null, code: v.code, name: v.name, kind: v.kind, owner_id: v.owner || null, active: p ? v.active === 'true' : true }).then(reload)} />}
    </>
  );
}
