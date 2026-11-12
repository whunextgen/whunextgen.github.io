import { useMemo, useState } from 'react';
import { ApiError, rpc, useViews, type Card, type CardPick, type ExpenseType, type LinePick, type Req, type Subject } from '../api';
import { Badge, Empty, Loading, day, money, num, today } from '../ui';

// 从学校系统导入：财务岗在学校财务系统里导出，在这里上传、粘贴，或者对着学校系统逐项填写；系统只列出和现有数据的差异，财务岗勾选确认后才写入。
// 中台不连学校系统，也不保存学校系统的密码。文件只在浏览器里读，不上传保存。

type Kind = 'balance' | 'post';
interface Col { key: string; label: string; guess: RegExp; not?: RegExp; required: boolean }
const COLS: Record<Kind, Col[]> = {
  balance: [
    { key: 'no', label: '经费卡号', guess: /卡号|经费号|项目编号|项目代码|项目号|账号/, required: true },
    { key: 'balance', label: '余额', guess: /余额|结余/, not: /可用|冻结/, required: true },
    { key: 'frozen', label: '冻结', guess: /冻结/, required: false },
    { key: 'available', label: '可用', guess: /可用/, required: false },
  ],
  post: [
    { key: 'amount', label: '入账金额', guess: /金额|借方|支出/, not: /余额|贷方/, required: true },
    { key: 'date', label: '入账日期', guess: /日期|时间/, required: true },
    { key: 'voucher', label: '凭证号', guess: /凭证/, required: false },
    { key: 'no', label: '经费卡号', guess: /卡号|经费号|项目编号|项目代码|项目号/, required: false },
    { key: 'memo', label: '摘要', guess: /摘要|说明|用途|事由/, required: false },
  ],
};
const KIND_TEXT: Record<Kind, [string, string]> = {
  balance: ['经费卡余额', '学校系统里各经费卡的余额、冻结和可用。导入后更新「学校余额对账」，用来发现没登记的单据和没回写的入账。'],
  post: ['入账明细', '学校系统里已经入账的支出明细。按金额（有卡号时加上卡号）对到正在学校审核的单据上，对上的回写入账日期、金额和凭证号。'],
};

const decode = (buf: ArrayBuffer) => { const u = new TextDecoder('utf-8').decode(buf); return u.includes('�') ? new TextDecoder('gb18030').decode(buf) : u; };
export function parse(raw: string): string[][] {
  const text = raw.replace(/^﻿/, ''), delim = text.includes('\t') ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  const end = () => { row.push(cell.trim()); cell = ''; if (row.some(Boolean)) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch !== '"') cell += ch; else if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; end(); }
    else cell += ch; }
  end();
  return rows;
}
export const amt = (s: string | undefined) => { const t = (s ?? '').replace(/[,，¥￥\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null; };
const date = (s: string | undefined) => { const m = (s ?? '').match(/^(\d{4})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const same = (a: number | null, b: string | null) => (a == null ? b == null : b != null && Math.abs(a - num(b)) < 0.005);

export function SchoolImport({ finance }: { finance: boolean }) {
  const { data, error, reload } = useViews<{ cards: Card[]; reqs: Req[] }>({ cards: ['card'], reqs: ['request'] });
  const [kind, setKind] = useState<Kind>('balance');
  const [paste, setPaste] = useState('');
  const [table, setTable] = useState<string[][] | null>(null);
  const [head, setHead] = useState(0);
  const [cols, setCols] = useState<Record<string, number>>({});
  const [off, setOff] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<[string, string] | null>(null);
  const [mode, setMode] = useState<'file' | 'form'>('file');
  const [manual, setManual] = useState(false);
  const [form, setForm] = useState<Record<string, Record<string, string>>>({});
  const put = (id: string, k: string, v: string) => setForm((f) => ({ ...f, [id]: { ...f[id], [k]: v } }));

  const load = (text: string, k = kind) => {
    const t = parse(text); setMsg(null); setOff({}); setManual(false);
    if (t.length < 2) { setTable(null); setMsg(['bad', '没有读到数据。请导出为 CSV，或在 Excel 里选中表头和数据复制后粘贴到这里。']); return; }
    // 表头不一定在第一行：取前 10 行里能认出列名最多的一行
    const score = (r: string[]) => COLS[k].filter((c) => r.some((h) => c.guess.test(h) && !c.not?.test(h))).length;
    const h = t.slice(0, 10).reduce((best, r, i) => (score(r) > score(t[best]) ? i : best), 0);
    setTable(t); setHead(h);
    setCols(Object.fromEntries(COLS[k].map((c) => [c.key, t[h].findIndex((x) => c.guess.test(x) && !c.not?.test(x))])));
  };
  const reset = (k: Kind) => { setKind(k); setTable(null); setPaste(''); setMsg(null); if (k !== kind) setForm({}); };
  // 表单填写：把填的内容拼成同样的表，走同一套差异和确认
  const loadForm = () => {
    if (!data) return;
    const keys = [...COLS[kind].map((c) => c.key), 'rid'];
    const rows = kind === 'balance'
      ? data.cards.filter((c) => form[c.card_id]?.balance?.trim()).map((c) => [c.card_no.trim(), form[c.card_id].balance, form[c.card_id].frozen ?? '', form[c.card_id].available ?? '', ''])
      : data.reqs.filter((r) => r.status === 'at_school' && form[r.id]?.date).map((r) => [form[r.id].amount?.trim() || String(r.amount), form[r.id].date, form[r.id].voucher ?? '', '', '', r.id]);
    setMsg(null); setOff({});
    if (rows.length === 0) { setMsg(['bad', kind === 'balance' ? '还没有填任何一张卡的余额。' : '还没有填任何一笔的入账日期。']); return; }
    setTable([[...COLS[kind].map((c) => c.label), ''], ...rows]); setHead(0); setManual(true);
    setCols(Object.fromEntries(keys.map((k, i) => [k, i])));
  };

  const diff = useMemo(() => {
    if (!data || !table) return null;
    const body = table.slice(head + 1), at = (r: string[], k: string) => (cols[k] >= 0 ? r[cols[k]] : undefined);
    if (kind === 'balance') {
      const byNo = new Map(data.cards.map((c) => [c.card_no.trim(), c]));
      return body.map((r, i) => { const no = (at(r, 'no') ?? '').trim(), card = byNo.get(no), balance = amt(at(r, 'balance')), frozen = amt(at(r, 'frozen')) ?? 0, available = amt(at(r, 'available'));
        const why = !no ? '没有卡号' : /^(合计|小计|总计)/.test(no) ? '合计行，不是经费卡' : !card ? '中台里没有这张卡' : balance == null ? '余额不是数字' : '';
        const changed = !!card && !why && !(same(balance, card.school_balance) && same(frozen, card.school_frozen ?? '0') && same(available ?? balance! - frozen, card.school_available));
        return { i, no, card, balance, frozen, available: available ?? (balance == null ? null : balance - frozen), why, changed, ok: !why && changed }; });
    }
    const open = data.reqs.filter((r) => r.status === 'at_school'), cardNo = new Map(data.cards.map((c) => [c.card_id, c.card_no.trim()]));
    const posted = new Set(data.reqs.filter((r) => r.status === 'posted' && r.voucher_no).map((r) => r.voucher_no));
    const taken = new Set<string>();
    return body.map((r, i) => { const amount = amt(at(r, 'amount')), on = date(at(r, 'date')), voucher = (at(r, 'voucher') ?? '').trim(), no = (at(r, 'no') ?? '').trim(), memo = at(r, 'memo') ?? '';
      const rid = manual ? at(r, 'rid') : undefined;
      const cand = amount == null ? [] : rid ? open.filter((q) => q.id === rid) : open.filter((q) => !taken.has(q.id) && Math.abs(num(q.amount) - amount) < 0.005 && (!no || cardNo.get(q.card_id) === no));
      const why = amount == null || amount <= 0 ? '金额不是正数' : voucher && posted.has(voucher) ? '这个凭证号已经入过账' : cand.length === 0 ? '没有对上审核中的单据' : cand.length > 1 ? `有 ${cand.length} 笔金额相同，请到学校侧进度里手工入账` : !on ? '没有入账日期' : '';
      const req = !why ? cand[0] : undefined; if (req) taken.add(req.id);
      return { i, amount, on, voucher, no, memo, req, why, ok: !why }; });
  }, [data, table, head, cols, kind, manual]);

  if (!data) return <Loading error={error} />;
  const cardName = new Map(data.cards.map((c) => [c.card_id, c.name]));
  const missing = table ? COLS[kind].filter((c) => c.required && (cols[c.key] ?? -1) < 0) : [];
  const picked = (diff ?? []).filter((d) => d.ok && !off[d.i]);
  const skipped = (diff ?? []).filter((d) => d.why);

  const confirm = async () => {
    setBusy(true); setMsg(null); let n = 0;
    try {
      if (kind === 'balance') for (const d of picked as { card: Card; balance: number; frozen: number; available: number }[]) {
        await rpc('set_school_balance', { card_id: d.card.card_id, balance: d.balance, frozen: d.frozen, available: d.available }); n++; }
      else { await rpc('post_vouchers', { rows: (picked as { req: Req; on: string; amount: number; voucher: string }[]).map((d) => ({ id: d.req.id, posted_on: d.on, amount: d.amount, voucher_no: d.voucher })) }); n = picked.length; }
      setMsg(['ok', kind === 'balance' ? `已更新 ${n} 张经费卡的学校余额。` : `已入账 ${n} 笔。`]); setTable(null); setPaste(''); setForm({});
    } catch (e) { setMsg(['bad', `${(e as ApiError).message}${kind === 'balance' && n > 0 ? `（前 ${n} 张已经更新）` : ''}`]); }
    setBusy(false); reload();
  };

  return (
    <section className="card">
      <h3>从学校系统导入</h3>
      <p className="hint">财务岗在学校财务系统里导出，在这里上传、粘贴，或者对着学校系统逐项填写。系统先列出和现有数据的差异，勾选确认后才写入；中台不直接连学校系统，也不保存学校系统的密码，文件只在浏览器里读取。</p>
      <div className="tabs" style={{ marginBottom: 12 }}>{(Object.keys(KIND_TEXT) as Kind[]).map((k) => <button key={k} className="sm" aria-pressed={k === kind} onClick={() => reset(k)}>{KIND_TEXT[k][0]}</button>)}</div>
      <p className="sub2">{KIND_TEXT[kind][1]}</p>
      {msg && <div className={`msg ${msg[0]}`} role={msg[0] === 'bad' ? 'alert' : 'status'}>{msg[1]}</div>}
      {!finance ? <Empty>导入由财务岗操作。</Empty> : !table && mode === 'form' ? (
        <>
          <div className="tabs" style={{ margin: '12px 0' }}><button className="sm ghost" aria-pressed={false} onClick={() => setMode('file')}>上传或粘贴</button><button className="sm ghost" aria-pressed>逐项填写</button></div>
          {kind === 'balance' ? (data.cards.length === 0 ? <Empty>还没有经费卡。</Empty> : (
            <div className="scroll"><table className="tight">
              <thead><tr><th>经费卡</th><th className="r">中台里记的学校余额</th><th>余额</th><th>冻结（可不填）</th><th>可用（不填按余额减冻结）</th></tr></thead>
              <tbody>{data.cards.map((c) => <tr key={c.card_id}><td>{c.name}<span className="sub2">{c.card_no}</span></td><td className="r">{c.school_balance != null ? money(c.school_balance) : '—'}</td>
                {['balance', 'frozen', 'available'].map((k) => <td key={k}><input inputMode="decimal" aria-label={`${c.name} ${k === 'balance' ? '余额' : k === 'frozen' ? '冻结' : '可用'}`} style={{ width: 130 }} value={form[c.card_id]?.[k] ?? ''} onChange={(e) => put(c.card_id, k, e.target.value)} /></td>)}</tr>)}</tbody>
            </table></div>)) : (data.reqs.filter((r) => r.status === 'at_school').length === 0 ? <Empty>没有正在学校审核的单据。</Empty> : (
            <div className="scroll"><table className="tight">
              <thead><tr><th>单据</th><th>经费卡</th><th className="r">申请金额</th><th>入账金额（不填按申请金额）</th><th>入账日期</th><th>凭证号</th></tr></thead>
              <tbody>{data.reqs.filter((r) => r.status === 'at_school').map((r) => <tr key={r.id}><td className="wrap">{r.title}<span className="sub2">{r.code}</span></td><td>{cardName.get(r.card_id) ?? '—'}</td><td className="r">{money(r.amount)}</td>
                <td><input inputMode="decimal" aria-label={`${r.title} 入账金额`} style={{ width: 120 }} placeholder={String(r.amount)} value={form[r.id]?.amount ?? ''} onChange={(e) => put(r.id, 'amount', e.target.value)} /></td>
                <td><input type="date" aria-label={`${r.title} 入账日期`} value={form[r.id]?.date ?? ''} onChange={(e) => put(r.id, 'date', e.target.value)} /></td>
                <td><input aria-label={`${r.title} 凭证号`} style={{ width: 130 }} value={form[r.id]?.voucher ?? ''} onChange={(e) => put(r.id, 'voucher', e.target.value)} /></td></tr>)}</tbody>
            </table></div>))}
          <p className="sub2">{kind === 'balance' ? '只填要更新的卡，没填余额的卡不动。' : '只填已经入账的单据，没填入账日期的不动。'}填完先看差异，确认后才写入。</p>
          <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}><button className="sm" onClick={loadForm}>看差异</button></div>
        </>
      ) : !table ? (
        <>
          <div className="tabs" style={{ margin: '12px 0' }}><button className="sm ghost" aria-pressed>上传或粘贴</button><button className="sm ghost" aria-pressed={false} onClick={() => setMode('form')}>逐项填写</button></div>
          <label className="field"><span>上传导出的文件（CSV 或制表符分隔的文本；Excel 文件请先另存为 CSV）</span>
            <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.arrayBuffer().then((b) => load(decode(b))); e.target.value = ''; }} /></label>
          <label className="field"><span>或者在 Excel 里选中表头和数据，复制后粘贴到这里</span>
            <textarea rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={COLS[kind].map((c) => c.label).join('\t')} /></label>
          <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}><button className="sm" disabled={!paste.trim()} onClick={() => load(paste)}>读取</button></div>
        </>
      ) : (
        <>
          {!manual && <><h4>列对应</h4>
          <p className="sub2">读到 {table.length - head - 1} 行，表头在第 {head + 1} 行。系统按列名猜了对应关系，不对的在这里改。</p></>}
          <div className="row" style={manual ? { display: 'none' } : undefined}>{COLS[kind].map((c) => (
            <label className="field" key={c.key}><span>{c.label}{c.required ? '' : '（可没有）'}</span>
              <select value={cols[c.key] ?? -1} onChange={(e) => { setCols({ ...cols, [c.key]: Number(e.target.value) }); setOff({}); }}>
                <option value={-1}>没有这一列</option>{table[head].map((h, i) => <option key={i} value={i}>{h || `第 ${i + 1} 列`}</option>)}</select></label>))}</div>
          {missing.length > 0 ? <div className="msg bad" role="alert">还没有指定：{missing.map((c) => c.label).join('、')}。</div> : kind === 'balance' ? (
            <>
              <h4>和现有数据的差异</h4>
              {(diff ?? []).filter((d) => d.ok).length === 0 ? <Empty>没有需要更新的经费卡：导入的数和中台里记的学校余额一致。</Empty> : (
                <div className="scroll"><table>
                  <thead><tr><th /><th>经费卡</th><th className="r">学校余额<span className="sub2">现在 → 导入</span></th><th className="r">冻结</th><th className="r">学校可用</th><th className="r">本系统可用</th><th className="r">相差</th></tr></thead>
                  <tbody>{(diff as { i: number; ok: boolean; card: Card; balance: number; frozen: number; available: number }[]).filter((d) => d.ok).map((d) => { const gap = num(d.card.avail) - d.available; return (
                    <tr key={d.i}><td><input type="checkbox" aria-label={`更新 ${d.card.name}`} checked={!off[d.i]} onChange={(e) => setOff({ ...off, [d.i]: !e.target.checked })} /></td>
                      <td>{d.card.name}<span className="sub2">{d.card.card_no}{d.card.school_synced_at ? ` · 上次回写 ${day(d.card.school_synced_at)}` : ' · 还没回写过'}</span></td>
                      <td className="r">{d.card.school_balance != null ? money(d.card.school_balance) : '—'} → <span className="chg">{money(d.balance)}</span></td>
                      <td className="r">{money(d.frozen)}</td><td className="r">{money(d.available)}</td><td className="r">{money(d.card.avail)}</td>
                      <td className="r">{Math.abs(gap) < 0.005 ? <Badge tone="ok">一致</Badge> : <span className="neg">{money(gap)}</span>}</td></tr>); })}</tbody>
                </table></div>)}
            </>
          ) : (
            <>
              <h4>对上的单据</h4>
              {(diff ?? []).filter((d) => d.ok).length === 0 ? <Empty>没有对上正在学校审核的单据。</Empty> : (
                <div className="scroll"><table>
                  <thead><tr><th /><th>单据</th><th>经费卡</th><th className="r">申请金额</th><th className="r">入账金额</th><th>入账日期</th><th>凭证号</th></tr></thead>
                  <tbody>{(diff as { i: number; ok: boolean; req: Req; amount: number; on: string; voucher: string }[]).filter((d) => d.ok).map((d) => (
                    <tr key={d.i}><td><input type="checkbox" aria-label={`入账：${d.req.title}`} checked={!off[d.i]} onChange={(e) => setOff({ ...off, [d.i]: !e.target.checked })} /></td>
                      <td className="wrap">{d.req.title}<span className="sub2">{d.req.code}</span></td><td>{cardName.get(d.req.card_id) ?? '—'}</td>
                      <td className="r">{money(d.req.amount)}</td><td className="r chg">{money(d.amount)}</td><td>{d.on}</td><td>{d.voucher || '—'}</td></tr>))}</tbody>
                </table></div>)}
            </>
          )}
          {missing.length === 0 && skipped.length > 0 && (
            <>
              <h4>没有处理的 {skipped.length} 行</h4>
              <div className="scroll"><table className="tight">
                <thead><tr><th>{manual ? '第几行' : '文件第几行'}</th><th>内容</th><th>原因</th></tr></thead>
                <tbody>{skipped.slice(0, 50).map((d) => <tr key={d.i}><td>{manual ? d.i + 1 : head + 2 + d.i}</td><td className="wrap">{table[head + 1 + d.i].filter(Boolean).slice(0, 6).join(' · ')}</td><td>{d.why}</td></tr>)}</tbody>
              </table></div>
              {skipped.length > 50 && <p className="sub2">只列出前 50 行。</p>}
            </>
          )}
          <div className="actions"><button className="ghost" onClick={() => reset(kind)}>{manual ? '返回修改' : '取消'}</button>
            <button disabled={busy || picked.length === 0 || missing.length > 0} onClick={confirm}>{busy ? '写入中…' : kind === 'balance' ? `确认更新 ${picked.length} 张经费卡` : `确认入账 ${picked.length} 笔`}</button></div>
        </>
      )}
    </section>
  );
}

// 补登支出：学校已经入账、但没在中台走过申请的支出（中台启用前的、学校直接扣的），由财务岗直接记成已入账，计入决算数
export function Backfill() {
  const { data, error, reload } = useViews<{ cards: CardPick[]; subjects: Subject[]; types: ExpenseType[]; lines: LinePick[] }>({
    cards: ['card_pick'], subjects: ['subject'], types: ['expense_type'], lines: ['line_pick'],
  });
  const blank = { card_id: '', subject_id: '', expense_type_id: '', title: '', amount: '', posted_on: today(), voucher_no: '', line_id: '' };
  const [v, setV] = useState(blank);
  const [rows, setRows] = useState<(typeof blank)[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<[string, string] | null>(null);
  if (!data) return <Loading error={error} />;
  const cards = data.cards.filter((c) => c.status === 'active');
  const card = cards.find((c) => c.id === v.card_id);
  const subjects = data.subjects.filter((s) => s.template_id === card?.template_id).sort((a, b) => a.sort - b.sort);
  const set = (p: Partial<typeof blank>) => setV({ ...v, ...p });
  const name = { card: new Map(cards.map((c) => [c.id, c.name])), subject: new Map(data.subjects.map((s) => [s.id, s.name])), type: new Map(data.types.map((t) => [t.id, t.name])) };
  const add = (e: React.FormEvent) => { e.preventDefault(); setMsg(null);
    if (amt(v.amount) == null || amt(v.amount)! <= 0) { setMsg(['bad', '金额要是大于 0 的数字。']); return; }
    setRows([...rows, v]); setV({ ...blank, card_id: v.card_id, posted_on: v.posted_on }); };
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const n = await rpc('record_expenses', { rows: rows.map((r) => ({ ...r, amount: amt(r.amount) })) }); setMsg(['ok', `已补登 ${n} 笔，计入各卡的决算数。`]); setRows([]); reload(); }
    catch (e) { setMsg(['bad', (e as ApiError).message]); }
    setBusy(false);
  };
  return (
    <section className="card">
      <h3>补登支出 <span className="h3sub">学校已入账、没在中台走过申请的</span></h3>
      <p className="hint">中台启用以前的支出、学校直接扣的款，在这里一笔一笔填好，先放进下面的清单，核对后一次写入。写入后直接算已入账，计入决算数，不经过申请和批准；只有财务岗能补登，每一笔都留记录。正常的支出仍然走 04 支出申请。</p>
      {msg && <div className={`msg ${msg[0]}`} role={msg[0] === 'bad' ? 'alert' : 'status'}>{msg[1]}</div>}
      <form onSubmit={add}>
        <div className="row">
          <label className="field"><span>经费卡</span><select required value={v.card_id} onChange={(e) => set({ card_id: e.target.value, subject_id: '' })}>
            <option value="">请选择</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.card_no}）</option>)}</select></label>
          <label className="field"><span>学校科目</span><select required value={v.subject_id} onChange={(e) => set({ subject_id: e.target.value })} disabled={!card}>
            <option value="">{card ? '请选择' : '先选经费卡'}</option>{subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="field"><span>支出类型</span><select required value={v.expense_type_id} onChange={(e) => set({ expense_type_id: e.target.value })}>
            <option value="">请选择</option>{data.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label className="field"><span>挂到项目预算行（可不选）</span><select value={v.line_id} onChange={(e) => set({ line_id: e.target.value })}>
            <option value="">不挂</option>{data.lines.map((l) => <option key={l.id} value={l.id}>{l.project_code} · {l.category_name} · {l.purpose}</option>)}</select></label>
        </div>
        <div className="row">
          <label className="field"><span>事项</span><input required value={v.title} onChange={(e) => set({ title: e.target.value })} /></label>
          <label className="field"><span>入账金额（元）</span><input required inputMode="decimal" value={v.amount} onChange={(e) => set({ amount: e.target.value })} /></label>
          <label className="field"><span>入账日期</span><input required type="date" max={today()} value={v.posted_on} onChange={(e) => set({ posted_on: e.target.value })} /></label>
          <label className="field"><span>凭证号（可不填）</span><input value={v.voucher_no} onChange={(e) => set({ voucher_no: e.target.value })} /></label>
        </div>
        <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 0 }}><button type="submit" className="sm ghost">加进清单</button></div>
      </form>
      {rows.length > 0 && (
        <>
          <h4>待写入的 {rows.length} 笔，合计 {money(rows.reduce((s, r) => s + (amt(r.amount) ?? 0), 0))}</h4>
          <div className="scroll"><table className="tight">
            <thead><tr><th>入账日期</th><th>经费卡</th><th>科目</th><th>类型</th><th>事项</th><th className="r">金额</th><th>凭证号</th><th /></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}><td>{r.posted_on}</td><td>{name.card.get(r.card_id)}</td><td>{name.subject.get(r.subject_id)}</td><td>{name.type.get(r.expense_type_id)}</td><td className="wrap">{r.title}</td>
                <td className="r">{money(amt(r.amount) ?? 0)}</td><td>{r.voucher_no || '—'}</td>
                <td><button className="sm ghost danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>去掉</button></td></tr>
            ))}</tbody>
          </table></div>
          <div className="actions"><button className="ghost" onClick={() => setRows([])}>清空</button><button disabled={busy} onClick={save}>{busy ? '写入中…' : `确认补登 ${rows.length} 笔`}</button></div>
        </>
      )}
    </section>
  );
}
