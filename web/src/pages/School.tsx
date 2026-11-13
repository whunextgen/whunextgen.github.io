import { useMemo, useState, type FormEvent } from 'react';
import { ApiError, rpc, useViews, type Card, type CardPick, type FundEvent, type Me, type Req, type ReqEvent, type Subject, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, money, num, today } from '../ui';
import { RequestTable } from './Requests';

// 批量入账：对着学校的入账清单逐行填，或把清单里的「金额 日期 凭证号」粘进来按金额自动对上。整批一起入，有一行不对就都不入。
function BatchPost({ rows, cardName, onDone, onCancel }: { rows: Req[]; cardName: Map<string, string>; onDone: (n: number) => void; onCancel: () => void }) {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [f, setF] = useState<Record<string, { posted_on: string; amount: string; voucher_no: string }>>(
    () => Object.fromEntries(rows.map((r) => [r.id, { posted_on: today(), amount: String(num(r.amount)), voucher_no: '' }])));
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picked = rows.filter((r) => on[r.id]);
  const patch = (id: string, p: Partial<(typeof f)[string]>) => setF({ ...f, [id]: { ...f[id], ...p } });
  const match = () => {
    const nf = { ...f }, non = { ...on }; let hit = 0, miss = 0;
    for (const line of paste.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const cells = line.split(/[\t,，\s]+/).filter(Boolean);
      const date = cells.find((c) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(c));
      const amount = cells.map((c) => c.replace(/[,¥￥]/g, '')).find((c) => c !== date && /^\d+(\.\d{1,2})?$/.test(c) && Number(c) > 0);
      const voucher = cells.find((c) => c !== date && c.replace(/[,¥￥]/g, '') !== amount);
      // 只有金额唯一对上一笔还没勾选的单据才自动填，对不上或有重复金额的留给人工
      const same = amount ? rows.filter((r) => !non[r.id] && Math.abs(num(r.amount) - Number(amount)) < 0.005) : [];
      if (same.length !== 1) { miss++; continue; }
      const d = date ? date.replace(/[/.]/g, '-').split('-').map((x, i) => (i ? x.padStart(2, '0') : x)).join('-') : nf[same[0].id].posted_on;
      nf[same[0].id] = { posted_on: d, amount: amount!, voucher_no: voucher ?? '' }; non[same[0].id] = true; hit++;
    }
    setF(nf); setOn(non); setNote(`对上 ${hit} 行${miss ? `，${miss} 行没有对上（金额没有或不唯一），请手工勾选` : ''}。`);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await rpc('post_vouchers', { rows: picked.map((r) => ({ id: r.id, ...f[r.id], amount: Number(f[r.id].amount) })) }); onDone(picked.length); }
    catch (err) { setError((err as ApiError).message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="change">
      <p className="hint">勾选学校已经入账的单据，填入账日期、金额和凭证号。决算数只认这里回写的学校入账。</p>
      <label className="field"><span>从学校的入账清单粘贴（每行：金额、日期、凭证号，顺序不限；可不用）</span>
        <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'9800.00 2026-11-05 PZ-1105-021'} /></label>
      <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}><button type="button" className="sm ghost" disabled={!paste.trim()} onClick={match}>按金额对上</button>
        {note && <span className="sub2">{note}</span>}</div>
      <div className="scroll"><table>
        <thead><tr><th /><th>事项</th><th>经费卡</th><th className="r">申请金额</th><th>入账日期</th><th className="r">入账金额</th><th>凭证号</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td><input type="checkbox" aria-label={`入账：${r.title}`} checked={!!on[r.id]} onChange={(e) => setOn({ ...on, [r.id]: e.target.checked })} /></td>
            <td className="wrap">{r.title}<div className="sub2">{r.code}</div></td><td>{cardName.get(r.card_id ?? '') ?? '—'}</td><td className="r">{money(r.amount)}</td>
            <td><input type="date" required={!!on[r.id]} disabled={!on[r.id]} value={f[r.id].posted_on} onChange={(e) => patch(r.id, { posted_on: e.target.value })} /></td>
            <td className="r"><input type="number" min="0.01" step="0.01" required={!!on[r.id]} disabled={!on[r.id]} value={f[r.id].amount} onChange={(e) => patch(r.id, { amount: e.target.value })} /></td>
            <td><input disabled={!on[r.id]} maxLength={60} value={f[r.id].voucher_no} onChange={(e) => patch(r.id, { voucher_no: e.target.value })} style={{ width: 150 }} /></td></tr>))}</tbody>
      </table></div>
      <p className="sub2">已勾选 {picked.length} 笔，入账合计 {money(picked.reduce((s, r) => s + num(f[r.id].amount), 0))}</p>
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="button" className="ghost" onClick={onCancel}>取消</button>
        <button type="submit" disabled={busy || picked.length === 0}>{busy ? '入账中…' : `入账 ${picked.length} 笔`}</button></div>
    </form>
  );
}

const KINDS = ['到账', '认领', '预借票', '核销', '下达', '冻结', '回收'];

export function School({ me }: { me: Me }) {
  const finance = can(me, 'ledger.post', 'card.fund');
  const { data, error, reload } = useViews<{ reqs: Req[]; cards: CardPick[]; subjects: Subject[]; users: User[]; events: FundEvent[]; returns: ReqEvent[]; fails: ReqEvent[]; full: Card[] }>({
    full: ['card'], reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], users: ['users'], events: ['fund_event'],
    returns: ['request_event', { kind: 'return' }], fails: ['procurement_event'],
  });
  const [adding, setAdding] = useState(false);
  const [finish, setFinish] = useState<FundEvent | null>(null);
  const [all, setAll] = useState(false);
  const [batch, setBatch] = useState(false);
  const [done, setDone] = useState('');
  const [bal, setBal] = useState<Card | null>(null);
  const maps = useMemo(() => ({
    card: new Map((data?.cards ?? []).map((c) => [c.id, c.name])),
    subject: new Map((data?.subjects ?? []).map((s) => [s.id, s.name])),
    user: new Map((data?.users ?? []).map((u) => [u.id, u.name])),
    req: new Map((data?.reqs ?? []).map((r) => [r.id, r])),
  }), [data]);
  if (!data) return <Loading error={error} />;

  const byEta = (a: Req, b: Req) => a.eta_date.localeCompare(b.eta_date);
  const atSchool = data.reqs.filter((r) => r.status === 'at_school').sort(byEta);
  const returned = data.reqs.filter((r) => r.status === 'returned').sort(byEta);
  const events = [...data.events].sort((a, b) => Number(a.done) - Number(b.done) || b.event_date.localeCompare(a.event_date));
  const open = events.filter((e) => !e.done);
  const shown = all ? events : open;
  const log = [
    ...data.returns.map((e) => ({ ...e, label: '学校退单', tone: 'bad' })),
    ...data.fails.filter((e) => e.kind === '废标' || e.kind === '流标').map((e) => ({ ...e, label: e.kind, tone: 'warn' })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const recon = data.full.filter((c) => c.status === 'active').sort((a, b) => a.card_no.localeCompare(b.card_no));
  const table = (rows: Req[]) => <RequestTable me={me} rows={rows} cards={data.cards} subjects={data.subjects}
    cardName={maps.card} subjectName={maps.subject} userName={maps.user} onChange={reload} />;

  return (
    <>
      <div className="top"><h2>入账跟踪：报销</h2>
        {finance && <button onClick={() => setAdding(true)}>登记一笔</button>}</div>

      <section className="card">
        <h3>被学校退回</h3>
        <p className="hint">退回的单据仍占用额度。财务岗可以改到别的卡或科目重新送审，也可以释放。</p>
        {returned.length === 0 ? <Empty>没有被退回的单据。</Empty> : table(returned)}
      </section>

      <section className="card">
        <h3>学校审核中</h3>
        {done && <div className="msg ok" role="status">{done}</div>}
        {finance && atSchool.length > 0 && !batch && <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
          <button className="sm" onClick={() => { setBatch(true); setDone(''); }}>批量入账</button></div>}
        {batch && <BatchPost rows={atSchool} cardName={maps.card} onCancel={() => setBatch(false)}
          onDone={(n) => { setBatch(false); setDone(`已入账 ${n} 笔。`); reload(); }} />}
        {atSchool.length === 0 ? <Empty>没有在学校审核的单据。</Empty> : batch ? null : (
          <>{table(atSchool)}<p className="sub2">{atSchool.length} 笔，合计 {money(atSchool.reduce((s, r) => s + num(r.amount), 0))}</p></>
        )}
      </section>

      <section className="card">
        <h3>学校余额对账</h3>
        <p className="hint">学校财务系统没有接口，余额、冻结和可用三个数由财务岗对着学校系统回写。学校的可用和本系统的可用对不上时，通常是有单据没登记或入账没回写。</p>
        {recon.length === 0 ? <Empty>没有在用的经费卡。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th className="r">本系统可用</th><th className="r">学校余额</th><th className="r">学校冻结</th><th className="r">学校可用</th><th className="r">相差</th><th>回写日</th><th /></tr></thead>
            <tbody>{recon.map((c) => { const d = c.school_available != null ? num(c.avail) - num(c.school_available) : null; return (
              <tr key={c.card_id}><td><a href={`#/card/${c.card_id}`}>{c.name}</a></td><td className="r">{money(c.avail)}</td>
                <td className="r">{c.school_balance != null ? money(c.school_balance) : '—'}</td><td className="r">{c.school_frozen != null ? money(c.school_frozen) : '—'}</td>
                <td className="r">{c.school_available != null ? money(c.school_available) : '—'}</td>
                <td className="r">{d == null ? <Badge tone="warn">未回写</Badge> : Math.abs(d) < 0.005 ? <Badge tone="ok">一致</Badge> : <span className="neg">{money(d)}</span>}</td>
                <td>{day(c.school_synced_at)}</td>
                <td><div className="acts">{finance && <button className="sm ghost" onClick={() => setBal(c)}>回写</button>}</div></td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>到账认领与借票核销</h3>
        <p className="hint">项目经费到校后要在科研系统认领才能使用；预借的发票要在款到后核销。登记时写了待办的记录，办结前列在这里。</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!all} onClick={() => setAll(false)}>未办 {open.length}</button>
          <button className="sm" aria-pressed={all} onClick={() => setAll(true)}>全部 {events.length}</button>
        </div>
        {shown.length === 0 ? <Empty>{all ? '还没有登记过学校侧的记录。' : '没有未办的认领或核销。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>经费卡</th><th>类型</th><th className="r">金额</th><th>待办</th><th /></tr></thead>
            <tbody>{shown.map((e) => (
              <tr key={e.id}><td>{day(e.event_date)}</td><td><a href={`#/card/${e.card_id}`}>{maps.card.get(e.card_id ?? '') ?? '—'}</a></td>
                <td>{e.kind}</td><td className="r">{money(e.amount)}</td>
                <td className="wrap">{e.done ? <Badge tone="ok">已办</Badge> : <Badge tone="warn">未办</Badge>} {e.todo}</td>
                <td><div className="acts">{finance && !e.done && <button className="sm ghost" onClick={() => setFinish(e)}>标记已办</button>}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>退单与废标记录</h3>
        {log.length === 0 ? <Empty>还没有退单、废标或流标的记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>类型</th><th>事项</th><th>经费卡</th><th className="r">金额</th><th>原因</th></tr></thead>
            <tbody>{log.map((e) => { const r = maps.req.get(e.request_id); return (
              <tr key={e.id}><td>{day(e.at)}</td><td><Badge tone={e.tone}>{e.label}</Badge></td>
                <td className="wrap">{r?.title ?? '—'}</td><td>{r ? maps.card.get(r.card_id ?? '') ?? '—' : '—'}</td>
                <td className="r">{r ? money(r.amount) : '—'}</td><td className="wrap">{e.note ?? '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      {adding && <ActionDialog title="登记学校侧记录" submitLabel="登记"
        hint="需要后续办理的（例如到账后去认领、借票后等款到核销）写上待办；不写待办的只作为记录。"
        fields={[
          { name: 'card_id', label: '经费卡', options: data.cards.map((c): [string, string] => [c.id, `${c.card_no} ${c.name}`]) },
          { name: 'kind', label: '类型', options: KINDS.map((k): [string, string] => [k, k]) },
          { name: 'event_date', label: '日期', type: 'date', value: today() },
          { name: 'amount', label: '金额（元）', type: 'number' },
          { name: 'todo', label: '待办（没有就不填）', required: false },
        ]}
        onSubmit={async (v) => { await rpc('add_fund_event', v); reload(); }} onClose={() => setAdding(false)} />}
      {bal && <ActionDialog title={`回写学校余额：${bal.name}`} submitLabel="回写"
        hint={`对着学校财务系统填。本系统可用 ${money(bal.avail)}。可用不填时按余额减冻结算。`}
        fields={[{ name: 'balance', label: '余额（元）', type: 'number', value: bal.school_balance != null ? String(num(bal.school_balance)) : '' },
          { name: 'frozen', label: '冻结（元）', type: 'number', value: String(num(bal.school_frozen)) },
          { name: 'available', label: '可用（元，可不填）', type: 'number', required: false }]}
        onSubmit={async (v) => { await rpc('set_school_balance', { card_id: bal.card_id, ...v }); reload(); }} onClose={() => setBal(null)} />}
      {finish && <ActionDialog title="标记已办" submitLabel="确认已办" fields={[]}
        hint={`${maps.card.get(finish.card_id ?? '') ?? ''} ${day(finish.event_date)} ${finish.kind} ${money(finish.amount)}：${finish.todo ?? ''}`}
        onSubmit={async () => { await rpc('finish_fund_event', { id: finish.id }); reload(); }} onClose={() => setFinish(null)} />}
    </>
  );
}
