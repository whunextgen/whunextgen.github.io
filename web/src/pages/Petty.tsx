import { useState } from 'react';
import { rpc, useViews, type LinePick, type Me, type PettyCash, type Req, type ResourceRequest, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, REQ, Tile, day, money, num, today } from '../ui';
import { KIND, RES_REQ, qty, type Act } from './Resource';

const PETTY: Record<PettyCash['status'], [string, string]> = {
  pending: ['待审批', 'warn'], approved: ['已领用，待核销', 'pri'], settled: ['已核销', 'ok'], rejected: ['已驳回', ''], withdrawn: ['已撤回', ''],
};
const days = (from: string) => Math.max(0, Math.floor((Date.parse(today()) - Date.parse(day(from))) / 864e5));

// ---------- 备用金：先领后核销的小额周转；从预算行里领，领用期间占着这一行预算 ----------
export function PettyPage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ rows: PettyCash[]; reqs: Req[]; lines: LinePick[] }>({ rows: ['petty_cash'], reqs: ['request'], lines: ['line_pick'] });
  const [act, setAct] = useState<Act | null>(null);
  const [all, setAll] = useState(false);
  if (!data) return <Loading error={error} />;

  const rows = [...data.rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const open = rows.filter((r) => r.status === 'pending' || r.status === 'approved');
  const out = rows.filter((r) => r.status === 'approved');
  const year = today().slice(0, 4);
  const settled = rows.filter((r) => r.status === 'settled' && day(r.settled_on).startsWith(year));
  const sum = (list: PettyCash[], k: 'amount' | 'spent' = 'amount') => list.reduce((s, r) => s + num(r[k]), 0);
  const saveAct = (r?: PettyCash): Act => ({
    label: r ? '保存' : '提交申请', title: r ? '修改备用金申请' : '申请备用金',
    hint: '备用金用于来不及办理支出申请的小额周转，同样从年度预算列支：选择一行预算，金额不得超过该预算行剩余额度；领用期间占用该预算行。由中心负责人审批，领用后凭票据由财务岗核销，未使用部分退回并释放预算。',
    fields: [{ name: 'line_id', label: '支出预算行', value: r?.budget_line_id,
      options: data.lines.map((l): [string, string] => [l.id, `${l.project_code} ${l.project_name} · ${l.category_name} · ${l.purpose}`]) },
      { name: 'amount', label: '金额（元）', type: 'number', value: r ? String(num(r.amount)) : '' }, { name: 'purpose', label: '用途', value: r?.purpose }],
    run: (v) => rpc('save_petty_cash', { id: r?.id ?? null, amount: v.amount, purpose: v.purpose, line_id: v.line_id }),
  });
  const decide = (r: PettyCash, action: 'approve' | 'reject' | 'withdraw'): Act => ({
    label: { approve: '批准', reject: '驳回', withdraw: '撤回' }[action], danger: action !== 'approve',
    title: `${{ approve: '批准', reject: '驳回', withdraw: '撤回' }[action]}备用金：${r.requester_name}，${money(r.amount)}`, hint: r.purpose,
    fields: action === 'withdraw' ? [] : [{ name: 'note', label: action === 'reject' ? '驳回原因' : '意见（选填）', required: action === 'reject' }],
    run: (v) => rpc('decide_petty_cash', { id: r.id, action, note: v.note ?? null }),
  });
  const settle = (r: PettyCash): Act => ({
    label: '核销', title: `核销备用金：${r.requester_name}，领用 ${money(r.amount)}`,
    hint: `预算行：${r.project_code ?? ''} ${r.line_purpose ?? ''}。填写凭票据实际支出的金额，未使用部分视为退回。实际支出须对应同一预算行上一笔已批准的支出申请（先在「支出申请」中登记），全额退回的无需选择。`,
    fields: [{ name: 'spent', label: '实际支出（元）', type: 'number', value: String(num(r.amount)) }, { name: 'settled_on', label: '核销日', type: 'date', value: today() },
      { name: 'request_id', label: '对应支出申请（实际支出大于 0 时必选）', required: false,
        options: data.reqs.filter((q) => q.budget_line_id === r.budget_line_id && ['committed', 'at_school', 'posted'].includes(q.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 60).map((q): [string, string] => [q.id, `${day(q.created_at)} ${q.title} ${money(q.amount)}`]) },
      { name: 'note', label: '说明（选填）', required: false }],
    run: (v) => rpc('settle_petty_cash', { id: r.id, spent: v.spent, settled_on: v.settled_on, note: v.note, request_id: v.request_id }),
  });
  const shown = all ? rows : open;

  return (
    <>
      <div className="top"><h2>备用金管理</h2><button onClick={() => setAct(saveAct())}>申请备用金</button></div>
      <div className="tiles">
        <Tile k="待审批" v={rows.filter((r) => r.status === 'pending').length} f="待中心负责人审批" tone={can(me, 'petty.approve') && rows.some((r) => r.status === 'pending') ? 'warn' : ''} />
        <Tile k="已领用未核销" v={money(sum(out))} f={`${out.length} 笔已领用`} tone={out.length ? 'warn' : ''} />
        <Tile k={`${year} 年已核销`} v={money(sum(settled, 'spent'))} f={`${settled.length} 笔，退回 ${money(sum(settled) - sum(settled, 'spent'))}`} />
        <Tile k="最长未核销" v={out.length ? `${Math.max(...out.map((r) => days(r.decided_at ?? r.created_at)))} 天` : '—'} f="领用后应及时凭票核销" />
      </div>
      <section className="card wide">
        <h3>备用金申请</h3>
        <p className="hint">备用金为先领用后报销，不在预算之外：申请时选择预算行 → 中心负责人审批 → 领用 → 财务岗凭票核销。领用期间占用该预算行；核销时实际支出部分对应同一预算行上的支出申请，由该笔申请计入经费卡，未使用部分释放回预算。</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!all} onClick={() => setAll(false)}>在途 {open.length}</button>
          <button className="sm" aria-pressed={all} onClick={() => setAll(true)}>全部 {rows.length}</button>
        </div>
        {shown.length === 0 ? <Empty>{all ? '暂无备用金申请。' : '暂无在途备用金。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>提交日期</th><th>申请人</th><th>项目 · 预算行</th><th className="r">领用</th><th>用途</th><th>状态</th><th className="r">实际支出</th><th className="r">退回</th><th /></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{r.requester_name}</td><td>{r.project_code}<div className="sub2">{r.line_purpose}</div></td><td className="r">{money(r.amount)}</td>
                <td className="wrap">{r.purpose}{r.decide_note && <div className="sub2">{r.decided_by_name}：{r.decide_note}</div>}{r.settle_note && <div className="sub2">核销：{r.settle_note}</div>}</td>
                <td><Badge tone={PETTY[r.status][1]}>{PETTY[r.status][0]}</Badge>{r.status === 'approved' && <div className="sub2">已领用 {days(r.decided_at ?? r.created_at)} 天</div>}</td>
                <td className="r">{r.spent != null ? money(r.spent) : '—'}{r.settled_on && <div className="sub2">{day(r.settled_on)}</div>}</td>
                <td className="r">{r.spent != null ? money(num(r.amount) - num(r.spent)) : '—'}</td>
                <td><div className="acts">
                  {r.status === 'pending' && can(me, 'petty.approve') && <><button className="sm" onClick={() => setAct(decide(r, 'approve'))}>批准</button>
                    <button className="sm ghost danger" onClick={() => setAct(decide(r, 'reject'))}>驳回</button></>}
                  {r.status === 'pending' && r.requested_by === me.id && <><button className="sm ghost" onClick={() => setAct(saveAct(r))}>修改</button>
                    <button className="sm ghost danger" onClick={() => setAct(decide(r, 'withdraw'))}>撤回</button></>}
                  {r.status === 'approved' && can(me, 'petty.settle') && <button className="sm" onClick={() => setAct(settle(r))}>核销</button>}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}

// ---------- 审批跟踪：所有在途的事项放在一张表里，看每一笔现在等谁 ----------
interface Item { id: string; type: '支出申请' | '备用金' | '资源申请'; flag: string; title: string; sub: string; who: string; amount: string; at: string; wait: string; badge: [string, string]; href: string }
export function TrackPage({ me }: { me: Me }) {
  const staff = can(me, 'read.finance');
  const { data, error } = useViews<{ reqs: Req[]; petty: PettyCash[]; res: ResourceRequest[]; users: User[] }>({
    reqs: ['request'], petty: ['petty_cash'], res: ['resource_request'], users: ['users'],
  });
  const [type, setType] = useState('');
  if (!data) return <Loading error={error} />;

  const name = new Map(data.users.map((u) => [u.id, u.name]));
  const WAIT: Record<string, string> = { pending: '中心负责人批准', committed: '财务岗提交单据至学校', at_school: '学校入账', returned: '财务岗变更经费卡或释放' };
  const items: Item[] = [
    ...data.reqs.filter((r) => r.status in WAIT).map((r): Item => ({ id: r.id, type: '支出申请', flag: r.emergency ? '紧急' : '', title: r.title, sub: r.code ?? '',
      who: r.requested_by === me.id ? '我' : name.get(r.requested_by ?? '') ?? '—', amount: money(r.amount), at: r.created_at, wait: r.status === 'pending' && r.step ? { confirm: '项目负责人确认', director: '中心负责人批准', check: '财务岗核对' }[r.step] ?? WAIT.pending : WAIT[r.status], badge: REQ[r.status], href: `#/requests/${r.status}` })),
    ...data.petty.filter((r) => r.status === 'pending' || r.status === 'approved').map((r): Item => ({ id: r.id, type: '备用金', flag: '', title: r.purpose, sub: '',
      who: r.requested_by === me.id ? '我' : r.requester_name, amount: money(r.amount), at: r.created_at, wait: r.status === 'pending' ? '中心负责人审批' : '财务岗凭票核销', badge: PETTY[r.status], href: '#/petty' })),
    ...data.res.filter((r) => ['pending', 'reviewed', 'approved'].includes(r.status)).map((r): Item => ({ id: r.id, type: '资源申请', flag: r.urgent ? '加急' : '', title: r.purpose,
      sub: `${r.resource_name ?? KIND[r.kind]}${r.project_code ? ` · ${r.project_code}` : ''}`, who: r.requested_by === me.id ? '我' : r.requester_name, amount: qty(r.approved_amount ?? r.amount, r.unit), at: r.created_at,
      wait: { pending: '项目负责人批示', reviewed: '财务岗批准', approved: '财务岗分发' }[r.status as 'pending'], badge: RES_REQ[r.status], href: staff ? '#/pool' : '#/resource' })),
  ].sort((a, b) => Number(!!b.flag) - Number(!!a.flag) || a.at.localeCompare(b.at));
  const types = ['支出申请', '备用金', '资源申请'] as const;
  const shown = items.filter((i) => !type || i.type === type);
  const slow = items.filter((i) => days(i.at) > 7).length;

  return (
    <>
      <div className="top"><h2>在途事项</h2></div>
      <div className="tiles">
        <Tile k="在途事项" v={items.length} f={types.map((t) => `${t} ${items.filter((i) => i.type === t).length}`).join(' · ')} />
        <Tile k="紧急、加急" v={items.filter((i) => i.flag).length} f="优先排列" tone={items.some((i) => i.flag) ? 'bad' : ''} />
        <Tile k="等待超过 7 天" v={slow} f="自提交之日起计算" tone={slow ? 'warn' : ''} />
        <Tile k="学校退回" v={data.reqs.filter((r) => r.status === 'returned').length} f="财务岗变更经费卡或释放" tone={data.reqs.some((r) => r.status === 'returned') ? 'bad' : ''} />
      </div>
      <section className="card wide">
        <h3>{staff ? '全部在途事项' : '我的在途事项'} <span className="h3sub">各事项当前等待对象</span></h3>
        <p className="hint">本页仅供查看，不办理业务：支出申请（含紧急支出）、备用金、资源申请中尚未办结的事项均列于此，按紧急程度和提交先后排序。需办理的，点击右侧链接进入对应页面。</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!type} onClick={() => setType('')}>全部 {items.length}</button>
          {types.map((t) => <button key={t} className="sm" aria-pressed={type === t} onClick={() => setType(t)}>{t} {items.filter((i) => i.type === t).length}</button>)}
        </div>
        {shown.length === 0 ? <Empty>暂无在途事项。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>类型</th><th>事项</th><th>申请人</th><th className="r">金额 / 数量</th><th>提交日期</th><th className="r">已等待</th><th>状态</th><th>当前等待</th><th /></tr></thead>
            <tbody>{shown.map((i) => (
              <tr key={i.type + i.id}><td>{i.type}{i.flag && <> <Badge tone="bad">{i.flag}</Badge></>}</td><td className="wrap">{i.title}{i.sub && <div className="sub2">{i.sub}</div>}</td><td>{i.who}</td>
                <td className="r">{i.amount}</td><td>{day(i.at)}</td><td className={`r ${days(i.at) > 7 ? 'neg' : ''}`}>{days(i.at)} 天</td>
                <td><Badge tone={i.badge[1]}>{i.badge[0]}</Badge></td><td>{i.wait}</td><td><a href={i.href}>办理 →</a></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
