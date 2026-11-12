import { useMemo, useState, type FormEvent } from 'react';
import { rpc, useViews, type CardPick, type ExpenseType, type LinePick, type Me, type Project, type QuotaPick, type Req, type ReqStatus, type Subject, type User } from '../api';
import { ActionDialog, Badge, Empty, Flow, Loading, REQ, day, money, num, today, type Field } from '../ui';

export const PATHS = ['直采', '集采', '分散采购'];
const OPEN: ReqStatus[] = ['pending', 'committed', 'at_school', 'returned'];

interface Action { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 每个状态下，当前角色能做什么。权限最终由数据库函数判定，这里只决定显示哪些按钮。
export function actionsFor(me: Me, r: Req, targets: [string, string][], lines: [string, string][] = []): Action[] {
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
  if (me.role === 'finance' && r.status === 'committed' && r.path && r.stage != null && r.stages != null && r.stage < r.stages) {
    out.push({ label: '推进采购', title: '采购进到下一阶段', hint: `${what}。${r.path}，现在是第 ${r.stage} 阶段，共 ${r.stages} 阶段；到最后一个阶段即验收贴码，之后才能提交学校。`,
      fields: [], run: () => rpc('procurement_advance', { id: r.id }) });
    out.push({ label: '废标/流标', title: '记录废标或流标', hint: `${what}。采购退回挂网阶段，预计入账日顺延。`, danger: true,
      fields: [{ name: 'kind', label: '类型', options: [['废标', '废标'], ['流标', '流标']] }, { name: 'reason', label: '原因' },
        { name: 'delay_days', label: '预计入账顺延天数', type: 'number', value: '30' }],
      run: (v) => rpc('procurement_fail', { id: r.id, kind: v.kind, reason: v.reason, delay_days: Math.round(Number(v.delay_days)) }) });
  }
  if (me.role === 'finance' && r.status === 'returned' && targets.length > 0)
    out.push({ label: '改卡', title: '改走另一张卡', hint: `${what}。目标卡要允许这类支出、可用额度够、预计入账不晚于它的单据截止日。`,
      fields: [{ name: 'target', label: '目标经费卡和科目', options: targets }],
      run: (v) => { const [card_id, subject_id] = v.target.split('|'); return rpc('move_request', { id: r.id, card_id, subject_id }); } });
  if ((me.role === 'finance' || me.role === 'director') && (r.status === 'committed' || r.status === 'returned'))
    out.push({ label: '释放', title: '释放这笔承诺', hint: `${what}。释放后额度回到可用，这笔申请作废。`, danger: true, fields: [],
      run: () => rpc('release_request', { id: r.id }) });
  if (me.role === 'finance' && !r.budget_line_id && lines.length > 0 && r.status !== 'rejected' && r.status !== 'released')
    out.push({ label: '挂到预算', title: '把这笔支出挂到预算行上', hint: `${what}。下达之前按经费卡提交的支出，挂上之后计入那个项目的预算执行。挂上后那一行不能超过核定数。`,
      fields: [{ name: 'line', label: '项目 · 预算行', options: lines }], run: (v) => rpc('set_request_line', { id: r.id, line_id: v.line }) });
  return out;
}

export function RequestTable({ me, rows, subjectName, cardName, userName, cards, subjects, projectName, lines, onChange }: {
  me: Me; rows: Req[]; projectName?: Map<string, string>; lines?: [string, string][]; cards?: CardPick[]; subjects?: Subject[]; subjectName?: Map<string, string>; cardName?: Map<string, string>; userName?: Map<string, string>; onChange: () => void;
}) {
  const [act, setAct] = useState<Action | null>(null);
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>事项</th>{cardName && <th>经费卡</th>}<th>科目</th><th className="r">金额</th><th>预计入账</th><th>状态</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const targets = r.status === 'returned' && me.role === 'finance' ? (cards ?? []).filter((c) => c.status === 'active' && c.id !== r.card_id)
            .flatMap((c) => (subjects ?? []).filter((s) => s.template_id === c.template_id).sort((a, b) => a.sort - b.sort)
              .map((s): [string, string] => [`${c.id}|${s.id}`, `${c.name} · ${s.name}`])) : [];
          const acts = actionsFor(me, r, targets, lines);
          return (
            <tr key={r.id}>
              <td className="wrap">{r.title}
                <div className="sub2">{[projectName?.get(r.project_id ?? ''), r.code, userName?.get(r.requested_by ?? ''), r.requested_by === me.id ? '我提交的' : '',
                  r.path && `${r.path} ${r.stage}/${r.stages}`, r.split_group && '分摊', r.morningstar_quota_id && '晨星额度', r.emergency && '紧急通道'].filter(Boolean).join(' · ')}</div></td>
              {cardName && <td>{cardName.get(r.card_id) ?? '—'}</td>}
              <td>{subjectName?.get(r.subject_id) ?? '—'}</td>
              <td className="r">{money(r.amount)}</td>
              <td>{r.status === 'posted' ? <>{day(r.posted_on)}<div className="sub2">已入账{r.voucher_no ? ` ${r.voucher_no}` : ''}</div></> : day(r.eta_date)}</td>
              <td><Badge tone={REQ[r.status][1]}>{REQ[r.status][0]}</Badge><Flow status={r.status} /></td>
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

interface Part { card_id: string; subject_id: string; amount: string }
const blank = (): Part => ({ card_id: '', subject_id: '', amount: '' });

function NewRequest({ cards, subjects, types, quotas, picks, canCard, onDone }: { cards: CardPick[]; subjects: Subject[]; types: ExpenseType[]; quotas: QuotaPick[]; picks: LinePick[]; canCard: boolean; onDone: (msg: string) => void }) {
  const usable = cards.filter((c) => c.status === 'active');
  const [v, setV] = useState({ card_id: '', subject_id: '', expense_type_id: '', title: '', amount: '', eta_date: '', path: '', emergency: false, quota_id: '' });
  const [split, setSplit] = useState(false);
  // 年度预算下达之后按项目提交：只选项目和预算行，经费卡由系统在这一行下达到的卡里挑
  const [byLine, setByLine] = useState(picks.length > 0);
  const [line, setLine] = useState({ project: '', id: '' });
  const projects = [...new Map(picks.map((x) => [x.project_id, x])).values()].sort((a, b) => a.project_code.localeCompare(b.project_code));
  const [parts, setParts] = useState<Part[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const card = usable.find((c) => c.id === v.card_id);
  const subsOf = (cardId: string) => { const c = usable.find((x) => x.id === cardId); return subjects.filter((s) => s.template_id === c?.template_id).sort((a, b) => a.sort - b.sort); };
  const type = types.find((t) => t.id === v.expense_type_id);
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  const setPart = (i: number, patch: Partial<Part>) => setParts(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const total = parts.reduce((s, p) => s + num(p.amount), 0);
  // 预计入账日不能晚于所涉及的卡里最早的单据截止日
  const cutoff = (split ? parts.map((p) => usable.find((c) => c.id === p.card_id)) : [card]).filter(Boolean).map((c) => day(c!.cutoff_date)).sort()[0];
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    const path = v.path || type?.required_path || null;
    try {
      if (byLine) {
        await rpc('submit_project_request', { line_id: line.id, expense_type_id: v.expense_type_id, title: v.title, amount: v.amount, eta_date: v.eta_date, emergency: v.emergency, path });
        onDone(`已提交：${v.title}，${money(v.amount)}，计入「${picks.find((x) => x.id === line.id)?.project_name ?? ''}」的预算。等待中心负责人批准。`);
      } else if (split) {
        await rpc('submit_split', { expense_type_id: v.expense_type_id, title: v.title, eta_date: v.eta_date, path, quota_id: v.quota_id,
          parts: parts.map((p) => ({ card_id: p.card_id, subject_id: p.subject_id, amount: Math.round(num(p.amount) * 100) / 100 })) });
        onDone(`已提交：${v.title}，分摊 ${parts.length} 处，合计 ${money(total)}。等待中心负责人逐笔批准。`);
      } else {
        await rpc('submit_request_quota', { ...v, path });
        onDone(`已提交：${v.title}，${money(v.amount)}。等待中心负责人批准。`);
      }
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>提交支出申请</h3>
      <p className="hint">{byLine ? '先申请、后支出。选项目和预算行就行，走哪张经费卡由系统在这一行下达到的卡里挑（快到期回收的卡优先）。超出这一行核定数、或者下达的卡都放不下时会说明原因。'
        : '先申请、后支出。提交时按可报销规则、可用额度、单据截止日和采购路径检查，不符合的会说明原因。'}</p>
      {picks.length > 0 && canCard && <div className="tabs" style={{ marginBottom: 12 }}>
        <button type="button" className="sm" aria-pressed={byLine} onClick={() => { setByLine(true); setSplit(false); }}>按项目预算</button>
        <button type="button" className="sm" aria-pressed={!byLine} onClick={() => setByLine(false)}>不在年度预算里，按经费卡</button></div>}
      <div className="grid">
        {byLine && <>
          <label className="field"><span>项目</span>
            <select required value={line.project} onChange={(e) => setLine({ project: e.target.value, id: '' })}>
              <option value="">请选择</option>{projects.map((x) => <option key={x.project_id} value={x.project_id}>{x.project_code} {x.project_name}</option>)}
            </select></label>
          <label className="field"><span>预算行</span>
            <select required value={line.id} disabled={!line.project} onChange={(e) => setLine({ ...line, id: e.target.value })}>
              <option value="">{line.project ? '请选择' : '先选项目'}</option>{picks.filter((x) => x.project_id === line.project).map((x) => <option key={x.id} value={x.id}>{x.category_name} · {x.purpose}</option>)}
            </select></label>
        </>}
        {!byLine && !split && <>
          <label className="field"><span>经费卡</span>
            <select required value={v.card_id} onChange={(e) => set({ card_id: e.target.value, subject_id: '' })}>
              <option value="">请选择</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.name}（截止 {day(c.cutoff_date)}）</option>)}
            </select></label>
          <label className="field"><span>科目</span>
            <select required value={v.subject_id} onChange={(e) => set({ subject_id: e.target.value })} disabled={!card}>
              <option value="">{card ? '请选择' : '先选经费卡'}</option>{subsOf(v.card_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
        </>}
        <label className="field"><span>支出类型</span>
          <select required value={v.expense_type_id} onChange={(e) => set({ expense_type_id: e.target.value })}>
            <option value="">请选择</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
        <label className="field"><span>事项</span><input required maxLength={200} value={v.title} onChange={(e) => set({ title: e.target.value })} /></label>
        {!split && <label className="field"><span>金额（元）</span><input required type="number" min="0.01" step="0.01" value={v.amount} onChange={(e) => set({ amount: e.target.value })} /></label>}
        <label className="field"><span>预计学校入账日</span><input required type="date" min={today()} max={byLine ? undefined : cutoff}
          value={v.eta_date} onChange={(e) => set({ eta_date: e.target.value })} /></label>
        <label className="field"><span>采购路径</span>
          <select value={type?.required_path ?? v.path} disabled={!!type?.required_path} onChange={(e) => set({ path: e.target.value })}>
            <option value="">不涉及采购</option>{PATHS.map((p) => <option key={p}>{p}</option>)}
          </select></label>
        {!byLine && quotas.length > 0 && <label className="field"><span>计入晨星额度</span>
          <select value={v.quota_id} onChange={(e) => set({ quota_id: e.target.value })}>
            <option value="">不计入</option>{quotas.map((q) => <option key={q.id} value={q.id}>{q.leader_name} {q.year} 年额度</option>)}
          </select></label>}
        {!byLine && <label className="field check"><input type="checkbox" checked={split} onChange={(e) => { setSplit(e.target.checked); if (e.target.checked) set({ emergency: false }); }} /><span>一笔支出分摊到多张卡或多个科目</span></label>}
        {!split && <label className="field check"><input type="checkbox" checked={v.emergency} onChange={(e) => set({ emergency: e.target.checked })} /><span>走紧急通道（事后补批，有单笔和全年上限）</span></label>}
      </div>
      {split && !byLine && (
        <div className="change parts" style={{ border: 0, padding: 0, margin: '6px 0 0' }}>
          <p className="hint">每一处各自按那张卡的规则和可用额度检查，有一处不通过就整笔不提交。涉及采购的，几处共用一条采购，直采的 5 万上限按合计算。</p>
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>科目</th><th className="r">金额（元）</th><th /></tr></thead>
            <tbody>{parts.map((p, i) => (
              <tr key={i}>
                <td><select required aria-label={`第 ${i + 1} 处的经费卡`} value={p.card_id} onChange={(e) => setPart(i, { card_id: e.target.value, subject_id: '' })}>
                  <option value="">请选择</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.name}（截止 {day(c.cutoff_date)}）</option>)}</select></td>
                <td><select required aria-label={`第 ${i + 1} 处的科目`} value={p.subject_id} disabled={!p.card_id} onChange={(e) => setPart(i, { subject_id: e.target.value })}>
                  <option value="">{p.card_id ? '请选择' : '先选经费卡'}</option>{subsOf(p.card_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                <td className="r"><input required type="number" min="0.01" step="0.01" aria-label={`第 ${i + 1} 处的金额`} value={p.amount} onChange={(e) => setPart(i, { amount: e.target.value })} /></td>
                <td><div className="acts">{parts.length > 2 && <button type="button" className="sm ghost danger" onClick={() => setParts(parts.filter((_, j) => j !== i))}>去掉</button>}</div></td>
              </tr>))}
              <tr className="sum"><td colSpan={2}>合计</td><td className="r">{money(total)}</td><td /></tr></tbody>
          </table></div>
          {parts.length < 6 && <div className="actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="sm ghost" onClick={() => setParts([...parts, blank()])}>再加一处</button></div>}
        </div>
      )}
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button></div>
    </form>
  );
}

export function Requests({ me, start = '' }: { me: Me; start?: string }) {
  const staff = me.role === 'finance' || me.role === 'director';
  const { data, error, reload } = useViews<{ reqs: Req[]; cards: CardPick[]; subjects: Subject[]; types: ExpenseType[]; users: User[]; quotas: QuotaPick[]; picks: LinePick[]; projects: Project[] }>({
    reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], types: ['expense_type'], users: ['users'], quotas: ['quota_pick'], picks: ['line_pick'], projects: ['project'],
  });
  const [tab, setTab] = useState<'open' | ReqStatus>(start in REQ ? (start as ReqStatus) : 'open');
  const [adding, setAdding] = useState(start === 'new');
  const [done, setDone] = useState('');
  const maps = useMemo(() => ({
    card: new Map((data?.cards ?? []).map((c) => [c.id, c.name])),
    subject: new Map((data?.subjects ?? []).map((s) => [s.id, s.name])),
    user: new Map((data?.users ?? []).map((u) => [u.id, u.name])),
    project: new Map((data?.projects ?? []).map((p) => [p.id, p.name])),
    lines: (data?.picks ?? []).map((x): [string, string] => [x.id, `${x.project_name} · ${x.category_name} · ${x.purpose}`]),
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
      <div className="top"><h2>支出申请</h2>
        <button onClick={() => { setAdding(!adding); setDone(''); }} className={adding ? 'ghost' : ''}>{adding ? '收起' : '提交支出申请'}</button></div>
      {done && <div className="msg ok" role="status">{done}</div>}
      {adding && <NewRequest cards={data.cards} subjects={data.subjects} types={data.types} quotas={data.quotas} picks={data.picks} canCard={me.role !== 'member'}
        onDone={(msg) => { setAdding(false); setDone(msg); setTab('open'); reload(); }} />}
      <section className="card">
        <h3>{staff ? '全部申请' : me.role === 'leader' ? '我的申请和我名下卡的申请' : '我的申请'}</h3>
        <p className="hint">每笔申请走四步：申请、批准、交学校、入账。状态下面的四格表示走到了哪一步，金色是现在停的地方。</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {tabs.map(([k, label]) => <button key={k} className="sm" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {rows.length === 0 ? <Empty>{tab === 'open' ? '没有进行中的申请。' : '这个状态下没有申请。'}</Empty> : (
          <>
            <RequestTable me={me} rows={rows} cards={data.cards} subjects={data.subjects} cardName={maps.card} subjectName={maps.subject} userName={maps.user} projectName={maps.project} lines={maps.lines} onChange={reload} />
            <p className="sub2">{rows.length} 笔，合计 {money(total)}</p>
          </>
        )}
      </section>
    </>
  );
}
