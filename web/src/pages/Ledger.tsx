import { useMemo, useState } from 'react';
import { ApiError, rpc, type Card, type Cell, type ExpenseType, type Req } from '../api';
import { Badge, money, num } from '../ui';
import { amt, parse } from './Import';
import { readXls } from '../xls';

// 在经费卡上导入学校财务系统导出的「项目收支明细账」：收入行更新当年下达数和已到账，支出行记为已入账，期末余额更新学校余额。
// 文件只在浏览器里读；先列出与中台现有记录的差异，确认后才写入。重复导入不重复写入。

interface Row { line: number; on: string; voucher: string; title: string; code: string; name: string; income: number; expense: number; balance: number | null }
interface Ledger { project: string; opening: number; rows: Row[]; ending: number | null; skipped: { line: number; text: string; why: string }[] }

const COL: [keyof typeof IDX, RegExp][] = [['on', /凭证日期|日期/], ['voucher', /凭证编号|凭证号/], ['title', /摘要/], ['code', /科目编号|科目代码/], ['name', /科目名称/], ['income', /收入/], ['expense', /支出/], ['balance', /余额/]];
const IDX = { on: -1, voucher: -1, title: -1, code: -1, name: -1, income: -1, expense: -1, balance: -1 };
const decode = (buf: ArrayBuffer) => { const u = new TextDecoder('utf-8').decode(buf); return u.includes('�') ? new TextDecoder('gb18030').decode(buf) : u; };
const key = (voucher: string, amount: number, on: string, title: string) => `${voucher}|${amount.toFixed(2)}|${on}|${title}`;

export function readLedger(t: string[][]): Ledger {
  const h = t.findIndex((r) => r.some((x) => /凭证日期/.test(x)) && r.some((x) => /摘要/.test(x)));
  if (h < 0) throw new Error('未找到表头。须为学校财务系统导出的项目收支明细账，表头含凭证日期、凭证编号、摘要、科目名称、项目收入、项目支出、项目余额。');
  const idx = { ...IDX }; for (const [k, re] of COL) idx[k] = t[h].findIndex((x) => re.test(x));
  const miss = (['on', 'title', 'expense'] as const).filter((k) => idx[k] < 0);
  if (miss.length > 0) throw new Error('表头缺少必要的列：凭证日期、摘要、项目支出。');
  const head = t.slice(0, h).flat().find((x) => /项目[：:]/.test(x)) ?? '';
  const project = (head.split(/项目[：:]/)[1] ?? '').trim();
  const at = (r: string[], k: keyof typeof IDX) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  const out: Ledger = { project, opening: 0, rows: [], ending: null, skipped: [] };
  t.slice(h + 1).forEach((r, i) => {
    const line = h + 2 + i, on = (at(r, 'on').match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/) ?? []).slice(1), title = at(r, 'title'), bal = amt(at(r, 'balance'));
    if (on.length < 3) { if (/年初余额/.test(title) && bal != null) out.opening = bal; return; }
    const income = amt(at(r, 'income')) ?? 0, expense = amt(at(r, 'expense')) ?? 0;
    const row: Row = { line, on: `${on[0]}-${on[1].padStart(2, '0')}-${on[2].padStart(2, '0')}`, voucher: at(r, 'voucher'), title, code: at(r, 'code'), name: at(r, 'name'), income, expense, balance: bal };
    if (bal != null) out.ending = bal;
    if (expense < 0 || income < 0) out.skipped.push({ line, text: `${row.on} ${row.voucher} ${title} ${money(income || expense)}`, why: '红字（负数）行，未导入，请在中台手工处理' });
    else if (income > 0 || expense > 0) out.rows.push(row);
  });
  return out;
}

export function LedgerImport({ card, cells, reqs, types, onDone }: { card: Card; cells: Cell[]; reqs: Req[]; types: ExpenseType[]; onDone: () => void }) {
  const [led, setLed] = useState<Ledger | null>(null);
  const [file, setFile] = useState('');
  const [type, setType] = useState('');
  const [subject, setSubject] = useState('');
  const [setIncome, setSetIncome] = useState(true);
  const [setBalance, setSetBalance] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<[string, string] | null>(null);

  const load = async (f: File) => {
    setMsg(null); setLed(null); setFile(f.name);
    try {
      const buf = await f.arrayBuffer();
      const table = /\.xls$/i.test(f.name) ? readXls(buf) : parse(decode(buf));
      setLed(readLedger(table));
    } catch (e) { setMsg(['bad', /\.xlsx$/i.test(f.name) ? '暂不支持 .xlsx，请使用学校系统导出的 .xls，或另存为 CSV。' : (e as Error).message]); }
  };

  const view = useMemo(() => {
    if (!led) return null;
    // 中台里这张卡已入账的支出，按“凭证编号|金额|日期|摘要”计数；文件里多出来的才是新增
    const have = new Map<string, number>();
    for (const r of reqs) if (r.status === 'posted' && r.posted_on) { const k = key(r.voucher_no ?? '', num(r.posted_amount ?? r.amount), r.posted_on.slice(0, 10), r.title); have.set(k, (have.get(k) ?? 0) + 1); }
    const seen = new Map<string, number>();
    const spend = led.rows.filter((r) => r.expense > 0), income = led.rows.filter((r) => r.income > 0);
    const fresh = spend.filter((r) => { const k = key(r.voucher, r.expense, r.on, r.title); seen.set(k, (seen.get(k) ?? 0) + 1); return seen.get(k)! > (have.get(k) ?? 0); });
    const sum = (rows: Row[], k: 'income' | 'expense') => rows.reduce((s, r) => s + r[k], 0);
    const names = new Set(cells.flatMap((c) => [c.subject_name, c.subject_code]));
    const unmatched = fresh.filter((r) => !names.has(r.name) && !names.has(r.code) && ![...names].some((n) => r.name.endsWith(`-${n}`)));
    return { spend, income, fresh, incomeSum: sum(income, 'income'), spendSum: sum(spend, 'expense'), freshSum: sum(fresh, 'expense'), unmatched };
  }, [led, reqs, cells]);

  const confirm = async () => {
    if (!led || !view) return;
    setBusy(true); setMsg(null);
    try {
      const r = await rpc('import_ledger', { card_id: card.card_id,
        rows: view.fresh.map((x) => ({ posted_on: x.on, voucher_no: x.voucher, title: x.title, amount: x.expense, school_code: x.code, school_name: x.name })),
        income: setIncome && view.incomeSum > 0 ? view.incomeSum : null, balance: setBalance && led.ending != null ? led.ending : null,
        expense_type_id: type || null, default_subject_id: subject || null }) as { added: number; skipped: number; amount: number };
      setMsg(['ok', `已导入：新增已入账支出 ${r.added} 笔，合计 ${money(r.amount)}${r.skipped ? `；${r.skipped} 笔中台已有，未重复写入` : ''}${setIncome && view.incomeSum > 0 ? `；当年下达数和已到账更新为 ${money(view.incomeSum)}` : ''}${setBalance && led.ending != null ? `；学校余额更新为 ${money(led.ending)}` : ''}。`]);
      setLed(null); setFile(''); onDone();
    } catch (e) { setMsg(['bad', (e as ApiError).message]); }
    setBusy(false);
  };

  const needType = !!view && view.fresh.length > 0 && !type, needSubject = !!view && view.unmatched.length > 0 && !subject;
  return (
    <section className="card">
      <h3>导入明细账 <span className="h3sub">学校财务系统导出的项目收支明细账</span></h3>
      <p className="hint">上传学校财务系统导出的该经费卡的明细账（.xls 或 CSV）。收入行用于更新当年下达数和已到账，支出行记为已入账的支出，期末余额用于更新学校余额。系统先列出与中台现有记录的差异，确认后写入；已导入过的行不会重复写入。文件仅在浏览器中读取。</p>
      {msg && <div className={`msg ${msg[0]}`} role={msg[0] === 'bad' ? 'alert' : 'status'}>{msg[1]}</div>}
      <label className="field"><span>选择明细账文件</span>
        <input type="file" accept=".xls,.csv,.tsv,.txt,application/vnd.ms-excel,text/csv,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} /></label>
      {led && view && (
        <>
          <h4>文件内容 <span className="sub2">{file}</span></h4>
          <table><tbody>
            <tr><th scope="row">文件所属项目</th><td>{led.project || '未注明'} <Badge tone="warn">请确认与本经费卡「{card.name} · {card.year} 年」一致</Badge></td></tr>
            <tr><th scope="row">收入</th><td>{view.income.length} 行，合计 {money(view.incomeSum)}{led.opening > 0 && <span className="sub2"> 另有年初余额 {money(led.opening)}，属上年结转，不在此写入</span>}</td></tr>
            <tr><th scope="row">支出</th><td>{view.spend.length} 行，合计 {money(view.spendSum)}；其中 {view.spend.length - view.fresh.length} 行中台已有，<b>{view.fresh.length} 行将新增</b>，合计 {money(view.freshSum)}</td></tr>
            <tr><th scope="row">期末余额</th><td>{led.ending != null ? money(led.ending) : '未注明'}</td></tr>
          </tbody></table>
          <h4>写入内容</h4>
          <div className="row">
            <label className="field"><span>支出类型（新增的支出统一按此登记）</span><select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">请选择</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label className="field"><span>未对应到本经费卡科目的支出归入{view.unmatched.length > 0 ? `（${view.unmatched.length} 行）` : '（本次无）'}</span><select value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value="">请选择</option>{cells.map((c) => <option key={c.subject_id} value={c.subject_id}>{c.subject_name}</option>)}</select></label>
          </div>
          <p className="sub2">学校科目名称与本经费卡科目名称一致的自动对应；对不上的归入所选科目，学校科目的编号和名称随每笔支出一并保存，可在下方按学校科目汇总查看。</p>
          <label className="field check"><input type="checkbox" checked={setIncome} disabled={view.incomeSum <= 0} onChange={(e) => setSetIncome(e.target.checked)} /><span>将当年下达数和已到账更新为收入合计 {money(view.incomeSum)}（当前下达数 {card.granted != null ? money(card.granted) : '未填写'}，已到账 {card.received != null ? money(card.received) : '未填写'}）</span></label>
          <label className="field check"><input type="checkbox" checked={setBalance} disabled={led.ending == null} onChange={(e) => setSetBalance(e.target.checked)} /><span>将学校余额更新为期末余额 {led.ending != null ? money(led.ending) : '—'}（当前 {card.school_balance != null ? money(card.school_balance) : '未回写'}）</span></label>
          {view.fresh.length > 0 && (
            <>
              <h4>将新增的 {view.fresh.length} 笔已入账支出</h4>
              <div className="scroll"><table className="tight">
                <thead><tr><th>凭证日期</th><th>凭证编号</th><th>摘要</th><th>学校科目</th><th className="r">金额</th></tr></thead>
                <tbody>{view.fresh.slice(0, 100).map((r) => <tr key={r.line}><td>{r.on}</td><td className="code">{r.voucher || '—'}</td><td className="wrap">{r.title}</td><td>{r.name}<span className="sub2">{r.code}</span></td><td className="r">{money(r.expense)}</td></tr>)}</tbody>
              </table></div>
              {view.fresh.length > 100 && <p className="sub2">仅列出前 100 笔，确认后全部写入。</p>}
            </>
          )}
          {led.skipped.length > 0 && (
            <>
              <h4>未处理的 {led.skipped.length} 行</h4>
              <div className="scroll"><table className="tight"><thead><tr><th>行号</th><th>内容</th><th>原因</th></tr></thead>
                <tbody>{led.skipped.map((s) => <tr key={s.line}><td>{s.line}</td><td className="wrap">{s.text}</td><td>{s.why}</td></tr>)}</tbody></table></div>
            </>
          )}
          <div className="actions"><button className="ghost" onClick={() => { setLed(null); setFile(''); }}>取消</button>
            <button disabled={busy || needType || needSubject || (view.fresh.length === 0 && !(setIncome && view.incomeSum > 0) && !(setBalance && led.ending != null))} onClick={confirm}>
              {busy ? '写入中…' : needType ? '请先选择支出类型' : needSubject ? '请先选择未对应科目的归属' : '确认导入'}</button></div>
        </>
      )}
    </section>
  );
}
