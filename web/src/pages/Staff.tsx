import { useMemo, useState } from 'react';
import { rpc, useViews, type CardPick, type Me, type PayType, type Person, type Sheet, type Staff, type Subject } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, money, num, today, type Field } from '../ui';

const SHEET: Record<Sheet['status'], [string, string]> = { draft: ['待发放', 'warn'], submitted: ['已提交', 'pri'], posted: ['已入账', 'ok'] };
const ym = (d: string) => d.slice(0, 7);
const first = (m: string) => (m ? `${m}-01` : null);
function span(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  while (out.length < 60) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k >= to) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
interface Act { title: string; hint?: string; label: string; fields: Field[]; run: (v: Record<string, string>) => Promise<unknown> }

export function StaffPage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ people: Person[]; types: PayType[]; staff: Staff[]; sheets: Sheet[]; cards: CardPick[]; subjects: Subject[] }>({
    people: ['person'], types: ['pay_type'], staff: ['staff'], sheets: ['payroll_sheet'], cards: ['card_pick'], subjects: ['subject'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const maps = useMemo(() => ({
    person: new Map((data?.people ?? []).map((p) => [p.id, p.name])),
    type: new Map((data?.types ?? []).map((t) => [t.id, t])),
    card: new Map((data?.cards ?? []).map((c) => [c.id, c])),
    sheet: new Map((data?.sheets ?? []).map((s) => [s.id, s])),
  }), [data]);
  if (!data) return <Loading error={error} />;

  const now = ym(today());
  const months = data.staff.length === 0 ? [] : span(
    data.staff.reduce((a, s) => (ym(s.month) < a ? ym(s.month) : a), now),
    data.staff.reduce((a, s) => (ym(s.month) > a ? ym(s.month) : a), now));
  const rows = new Map<string, { person: string; type: string; cells: Map<string, Staff> }>();
  for (const s of data.staff) {
    const k = `${s.person_id}|${s.pay_type_id}`;
    if (!rows.has(k)) rows.set(k, { person: s.person_id, type: s.pay_type_id, cells: new Map() });
    rows.get(k)!.cells.set(ym(s.month), s);
  }
  const list = [...rows.values()].sort((a, b) => (maps.person.get(a.person) ?? '').localeCompare(maps.person.get(b.person) ?? '', 'zh-CN'));
  const gaps = data.staff.filter((s) => s.gap);
  const unsheeted = data.staff.filter((s) => ym(s.month) === now && !s.sheet_id && !s.gap);
  const sheets = [...data.sheets].sort((a, b) => b.month.localeCompare(a.month));

  const people: [string, string][] = data.people.map((p) => [p.id, p.name]);
  const types: [string, string][] = data.types.map((t) => [t.id, t.name]);
  const cards: [string, string][] = data.cards.filter((c) => c.status === 'active').map((c) => [c.id, `${c.card_no} ${c.name}（${day(c.start_date)} 至 ${day(c.cutoff_date)}）`]);
  const codes = [...new Map(data.subjects.map((s) => [s.code, s.name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  const who: Field[] = [{ name: 'person_id', label: '人员', options: people }, { name: 'pay_type_id', label: '发放类型', options: types }];
  const range: Field[] = [{ name: 'from', label: '起始月份', type: 'month', value: now }, { name: 'to', label: '结束月份', type: 'month', value: now }];

  const plan: Act = { title: '排布人员费', label: '保存排布',
    hint: '将一名人员的一种发放在一段月份内列支于一张经费卡，每月金额相同。金额留空表示撤销该段排布。已列入发放表的月份不得修改。',
    fields: [...who, ...range, { name: 'card_id', label: '经费卡', options: cards, required: false }, { name: 'amount', label: '每月金额（元）', type: 'number', required: false }],
    run: (v) => rpc('set_staff', { person_id: v.person_id, pay_type_id: v.pay_type_id, from_month: first(v.from), to_month: first(v.to), card_id: v.card_id || null, amount: v.amount || null }) };
  const move: Act = { title: '变更经费卡', label: '确认变更',
    hint: '将该段月份内尚未列入发放表的排布整体变更至目标经费卡，金额不变。发放日不在目标经费卡有效期内，或目标经费卡该科目不足时不予办理。',
    fields: [...who, ...range, { name: 'card_id', label: '目标经费卡', options: cards }],
    run: (v) => rpc('reassign_staff', { person_id: v.person_id, pay_type_id: v.pay_type_id, from_month: first(v.from), to_month: first(v.to), card_id: v.card_id }) };
  const build: Act = { title: '生成发放表', label: '生成',
    hint: '按发放类型和经费卡分表，仅纳入发放日（当月 20 日）在经费卡有效期内的排布。列入发放表后，相应月份的排布锁定。',
    fields: [{ name: 'month', label: '月份', type: 'month', value: now }],
    run: (v) => rpc('build_payroll', { month: first(v.month) }) };
  const person = (p?: Person): Act => ({ title: p ? '修改人员' : '新增人员', label: '保存',
    fields: [{ name: 'name', label: '姓名', value: p?.name ?? '' }],
    run: (v) => rpc('save_person', { id: p?.id ?? null, name: v.name }) });
  const payType = (t?: PayType): Act => ({ title: t ? '修改发放类型' : '新增发放类型', label: '保存',
    hint: '发放类型决定该笔款项计入的科目。例如：外聘人员劳务费、学生三兼费、编外人员工资、专家咨询费。',
    fields: [{ name: 'name', label: '名称', value: t?.name ?? '' }, { name: 'subject_code', label: '对应科目', options: codes, value: t?.subject_code ?? '' },
      { name: 'monthly_cap', label: '每人每月上限（元，无上限的留空）', type: 'number', required: false, value: t?.monthly_cap ?? '' }],
    run: (v) => rpc('save_pay_type', { id: t?.id ?? null, name: v.name, subject_code: v.subject_code, monthly_cap: v.monthly_cap || null }) });
  const post = (s: Sheet): Act => ({ title: '发放表入账', label: '确认入账',
    hint: `${ym(s.month)} ${maps.type.get(s.pay_type_id)?.name ?? ''} · ${maps.card.get(s.card_id)?.name ?? ''}，合计 ${money(s.total)}。入账后计入决算数。`,
    fields: [{ name: 'posted_on', label: '学校入账日期', type: 'date', value: today() }],
    run: (v) => rpc('post_payroll', { id: s.id, posted_on: v.posted_on }) });
  const ready = data.people.length > 0 && data.types.length > 0;

  return (
    <>
      <div className="top"><h2>人员经费</h2>
        {can(me, 'payroll.reassign') && data.staff.length > 0 && <button className="ghost" onClick={() => setAct(move)}>变更经费卡</button>}
        {ready && <button onClick={() => setAct(plan)}>排布</button>}</div>

      <section className="card">
        <h3>人员 × 月份</h3>
        <p className="hint">每格为当月发放额及列支的经费卡。红格表示发放日（当月 20 日）不在该经费卡有效期内，该笔款项无法发放，需变更经费卡。</p>
        {list.length === 0 ? <Empty>{ready ? '暂无排布。点击右上角「排布」，将每人每月的发放额列支到经费卡。' : '请先在下方新增人员和发放类型，再进行排布。'}</Empty> : (
          <div className="scroll"><table className="staff">
            <thead><tr><th>人员</th><th>发放类型</th>{months.map((m) => <th key={m} className="r">{m.slice(2)}</th>)}</tr></thead>
            <tbody>{list.map((r) => (
              <tr key={`${r.person}|${r.type}`}><th scope="row">{maps.person.get(r.person) ?? '—'}</th><td>{maps.type.get(r.type)?.name ?? '—'}</td>
                {months.map((m) => { const c = r.cells.get(m); const sh = c?.sheet_id ? maps.sheet.get(c.sheet_id) : undefined; return (
                  <td key={m} className={`r ${c?.gap ? 'gap' : ''}`}>{c ? <><b>{money(c.amount)}</b>
                    <div className="sub2">{maps.card.get(c.card_id)?.card_no ?? '—'}{c.gap ? ` · ${c.gap}` : sh ? ` · ${sh.status === 'posted' ? '已入账' : '已列入发放表'}` : ''}</div></> : <span className="sub2">—</span>}</td>); })}</tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>检查</h3>
        <ul className="todo">
          <li><a href="#/staff"><Badge tone={gaps.length ? 'bad' : 'ok'}>{gaps.length ? `${gaps.length} 个人月` : '无'}</Badge>
            <span>列支于已回收、已结题或未下达的经费卡{gaps.length ? `，合计 ${money(gaps.reduce((s, g) => s + num(g.amount), 0))}` : ''}</span><span /></a></li>
          <li><a href="#/staff"><Badge tone={unsheeted.length ? 'warn' : 'ok'}>{unsheeted.length ? `${unsheeted.length} 笔` : '无'}</Badge>
            <span>本月（{now}）的排布尚未列入发放表{unsheeted.length ? `，合计 ${money(unsheeted.reduce((s, g) => s + num(g.amount), 0))}` : ''}</span><span /></a></li>
        </ul>
      </section>

      <section className="card">
        <h3>发放表</h3>
        {can(me, 'payroll.run') && data.staff.length > 0 && <div className="tabs" style={{ marginBottom: 12 }}><button className="sm" aria-pressed="true" onClick={() => setAct(build)}>生成发放表</button></div>}
        {sheets.length === 0 ? <Empty>暂无发放表。由财务岗按月根据排布生成。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>月份</th><th>发放类型</th><th>经费卡</th><th className="r">合计</th><th>状态</th><th /></tr></thead>
            <tbody>{sheets.map((s) => (
              <tr key={s.id}><td>{ym(s.month)}</td><td>{maps.type.get(s.pay_type_id)?.name ?? '—'}</td>
                <td><a href={`#/card/${s.card_id}`}>{maps.card.get(s.card_id)?.name ?? '—'}</a></td><td className="r">{money(s.total)}</td>
                <td><Badge tone={SHEET[s.status][1]}>{SHEET[s.status][0]}</Badge>{s.posted_on && <span className="sub2"> {day(s.posted_on)}</span>}</td>
                <td><div className="acts">{can(me, 'payroll.run') && s.status !== 'posted' && <button className="sm ghost" onClick={() => setAct(post(s))}>入账</button>}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>人员</h3>
        <div className="tabs">
          {data.people.map((p) => <button key={p.id} className="sm" title="修改" onClick={() => setAct(person(p))}>{p.name}</button>)}
          <button className="sm" aria-pressed="true" onClick={() => setAct(person())}>新增人员</button>
        </div>
      </section>

      <section className="card">
        <h3>发放类型</h3>
        <div className="tabs">
          {data.types.map((t) => <button key={t.id} className="sm" title="修改" onClick={() => setAct(payType(t))}>{t.name}{t.monthly_cap ? ` · 每月上限 ${money(t.monthly_cap)}` : ''}</button>)}
          <button className="sm" aria-pressed="true" onClick={() => setAct(payType())}>新增发放类型</button>
        </div>
      </section>

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
