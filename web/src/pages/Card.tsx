import { useState, type FormEvent } from 'react';
import { rpc, useViews, type Cap, type Card, type CardIncome, type CardSchoolSubject, type Cell, type Change, type Me, type Node, type Req, type SettleLine, type Template, type User } from '../api';
import { ActionDialog, Badge, Bar, CHANGE, Empty, END_RULE, Loading, can, cardGap, cardGranted, cardTotal, ROLE, Tile, day, money, num, pct, today, type Field } from '../ui';
import { cardFields, saveCard } from './Admin';
import { LedgerImport } from './Ledger';
import { nodeState } from './Overview';
import { RequestTable } from './Requests';
import { LegacyAdjustList } from './Legacy';

interface Act { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 预算变更：调出与调入相等才能提交；可用额度和比例上限由数据库函数检查
function NewChange({ cardId, cells, onDone, onCancel }: { cardId: string; cells: Cell[]; onDone: () => void; onCancel: () => void }) {
  const [delta, setDelta] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lines = Object.entries(delta).map(([subject_id, v]) => ({ subject_id, delta: Math.round(Number(v) * 100) / 100 })).filter((l) => l.delta);
  const net = lines.reduce((s, l) => s + l.delta, 0);
  const out = lines.reduce((s, l) => s + Math.max(0, -l.delta), 0);
  const ready = lines.length >= 2 && Math.abs(net) < 0.005;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await rpc('create_change', { card_id: cardId, reason, lines }); onDone(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="change">
      <p className="hint">调出填负数，调入填正数，合计为零。提交后由中心负责人确认并报发规办，批复录入后生效。</p>
      <div className="scroll"><table>
        <thead><tr><th>科目</th><th className="r">现行预算</th><th className="r">可用</th><th className="r">调整（元）</th><th className="r">调整后</th></tr></thead>
        <tbody>{cells.map((x) => { const d = Number(delta[x.subject_id] || 0); return (
          <tr key={x.subject_id}><td>{x.subject_name}</td><td className="r">{money(x.cur)}</td><td className="r">{money(x.avail)}</td>
            <td className="r"><input type="number" step="0.01" aria-label={`${x.subject_name} 调整金额`} value={delta[x.subject_id] ?? ''}
              onChange={(e) => setDelta({ ...delta, [x.subject_id]: e.target.value })} /></td>
            <td className={`r ${num(x.cur) + d < 0 || -d > num(x.avail) ? 'neg' : ''}`}>{d ? money(num(x.cur) + d) : '—'}</td></tr>); })}</tbody>
      </table></div>
      <p className="sub2">调出 {money(out)}，调入 {money(out + net)}{Math.abs(net) >= 0.005 && `，尚有 ${money(-net)} 未配平`}</p>
      <label className="field"><span>变更原因</span><input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="button" className="ghost" onClick={onCancel}>取消</button>
        <button type="submit" disabled={busy || !ready}>{busy ? '提交中…' : '提交预算变更'}</button></div>
    </form>
  );
}

// 年初预算：首次录入由财务岗做；录入后要更正只能由中心负责人做，日常调整走预算变更
function SetBudget({ cardId, cells, first, onDone, onCancel }: { cardId: string; cells: Cell[]; first: boolean; onDone: () => void; onCancel: () => void }) {
  const [amt, setAmt] = useState<Record<string, string>>(() => Object.fromEntries(cells.filter((x) => num(x.orig)).map((x) => [x.subject_id, String(num(x.orig))])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const val = (id: string) => Math.round(Number(amt[id] || 0) * 100) / 100;
  const total = cells.reduce((s, x) => s + val(x.subject_id), 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await rpc('set_budget', { card_id: cardId, lines: cells.map((x) => ({ subject_id: x.subject_id, amount: val(x.subject_id) })) }); onDone(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="change">
      <p className="hint">{first ? '按任务书或下达通知把当年下达数逐科目填入明细，不使用的科目留空。填了当年下达数的，明细合计不得超过下达数。保存时校验模板的比例上限。'
        : '更正明细。已办理的预算变更继续叠加；更正后各科目的现行预算不得低于已承诺和已入账的合计，明细合计不得超过当年下达数。'}</p>
      <div className="scroll"><table>
        <thead><tr><th>科目</th><th className="r">年初预算（元）</th>{!first && <><th className="r">变更</th><th className="r">已承诺和已入账</th></>}</tr></thead>
        <tbody>{cells.map((x) => (
          <tr key={x.subject_id}><td>{x.subject_name}</td>
            <td className="r"><input type="number" min="0" step="0.01" aria-label={`${x.subject_name} 年初预算`} value={amt[x.subject_id] ?? ''}
              onChange={(e) => setAmt({ ...amt, [x.subject_id]: e.target.value })} /></td>
            {!first && <><td className="r">{num(x.adj) ? money(x.adj) : '—'}</td><td className="r">{money(num(x.commit) + num(x.actual))}</td></>}</tr>))}
          <tr className="sum"><td>合计</td><td className="r">{money(total)}</td>{!first && <><td /><td /></>}</tr></tbody>
      </table></div>
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="button" className="ghost" onClick={onCancel}>取消</button>
        <button type="submit" disabled={busy || total <= 0}>{busy ? '保存中…' : first ? '录入年初预算' : '保存更正'}</button></div>
    </form>
  );
}

function changeActs(me: Me, ch: Change): Act[] {
  const out: Act[] = [];
  if (can(me, 'change.confirm') && ch.status === 'pending')
    out.push({ label: '确认', title: '确认预算变更', hint: `${ch.reason}。确认后报发规办，批复录入前不改变现行预算。`, fields: [], run: () => rpc('confirm_change', { id: ch.id }) });
  if (can(me, 'change.record') && ch.status === 'filed')
    out.push({ label: '录入批复', title: '发规办已批复', hint: `${ch.reason}。录入后现行预算立即按该笔变更调整。`,
      fields: [{ name: 'approved_on', label: '批复日期', type: 'date', value: today() }], run: (v) => rpc('approve_change', { id: ch.id, approved_on: v.approved_on }) });
  if (can(me, 'change.confirm') && (ch.status === 'pending' || ch.status === 'filed'))
    out.push({ label: '驳回', title: '驳回预算变更', hint: ch.reason, danger: true, fields: [], run: () => rpc('reject_change', { id: ch.id }) });
  return out;
}

export function CardPage({ me, id }: { me: Me; id: string }) {
  const f = { card_id: id };
  const [act, setAct] = useState<Act | null>(null);
  const [adding, setAdding] = useState(false);
  const [budgeting, setBudgeting] = useState(false);
  const { data, error, reload } = useViews<{ card: Card[]; cells: Cell[]; nodes: Node[]; caps: Cap[]; changes: Change[]; reqs: Req[]; settle: SettleLine[]; templates: Template[]; users: User[]; school: CardSchoolSubject[]; incomes: CardIncome[] }>({
    incomes: ['card_income', f], school: ['card_school_subject', f], templates: ['template'], users: ['users'], card: ['card', f], cells: ['cell', f], nodes: ['node', f], caps: ['cap', f], changes: ['budget_change', f], reqs: ['request', f], settle: ['settlement', f],
  }, id);
  if (!data) return <Loading error={error} />;
  const c = data.card[0];
  if (!c) return <><div className="top"><h2>经费卡管理</h2></div><Empty>经费卡不存在或无权查看。<a href="#/cards">返回经费卡管理</a></Empty></>;
  const now = today();
  const cells = [...data.cells].sort((a, b) => a.sort - b.sort || a.subject_code.localeCompare(b.subject_code));
  const used = cells.filter((x) => num(x.cur) || num(x.commit) || num(x.actual));
  const name = new Map(cells.map((x) => [x.subject_id, x.subject_name]));
  const open = data.reqs.filter((r) => !['posted', 'released', 'rejected'].includes(r.status));
  const staff = can(me, 'card.manage');
  const canChange = staff && c.status === 'active' && !c.locked;
  const canSettle = can(me, 'card.settle') && c.status === 'active' && !!c.settle_date && day(c.settle_date) <= now;
  const editable = staff && c.status === 'active';
  // 年初预算只有上年结转进来的那部分时，仍算尚未录入
  const noBudget = cells.reduce((s, x) => s + num(x.orig), 0) <= num(c.carried_in);
  const canBudget = editable && (noBudget ? true : can(me, 'card.rebudget'));
  const nodeAct = (n?: Node): Act => ({
    label: n ? '修改' : '新增节点', title: n ? `修改 ${day(n.node_date)} 的考核节点` : '新增考核节点',
    hint: '至节点日，决算数应达到现行预算的该比例。同一日期仅可设置一个节点。',
    fields: [...(n ? [] : [{ name: 'node_date', label: '节点日', type: 'date' } as Field]),
      { name: 'ratio', label: '要求比例（%）', type: 'number', value: n ? String(num(n.ratio) * 100) : '' },
      { name: 'consequence', label: '未达标的后果（如通报、回收、清零、结题）', value: n?.consequence }],
    run: (v) => rpc('set_node', { card_id: c.card_id, node_date: n ? day(n.node_date) : v.node_date, ratio: Number(v.ratio) / 100, consequence: v.consequence }),
  });
  const diff = c.school_available != null ? num(c.avail) - num(c.school_available) : null;
  const gap = cardGap(c);   // 下达了但还没分到科目的部分
  // 科目沿用学校明细账的科目（编号以数字开头）。编预算时列出学校科目，以及此前已有金额或支出的其他科目；一个学校科目都还没有时列出全部
  const isSchool = (x: Cell) => /^\d/.test(x.subject_code) || x.subject_code.startsWith('school-');
  const budgetCells = cells.some(isSchool) ? cells.filter((x) => x.subject_code !== 'school' && (isSchool(x) || num(x.orig) || num(x.cur) || num(x.commit) || num(x.actual))) : cells.filter((x) => x.subject_code !== 'school');
  // 学校余额按明细核对：上年结转 + 收入明细合计 − 明细账里的支出合计
  const hasLedger = num(c.ledger_actual) > 0 || num(c.income) > 0;
  const byLedger = num(c.carried_in) + num(c.income) - num(c.ledger_actual);
  // 只控总额的卡按学校科目列支出：同名的学校科目合并；没有学校科目的支出（在中台里申请的）按本卡科目列
  const bySchool = new Map<string, { school_name: string; school_code: string | null; n: number; amount: number }>();
  for (const r of data.school) { const o = bySchool.get(r.school_name) ?? { school_name: r.school_name, school_code: r.school_code, n: 0, amount: 0 }; o.n += r.n; o.amount += num(r.amount); bySchool.set(r.school_name, o); }
  const schoolRows = [...bySchool.values()].sort((a, b) => b.amount - a.amount);
  const otherRows = cells.map((x) => ({ ...x, rest: num(x.actual) - data.school.filter((r) => r.subject_id === x.subject_id).reduce((t, r) => t + num(r.amount), 0) })).filter((x) => x.rest >= 0.005 || num(x.commit) >= 0.005);

  return (
    <>
      <div className="top">
        <div className="crumb"><a href="#/funds">项目管理</a> / <a href="#/cards">经费卡管理</a> / {c.card_no}</div>
        <h2>{c.name} · {c.year} 年</h2>
        {c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone={day(c.cutoff_date) < now ? 'bad' : 'ok'}>{day(c.cutoff_date) < now ? '已过单据截止' : '在用'}</Badge>}
        {canSettle && <button className="ghost" onClick={() => setAct({ label: '结清', title: '结清经费卡',
          hint: `${c.name}。结清后按科目固定预算、决算和结余，该经费卡不得再提交支出，结清不可撤销。存在在途支出、在途变更或未入账人员费时不得结清。`,
          danger: true, fields: [], run: () => rpc('settle_card', { card_id: c.card_id }) })}>结清</button>}
        {editable && <button className="ghost" onClick={() => setAct({ label: '保存', title: '修改经费卡', hint: '负责人、经费性质和科目模板以所属项目为准，请在「项目管理」中修改。',
          fields: cardFields(c), run: (v) => saveCard(c, v) })}>修改</button>}
      </div>
      <div className="tiles">
        <Tile k="现行预算" v={money(c.cur)} f={num(c.adj) ? `年初 ${money(c.orig)}，变更 ${money(c.adj)}` : '未办理预算变更'} />
        <Tile k="决算数" v={money(c.actual)} f={`执行率 ${pct(num(c.actual), num(c.cur))}`} />
        <Tile k="承诺" v={money(c.commit)} f={`${open.length} 笔在途`} />
        <Tile k="可用" v={money(c.avail)} tone={num(c.avail) < 0 ? 'bad' : ''} />
      </div>

      <section className="card">
        <h3>基本情况</h3>
        <table><tbody>
          <tr><th scope="row">年度</th><td>{c.year} 年<span className="sub2"> 额度和期限见<a href="#/funds">项目管理</a></span></td>
            <th scope="row">当年申请数</th><td>{c.applied != null ? money(c.applied) : <span className="sub2">尚未填写</span>}</td></tr>
          <tr><th scope="row">当年下达数</th><td>{money(cardGranted(c))}{c.granted == null && <span className="sub2"> 未单独填写，按明细合计</span>}
            {gap >= 0.005 && <> <Badge tone="warn">尚有 {money(gap)} 未分到科目，暂不可支出</Badge></>}
            {editable && <> <button className="sm ghost" onClick={() => setAct({ label: '保存', title: '当年下达数', hint: '按学校的下达通知填写本年度下达到这张经费卡的金额，不含上年结转。各科目的明细合计不得超过下达数；留空则按明细合计计算。',
              fields: [{ name: 'granted', label: '当年下达数（元）', type: 'number', required: false, value: c.granted != null ? String(num(c.granted)) : '' }],
              run: (v) => rpc('set_card_granted', { card_id: c.card_id, granted: v.granted }) })}>修改</button></>}</td>
            <th scope="row">上年结转</th><td>{num(c.carried_in) > 0 ? money(c.carried_in) : '无'}</td></tr>
          <tr><th scope="row">控制方式</th><td colSpan={3}>{c.pooled ? '只控总额：支出只与整张卡的可用额核对，不按科目控制' : '按科目控制：支出与所在科目的可用额核对'}
            {editable && <> <button className="sm ghost" onClick={() => setAct({ label: '保存', title: '控制方式', hint: '学校只管总额、不按科目控制的经费卡（明细账中「额度控制分类」为空），选只控总额；学校按科目下达并控制的，选按科目控制。',
              fields: [{ name: 'pooled', label: '控制方式', options: [['false', '按科目控制'], ['true', '只控总额']], value: String(c.pooled) }],
              run: (v) => rpc('set_card_pooled', { card_id: c.card_id, pooled: v.pooled === 'true' }) })}>修改</button></>}</td></tr>
          <tr><th scope="row">已到账</th><td colSpan={3}>{c.received != null ? money(c.received) : <span className="sub2">尚未填写</span>}
            {c.fund_kind === 'horizontal' ? <> <Badge tone={num(c.received) < cardTotal(c) ? 'warn' : 'ok'}>{num(c.received) < cardTotal(c) ? `已下达未到账 ${money(cardTotal(c) - num(c.received))}，到账前不得支出` : '已全部到账'}</Badge><span className="sub2"> 横向经费的支出不得超过已到账金额</span></>
              : <span className="sub2"> 仅作记录，不限制支出</span>}</td></tr>
          {c.status === 'settled' && <tr><th scope="row">结余去向</th><td colSpan={3}>{num(c.carried_out) > 0 ? `结转至下一年 ${money(c.carried_out)}` : num(c.recalled) > 0 ? `回收 ${money(c.recalled)}` : '无结余'}</td></tr>}
          <tr><th scope="row">科目模板</th><td>{c.template_name}{c.locked && '（科目锁定，不得变更预算）'}</td>
            <th scope="row">下达日</th><td>{day(c.start_date)}</td></tr>
          <tr><th scope="row">单据截止日</th><td>{day(c.cutoff_date)}</td>
            <th scope="row">到期处理</th><td>{END_RULE[c.end_rule]}{c.settle_date ? `，结清日 ${day(c.settle_date)}` : '，尚未设结清日'}</td></tr>
          <tr><th scope="row">学校余额核对</th>
            <td colSpan={3}>{c.school_synced_at == null ? '尚未回写学校余额，无法核对。导入学校的明细账后按明细核对。'
              : hasLedger ? <>按明细核对：上年结转 {money(c.carried_in)} + 收入 {money(c.income)} − 明细账支出 {money(c.ledger_actual)} = <b>{money(byLedger)}</b>；学校余额 <b>{money(c.school_balance)}</b>（{day(c.school_synced_at)} 回写）
                  {' '}{Math.abs(byLedger - num(c.school_balance)) < 0.005 ? <Badge tone="ok">相符</Badge> : <Badge tone="bad">相差 {money(byLedger - num(c.school_balance))}</Badge>}
                  {num(c.income) <= 0 && <div className="sub2" style={{ marginLeft: 0 }}>尚无收入明细：请重新导入一次明细账，收入行和年初余额会补上，已有的支出不会重复。</div>}</>
                : <>余额 {money(c.school_balance)}，冻结 {money(c.school_frozen)}，可用 {money(c.school_available)}（{day(c.school_synced_at)} 回写）
                  {diff != null && Math.abs(diff) >= 0.005 && <> <Badge tone="bad">与本系统可用相差 {money(diff)}</Badge></>}</>}
              {hasLedger && c.stray_n > 0 && <div className="msg warn" role="status" style={{ margin: '8px 0 0' }}>另有 {c.stray_n} 笔已入账支出不在学校明细账中，合计 {money(c.stray_amount)}。这些记录计入了本卡的已入账，但学校账上没有对应的行，会使可用额比学校余额少。确属重复或旧记录的可以作废，作废后不再计入已入账，记录仍保留。
                {editable && <button className="sm danger" style={{ marginLeft: 8 }} onClick={() => setAct({ label: '确认作废', title: '作废明细账之外的已入账支出', danger: true, fields: [],
                  hint: `将该经费卡上不在学校明细账中的 ${c.stray_n} 笔已入账支出（合计 ${money(c.stray_amount)}）作废。作废后不再计入已入账和可用额的计算，记录和留痕保留。`,
                  run: () => rpc('void_stray_posted', { card_id: c.card_id }) })}>作废这 {c.stray_n} 笔</button>}</div>}</td></tr>
          {c.rule_note && <tr><th scope="row">备注</th><td colSpan={3} className="wrap">{c.rule_note}</td></tr>}
        </tbody></table>
      </section>

      <section className="card">
        <h3>明细与执行 <span className="h3sub">{c.pooled ? '只控总额，按学校科目列支出' : '科目沿用学校明细账的科目；当年下达数按科目编预算，支出按科目核对'}</span></h3>
        {c.pooled ? (
          <>
            <p className="hint">该经费卡只控总额：当年下达数连同上年结转 {money(c.cur)}，已入账 {money(c.actual)}，已承诺 {money(c.commit)}，可用 {money(c.avail)}。支出只与可用总额核对，下表按学校科目列出已入账的支出。</p>
            {schoolRows.length + otherRows.length === 0 ? <Empty>暂无支出。可在下方导入学校的明细账。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>学校科目</th><th>科目编号</th><th className="r">笔数</th><th className="r">已入账</th><th className="r">已承诺</th></tr></thead>
                <tbody>
                  {schoolRows.map((r) => <tr key={r.school_name}><td>{r.school_name}</td><td className="code">{r.school_code ?? '—'}</td><td className="r">{r.n}</td><td className="r">{money(r.amount)}</td><td className="r">—</td></tr>)}
                  {otherRows.map((x) => <tr key={x.subject_id}><td>{x.subject_name}<span className="sub2"> 未注明学校科目</span></td><td className="code">—</td><td className="r">—</td><td className="r">{money(x.rest)}</td><td className="r">{money(x.commit)}</td></tr>)}
                  <tr className="sum"><td>合计</td><td /><td className="r">{schoolRows.reduce((t, r) => t + r.n, 0) || '—'}</td><td className="r">{money(c.actual)}</td><td className="r">{money(c.commit)}</td></tr>
                </tbody>
              </table></div>
            )}
            {num(c.assigned ?? 0) > 0 && <p className="sub2">该卡此前按科目录入过预算（合计 {money(c.assigned)}），只控总额时不作为支出依据。已不存在的预算可以更正为零。
              {canBudget && !budgeting && <> <button className="sm ghost" onClick={() => setBudgeting(true)}>更正明细</button></>}</p>}
            {budgeting && <SetBudget cardId={c.card_id} cells={budgetCells} first={false} onDone={() => { setBudgeting(false); reload(); }} onCancel={() => setBudgeting(false)} />}
          </>
        ) : (
          <>
            {canBudget && !budgeting && <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
              <button className={noBudget ? 'sm' : 'sm ghost'} onClick={() => setBudgeting(true)}>{noBudget ? '录入明细' : '更正明细'}</button></div>}
            {budgeting && <SetBudget cardId={c.card_id} cells={budgetCells} first={noBudget} onDone={() => { setBudgeting(false); reload(); }} onCancel={() => setBudgeting(false)} />}
            {used.length === 0 ? (!budgeting && <Empty>该经费卡尚未录入明细。{editable && !canBudget && '明细由财务岗录入。'}</Empty>) : (
              <div className="scroll"><table>
                <thead><tr><th>科目</th><th className="r">下达数</th><th className="r">变更</th><th className="r">现行预算</th><th className="r">决算数</th>
                  <th className="r">承诺</th><th className="r">可用</th><th>执行</th></tr></thead>
                <tbody>
                  {used.flatMap((x) => [
                    <tr key={x.subject_id}><td>{x.subject_name}{isSchool(x) && <span className="sub2"> {x.subject_code}</span>}</td><td className="r">{money(x.orig)}</td><td className="r">{num(x.adj) ? money(x.adj) : '—'}</td>
                      <td className="r">{money(x.cur)}</td><td className="r">{money(x.actual)}</td><td className="r">{money(x.commit)}</td>
                      <td className={`r ${num(x.avail) < 0 ? 'neg' : ''}`}>{money(x.avail)}</td>
                      <td><Bar cur={num(x.cur)} actual={num(x.actual)} commit={num(x.commit)} /></td></tr>,
                    ...data.school.filter((r) => r.subject_id === x.subject_id && x.subject_code === 'school').sort((a, b) => num(b.amount) - num(a.amount)).map((r) => (
                      <tr key={`${x.subject_id}-${r.school_name}`}><td style={{ paddingLeft: 24 }}><span className="sub2">{r.school_name} · {r.n} 笔</span></td><td /><td /><td /><td className="r"><span className="sub2">{money(r.amount)}</span></td><td /><td /><td /></tr>)),
                  ])}
                  <tr className="sum"><td>合计</td><td className="r">{money(c.orig)}</td><td className="r">{num(c.adj) ? money(c.adj) : '—'}</td><td className="r">{money(c.assigned ?? c.cur)}</td>
                    <td className="r">{money(c.actual)}</td><td className="r">{money(c.commit)}</td><td className="r">{money(num(c.assigned ?? c.cur) - num(c.actual) - num(c.commit))}</td><td /></tr>
                </tbody>
              </table></div>
            )}
            {cells.length > used.length && <p className="sub2">另有 {cells.length - used.length} 个科目无预算且无支出，未列出。</p>}
            {gap >= 0.005 && <p className="sub2">当年下达数连同上年结转共 {money(c.cur)}，其中 {money(gap)} 尚未分到科目；本表合计为已分到科目的部分。</p>}
            {used.some((x) => num(x.avail) < 0) && editable && (
              <div className="msg warn" role="status">部分科目已有支出但尚未编预算，可用为负。科目沿用学校明细账的科目：需要按科目控制的，请点「{noBudget ? '录入明细' : '更正明细'}」按学校科目编预算；学校对该卡只控总额、不按科目控制的，请改为只控总额，改后支出只与可用总额核对。
                <button className="sm" style={{ marginLeft: 8 }} onClick={() => rpc('set_card_pooled', { card_id: c.card_id, pooled: true }).then(reload)}>改为只控总额</button></div>
            )}
          </>
        )}
      </section>

      {data.incomes.length > 0 && (
        <section className="card">
          <h3>收入明细 <span className="h3sub">来自学校的明细账，合计即当年下达数</span></h3>
          <div className="scroll"><table>
            <thead><tr><th>凭证日期</th><th>凭证编号</th><th>摘要</th><th>学校科目</th><th className="r">金额</th></tr></thead>
            <tbody>{[...data.incomes].sort((a, b) => a.posted_on.localeCompare(b.posted_on)).map((r) => <tr key={r.id}><td>{day(r.posted_on)}</td><td className="code">{r.voucher_no ?? '—'}</td><td className="wrap">{r.title}</td><td>{r.school_name ?? '—'}</td><td className="r">{money(r.amount)}</td></tr>)}
              <tr className="sum"><td>合计</td><td /><td /><td /><td className="r">{money(c.income)}</td></tr></tbody>
          </table></div>
        </section>
      )}

      {editable && <LedgerImport card={c} reqs={data.reqs} onDone={reload} />}


      <section className="card">
        <h3>比例上限</h3>
        {data.caps.length === 0 ? <Empty>该经费卡的模板未设置比例上限。</Empty> : (
          <table>
            <thead><tr><th>规则</th><th className="r">上限</th><th className="r">上限金额</th><th className="r">现行预算中</th><th>状态</th></tr></thead>
            <tbody>{data.caps.map((k) => (
              <tr key={k.cap_id}><td>{k.name}</td><td className="r">{(num(k.max_ratio) * 100).toFixed(0)}%</td><td className="r">{money(k.max_amount)}</td>
                <td className="r">{money(k.used)}</td><td>{num(k.used) > num(k.max_amount) ? <Badge tone="bad">超出</Badge> : <Badge tone="ok">未超</Badge>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>考核节点</h3>
        {editable && <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(nodeAct())}>新增节点</button></div>}
        {data.nodes.length === 0 ? <Empty>该经费卡暂无考核节点。</Empty> : (
          <table>
            <thead><tr><th>节点日</th><th className="r">要求比例</th><th className="r">要求金额</th><th className="r">预测</th><th>状态</th><th>后果</th><th /></tr></thead>
            <tbody>{[...data.nodes].sort((a, b) => a.node_date.localeCompare(b.node_date)).map((n) => { const s = nodeState(n, now); return (
              <tr key={n.node_id}><td>{day(n.node_date)}</td><td className="r">{(num(n.ratio) * 100).toFixed(0)}%</td><td className="r">{money(n.need)}</td>
                <td className="r">{money(n.forecast)}</td><td><Badge tone={s.tone}>{s.text}{s.gap > 0 ? `，差 ${money(s.gap)}` : ''}</Badge></td><td>{n.consequence}</td>
                <td><div className="acts">{editable && <><button className="sm ghost" onClick={() => setAct(nodeAct(n))}>修改</button>
                  <button className="sm ghost danger" onClick={() => setAct({ label: '删除', title: `删除 ${day(n.node_date)} 的考核节点`, danger: true, fields: [], run: () => rpc('delete_node', { id: n.node_id }) })}>删除</button></>}</div></td></tr>); })}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>预算变更</h3>
        {canChange && !adding && <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAdding(true)}>发起预算变更</button></div>}
        {adding && <NewChange cardId={c.card_id} cells={cells} onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />}
        {data.changes.length === 0 ? (!adding && <Empty>暂无预算变更记录。{c.locked && '该经费卡科目锁定，不得变更预算。'}</Empty>) : (
          <div className="scroll"><table>
            <thead><tr><th>发起日</th><th>原因</th><th>调整</th><th>状态</th><th>批复日</th><th /></tr></thead>
            <tbody>{[...data.changes].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((ch) => (
              <tr key={ch.id}><td>{day(ch.created_at)}</td><td className="wrap">{ch.reason}</td>
                <td className="wrap">{(ch.lines ?? []).map((l) => `${name.get(l.subject_id) ?? '科目'} ${l.delta > 0 ? '+' : ''}${money(l.delta)}`).join('；')}</td>
                <td><Badge tone={CHANGE[ch.status][1]}>{CHANGE[ch.status][0]}</Badge></td><td>{day(ch.approved_on)}</td>
                <td><div className="acts">{changeActs(me, ch).map((a) => <button key={a.label} className={`sm ghost ${a.danger ? 'danger' : ''}`} onClick={() => setAct(a)}>{a.label}</button>)}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>在途支出</h3>
        <p className="hint">已入账的历史支出可在 <a href="#/requests">支出申请</a> 中按状态查看。</p>
        {open.length === 0 ? <Empty>该经费卡暂无在途支出。</Empty>
          : <RequestTable me={me} rows={open} subjectName={name} onChange={reload} />}
      </section>

      {data.settle.length > 0 && (
        <section className="card">
          <h3>结清</h3>
          <p className="hint">{day(data.settle[0].settled_on)} 结清，以下数据已固定。</p>
          <div className="scroll"><table>
            <thead><tr><th>科目</th><th className="r">预算</th><th className="r">决算</th><th className="r">结余</th></tr></thead>
            <tbody>{data.settle.filter((l) => num(l.budget) || num(l.actual)).map((l) => (
              <tr key={l.subject_id}><td>{name.get(l.subject_id) ?? '科目'}</td><td className="r">{money(l.budget)}</td><td className="r">{money(l.actual)}</td><td className="r">{money(l.balance)}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      <LegacyAdjustList cardId={id} />
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
