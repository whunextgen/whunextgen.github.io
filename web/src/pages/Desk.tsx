import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetYear, type Card, type CategorySubject, type Me, type Subject } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, today, type Field } from '../ui';
import { STAGE_TEXT } from './Budget';
import { Backfill, SchoolImport } from './Import';

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
      <div className="top"><h2>预算参数</h2></div>
      <p className="lede">年度预算截止日、预算科目及其对应的学校科目在此调整，学校系统导出的文件也在此导入；经费卡和用户在「权限管理」中管理。</p>
      <section className="card">
        <h3>年度预算</h3>
        {data.years.length === 0 ? <Empty>暂无已启动的年度预算。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>年度</th><th>当前环节</th><th>申报截止日</th><th>报学校</th><th>学校批复</th><th /></tr></thead>
            <tbody>{data.years.slice().sort((a, b) => b.year - a.year).map((r) => (
              <tr key={r.year}><td><a href={`#/budget/${r.year}`}>{r.year}</a></td><td><Badge tone={r.stage === 'declare' ? 'warn' : 'pri'}>{STAGE_TEXT[r.stage]}</Badge></td>
                <td>{day(r.due_date)}</td><td>{day(r.applied_on)}</td><td>{day(r.granted_on)}</td>
                <td className="r">{r.stage === 'declare' && <button className="ghost sm" onClick={() => setYr(r)}>修改截止日</button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button onClick={() => setYr('new')}>启动新年度预算</button></div>
      </section>
      <section className="card">
        <h3>预算科目</h3>
        <p className="hint">各研究单元申报年度预算时按以下科目填报。预算科目为中心内部口径；每个预算科目须对应到学校的经费卡科目，下达时据此确定该预算行可由哪张经费卡的哪个科目列支；未对应的科目不能自动分配。</p>
        <div className="scroll"><table>
          <thead><tr><th>顺序</th><th>代码</th><th>名称</th><th>劳务类</th><th>对应的学校科目</th><th>状态</th><th /></tr></thead>
          <tbody>{cats.map((r) => (
            <tr key={r.id} style={r.active ? undefined : { opacity: .55 }}><td>{r.sort}</td><td>{r.code}</td><td>{r.name}</td><td>{r.labor ? '是' : '—'}</td>
              <td className="wrap">{linked(r.id).length === 0 ? (r.active ? <Badge tone="bad">尚未对应</Badge> : '—') : [...new Set(linked(r.id).map((s) => s.name))].join('、')}</td><td>{r.active ? '在用' : '已停用'}</td>
              <td className="r"><div className="acts"><button className="ghost sm" onClick={() => setLink(r)}>对应学校科目</button><button className="ghost sm" onClick={() => setCat(r)}>修改</button></div></td></tr>
          ))}</tbody>
        </table></div>
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="ghost" onClick={() => setCat('new')}>新增科目</button></div>
      </section>
      <SchoolImport finance={can(me, 'ledger.post')} />
      {can(me, 'ledger.post') && <Backfill />}
      {link && <ActionDialog title={`${link.name} 对应的学校科目`} submitLabel="保存" onClose={() => setLink(null)}
        hint="勾选该预算科目可列支的学校科目。不同经费卡的预算模板科目不同，各模板中可用的科目均须勾选。"
        fields={[{ name: 'subjects', label: '学校科目', type: 'multi', required: false, value: linked(link.id).map((s) => s.id).join(','),
          options: subs.map((s): [string, string] => [s.id, `${tpl.get(s.template_id) ?? '模板'} · ${s.code} ${s.name}`]) }]}
        onSubmit={(v) => rpc('set_category_subjects', { category_id: link.id, subjects: v.subjects.split(',').filter(Boolean) }).then(reload)} />}
      {yr && <ActionDialog title={y ? `修改 ${y.year} 年度预算申报截止日` : '启动新年度预算'} submitLabel="保存" onClose={() => setYr(null)}
        fields={[...(y ? [] : [{ name: 'year', label: '年度', type: 'number', value: String(next) } as Field]), { name: 'due', label: '申报截止日', type: 'date', value: y ? day(y.due_date) : '' }]}
        onSubmit={(v) => rpc('open_budget_year', { year: y?.year ?? Math.round(Number(v.year)), due_date: v.due }).then(reload)} />}
      {cat && <ActionDialog title={c ? `修改科目：${c.name}` : '新增预算科目'} submitLabel="保存" onClose={() => setCat(null)}
        fields={[{ name: 'code', label: '代码', value: c?.code }, { name: 'name', label: '名称', value: c?.name }, { name: 'sort', label: '顺序', type: 'number', value: String(c?.sort ?? (cats.at(-1)?.sort ?? 0) + 10) },
          { name: 'labor', label: '劳务类（计入劳务上限）', type: 'check', value: String(c?.labor ?? false) }, ...(c ? [{ name: 'active', label: '在用', type: 'check', value: String(c.active) } as Field] : [])]}
        onSubmit={(v) => rpc('save_budget_category', { id: c?.id ?? null, code: v.code, name: v.name, labor: v.labor === 'true', sort: Math.round(Number(v.sort)), active: c ? v.active === 'true' : true }).then(reload)} />}
    </>
  );
}
