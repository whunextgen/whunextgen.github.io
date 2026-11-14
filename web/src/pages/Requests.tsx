import { useMemo, useState, type FormEvent } from 'react';
import { rpc, useViews, type CardPick, type ExpenseType, type LinePick, type Me, type Project, type QuotaPick, type Req, type ReqStatus, type Subject, type User } from '../api';
import { ActionDialog, Badge, Empty, Flow, Loading, can, REQ, reqBadge, day, money, num, today, type Field } from '../ui';

export const PATHS = ['直采', '集采', '分散采购'];
const OPEN: ReqStatus[] = ['pending', 'committed', 'at_school', 'returned'];

interface Action { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 每个状态下，当前角色能做什么。权限最终由数据库函数判定，这里只决定显示哪些按钮。
export function actionsFor(me: Me, r: Req, targets: [string, string][], lines: [string, string][] = []): Action[] {
  const what = `${r.title}，${money(r.amount)}`;
  const out: Action[] = [];
  const over = num(r.over_amount);
  if (r.status === 'pending' && r.can_confirm) {
    out.push({ label: '确认', title: '确认支出申请', hint: `${what}。${over > 0 ? `该笔超出预算行 ${money(over)}，确认后提交中心负责人审批。` : '确认后提交财务岗核对。'}`, fields: [], run: () => rpc('confirm_request', { id: r.id, ok: true, note: null }) });
    out.push({ label: '不同意', title: '不同意支出申请', hint: what, danger: true, fields: [{ name: 'note', label: '原因' }], run: (v) => rpc('confirm_request', { id: r.id, ok: false, note: v.note }) });
  }
  if (can(me, 'request.process') && r.status === 'pending' && r.step === 'check') {
    out.push({ label: '核对通过', title: '支出申请核对通过', hint: `${what}。核对通过后占用额度，开始办理。`, fields: [], run: () => rpc('check_request', { id: r.id, ok: true, note: null }) });
    out.push({ label: '退回', title: '退回支出申请', hint: `${what}。退回后该笔申请终止，申请人可查看退回原因，修改后重新提交。`, danger: true, fields: [{ name: 'note', label: '退回原因' }], run: (v) => rpc('check_request', { id: r.id, ok: false, note: v.note }) });
  }
  if (can(me, 'request.approve') && r.status === 'pending') {
    if (!r.step) out.push({ label: '批准', title: '批准支出申请', hint: `${what}。批准后计入承诺。`, fields: [], run: () => rpc('approve_request', { id: r.id }) });
    if (r.step === 'director') out.push({ label: '批准', title: over > 0 ? '批准超预算支出申请' : '批准支出申请',
      hint: `${what}。${over > 0 ? `该笔超出预算行 ${money(over)}，批准后该预算行核定数相应调增，各研究单元核定数合计不得超过年度总预算。` : ''}批准后提交财务岗核对。`, fields: [], run: () => rpc('approve_request', { id: r.id }) });
    out.push({ label: '驳回', title: '驳回支出申请', hint: what, danger: true, fields: [{ name: 'note', label: '驳回原因' }],
      run: (v) => rpc('reject_request', { id: r.id, note: v.note }) });
  }
  if (can(me, 'request.process') && r.status === 'committed')
    out.push({ label: '提交学校', title: '单据已提交学校', hint: what, fields: [], run: () => rpc('send_to_school', { id: r.id }) });
  if (can(me, 'ledger.post', 'request.process') && r.status === 'at_school') {
    out.push({ label: '入账', title: '回写学校入账', hint: `${what}。决算数以学校正式入账为准。`,
      fields: [{ name: 'posted_on', label: '入账日期', type: 'date', value: today() }, { name: 'amount', label: '入账金额', type: 'number', value: String(num(r.amount)) },
        { name: 'voucher_no', label: '凭证号（选填）', required: false }],
      run: (v) => rpc('post_voucher', { id: r.id, ...v }) });
    out.push({ label: '退回', title: '学校退回单据', hint: `${what}。退回原因将记入报销答复记录。`, danger: true,
      fields: [{ name: 'reason', label: '退回原因' }], run: (v) => rpc('school_return', { id: r.id, reason: v.reason }) });
  }
  if (can(me, 'request.process') && r.status === 'committed' && r.path && r.stage != null && r.stages != null && r.stage < r.stages) {
    out.push({ label: '推进采购', title: '采购进入下一阶段', hint: `${what}。${r.path}，当前为第 ${r.stage} 阶段，共 ${r.stages} 阶段；最后一个阶段为验收贴码，完成后方可提交学校。`,
      fields: [], run: () => rpc('procurement_advance', { id: r.id }) });
    out.push({ label: '废标/流标', title: '记录废标或流标', hint: `${what}。采购退回挂网阶段，预计入账日顺延。`, danger: true,
      fields: [{ name: 'kind', label: '类型', options: [['废标', '废标'], ['流标', '流标']] }, { name: 'reason', label: '原因' },
        { name: 'delay_days', label: '预计入账顺延天数', type: 'number', value: '30' }],
      run: (v) => rpc('procurement_fail', { id: r.id, kind: v.kind, reason: v.reason, delay_days: Math.round(Number(v.delay_days)) }) });
  }
  if (can(me, 'request.process') && r.status === 'returned' && targets.length > 0)
    out.push({ label: '变更经费卡', title: '变更经费卡', hint: `${what}。目标经费卡须允许该类支出、可用额度充足，且预计入账日不晚于其单据截止日。`,
      fields: [{ name: 'target', label: '目标经费卡和科目', options: targets }],
      run: (v) => { const [card_id, subject_id] = v.target.split('|'); return rpc('move_request', { id: r.id, card_id, subject_id }); } });
  if (can(me, 'request.adjust') && (r.status === 'committed' || r.status === 'returned'))
    out.push({ label: '释放', title: '释放承诺', hint: `${what}。释放后额度恢复为可用，该笔申请作废。`, danger: true, fields: [],
      run: () => rpc('release_request', { id: r.id }) });
  if (can(me, 'request.adjust') && can(me, 'ledger.post') && !r.budget_line_id && lines.length > 0 && r.status !== 'rejected' && r.status !== 'released')
    out.push({ label: '关联预算行', title: '将支出关联至预算行', hint: `${what}。下达前按经费卡提交的支出，关联后计入对应研究单元的预算执行。关联后该预算行不得超过核定数。`,
      fields: [{ name: 'line', label: '研究单元 · 预算行', options: lines }], run: (v) => rpc('set_request_line', { id: r.id, line_id: v.line }) });
  return out;
}

export function RequestTable({ me, rows, subjectName, cardName, userName, cards, subjects, projectName, lines, onChange }: {
  me: Me; rows: Req[]; projectName?: Map<string, string>; lines?: [string, string][]; cards?: CardPick[]; subjects?: Subject[]; subjectName?: Map<string, string>; cardName?: Map<string, string>; userName?: Map<string, string>; onChange: () => void;
}) {
  const [act, setAct] = useState<Action | null>(null);
  return (
    <div className="scroll">
      <table>
        <thead><tr><th>事项</th>{cardName && <th>经费卡</th>}<th>研究单元 · 预算行</th><th className="r">金额</th><th>预计入账</th><th>状态</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const targets = r.status === 'returned' && can(me, 'request.process') ? (cards ?? []).filter((c) => c.status === 'active' && c.id !== r.card_id)
            .flatMap((c) => (subjects ?? []).filter((s) => s.template_id === c.template_id).sort((a, b) => a.sort - b.sort)
              .map((s): [string, string] => [`${c.id}|${s.id}`, `${c.name} · ${s.name}`])) : [];
          const acts = actionsFor(me, r, targets, lines);
          return (
            <tr key={r.id}>
              <td className="wrap">{r.title}
                <div className="sub2">{[r.code, r.requester_name ?? userName?.get(r.requested_by ?? ''), r.requested_by === me.id ? '本人提交' : '',
                  r.path && `${r.path} ${r.stage}/${r.stages}`, r.split_group && '分摊', r.morningstar_quota_id && '晨星额度', r.emergency && '紧急通道'].filter(Boolean).join(' · ')}</div>
                {r.status === 'rejected' && r.return_note && <div className="sub2 neg">原因：{r.return_note}</div>}</td>
              {cardName && <td>{cardName.get(r.card_id ?? '') ?? '—'}</td>}
              <td className="wrap">{r.project_name ?? projectName?.get(r.project_id ?? '') ?? '—'}<div className="sub2">{r.line_purpose ?? subjectName?.get(r.subject_id) ?? ''}</div></td>
              <td className="r">{money(r.amount)}{num(r.over_amount) > 0 && <div className="sub2 neg">超预算 {money(r.over_amount)}</div>}</td>
              <td>{r.status === 'posted' ? <>{day(r.posted_on)}<div className="sub2">已入账{r.voucher_no ? ` ${r.voucher_no}` : ''}</div></> : day(r.eta_date)}</td>
              <td><Badge tone={reqBadge(r)[1]}>{reqBadge(r)[0]}</Badge><Flow status={r.status} />
                {r.step && (r.confirmed_by_name || r.checked_by_name) && <div className="sub2">{[r.confirmed_by_name && (r.self_confirmed ? '负责人本人提交' : `${r.confirmed_by_name} 已确认`), r.checked_by_name && `${r.checked_by_name} 已核对`].filter(Boolean).join(' · ')}</div>}</td>
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
  // 年度预算下达之后按研究单元提交：只选研究单元和预算行，经费卡由系统在这一行下达到的卡里挑
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
        onDone(`已提交：${v.title}，${money(v.amount)}，计入「${picks.find((x) => x.id === line.id)?.project_name ?? ''}」预算。先由研究单元负责人确认，再由财务岗核对；超出预算行的另由中心负责人审批。当前环节可在下方列表查看。`);
      } else if (split) {
        await rpc('submit_split', { expense_type_id: v.expense_type_id, title: v.title, eta_date: v.eta_date, path, quota_id: v.quota_id,
          parts: parts.map((p) => ({ card_id: p.card_id, subject_id: p.subject_id, amount: Math.round(num(p.amount) * 100) / 100 })) });
        onDone(`已提交：${v.title}，分摊 ${parts.length} 项，合计 ${money(total)}。后续逐笔确认、核对。`);
      } else {
        await rpc('submit_request_quota', { ...v, path });
        onDone(`已提交：${v.title}，${money(v.amount)}。待研究单元负责人确认、财务岗核对。`);
      }
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>提交支出申请</h3>
      <p className="hint">{byLine ? '先申请、后支出。仅可在本人所属成员名单的研究单元内提交，选择研究单元和预算行即可，经费来源由财务岗安排。提交后先由研究单元负责人确认，再由财务岗核对；超出该预算行的不拦截，标明超出金额，另由中心负责人审批。'
        : '先申请、后支出。提交时按可报销规则、可用额度、单据截止日和采购路径检查，不符合的将说明原因。'}</p>
      {picks.length > 0 && canCard && <div className="tabs" style={{ marginBottom: 12 }}>
        <button type="button" className="sm" aria-pressed={byLine} onClick={() => { setByLine(true); setSplit(false); }}>按研究单元预算</button>
        <button type="button" className="sm" aria-pressed={!byLine} onClick={() => setByLine(false)}>未列入年度预算，按经费卡</button></div>}
      <div className="grid">
        {byLine && <>
          <label className="field"><span>研究单元</span>
            <select required value={line.project} onChange={(e) => setLine({ project: e.target.value, id: '' })}>
              <option value="">请选择</option>{projects.map((x) => <option key={x.project_id} value={x.project_id}>{x.project_code} {x.project_name}</option>)}
            </select></label>
          <label className="field"><span>预算行</span>
            <select required value={line.id} disabled={!line.project} onChange={(e) => setLine({ ...line, id: e.target.value })}>
              <option value="">{line.project ? '请选择' : '请先选择研究单元'}</option>{picks.filter((x) => x.project_id === line.project).map((x) => <option key={x.id} value={x.id}>{x.category_name} · {x.purpose}</option>)}
            </select></label>
        </>}
        {!byLine && !split && <>
          <label className="field"><span>经费卡</span>
            <select required value={v.card_id} onChange={(e) => set({ card_id: e.target.value, subject_id: '' })}>
              <option value="">请选择</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.name}（截止 {day(c.cutoff_date)}）</option>)}
            </select></label>
          <label className="field"><span>科目</span>
            <select required value={v.subject_id} onChange={(e) => set({ subject_id: e.target.value })} disabled={!card}>
              <option value="">{card ? '请选择' : '请先选择经费卡'}</option>{subsOf(v.card_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
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
        {!byLine && <label className="field check"><input type="checkbox" checked={split} onChange={(e) => { setSplit(e.target.checked); if (e.target.checked) set({ emergency: false }); }} /><span>一笔支出分摊至多张经费卡或多个科目</span></label>}
        {!split && <label className="field check"><input type="checkbox" checked={v.emergency} onChange={(e) => set({ emergency: e.target.checked })} /><span>使用紧急通道（事后补批，设单笔和全年上限）</span></label>}
      </div>
      {split && !byLine && (
        <div className="change parts" style={{ border: 0, padding: 0, margin: '6px 0 0' }}>
          <p className="hint">各分摊项分别按对应经费卡的规则和可用额度检查，任一项不通过则整笔不予提交。涉及采购的，各项共用一条采购，直采 5 万上限按合计金额计算。</p>
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>科目</th><th className="r">金额（元）</th><th /></tr></thead>
            <tbody>{parts.map((p, i) => (
              <tr key={i}>
                <td><select required aria-label={`第 ${i + 1} 项经费卡`} value={p.card_id} onChange={(e) => setPart(i, { card_id: e.target.value, subject_id: '' })}>
                  <option value="">请选择</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.name}（截止 {day(c.cutoff_date)}）</option>)}</select></td>
                <td><select required aria-label={`第 ${i + 1} 项科目`} value={p.subject_id} disabled={!p.card_id} onChange={(e) => setPart(i, { subject_id: e.target.value })}>
                  <option value="">{p.card_id ? '请选择' : '请先选择经费卡'}</option>{subsOf(p.card_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                <td className="r"><input required type="number" min="0.01" step="0.01" aria-label={`第 ${i + 1} 项金额`} value={p.amount} onChange={(e) => setPart(i, { amount: e.target.value })} /></td>
                <td><div className="acts">{parts.length > 2 && <button type="button" className="sm ghost danger" onClick={() => setParts(parts.filter((_, j) => j !== i))}>移除</button>}</div></td>
              </tr>))}
              <tr className="sum"><td colSpan={2}>合计</td><td className="r">{money(total)}</td><td /></tr></tbody>
          </table></div>
          {parts.length < 6 && <div className="actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="sm ghost" onClick={() => setParts([...parts, blank()])}>新增分摊项</button></div>}
        </div>
      )}
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? '提交中…' : '提交申请'}</button></div>
    </form>
  );
}

export function Requests({ me, start = '' }: { me: Me; start?: string }) {
  const staff = can(me, 'read.finance'), adds = staff || can(me, 'request.process');
  const { data, error, reload } = useViews<{ reqs: Req[]; cards: CardPick[]; subjects: Subject[]; types: ExpenseType[]; users: User[]; quotas: QuotaPick[]; picks: LinePick[]; projects: Project[] }>({
    reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], types: ['expense_type'], users: ['users'], quotas: ['quota_pick'], picks: ['line_pick'], projects: ['project'],
  });
  const [tab, setTab] = useState<'open' | 'mine' | 'self' | ReqStatus>(start in REQ || start === 'mine' ? (start as ReqStatus) : 'open');
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
  // 轮到我：等我确认的、等我批的、等我核对的
  const myTurn = (r: Req) => r.status === 'pending' && (r.can_confirm || (can(me, 'request.approve') && (!r.step || r.step === 'director')) || (can(me, 'request.process') && r.step === 'check'));
  const selfDone = (r: Req) => !!r.self_confirmed;
  const rows = data.reqs.filter((r) => (tab === 'open' ? OPEN.includes(r.status) : tab === 'mine' ? myTurn(r) : tab === 'self' ? selfDone(r) : r.status === tab))
    .sort((a, b) => (b.posted_on ?? b.created_at).localeCompare(a.posted_on ?? a.created_at));
  const total = rows.reduce((s, r) => s + num(r.amount), 0);
  const tabs: ['open' | 'mine' | 'self' | ReqStatus, string][] = [['open', `进行中 ${OPEN.reduce((s, x) => s + count(x), 0)}`],
    ...(data.reqs.some(myTurn) || tab === 'mine' ? [['mine', `待我处理 ${data.reqs.filter(myTurn).length}`] as ['mine', string]] : []),
    ...(staff ? [['self', `负责人本人提交 ${data.reqs.filter(selfDone).length}`] as ['self', string]] : []),
    ...(['pending', 'committed', 'at_school', 'returned', 'posted', 'rejected', 'released'] as ReqStatus[]).map((s) => [s, `${REQ[s][0]} ${count(s)}`] as [ReqStatus, string])];

  return (
    <>
      <div className="top"><h2>支出申请</h2>
        <button onClick={() => { setAdding(!adding); setDone(''); }} className={adding ? 'ghost' : ''}>{adding ? '收起' : '提交支出申请'}</button></div>
      {done && <div className="msg ok" role="status">{done}</div>}
      {adding && (data.picks.length === 0 && !adds
        ? <section className="card"><h3>提交支出申请</h3><Empty>本人当前不在任何已下达预算研究单元的成员名单内，无法提交支出申请。请研究单元负责人在「课题管理」页加入名单；加入后即可选择该研究单元的预算行。</Empty></section>
        : <NewRequest cards={data.cards} subjects={data.subjects} types={data.types} quotas={data.quotas} picks={data.picks} canCard={staff}
            onDone={(msg) => { setAdding(false); setDone(msg); setTab('open'); reload(); }} />)}
      <section className="card">
        <h3>{staff ? '全部申请' : data.projects.some((p) => p.mine) ? '我的申请及负责研究单元的申请' : '我的申请'}</h3>
        <p className="hint">每笔申请分四个环节：申请、确认、提交学校、入账。状态下方四格表示当前环节，金色为所在环节。确认环节分为研究单元负责人确认、财务岗核对两步；超出预算行的，中间增加中心负责人审批。{staff && '负责人本人提交的申请无他人确认，单独列出备查。'}</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {tabs.map(([k, label]) => <button key={k} className="sm" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {rows.length === 0 ? <Empty>{tab === 'open' ? '暂无进行中的申请。' : tab === 'mine' ? '暂无待办申请。' : '该状态下暂无申请。'}</Empty> : (
          <>
            <RequestTable me={me} rows={rows} cards={data.cards} subjects={data.subjects} cardName={staff ? maps.card : undefined} subjectName={maps.subject} userName={maps.user} projectName={maps.project} lines={maps.lines} onChange={reload} />
            <p className="sub2">{rows.length} 笔，合计 {money(total)}</p>
          </>
        )}
      </section>
    </>
  );
}
