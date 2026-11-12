import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetYear, type Card, type CategorySubject, type Me, type Subject } from '../api';
import { ActionDialog, Badge, Empty, Loading, day, today, type Field } from '../ui';
import { STAGE_TEXT } from './Budget';
import { SchoolImport } from './Import';

// 财务工作台：年度预算用到的设置都在这里改，不写死在系统里。
export function Desk({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ years: BudgetYear[]; cats: BudgetCategory[]; map: CategorySubject[]; subjects: Subject[]; cards: Card[] }>({
    years: ['budget_year'], cats: ['budget_category'], map: ['category_subject'], subjects: ['subject'], cards: ['card'] });
  const [link, setLink] = useState<BudgetCategory | null>(null);
  const [yr, setYr] = useState<BudgetYear | 'new' | null>(null);
  const [cat, setCat] = useState<BudgetCategory | 'new' | null>(null);
  if (!data) return <Loading error={error} />;
  const y = yr === 'new' ? null : yr, c = cat === 'new' ? null : cat;
  const next = Number(today().slice(0, 4)) + 1;
  const cats = data.cats.slice().sort((a, b) => a.sort - b.sort);
  const tpl = new Map(data.cards.map((c) => [c.template_id, c.template_name]));
  const subs = data.subjects.slice().sort((a, b) => (tpl.get(a.template_id) ?? '').localeCompare(tpl.get(b.template_id) ?? '', 'zh') || a.sort - b.sort);
  const linked = (id: string) => subs.filter((s) => data.map.some((m) => m.category_id === id && m.subject_id === s.id));
  return (
    <>
      <div className="top"><h2>财务工作台</h2></div>
      <p className="lede">年度预算的截止日、预算科目和它对应的学校科目在这里调整，学校系统导出的文件也在这里导入；经费卡、对账和用户在上面的分页里。</p>
      <section className="card">
        <h3>年度预算</h3>
        {data.years.length === 0 ? <Empty>还没有开始任何年度的预算。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>年度</th><th>走到哪一步</th><th>申报截止日</th><th>报学校</th><th>学校批复</th><th /></tr></thead>
            <tbody>{data.years.slice().sort((a, b) => b.year - a.year).map((r) => (
              <tr key={r.year}><td><a href={`#/budget/${r.year}`}>{r.year}</a></td><td><Badge tone={r.stage === 'declare' ? 'warn' : 'pri'}>{STAGE_TEXT[r.stage]}</Badge></td>
                <td>{day(r.due_date)}</td><td>{day(r.applied_on)}</td><td>{day(r.granted_on)}</td>
                <td className="r">{r.stage === 'declare' && <button className="ghost sm" onClick={() => setYr(r)}>改截止日</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button onClick={() => setYr('new')}>开始新年度</button></div>
      </section>
      <section className="card">
        <h3>预算科目</h3>
        <p className="hint">各项目申报年度预算时按这些科目填。它是中心自己的口径；每个预算科目要对应到学校的经费卡科目，下达时才知道这一行的钱能从哪张卡的哪个科目出；没有对应的科目不能自动对卡。</p>
        <div className="scroll"><table>
          <thead><tr><th>顺序</th><th>代码</th><th>名称</th><th>劳务类</th><th>对应的学校科目</th><th>状态</th><th /></tr></thead>
          <tbody>{cats.map((r) => (
            <tr key={r.id} style={r.active ? undefined : { opacity: .55 }}><td>{r.sort}</td><td>{r.code}</td><td>{r.name}</td><td>{r.labor ? '是' : '—'}</td>
              <td className="wrap">{linked(r.id).length === 0 ? (r.active ? <Badge tone="bad">还没对应</Badge> : '—') : [...new Set(linked(r.id).map((s) => s.name))].join('、')}</td><td>{r.active ? '在用' : '已停用'}</td>
              <td className="r"><div className="acts"><button className="ghost sm" onClick={() => setLink(r)}>对应学校科目</button><button className="ghost sm" onClick={() => setCat(r)}>修改</button></div></td></tr>
          ))}</tbody>
        </table></div>
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="ghost" onClick={() => setCat('new')}>加科目</button></div>
      </section>
      <SchoolImport finance={me.role === 'finance'} />
      {link && <ActionDialog title={`${link.name} 对应的学校科目`} submitLabel="保存" onClose={() => setLink(null)}
        hint="勾上这个预算科目的钱可以从哪些学校科目出。不同经费卡的预算模板科目不一样，每个模板里能用的都勾上。"
        fields={[{ name: 'subjects', label: '学校科目', type: 'multi', required: false, value: linked(link.id).map((s) => s.id).join(','),
          options: subs.map((s): [string, string] => [s.id, `${tpl.get(s.template_id) ?? '模板'} · ${s.code} ${s.name}`]) }]}
        onSubmit={(v) => rpc('set_category_subjects', { category_id: link.id, subjects: v.subjects.split(',').filter(Boolean) }).then(reload)} />}
      {yr && <ActionDialog title={y ? `改 ${y.year} 年度预算的申报截止日` : '开始一个年度的预算'} submitLabel="保存" onClose={() => setYr(null)}
        fields={[...(y ? [] : [{ name: 'year', label: '年度', type: 'number', value: String(next) } as Field]), { name: 'due', label: '申报截止日', type: 'date', value: y ? day(y.due_date) : '' }]}
        onSubmit={(v) => rpc('open_budget_year', { year: y?.year ?? Math.round(Number(v.year)), due_date: v.due }).then(reload)} />}
      {cat && <ActionDialog title={c ? `修改科目：${c.name}` : '加预算科目'} submitLabel="保存" onClose={() => setCat(null)}
        fields={[{ name: 'code', label: '代码', value: c?.code }, { name: 'name', label: '名称', value: c?.name }, { name: 'sort', label: '顺序', type: 'number', value: String(c?.sort ?? (cats.at(-1)?.sort ?? 0) + 10) },
          { name: 'labor', label: '劳务类（计入劳务上限）', type: 'check', value: String(c?.labor ?? false) }, ...(c ? [{ name: 'active', label: '在用', type: 'check', value: String(c.active) } as Field] : [])]}
        onSubmit={(v) => rpc('save_budget_category', { id: c?.id ?? null, code: v.code, name: v.name, labor: v.labor === 'true', sort: Math.round(Number(v.sort)), active: c ? v.active === 'true' : true }).then(reload)} />}
    </>
  );
}
