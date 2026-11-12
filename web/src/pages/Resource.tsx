import { useEffect, useRef, useState } from 'react';
import { rpc, secretGet, secretSet, useViews, type Allocation, type Me, type Req, type Resource, type ResourcePick, type ResourcePlan, type ResourceRequest, type ResourceStock, type ResReqStatus,
  type SecretAccess, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, PERSON, Tile, canPublic, day, money, num, today, type Field } from '../ui';

export interface Act { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
export const KIND: Record<string, string> = { api: '接口额度', asset: '资产' };
export const RES_REQ: Record<ResReqStatus, [string, string]> = {
  pending: ['待项目负责人批示', 'warn'], reviewed: ['待批准', 'warn'], approved: ['已批准，待分发', 'pri'], fulfilled: ['已分发', 'ok'], rejected: ['已驳回', ''], withdrawn: ['已撤回', ''],
};
export const qty = (v: string | number | null, unit: string | null) => (v == null ? '—' : `${num(v).toLocaleString('zh-CN')}${unit ? ` ${unit}` : ''}`);
const spec = (o: { provider?: string | null; model?: string | null; spec?: string | null; category?: string | null }) => [o.provider, o.model, o.category, o.spec].filter(Boolean).join(' · ');
const monthEnd = (d: string) => { const [y, m] = d.split('-').map(Number); return `${d.slice(0, 7)}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`; };
const soon = (d: string | null) => d != null && day(d) >= today() && day(d) <= new Date(Date.now() + 38 * 86400e3).toISOString().slice(0, 10);

// 查看密钥：点了才取，取一次记一次；关掉就从页面上清掉
function SecretDialog({ kind, id, title, onClose }: { kind: 'resource' | 'allocation'; id: string; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [plain, setPlain] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} onClose={onClose}>
      <h3>{title}</h3>
      <p className="hint">密钥加密保存在中台里，只有持有人和财务岗能取。每取一次记一条取用记录。不要转发给别人，也不要写进代码仓库；用完归还或到期后，这把密钥会从你名下撤掉。</p>
      {plain ? <p className="secret"><code>{plain}</code></p> : <p className="empty">还没有显示。</p>}
      {msg && <div className={`msg ${msg === '已复制' ? '' : 'bad'}`} role="status">{msg}</div>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>关闭</button>
        {plain ? <button type="button" onClick={() => navigator.clipboard.writeText(plain).then(() => setMsg('已复制'), () => setMsg('复制失败，请手动选中复制'))}>复制</button>
          : <button type="button" disabled={busy} onClick={() => { setBusy(true); setMsg('');
            secretGet(kind, id).then(setPlain, (e: Error) => setMsg(e.message)).finally(() => setBusy(false)); }}>{busy ? '取用中…' : '显示密钥'}</button>}
      </div>
    </dialog>
  );
}

const keyAct = (kind: 'resource' | 'allocation', id: string, name: string, has: boolean): Act => ({
  label: '保存', title: `${has ? '更换' : '保存'}密钥：${name}`,
  hint: `密钥在服务端加密后保存，页面上只显示掩码。${kind === 'resource' ? '这是整个账号共用的密钥，只有财务岗能取用；发给个人的密钥请在额度台账上单独保存。' : '这是发给这位持有人的密钥，持有人可以在「申请与名下」里自己取用，收回时自动删除。'}${has ? '留空保存即删除现有密钥。' : ''}`,
  fields: [{ name: 'secret', label: '密钥', required: !has }],
  run: (v) => secretSet(kind, id, v.secret.trim()),
});

// ---------- 申请与名下：所有人 ----------
export function ResourcePage({ me }: { me: Me }) {
  const staff = can(me, 'read.resource');
  const { data, error, reload } = useViews<{ allocs: Allocation[]; plans: ResourcePlan[]; reqs: ResourceRequest[] }>({
    allocs: ['allocation'], plans: ['resource_plan'], reqs: ['resource_request'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [key, setKey] = useState<Allocation | null>(null);
  if (!data) return <Loading error={error} />;

  const mine = data.allocs.filter((a) => a.user_id === me.id && a.current).sort((a, b) => a.kind.localeCompare(b.kind) || a.resource_name.localeCompare(b.resource_name, 'zh'));
  const myReqs = data.reqs.filter((r) => r.requested_by === me.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const toReview = data.reqs.filter((r) => r.status === 'pending' && r.my_project && r.requested_by !== me.id && !staff);
  // 资源申请只能挂在做了资源计划的预算行上：选预算行，项目和资源跟着预算行走
  const plans = data.plans.filter((p) => p.open).sort((a, b) => a.project_code.localeCompare(b.project_code) || a.purpose.localeCompare(b.purpose, 'zh'));
  const rest = (p: ResourcePlan) => num(p.plan_qty) - num(p.asked) - num(p.granted);
  // 公共资源只有一种：中心公共开支里给博士后、博士、硕士、研究助理个人申领的设备。其余资源都在各项目自己的预算里，跟项目负责人走
  const pub = plans.filter((p) => p.project_kind === 'public'), own = plans.filter((p) => p.project_kind !== 'public');
  const eligible = canPublic(me.kind);
  const lineOpts = (kind: 'api' | 'asset') => plans.filter((p) => p.kind === kind && (p.project_kind !== 'public' || eligible)).map((p): [string, string] =>
    [p.id, `${p.project_code} ${p.purpose} · ${p.resource_name}，计划 ${qty(p.plan_qty, p.unit)}，还剩 ${qty(rest(p), p.unit)}`]);
  const none = (kind: 'api' | 'asset') => (lineOpts(kind).length ? '' : `今年的预算里还没有${KIND[kind]}的资源计划，现在提不了。要用先请项目负责人在年度预算里加上，年中要追加的找财务岗在复盘时调整。`);
  const reqAct = (kind: 'api' | 'asset'): Act => kind === 'api' ? {
    label: '提交申请', title: '申请接口额度',
    hint: `资源都从年度预算里出：选一行做了资源计划的预算，累计申请不能超过计划数量。先由项目负责人批示，再由财务岗批准并分发；自己负责的项目直接到财务岗。申请里不要填任何密钥。${none(kind)}`,
    fields: [{ name: 'line_id', label: '从哪一行预算出', options: lineOpts(kind) },
      { name: 'amount', label: '额度', type: 'number' }, { name: 'period', label: '用在哪个月', type: 'month', value: today().slice(0, 7) },
      { name: 'purpose', label: '用途' }, { name: 'usage_note', label: '用量估算（模型、调用量；加急的必须写）', required: false },
      { name: 'urgent', label: '加急', type: 'check', value: 'false' }],
    run: (v) => rpc('save_resource_request', { id: null, kind, resource_id: null, line_id: v.line_id, amount: v.amount, period: `${v.period}-01`,
      purpose: v.purpose, usage_note: v.usage_note, urgent: v.urgent === 'true' }),
  } : {
    label: '提交申请', title: '申领资产',
    hint: `设备和耗材也从年度预算里出：选一行做了资源计划的预算，累计申领不能超过计划数量。项目里的设备由项目负责人批示；公共设备只给博士后、博士、硕士和研究助理，直接到财务岗。库存不够的也可以先提，财务岗按预算走采购，到货入库后分发。${none(kind)}`,
    fields: [{ name: 'line_id', label: '从哪一行预算出', options: lineOpts(kind) }, { name: 'amount', label: '数量', type: 'number', value: '1' },
      { name: 'purpose', label: '用途' }, { name: 'usage_note', label: '补充说明（加急的必须写）', required: false },
      { name: 'urgent', label: '加急', type: 'check', value: 'false' }],
    run: (v) => rpc('save_resource_request', { id: null, kind, resource_id: null, line_id: v.line_id, amount: v.amount, period: null,
      purpose: v.purpose, usage_note: v.usage_note, urgent: v.urgent === 'true' }),
  };
  const decide = (r: ResourceRequest, action: 'review' | 'reject' | 'withdraw'): Act => ({
    label: { review: '同意', reject: '驳回', withdraw: '撤回' }[action], danger: action !== 'review',
    title: `${{ review: '同意', reject: '驳回', withdraw: '撤回' }[action]}：${r.requester_name} 申请 ${r.resource_name ?? KIND[r.kind]} ${qty(r.amount, r.unit)}`,
    hint: action === 'review' ? '同意后转给财务岗批准和分发。' : action === 'withdraw' ? '撤回后这笔申请作废，需要的话重新提交。' : undefined,
    fields: action === 'withdraw' ? [] : [{ name: 'note', label: action === 'reject' ? '驳回原因' : '意见（可不填）', required: action === 'reject' }],
    run: (v) => rpc('decide_resource_request', { id: r.id, action, amount: null, note: v.note ?? null }),
  });

  return (
    <>
      <div className="top"><h2>资源：申请与名下</h2>
        <div className="acts"><button onClick={() => setAct(reqAct('api'))}>申请接口额度</button><button className="ghost" onClick={() => setAct(reqAct('asset'))}>申领资产</button></div></div>
      <div className="tiles">
        <Tile k="名下接口" v={mine.filter((a) => a.kind === 'api').length} f="正在生效的额度" />
        <Tile k="名下资产" v={mine.filter((a) => a.kind === 'asset').length} f="在你名下的设备和耗材" />
        <Tile k="在途申请" v={myReqs.filter((r) => ['pending', 'reviewed', 'approved'].includes(r.status)).length} f="提交后还没分发的" />
        <Tile k="快到期" v={mine.filter((a) => soon(a.to_date)).length} f="一个月内到期" tone={mine.some((a) => soon(a.to_date)) ? 'warn' : ''} />
      </div>

      {toReview.length > 0 && (
        <section className="card wide">
          <h3>等你批示 <span className="h3sub">你负责的项目下，成员提的资源申请</span></h3>
          <div className="scroll"><table>
            <thead><tr><th>提交</th><th>申请人</th><th>项目 · 预算行</th><th>资源</th><th className="r">数量</th><th>用于</th><th>用途</th><th /></tr></thead>
            <tbody>{toReview.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{r.requester_name}{r.urgent && <> <Badge tone="bad">加急</Badge></>}</td><td>{r.project_code} {r.project_name}<div className="sub2">{r.line_purpose}，计划 {qty(r.plan_qty, r.unit)}</div></td>
                <td>{r.resource_name ?? `${KIND[r.kind]}（未指定）`}</td><td className="r">{qty(r.amount, r.unit)}</td><td>{r.period ? r.period.slice(0, 7) : '—'}</td>
                <td className="wrap">{r.purpose}{r.usage_note && <div className="sub2">{r.usage_note}</div>}</td>
                <td><div className="acts"><button className="sm" onClick={() => setAct(decide(r, 'review'))}>同意</button>
                  <button className="sm ghost danger" onClick={() => setAct(decide(r, 'reject'))}>驳回</button></div></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      <section className="card wide">
        <h3>项目预算里的资源计划 <span className="h3sub">跟项目负责人走</span></h3>
        <p className="hint">接口额度、设备都编在各项目自己的年度预算里：项目负责人申报时在预算行上写明要什么资源、全年多少，预算下达后项目里的人按计划申请，由项目负责人批示。这里只显示数量，不显示金额。</p>
        {own.length === 0 ? <Empty>今年已下达的预算里还没有资源计划。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>项目</th><th>预算行</th><th>资源</th><th className="r">全年计划</th><th className="r">已分发</th><th className="r">在途</th><th className="r">还能申请</th></tr></thead>
            <tbody>{own.map((p) => (
              <tr key={p.id}><td>{p.project_code}<div className="sub2">{p.project_name}</div></td><td className="wrap">{p.purpose}<div className="sub2">{p.category_name}</div></td>
                <td>{p.resource_name}<div className="sub2">{KIND[p.kind]}</div></td><td className="r">{qty(p.plan_qty, p.unit)}</td><td className="r">{qty(p.granted, p.unit)}</td>
                <td className="r">{num(p.asked) > 0 ? qty(p.asked, p.unit) : '—'}</td><td className={`r ${rest(p) <= 0 ? 'neg' : ''}`}>{rest(p) > 0 ? qty(rest(p), p.unit) : '已用完'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>公共设备 <span className="h3sub">中心统一配给博士后、博士、硕士和研究助理个人</span></h3>
        <p className="hint">中心公共的资源只有这一种，编在中心公共开支的预算里，申领后直接到财务岗。
          {eligible ? `你登记的身份是${PERSON[me.kind!]}，可以申领。` : me.kind ? `你登记的身份是${PERSON[me.kind]}，不在申领范围内，要用设备请从所在项目的预算里申请。` : '你的身份还没登记，先请财务岗登记后再申领。'}</p>
        {pub.length === 0 ? <Empty>今年的中心公共开支里还没有设备计划。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>预算行</th><th>设备</th><th className="r">全年计划</th><th className="r">已分发</th><th className="r">在途</th><th className="r">还能申领</th></tr></thead>
            <tbody>{pub.map((p) => (
              <tr key={p.id}><td className="wrap">{p.purpose}<div className="sub2">{p.category_name}</div></td><td>{p.resource_name}</td>
                <td className="r">{qty(p.plan_qty, p.unit)}</td><td className="r">{qty(p.granted, p.unit)}</td>
                <td className="r">{num(p.asked) > 0 ? qty(p.asked, p.unit) : '—'}</td><td className={`r ${rest(p) <= 0 ? 'neg' : ''}`}>{rest(p) > 0 ? qty(rest(p), p.unit) : '已用完'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>我名下的资源</h3>
        <p className="hint">接口密钥加密保存在中台里：财务岗分发后，你在这里自己取用，每次取用都有记录；额度到期或收回后密钥随之撤掉。用量由财务岗按服务商账单回写。</p>
        {mine.length === 0 ? <Empty>你名下现在没有资源。需要接口额度或设备，按上面的资源计划提交申请。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>资源</th><th>类型</th><th className="r">额度 / 数量</th><th className="r">已用</th><th>编号 · 存放</th><th>起始</th><th>到期</th><th>密钥</th></tr></thead>
            <tbody>{mine.map((a) => { const over = a.quota != null && a.used != null && num(a.used) >= num(a.quota) * 0.9; return (
              <tr key={a.id}><td>{a.resource_name}{spec(a) && <div className="sub2">{spec(a)}</div>}{a.note && <div className="sub2">{a.note}</div>}</td><td>{KIND[a.kind]}</td>
                <td className="r">{qty(a.quota, a.unit)}</td>
                <td className={`r ${over ? 'neg' : ''}`}>{a.kind === 'asset' ? '—' : a.used == null ? '未回写' : qty(a.used, a.unit)}{a.used_on && <div className="sub2">截至 {day(a.used_on)}</div>}</td>
                <td>{a.kind === 'asset' ? <>{a.asset_no ?? '—'}{a.location && <div className="sub2">{a.location}</div>}</> : <span className="code">{a.ref ?? '—'}</span>}</td>
                <td>{day(a.from_date)}</td><td>{a.to_date ? <>{day(a.to_date)}{soon(a.to_date) && <> <Badge tone="warn">快到期</Badge></>}</> : '长期'}</td>
                <td>{a.has_secret ? <div className="acts"><span className="code">{a.secret_hint ?? '已保存'}</span><button className="sm ghost" onClick={() => setKey(a)}>查看</button></div>
                  : a.kind === 'api' ? <span className="sub2">还没发放</span> : '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>我的申请</h3>
        {myReqs.length === 0 ? <Empty>你还没有提过资源申请。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>提交</th><th>类型</th><th>资源</th><th>项目 · 预算行</th><th className="r">申请</th><th className="r">批准</th><th>用于</th><th>用途</th><th>状态</th><th /></tr></thead>
            <tbody>{myReqs.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{KIND[r.kind]}{r.urgent && <> <Badge tone="bad">加急</Badge></>}</td><td>{r.resource_name ?? '未指定'}</td>
                <td>{r.project_code} {r.project_name}<div className="sub2">{r.line_purpose}</div></td><td className="r">{qty(r.amount, r.unit)}</td>
                <td className="r">{r.approved_amount != null ? qty(r.approved_amount, r.unit) : '—'}</td><td>{r.period ? r.period.slice(0, 7) : '—'}</td>
                <td className="wrap">{r.purpose}{r.decide_note && <div className="sub2">{r.decided_by_name ?? r.reviewed_by_name}：{r.decide_note}</div>}</td>
                <td><Badge tone={RES_REQ[r.status][1]}>{RES_REQ[r.status][0]}</Badge></td>
                <td><div className="acts">{['pending', 'reviewed', 'approved'].includes(r.status) && <button className="sm ghost danger" onClick={() => setAct(decide(r, 'withdraw'))}>撤回</button>}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {key && <SecretDialog kind="allocation" id={key.id} title={`密钥：${key.resource_name}`} onClose={() => { setKey(null); reload(); }} />}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}

// ---------- 需求池与分发：财务岗、中心负责人 ----------
export function PoolPage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ resources: Resource[]; reqs: ResourceRequest[]; plans: ResourcePlan[] }>({ resources: ['resource'], reqs: ['resource_request'], plans: ['resource_plan'] });
  const [act, setAct] = useState<Act | null>(null);
  const [all, setAll] = useState(false);
  if (!data) return <Loading error={error} />;

  const open = data.reqs.filter((r) => ['pending', 'reviewed', 'approved'].includes(r.status));
  const shown = [...(all ? data.reqs : open)].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.created_at.localeCompare(b.created_at));
  const n = (s: ResReqStatus) => data.reqs.filter((r) => r.status === s).length;
  const active = data.resources.filter((r) => r.active);
  // 需求池：在途需求合计，对着剩余量看缺口；采购量按需求 ×120% 提示，留两成余量
  const yearNow = Number(today().slice(0, 4));
  const planned = (id: string, k: 'plan_qty' | 'granted') => data.plans.filter((p) => p.resource_id === id && p.year === yearNow).reduce((s, p) => s + num(p[k]), 0);
  const pool = active.filter((r) => num(r.asked) > 0 || planned(r.id, 'plan_qty') > 0).map((r) => {
    const left = r.total == null ? null : num(r.total) - num(r.allocated);
    const plan = r.kind === 'asset' ? Math.ceil(num(r.asked) * 1.2) : num(r.asked) * 1.2;
    return { r, left, plan, buy: left == null ? 0 : Math.max(0, plan - left) };
  });
  const price = (r: Resource) => (r.unit_price != null ? num(r.unit_price) : null);
  const cost = pool.reduce((s, p) => s + p.buy * (price(p.r) ?? 0), 0);
  const options = (kind: string) => active.filter((r) => r.kind === kind).map((r): [string, string] => [r.id, `${r.name}${r.total != null ? `，余 ${qty(num(r.total) - num(r.allocated), r.unit)}` : ''}`]);
  const approve = (r: ResourceRequest): Act => ({
    label: '批准', title: `批准：${r.requester_name} 申请 ${r.resource_name ?? KIND[r.kind]} ${qty(r.amount, r.unit)}`,
    hint: `${r.purpose}${r.usage_note ? `。${r.usage_note}` : ''}。批准的数量可以比申请的少，少了要写明原因。${r.status === 'pending' ? '这笔还没经项目负责人批示，由中心负责人直接批准。' : ''}`,
    fields: [{ name: 'amount', label: `批准数量${r.unit ? `（${r.unit}）` : ''}`, type: 'number', value: String(num(r.amount)) }, { name: 'note', label: '意见（可不填）', required: false }],
    run: (v) => rpc('decide_resource_request', { id: r.id, action: 'approve', amount: v.amount, note: v.note }),
  });
  const reject = (r: ResourceRequest): Act => ({
    label: '驳回', danger: true, title: `驳回：${r.requester_name} 申请 ${r.resource_name ?? KIND[r.kind]} ${qty(r.amount, r.unit)}`,
    fields: [{ name: 'note', label: '驳回原因' }], run: (v) => rpc('decide_resource_request', { id: r.id, action: 'reject', amount: null, note: v.note }),
  });
  const fulfil = (r: ResourceRequest): Act => ({
    label: '分发', title: `分发：${r.requester_name}，${qty(r.approved_amount ?? r.amount, r.unit)}`,
    hint: '分发后生成一条分配记录，记在申请人名下。发给个人的密钥在「资源池与库存」的额度台账上保存。',
    fields: [...(r.resource_id ? [] : [{ name: 'resource_id', label: '从哪个资源分发', options: options(r.kind) } as Field]),
      { name: 'to_date', label: r.kind === 'api' ? '到期日（默认到申请那个月的月底）' : '归还日（长期的不填）', type: 'date', required: false, value: r.period ? monthEnd(r.period) : '' }, { name: 'note', label: '备注（可不填）', required: false }],
    run: (v) => rpc('fulfil_resource_request', { id: r.id, resource_id: r.resource_id ?? v.resource_id, to_date: v.to_date, note: v.note }),
  });

  return (
    <>
      <div className="top"><h2>需求池与分发</h2></div>
      <div className="tiles">
        <Tile k="待项目负责人批示" v={n('pending')} f="每笔都挂在预算行上，先过负责人" />
        <Tile k="待批准" v={n('reviewed')} f="财务岗或中心负责人批准" tone={n('reviewed') ? 'warn' : ''} />
        <Tile k="待分发" v={n('approved')} f="批准了还没发到人" tone={n('approved') ? 'warn' : ''} />
        <Tile k="建议采购" v={money(cost)} f="缺口按单价折算，钱从对应预算行出" />
      </div>

      <section className="card wide">
        <h3>需求池 <span className="h3sub">预算计划和在途申请按资源汇总</span></h3>
        <p className="hint">全年计划是今年各预算行资源计划的合计，申请不能超过它。采购量按在途需求 × 120% 备货，减去现有剩余就是建议采购量；采购的钱走 04 支出申请，挂在同一行预算上，批准后到货才能在「资源池与库存」入库。</p>
        {pool.length === 0 ? <Empty>今年的预算里没有资源计划，也没有在途的资源需求。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>资源</th><th>类型</th><th className="r">全年计划</th><th className="r">已分发</th><th className="r">在途需求</th><th className="r">按 120% 备货</th><th className="r">现有剩余</th><th className="r">建议采购</th><th className="r">单价</th><th className="r">折合（元）</th></tr></thead>
            <tbody>{pool.map(({ r, left, plan, buy }) => (
              <tr key={r.id}><td>{r.name}{spec(r) && <div className="sub2">{spec(r)}</div>}</td><td>{KIND[r.kind]}</td><td className="r">{planned(r.id, 'plan_qty') > 0 ? qty(planned(r.id, 'plan_qty'), r.unit) : '—'}</td><td className="r">{qty(planned(r.id, 'granted'), r.unit)}</td>
                <td className="r">{num(r.asked) > 0 ? qty(r.asked, r.unit) : '—'}</td><td className="r">{num(r.asked) > 0 ? qty(plan, r.unit) : '—'}</td>
                <td className="r">{left == null ? '不限量' : qty(left, r.unit)}</td><td className={`r ${buy > 0 ? 'neg' : ''}`}>{left == null ? '—' : buy > 0 ? qty(buy, r.unit) : '够用'}</td>
                <td className="r">{r.unit_price != null ? money(r.unit_price) : '—'}</td><td className="r">{buy > 0 && price(r) != null ? money(buy * price(r)!) : '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>资源申请</h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!all} onClick={() => setAll(false)}>在途 {open.length}</button>
          <button className="sm" aria-pressed={all} onClick={() => setAll(true)}>全部 {data.reqs.length}</button>
        </div>
        {shown.length === 0 ? <Empty>没有资源申请。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>提交</th><th>申请人</th><th>项目 · 预算行</th><th>资源</th><th className="r">申请</th><th className="r">批准</th><th>用于</th><th>用途</th><th>状态</th><th /></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{r.requester_name}{r.urgent && <> <Badge tone="bad">加急</Badge></>}</td>
                <td>{r.project_code}<div className="sub2">{r.line_purpose}，计划 {qty(r.plan_qty, r.unit)}</div></td>
                <td>{r.resource_name ?? '未指定'}<div className="sub2">{KIND[r.kind]}</div></td><td className="r">{qty(r.amount, r.unit)}</td>
                <td className="r">{r.approved_amount != null ? qty(r.approved_amount, r.unit) : '—'}</td><td>{r.period ? r.period.slice(0, 7) : '—'}</td>
                <td className="wrap">{r.purpose}{r.usage_note && <div className="sub2">{r.usage_note}</div>}{r.decide_note && <div className="sub2">{r.decided_by_name ?? r.reviewed_by_name}：{r.decide_note}</div>}</td>
                <td><Badge tone={RES_REQ[r.status][1]}>{RES_REQ[r.status][0]}</Badge></td>
                <td><div className="acts">
                  {(r.status === 'reviewed' || (r.status === 'pending' && can(me, 'resource.fasttrack'))) && <button className="sm" onClick={() => setAct(approve(r))}>批准</button>}
                  {r.status === 'approved' && <button className="sm" onClick={() => setAct(fulfil(r))}>分发</button>}
                  {['pending', 'reviewed'].includes(r.status) && <button className="sm ghost danger" onClick={() => setAct(reject(r))}>驳回</button>}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}

// ---------- 资源池与库存：财务岗、中心负责人 ----------
export function StockPage() {
  const { data, error, reload } = useViews<{ resources: Resource[]; allocs: Allocation[]; users: User[]; stock: ResourceStock[]; access: SecretAccess[]; reqs: Req[] }>({
    resources: ['resource'], allocs: ['allocation'], users: ['users'], stock: ['resource_stock'], access: ['secret_access'], reqs: ['request'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [key, setKey] = useState<{ kind: 'resource' | 'allocation'; id: string; name: string } | null>(null);
  const [tab, setTab] = useState<'api' | 'asset'>('api');
  const [past, setPast] = useState(false);
  if (!data) return <Loading error={error} />;

  const users = data.users.filter((u) => u.active).map((u): [string, string] => [u.id, u.name]);
  const list = data.resources.filter((r) => r.kind === tab).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh'));
  const allocs = data.allocs.filter((a) => a.kind === tab && (past || a.current)).sort((a, b) => Number(b.current) - Number(a.current) || b.from_date.localeCompare(a.from_date));
  const apis = data.resources.filter((r) => r.kind === 'api' && r.active), assets = data.resources.filter((r) => r.kind === 'asset' && r.active);
  const low = apis.filter((r) => r.total != null && num(r.total) > 0 && num(r.used) >= num(r.total) * 0.8).length
    + assets.filter((r) => r.total != null && num(r.total) - num(r.allocated) <= 0).length;
  const info = (r: Resource | undefined, v: Record<string, string>, kind: string) => kind === 'api'
    ? { provider: v.provider, model: v.model, currency: v.currency, ...(v.balance !== (r?.balance != null ? String(num(r.balance)) : '') ? { balance: v.balance } : {}) }
    : { category: v.category, spec: v.spec, unit_price: v.unit_price, bundle: v.bundle, location: v.location };
  const resAct = (r?: Resource): Act => { const kind = r?.kind ?? tab; return {
    label: r ? '保存' : '登记', title: r ? `修改：${r.name}` : `登记${KIND[kind]}`,
    hint: kind === 'api' ? '总配额填这个账号一共能分出去多少（例如 元/月）；余额是服务商那边账户里还剩的钱，对账时更新。密钥不要填在这里，登记后在列表里单独保存。'
      : '单件资产（一台设备）不填库存，一次只能在一个人名下；成批的（同一型号多件、耗材）填库存数量，按件申领。',
    fields: [{ name: 'name', label: '名称', value: r?.name },
      ...(kind === 'api' ? [{ name: 'provider', label: '服务商（可不填）', required: false, value: r?.provider ?? '' }, { name: 'model', label: '模型或套餐（可不填）', required: false, value: r?.model ?? '' },
        { name: 'ref', label: '账号（可不填，不要填密钥）', required: false, value: r?.ref ?? '' },
        { name: 'total', label: '总配额（不限量的不填）', type: 'number', required: false, value: r?.total != null ? String(num(r.total)) : '' },
        { name: 'unit', label: '单位（例如 元/月）', required: false, value: r?.unit ?? '' }, { name: 'currency', label: '币种（可不填）', required: false, value: r?.currency ?? '' },
        { name: 'balance', label: '服务商账户余额（可不填）', type: 'number', required: false, value: r?.balance != null ? String(num(r.balance)) : '' }] as Field[]
      : [{ name: 'category', label: '类别（例如 显卡、显示器、耗材）', required: false, value: r?.category ?? '' }, { name: 'spec', label: '规格型号（可不填）', required: false, value: r?.spec ?? '' },
        { name: 'ref', label: '资产编号（成批的可不填）', required: false, value: r?.ref ?? '' },
        { name: 'total', label: '库存数量（单件资产不填）', type: 'number', required: false, value: r?.total != null ? String(num(r.total)) : '' },
        { name: 'unit', label: '单位（例如 台、个）', required: false, value: r?.unit ?? '' }, { name: 'unit_price', label: '单价（元，可不填）', type: 'number', required: false, value: r?.unit_price != null ? String(num(r.unit_price)) : '' },
        { name: 'bundle', label: '随附配件（可不填）', required: false, value: r?.bundle ?? '' }, { name: 'location', label: '存放地点（可不填）', required: false, value: r?.location ?? '' }] as Field[]),
      { name: 'note', label: '备注（可不填）', required: false, value: r?.note ?? '' },
      ...(r ? [{ name: 'active', label: '在用（取消勾选即停用，不能再申请和分配）', type: 'check', value: String(r.active) } as Field] : [])],
    run: async (v) => { const id = await rpc('save_resource', { id: r?.id ?? null, kind, name: v.name, ref: v.ref, total: v.total, unit: v.unit, note: v.note, active: r ? v.active === 'true' : true });
      await rpc('set_resource_info', { id: r?.id ?? id, info: info(r, v, kind) }); },
  }; };
  const giveAct = (r: Resource): Act => ({
    label: '分配', title: `直接分配：${r.name}`,
    hint: `不经申请直接记到某人名下，用于补记和续期。${r.total != null ? `${r.kind === 'asset' ? '库存' : '总配额'} ${qty(r.total, r.unit)}，已分出 ${qty(r.allocated, r.unit)}。` : r.kind === 'asset' ? '单件资产一次只能在一个人名下，换人前先收回。' : ''}`,
    fields: [{ name: 'user_id', label: '使用人', options: users },
      ...(r.kind === 'api' ? [{ name: 'quota', label: `额度${r.unit ? `（${r.unit}）` : ''}`, type: 'number', required: r.total != null } as Field]
        : r.total != null ? [{ name: 'quota', label: `数量${r.unit ? `（${r.unit}）` : ''}`, type: 'number', value: '1' } as Field] : []),
      { name: 'from_date', label: '起始日', type: 'date', value: today() }, { name: 'to_date', label: '到期日（长期的不填）', type: 'date', required: false },
      { name: 'note', label: '用途（可不填）', required: false }],
    run: (v) => rpc('allocate_resource', { resource_id: r.id, user_id: v.user_id, quota: v.quota ?? null, from_date: v.from_date, to_date: v.to_date, note: v.note }),
  });
  const bought = data.reqs.filter((q) => ['committed', 'at_school', 'posted'].includes(q.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 80)
    .map((q): [string, string] => [q.id, `${day(q.created_at)} ${q.title} ${money(q.amount)}`]);
  const stockAct = (r: Resource): Act => ({
    label: r.kind === 'api' ? '充值' : '入库', title: `${r.kind === 'api' ? '充值' : '验收入库'}：${r.name}`,
    hint: `${r.kind === 'api' ? '充值后总配额和服务商账户余额同时增加。' : '验收后库存增加。'}采购先走预算：这笔钱要先在 04 支出申请里从预算行提出并批准，这里选上对应的那一笔才能${r.kind === 'api' ? '充值' : '入库'}。`,
    fields: [{ name: 'request_id', label: '对应的支出申请（已批准的）', options: bought },
      { name: 'qty', label: `${r.kind === 'api' ? '充值额度' : '数量'}${r.unit ? `（${r.unit}）` : ''}`, type: 'number' },
      { name: 'unit_price', label: r.kind === 'api' ? '实付金额（元，可不填）' : '单价（元，可不填）', type: 'number', required: false, value: r.kind === 'asset' && r.unit_price != null ? String(num(r.unit_price)) : '' },
      { name: 'received_on', label: r.kind === 'api' ? '充值日' : '验收日', type: 'date', value: today() }, { name: 'supplier', label: '供应商（可不填）', required: false },
      { name: 'note', label: '备注（可不填）', required: false }],
    run: (v) => rpc('stock_in', { resource_id: r.id, qty: v.qty, unit_price: v.unit_price, received_on: v.received_on, supplier: v.supplier, note: v.note, request_id: v.request_id }),
  });
  const useAct = (a: Allocation): Act => a.kind === 'api' ? {
    label: '回写', title: `回写用量：${a.user_name} · ${a.resource_name}`, hint: `按服务商账单填截至某天的累计用量。额度 ${qty(a.quota, a.unit)}。`,
    fields: [{ name: 'used', label: `已用${a.unit ? `（${a.unit}）` : ''}`, type: 'number', value: a.used != null ? String(num(a.used)) : '' }, { name: 'used_on', label: '截至', type: 'date', value: today() }],
    run: (v) => rpc('set_allocation_info', { id: a.id, used: v.used, used_on: v.used_on, asset_no: null, location: null }),
  } : {
    label: '保存', title: `编号和存放：${a.user_name} · ${a.resource_name}`,
    fields: [{ name: 'asset_no', label: '资产编号', required: false, value: a.asset_no ?? '' }, { name: 'location', label: '存放地点', required: false, value: a.location ?? '' }],
    run: (v) => rpc('set_allocation_info', { id: a.id, used: null, used_on: null, asset_no: v.asset_no, location: v.location }),
  };
  const reqTitle = new Map(data.reqs.map((q) => [q.id, q.title]));
  const stock = data.stock.filter((s) => s.kind === tab).sort((a, b) => b.received_on.localeCompare(a.received_on));

  return (
    <>
      <div className="top"><h2>资源池与库存</h2><button onClick={() => setAct(resAct())}>登记{KIND[tab]}</button></div>
      <div className="tiles">
        <Tile k="接口账号" v={apis.length} f={`${apis.filter((r) => r.has_secret).length} 个已保存密钥`} />
        <Tile k="资产" v={assets.length} f={`${assets.filter((r) => r.total == null).length} 件单件，${assets.filter((r) => r.total != null).length} 种成批`} />
        <Tile k="在用分配" v={data.allocs.filter((a) => a.current).length} f={`${new Set(data.allocs.filter((a) => a.current).map((a) => a.user_id)).size} 人名下`} />
        <Tile k="要补货" v={low} f="接口用到八成，或库存发完" tone={low ? 'bad' : ''} />
      </div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button aria-pressed={tab === 'api'} onClick={() => setTab('api')}>接口额度</button>
        <button aria-pressed={tab === 'asset'} onClick={() => setTab('asset')}>资产与库存</button>
      </div>

      <section className="card wide">
        <h3>{tab === 'api' ? '接口账号' : '资产与库存'}</h3>
        {list.length === 0 ? <Empty>还没有登记{KIND[tab]}。</Empty> : (
          <div className="scroll"><table>
            {tab === 'api'
              ? <thead><tr><th>名称</th><th>账号</th><th className="r">总配额</th><th className="r">已分出</th><th className="r">已用</th><th className="r">服务商余额</th><th className="r">在途需求</th><th>密钥</th><th /></tr></thead>
              : <thead><tr><th>名称</th><th>编号</th><th className="r">库存</th><th className="r">已发出</th><th className="r">剩余</th><th className="r">单价</th><th>存放</th><th className="r">在途需求</th><th /></tr></thead>}
            <tbody>{list.map((r) => { const left = r.total == null ? null : num(r.total) - num(r.allocated); return (
              <tr key={r.id}><td>{r.name}{!r.active && <> <Badge>已停用</Badge></>}{spec(r) && <div className="sub2">{spec(r)}</div>}{r.note && <div className="sub2">{r.note}</div>}</td>
                <td className="code">{r.ref ?? '—'}</td>
                {tab === 'api' ? <>
                  <td className="r">{r.total == null ? '不限' : qty(r.total, r.unit)}</td><td className="r">{qty(r.allocated, r.unit)}<div className="sub2">{r.holders} 人</div></td>
                  <td className={`r ${r.total != null && num(r.used) >= num(r.total) * 0.8 ? 'neg' : ''}`}>{qty(r.used, r.unit)}</td>
                  <td className="r">{r.balance != null ? <>{money(r.balance)}{r.currency ? ` ${r.currency}` : ''}<div className="sub2">{day(r.balance_on)}</div></> : '—'}</td>
                  <td className="r">{num(r.asked) > 0 ? qty(r.asked, r.unit) : '—'}</td>
                  <td>{r.has_secret ? <div className="acts"><span className="code">{r.secret_hint ?? '已保存'}</span><button className="sm ghost" onClick={() => setKey({ kind: 'resource', id: r.id, name: r.name })}>查看</button></div> : <span className="sub2">未保存</span>}</td>
                </> : <>
                  <td className="r">{r.total == null ? '单件' : qty(r.total, r.unit)}</td><td className="r">{r.total == null ? (r.holders ? '在用' : '在库') : qty(r.allocated, r.unit)}</td>
                  <td className={`r ${left != null && left <= 0 ? 'neg' : ''}`}>{left == null ? '—' : qty(left, r.unit)}</td><td className="r">{r.unit_price != null ? money(r.unit_price) : '—'}</td>
                  <td className="wrap">{r.location ?? '—'}{r.bundle && <div className="sub2">随附 {r.bundle}</div>}</td><td className="r">{num(r.asked) > 0 ? qty(r.asked, r.unit) : '—'}</td>
                </>}
                <td><div className="acts">{r.active && <button className="sm ghost" onClick={() => setAct(giveAct(r))}>分配</button>}
                  {r.active && (r.kind === 'api' || r.total != null) && <button className="sm ghost" onClick={() => setAct(stockAct(r))}>{r.kind === 'api' ? '充值' : '入库'}</button>}
                  {r.kind === 'api' && <button className="sm ghost" onClick={() => setAct(keyAct('resource', r.id, r.name, r.has_secret))}>{r.has_secret ? '换密钥' : '存密钥'}</button>}
                  <button className="sm ghost" onClick={() => setAct(resAct(r))}>修改</button></div></td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>{tab === 'api' ? '额度台账' : '领用台账'} <span className="h3sub">谁名下有什么</span></h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!past} onClick={() => setPast(false)}>在用 {data.allocs.filter((a) => a.kind === tab && a.current).length}</button>
          <button className="sm" aria-pressed={past} onClick={() => setPast(true)}>全部 {data.allocs.filter((a) => a.kind === tab).length}</button>
        </div>
        {allocs.length === 0 ? <Empty>没有记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>{tab === 'api' ? '接口' : '资产'}</th><th>使用人</th><th className="r">{tab === 'api' ? '额度' : '数量'}</th>{tab === 'api' ? <><th className="r">已用</th><th className="r">剩余</th></> : <><th>编号</th><th>存放</th></>}
              <th>起始</th><th>到期</th>{tab === 'api' && <th>密钥</th>}<th>状态</th><th /></tr></thead>
            <tbody>{allocs.map((a) => { const rest = a.quota != null && a.used != null ? num(a.quota) - num(a.used) : null; return (
              <tr key={a.id}><td>{a.resource_name}{a.note && <div className="sub2">{a.note}</div>}</td><td>{a.user_name}{a.request_id && <div className="sub2">经申请</div>}</td><td className="r">{qty(a.quota, a.unit)}</td>
                {tab === 'api' ? <><td className="r">{a.used == null ? '未回写' : qty(a.used, a.unit)}{a.used_on && <div className="sub2">截至 {day(a.used_on)}</div>}</td>
                  <td className={`r ${rest != null && rest <= num(a.quota) * 0.1 ? 'neg' : ''}`}>{rest == null ? '—' : qty(rest, a.unit)}</td></>
                  : <><td>{a.asset_no ?? '—'}</td><td className="wrap">{a.location ?? '—'}</td></>}
                <td>{day(a.from_date)}</td><td>{a.to_date ? day(a.to_date) : '长期'}</td>
                {tab === 'api' && <td>{a.has_secret ? <span className="code">{a.secret_hint ?? '已保存'}</span> : <span className="sub2">{a.returned_on ? '—' : '未发放'}</span>}</td>}
                <td>{a.returned_on ? <Badge>{day(a.returned_on)} 收回</Badge> : a.current ? <Badge tone="ok">在用</Badge> : <Badge tone="warn">已到期</Badge>}</td>
                <td><div className="acts">{!a.returned_on && <>
                  <button className="sm ghost" onClick={() => setAct(useAct(a))}>{tab === 'api' ? '回写用量' : '编号存放'}</button>
                  {tab === 'api' && <button className="sm ghost" onClick={() => setAct(keyAct('allocation', a.id, `${a.user_name} · ${a.resource_name}`, a.has_secret))}>{a.has_secret ? '换密钥' : '发密钥'}</button>}
                  <button className="sm ghost danger" onClick={() => setAct({ label: '收回', title: `收回：${a.user_name} · ${a.resource_name}`, danger: true,
                    hint: `使用权到收回日为止${tab === 'api' ? '，发给这位持有人的密钥同时从中台删除。服务商那边的密钥要另外停用或轮换。' : '，成批的库存相应加回。'}`,
                    fields: [{ name: 'returned_on', label: '收回日', type: 'date', value: today() }], run: (v) => rpc('return_allocation', { id: a.id, returned_on: v.returned_on }) })}>收回</button></>}</div></td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>{tab === 'api' ? '充值记录' : '入库记录'}</h3>
        {stock.length === 0 ? <Empty>还没有{tab === 'api' ? '充值' : '入库'}记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>资源</th><th className="r">数量</th><th className="r">{tab === 'api' ? '实付' : '单价'}</th><th>对应支出申请</th><th>供应商</th><th>备注</th><th>经办</th></tr></thead>
            <tbody>{stock.map((s) => (
              <tr key={s.id}><td>{day(s.received_on)}</td><td>{s.resource_name}</td><td className="r">{qty(s.qty, s.unit)}</td><td className="r">{s.unit_price != null ? money(s.unit_price) : '—'}</td>
                <td className="wrap">{s.expense_request_id ? reqTitle.get(s.expense_request_id) ?? '已关联' : '—'}</td><td>{s.supplier ?? '—'}</td><td className="wrap">{s.note ?? '—'}</td><td>{s.created_by_name ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {tab === 'api' && (
        <section className="card">
          <h3>密钥取用记录 <span className="h3sub">最近 {Math.min(50, data.access.length)} 次</span></h3>
          {data.access.length === 0 ? <Empty>还没有人取用过密钥。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>时间</th><th>取用人</th><th>接口</th><th>密钥属于</th></tr></thead>
              <tbody>{[...data.access].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50).map((s) => (
                <tr key={s.id}><td>{s.at.slice(0, 16).replace('T', ' ')}</td><td>{s.user_name}</td><td>{s.resource_name}</td><td>{s.owner_kind === 'resource' ? '整个账号' : s.holder_name ?? '—'}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}
      {key && <SecretDialog kind={key.kind} id={key.id} title={`密钥：${key.name}`} onClose={() => { setKey(null); reload(); }} />}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
