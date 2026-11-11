import { useMemo, useState, type FormEvent } from 'react';
import { rpc, useViews, type CardPick, type ExpenseType, type Me, type Req, type ReqStatus, type Subject, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, REQ, day, money, num, today, type Field } from '../ui';

const PATHS = ['直采', '集采', '分散采购'];
const OPEN: ReqStatus[] = ['pending', 'committed', 'at_school', 'returned'];

interface Action { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 每个状态下，当前角色能做什么。权限最终由数据库函数判定，这里只决定显示哪些按钮。
function actionsFor(me: Me, r: Req): Action[] {
  const what = `${r.title}，${money(r.amount)}`;
  const out: Action[] = [];
  if (me.role === 'director' && r.status === 'pending') {
    out.push({ label: '批准', title: '批准这笔支出', hint: `${what}。批准后计入该卡的承诺。`, fields: [], run: () => rpc('approve_request', { id: r.id }) });
    out.push({ label: '驳回', title: '驳回这笔申请', hint: what, danger: true, fields: [{ name: 'note', label: '驳回原因' }],
      run: (v) => rpc('reject_request', { id: r.id, note: v.note }) });
  }
  if (me.role === 'finance' && r.status === 'committed')
    out.push({ label: '提交学校', title: '单据已提交学校', hint: what, fields: [], run: () => rpc('send_to_school', { id: r.id }) });
  if (me.role === 'finance' && r.status === 'at_school') {
    out.push({ label: '入账', title: '回写学校入账', hint: `${what}。决算数只认学校正式入账。`,
      fields: [{ name: 'posted_on', label: '入账日期', type: 'date', value: today() }, { name: 'amount', label: '入账金额', type: 'number', value: String(num(r.amount)) },
        { name: 'voucher_no', label: '凭证号（可不填）', required: false }],
      run: (v) => rpc('post_voucher', { id: r.id, ...v }) });
    out.push({ label: '退回', title: '学校退回了这笔单据', hint: `${what}。退回原因会写进可报销规则表。`, danger: true,
      fields: [{ name: 'reason', label: '退回原因' }], run: (v) => rpc('school_return', { id: r.id, reason: v.reason }) });
  }
  if ((me.role === 'finance' || me.role === 'director') && (r.status === 'committed' || r.status === 'returned'))
    out.push({ label: '释放', title: '释放这笔承诺', hint: `${what}。释放后额度回到可用，这笔申请作废。`, danger: true, fields: [],
      run: () => rpc('release_request', { id: r.id }) });
  return out;
}

export function RequestTable({ me, rows, subjectName, cardName, userName, onChange }: {
  me: Me; rows: Req[]; subjectName?: Map<string, string>; cardName?: Map<string, string>; userName?: Map<string, string>; onChange: () => void;
}) {
  const [act, setAct] = useState<Action | null>(null);
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>事项</th>{cardName && <th>经费卡</th>}<th>科目</th><th className="r">金额</th><th>预计入账</th><th>状态</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const acts = actionsFor(me, r);
          return (
            <tr key={r.id}>
              <td className="wrap">{r.title}
                <div className="sub2">{[r.code, userName?.get(r.requested_by ?? ''), r.requested_by === me.id ? '我提交的' : '',
                  r.path && `${r.path} ${r.stage}/${r.stages}`, r.emergency && '紧急通道'].filter(Boolean).join(' · ')}</div></td>
              {cardName && <td>{cardName.get(r.card_id) ?? '—'}</td>}
              <td>{subjectName?.get(r.subject_id) ?? '—'}</td>
              <td className="r">{money(r.amount)}</td>
              <td>{r.status === 'posted' ? <>{day(r.posted_on)}<div className="sub2">已入账{r.voucher_no ? ` ${r.voucher_no}` : ''}</div></> : day(r.eta_date)}</td>
              <td><Badge tone={REQ[r.status][1]}>{REQ[r.status][0]}</Badge></td>
              <td><div className="acts">{acts.map((a) => <button key={a.label} className={`sm ghost ${a.danger ? 'danger' : ''}`} onClick={() => setAct(a)}>{a.label}</button>)}</div></td>
            </tr>
          );
        })}</tbody>
      </table>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); onChange(); }} onClose={() => setAct(null)} />}
    </div>
  );
}

function NewRequest({ cards, subjects, types, onDone }: { cards: CardPick[]; subjects: Subject[]; types: ExpenseType[]; onDone: (msg: string) => void }) {
  const usable = cards.filter((c) => c.status === 'active');
  const [v, setV] = useState({ card_id: '', subject_id: '', expense_type_id: '', title: '', amount: '', eta_date: '', path: '', emergency: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const card = usable.find((c) => c.id === v.card_id);
  const subs = subjects.filter((s) => s.template_id === card?.template_id).sort((a, b) => a.sort - b.sort);
  const type = types.find((t) => t.id === v.expense_type_id);
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await rpc('submit_request', { ...v, path: v.path || type?.required_path || null });
      onDone(`已提交：${v.title}，${money(v.amount)}。等待中心负责人批准。`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>提交支出申请</h3>
      <p className="hint">先申请、后支出。提交时按可报销规则、可用额度、单据截止日和采购路径检查，不符合的会说明原因。</p>
      <div className="grid">
        <label className="field"><span>经费卡</span>
          <select required value={v.card_id} onChange={(e) => set({ card_id: e.target.value, subject_id: '' })}>
            <option value="">请选择</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.name}（截止 {day(c.cutoff_date)}）</option>)}
          </select></label>
        <label className="field"><span>科目</span>
          <select required value={v.subject_id} onChange={(e) => set({ subject_id: e.target.value })} disabled={!card}>
            <option value="">{card ? '请选择' : '先选经费卡'}</option>{subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        <label className="field"><span>支出类型</span>
          <select required value={v.expense_type_id} onChange={(e) => set({ expense_type_id: e.target.value })}>
            <option value="">请选择</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
        <label className="field"><span>事项</span><input required maxLength={200} value={v.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="field"><span>金额（元）</span><input required type="number" min="0.01" step="0.01" value={v.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
        <label className="field"><span>预计学校入账日</span><input required type="date" min={today()} max={card ? day(card.cutoff_date) : undefined}
          value={v.eta_date} onChange={(e) => set({ eta_date: e.target.value })} /></label>
        <label className="field"><span>采购路径</span>
          <select value={type?.required_path ?? v.path} disabled={!!type?.required_path} onChange={(e) => set({ path: e.target.value })}>
            <option value="">不涉及采购</option>{PATHS.map((p) => <option key={p}>{p}</option>)}
          </select></label>
        <label className="field check"><input type="checkbox" checked={v.emergency} onChange={(e) => set({ emergency: e.target.checked })} /><span>走紧急通道（事后补批，有单笔和全年上限）</span></label>
      </div>
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button></div>
    </form>
  );
}

export function Requests({ me }: { me: Me }) {
  const staff = me.role === 'finance' || me.role === 'director';
  const { data, error, reload } = useViews<{ reqs: Req[]; cards: CardPick[]; subjects: Subject[]; types: ExpenseType[]; users: User[] }>({
    reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], types: ['expense_type'], users: ['users'],
  });
  const [tab, setTab] = useState<'open' | ReqStatus>('open');
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState('');
  const maps = useMemo(() => ({
    card: new Map((data?.cards ?? []).map((c) => [c.id, c.name])),
    subject: new Map((data?.subjects ?? []).map((s) => [s.id, s.name])),
    user: new Map((data?.users ?? []).map((u) => [u.id, u.name])),
  }), [data]);
  if (!data) return <Loading error={error} />;
  const count = (s: ReqStatus) => data.reqs.filter((r) => r.status === s).length;
  const rows = data.reqs.filter((r) => (tab === 'open' ? OPEN.includes(r.status) : r.status === tab))
    .sort((a, b) => (b.posted_on ?? b.created_at).localeCompare(a.posted_on ?? a.created_at));
  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  const tabs: ['open' | ReqStatus, string][] = [['open', `进行中 ${OPEN.reduce((s, x) => s + count(x), 0)}`],
    ...(['pending', 'committed', 'at_school', 'returned', 'posted', 'rejected', 'released'] as ReqStatus[]).map((s) => [s, `${REQ[s][0]} ${count(s)}`] as [ReqStatus, string])];

  return (
    <>
      <div className="top"><h2>支出与承诺</h2>
        <button onClick={() => { setAdding(!adding); setDone(''); }} className={adding ? 'ghost' : ''}>{adding ? '收起' : '提交支出申请'}</button></div>
      {done && <div className="msg ok" role="status">{done}</div>}
      {adding && <NewRequest cards={data.cards} subjects={data.subjects} types={data.types}
        onDone={(msg) => { setAdding(false); setDone(msg); setTab('open'); reload(); }} />}
      <section className="card">
        <h3>{staff ? '全部申请' : me.role === 'leader' ? '我的申请和我名下卡的申请' : '我的申请'}</h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {tabs.map(([k, label]) => <button key={k} className="sm" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {rows.length === 0 ? <Empty>{tab === 'open' ? '没有进行中的申请。' : '这个状态下没有申请。'}</Empty> : (
          <>
            <RequestTable me={me} rows={rows} cardName={maps.card} subjectName={maps.subject} userName={maps.user} onChange={reload} />
            <p className="sub2">{rows.length} 笔，合计 {money(total)}</p>
          </>
        )}
      </section>
    </>
  );
}
