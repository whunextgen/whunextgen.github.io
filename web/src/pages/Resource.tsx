import { useEffect, useRef, useState } from 'react';
import { rpc, secretGet, secretSet, useViews, type Allocation, type Me, type Req, type Resource, type ResourcePick, type ResourcePlan, type ResourceRequest, type ResourceStock, type YearCheck, type ResReqStatus,
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
      <p className="hint">密钥加密保存于中台，仅持有人和财务岗可取用，每次取用均记录在案。不得转发他人或写入代码仓库；归还或到期后，该密钥自本人名下撤销。</p>
      {plain ? <p className="secret"><code>{plain}</code></p> : <p className="empty">尚未显示。</p>}
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
  hint: `密钥经服务端加密后保存，页面仅显示掩码。${kind === 'resource' ? '此为账号共用密钥，仅财务岗可取用；发放给个人的密钥请在额度台账中单独保存。' : '此为发放给该持有人的密钥，持有人可在「资源申领」中自行取用，收回时自动删除。'}${has ? '留空保存即删除现有密钥。' : ''}`,
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
    [p.id, `${p.project_code} ${p.purpose} · ${p.resource_name}，计划 ${qty(p.plan_qty, p.unit)}，剩余 ${qty(rest(p), p.unit)}`]);
  const none = (kind: 'api' | 'asset') => (lineOpts(kind).length ? '' : `本年度预算中暂无${KIND[kind]}的资源计划，暂不能提交申请。如需使用，请项目负责人在年度预算中补充；年中追加的，由财务岗在复盘时调整。`);
  const reqAct = (kind: 'api' | 'asset'): Act => kind === 'api' ? {
    label: '提交申请', title: '申请接口额度',
    hint: `资源均由年度预算列支：选择一条已编制资源计划的预算行，累计申请不得超过计划数量。先由项目负责人批示，再由财务岗批准并分发；本人负责的项目直接提交财务岗。申请中不得填写任何密钥。${none(kind)}`,
    fields: [{ name: 'line_id', label: '支出预算行', options: lineOpts(kind) },
      { name: 'amount', label: '额度', type: 'number' }, { name: 'period', label: '使用月份', type: 'month', value: today().slice(0, 7) },
      { name: 'purpose', label: '用途' }, { name: 'usage_note', label: '用量估算（模型、调用量；加急申请必填）', required: false },
      { name: 'urgent', label: '加急', type: 'check', value: 'false' }],
    run: (v) => rpc('save_resource_request', { id: null, kind, resource_id: null, line_id: v.line_id, amount: v.amount, period: `${v.period}-01`,
      purpose: v.purpose, usage_note: v.usage_note, urgent: v.urgent === 'true' }),
  } : {
    label: '提交申请', title: '申领资产',
    hint: `设备和耗材同样由年度预算列支：选择一条已编制资源计划的预算行，累计申领不得超过计划数量。项目内设备由项目负责人批示；公共设备仅面向博士后、博士、硕士和研究助理，直接提交财务岗。库存不足时也可先行提交，财务岗按预算办理采购，到货入库后分发。${none(kind)}`,
    fields: [{ name: 'line_id', label: '支出预算行', options: lineOpts(kind) }, { name: 'amount', label: '数量', type: 'number', value: '1' },
      { name: 'purpose', label: '用途' }, { name: 'usage_note', label: '补充说明（加急申请必填）', required: false },
      { name: 'urgent', label: '加急', type: 'check', value: 'false' }],
    run: (v) => rpc('save_resource_request', { id: null, kind, resource_id: null, line_id: v.line_id, amount: v.amount, period: null,
      purpose: v.purpose, usage_note: v.usage_note, urgent: v.urgent === 'true' }),
  };
  const decide = (r: ResourceRequest, action: 'review' | 'reject' | 'withdraw'): Act => ({
    label: { review: '同意', reject: '驳回', withdraw: '撤回' }[action], danger: action !== 'review',
    title: `${{ review: '同意', reject: '驳回', withdraw: '撤回' }[action]}：${r.requester_name} 申请 ${r.resource_name ?? KIND[r.kind]} ${qty(r.amount, r.unit)}`,
    hint: action === 'review' ? '同意后转财务岗批准并分发。' : action === 'withdraw' ? '撤回后该申请作废，如有需要可重新提交。' : undefined,
    fields: action === 'withdraw' ? [] : [{ name: 'note', label: action === 'reject' ? '驳回原因' : '意见（选填）', required: action === 'reject' }],
    run: (v) => rpc('decide_resource_request', { id: r.id, action, amount: null, note: v.note ?? null }),
  });

  return (
    <>
      <div className="top"><h2>资源申领</h2>
        <div className="acts"><button onClick={() => setAct(reqAct('api'))}>申请接口额度</button><button className="ghost" onClick={() => setAct(reqAct('asset'))}>申领资产</button></div></div>
      <div className="tiles">
        <Tile k="名下接口" v={mine.filter((a) => a.kind === 'api').length} f="正在生效的额度" />
        <Tile k="名下资产" v={mine.filter((a) => a.kind === 'asset').length} f="本人名下的设备和耗材" />
        <Tile k="在途申请" v={myReqs.filter((r) => ['pending', 'reviewed', 'approved'].includes(r.status)).length} f="已提交、尚未分发" />
        <Tile k="即将到期" v={mine.filter((a) => soon(a.to_date)).length} f="一个月内到期" tone={mine.some((a) => soon(a.to_date)) ? 'warn' : ''} />
      </div>

      {toReview.length > 0 && (
        <section className="card wide">
          <h3>待批示 <span className="h3sub">本人负责项目的成员资源申请</span></h3>
          <div className="scroll"><table>
            <thead><tr><th>提交日期</th><th>申请人</th><th>项目 · 预算行</th><th>资源</th><th className="r">数量</th><th>使用月份</th><th>用途</th><th /></tr></thead>
            <tbody>{toReview.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{r.requester_name}{r.urgent && <> <Badge tone="bad">加急</Badge></>}{r.priority && <> <Badge tone="ok">优先</Badge><div className="sub2">出资项目成员</div></>}</td><td>{r.project_code} {r.project_name}<div className="sub2">{r.line_purpose}，计划 {qty(r.plan_qty, r.unit)}</div></td>
                <td>{r.resource_name ?? `${KIND[r.kind]}（未指定）`}</td><td className="r">{qty(r.amount, r.unit)}</td><td>{r.period ? r.period.slice(0, 7) : '—'}</td>
                <td className="wrap">{r.purpose}{r.usage_note && <div className="sub2">{r.usage_note}</div>}</td>
                <td><div className="acts"><button className="sm" onClick={() => setAct(decide(r, 'review'))}>同意</button>
                  <button className="sm ghost danger" onClick={() => setAct(decide(r, 'reject'))}>驳回</button></div></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      <section className="card wide">
        <h3>项目预算资源计划 <span className="h3sub">由项目负责人批示</span></h3>
        <p className="hint">接口额度、设备均编入各项目年度预算：项目负责人申报时在预算行上注明所需资源及全年数量，预算下达后项目成员按计划申请，由项目负责人批示。此处仅显示数量，不显示金额。</p>
        {own.length === 0 ? <Empty>本年度已下达预算中暂无资源计划。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>项目</th><th>预算行</th><th>资源</th><th className="r">全年计划</th><th className="r">已分发</th><th className="r">在途</th><th className="r">可申请</th></tr></thead>
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
        <p className="hint">中心公共资源仅此一类，编入中心公共开支预算，申领后直接提交财务岗。
          {eligible ? `本人登记身份为${PERSON[me.kind!]}，可申领。` : me.kind ? `本人登记身份为${PERSON[me.kind]}，不在申领范围内，如需设备请在所在项目预算中申请。` : '本人身份尚未登记，请财务岗登记后再申领。'}</p>
        {pub.length === 0 ? <Empty>本年度中心公共开支中暂无设备计划。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>预算行</th><th>设备</th><th className="r">全年计划</th><th className="r">已分发</th><th className="r">在途</th><th className="r">可申领</th></tr></thead>
            <tbody>{pub.map((p) => (
              <tr key={p.id}><td className="wrap">{p.purpose}<div className="sub2">{p.category_name}</div></td><td>{p.resource_name}</td>
                <td className="r">{qty(p.plan_qty, p.unit)}</td><td className="r">{qty(p.granted, p.unit)}</td>
                <td className="r">{num(p.asked) > 0 ? qty(p.asked, p.unit) : '—'}</td><td className={`r ${rest(p) <= 0 ? 'neg' : ''}`}>{rest(p) > 0 ? qty(rest(p), p.unit) : '已用完'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>本人名下资源</h3>
        <p className="hint">接口密钥加密保存于中台：财务岗分发后，可在此自行取用，每次取用均有记录；额度到期或收回后密钥随之撤销。用量由财务岗按服务商账单回写。</p>
        {mine.length === 0 ? <Empty>名下暂无资源。如需接口额度或设备，请按上方资源计划提交申请。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>资源</th><th>类型</th><th className="r">额度 / 数量</th><th className="r">已用</th><th>编号 · 存放</th><th>起始</th><th>到期</th><th>密钥</th></tr></thead>
            <tbody>{mine.map((a) => { const over = a.quota != null && a.used != null && num(a.used) >= num(a.quota) * 0.9; return (
              <tr key={a.id}><td>{a.resource_name}{spec(a) && <div className="sub2">{spec(a)}</div>}{a.note && <div className="sub2">{a.note}</div>}</td><td>{KIND[a.kind]}</td>
                <td className="r">{qty(a.quota, a.unit)}</td>
                <td className={`r ${over ? 'neg' : ''}`}>{a.kind === 'asset' ? '—' : a.used == null ? '未回写' : qty(a.used, a.unit)}{a.used_on && <div className="sub2">截至 {day(a.used_on)}</div>}</td>
                <td>{a.kind === 'asset' ? <>{a.asset_no ?? '—'}{a.location && <div className="sub2">{a.location}</div>}</> : <span className="code">{a.ref ?? '—'}</span>}</td>
                <td>{day(a.from_date)}</td><td>{a.to_date ? <>{day(a.to_date)}{soon(a.to_date) && <> <Badge tone="warn">即将到期</Badge></>}</> : '长期'}</td>
                <td>{a.has_secret ? <div className="acts"><span className="code">{a.secret_hint ?? '已保存'}</span><button className="sm ghost" onClick={() => setKey(a)}>查看</button></div>
                  : a.kind === 'api' ? <span className="sub2">尚未发放</span> : '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>本人申请</h3>
        {myReqs.length === 0 ? <Empty>暂无资源申请。</Empty> : (
          <div className="scroll"><table className="tight">
            <thead><tr><th>提交日期</th><th>类型</th><th>资源</th><th>项目 · 预算行</th><th className="r">申请</th><th className="r">批准</th><th>使用月份</th><th>用途</th><th>状态</th><th /></tr></thead>
            <tbody>{myReqs.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{KIND[r.kind]}{r.urgent && <> <Badge tone="bad">加急</Badge></>}</td><td>{r.resource_name ?? '未指定'}</td>
                <td className="wrap">{r.project_code} {r.project_name}<div className="sub2">{r.line_purpose}</div></td><td className="r">{qty(r.amount, r.unit)}</td>
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
  // 出钱买这台设备的项目的成员排在前面
  const shown = [...(all ? data.reqs : open)].sort((a, b) => Number(b.urgent) - Number(a.urgent) || Number(b.priority) - Number(a.priority) || a.created_at.localeCompare(b.created_at));
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
    hint: `${r.purpose}${r.usage_note ? `。${r.usage_note}` : ''}。批准数量可少于申请数量，核减的须注明原因。${r.status === 'pending' ? '该申请尚未经项目负责人批示，由中心负责人直接批准。' : ''}`,
    fields: [{ name: 'amount', label: `批准数量${r.unit ? `（${r.unit}）` : ''}`, type: 'number', value: String(num(r.amount)) }, { name: 'note', label: '意见（选填）', required: false }],
    run: (v) => rpc('decide_resource_request', { id: r.id, action: 'approve', amount: v.amount, note: v.note }),
  });
  const reject = (r: ResourceRequest): Act => ({
    label: '驳回', danger: true, title: `驳回：${r.requester_name} 申请 ${r.resource_name ?? KIND[r.kind]} ${qty(r.amount, r.unit)}`,
    fields: [{ name: 'note', label: '驳回原因' }], run: (v) => rpc('decide_resource_request', { id: r.id, action: 'reject', amount: null, note: v.note }),
  });
  const fulfil = (r: ResourceRequest): Act => ({
    label: '分发', title: `分发：${r.requester_name}，${qty(r.approved_amount ?? r.amount, r.unit)}`,
    hint: '分发后生成一条分配记录，记入申请人名下。发放给个人的密钥在「资产盘点」的额度台账中保存。',
    fields: [...(r.resource_id ? [] : [{ name: 'resource_id', label: '分发资源', options: options(r.kind) } as Field]),
      { name: 'to_date', label: r.kind === 'api' ? '到期日（默认为申请月份的月底）' : '归还日（长期使用的留空）', type: 'date', required: false, value: r.period ? monthEnd(r.period) : '' }, { name: 'note', label: '备注（选填）', required: false }],
    run: (v) => rpc('fulfil_resource_request', { id: r.id, resource_id: r.resource_id ?? v.resource_id, to_date: v.to_date, note: v.note }),
  });

  return (
    <>
      <div className="top"><h2>资源调配</h2></div>
      <div className="tiles">
        <Tile k="待项目负责人批示" v={n('pending')} f="每笔均对应预算行，先经项目负责人批示" />
        <Tile k="待批准" v={n('reviewed')} f="财务岗或中心负责人批准" tone={n('reviewed') ? 'warn' : ''} />
        <Tile k="待分发" v={n('approved')} f="已批准、尚未分发" tone={n('approved') ? 'warn' : ''} />
        <Tile k="建议采购" v={money(cost)} f="缺口按单价折算，由对应预算行列支" />
      </div>

      <section className="card wide">
        <h3>需求池 <span className="h3sub">预算计划和在途申请按资源汇总</span></h3>
        <p className="hint">全年计划为本年度各预算行资源计划的合计，申请不得超过该数。采购量按在途需求 × 120% 备货，扣除现有剩余即为建议采购量；采购经费通过支出申请办理，对应同一预算行，批准并到货后方可在「资产盘点」入库。</p>
        {pool.length === 0 ? <Empty>本年度预算中暂无资源计划，也无在途资源需求。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>资源</th><th>类型</th><th className="r">全年计划</th><th className="r">已分发</th><th className="r">在途需求</th><th className="r">按 120% 备货</th><th className="r">现有剩余</th><th className="r">建议采购</th><th className="r">单价</th><th className="r">折合（元）</th></tr></thead>
            <tbody>{pool.map(({ r, left, plan, buy }) => (
              <tr key={r.id}><td>{r.name}{spec(r) && <div className="sub2">{spec(r)}</div>}</td><td>{KIND[r.kind]}</td><td className="r">{planned(r.id, 'plan_qty') > 0 ? qty(planned(r.id, 'plan_qty'), r.unit) : '—'}</td><td className="r">{qty(planned(r.id, 'granted'), r.unit)}</td>
                <td className="r">{num(r.asked) > 0 ? qty(r.asked, r.unit) : '—'}</td><td className="r">{num(r.asked) > 0 ? qty(plan, r.unit) : '—'}</td>
                <td className="r">{left == null ? '不限量' : qty(left, r.unit)}</td><td className={`r ${buy > 0 ? 'neg' : ''}`}>{left == null ? '—' : buy > 0 ? qty(buy, r.unit) : '充足'}</td>
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
        {shown.length === 0 ? <Empty>暂无资源申请。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>提交日期</th><th>申请人</th><th>项目 · 预算行</th><th>资源</th><th className="r">申请</th><th className="r">批准</th><th>使用月份</th><th>用途</th><th>状态</th><th /></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}><td>{day(r.created_at)}</td><td>{r.requester_name}{r.urgent && <> <Badge tone="bad">加急</Badge></>}{r.priority && <> <Badge tone="ok">优先</Badge><div className="sub2">出资项目成员</div></>}</td>
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
  const { data, error, reload } = useViews<{ resources: Resource[]; allocs: Allocation[]; users: User[]; stock: ResourceStock[]; access: SecretAccess[]; reqs: Req[]; checks: YearCheck[] }>({
    resources: ['resource'], allocs: ['allocation'], users: ['users'], stock: ['resource_stock'], access: ['secret_access'], reqs: ['request'], checks: ['year_check'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [key, setKey] = useState<{ kind: 'resource' | 'allocation'; id: string; name: string } | null>(null);
  const [tab, setTab] = useState<'api' | 'asset'>('api');
  const [past, setPast] = useState(false);
  const [yr, setYr] = useState(0);
  if (!data) return <Loading error={error} />;

  const checkYears = [...new Set(data.checks.map((k) => k.year))].sort((a, b) => b - a);
  const checkYear = checkYears.includes(yr) ? yr : checkYears[0];
  const checks = data.checks.filter((k) => k.year === checkYear && k.kind === tab).sort((a, b) => a.resource_name.localeCompare(b.resource_name, 'zh'));
  const checkAct = (k: YearCheck): Act => ({
    label: '保存', title: `${k.year} 年末盘点：${k.resource_name}`,
    hint: `当前账面为 ${qty(k.book_now, k.unit)}。${k.kind === 'api' ? '实盘填写服务商账户的实际余额。' : '实盘填写实际清点数量。'}实盘与账面不一致的须注明原因。`,
    fields: [{ name: 'actual', label: `实盘${k.unit ? `（${k.unit}）` : ''}`, type: 'number', value: k.actual != null ? String(num(k.actual)) : String(num(k.book_now)) }, { name: 'note', label: '说明（有差异时必填）', required: false, value: k.note ?? '' }],
    run: (v) => rpc('save_year_check', { year: k.year, resource_id: k.resource_id, actual: v.actual, note: v.note || null }),
  });
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
    hint: kind === 'api' ? '总配额填写该账号可分配的总量（例如 元/月）；余额为服务商账户的剩余金额，对账时更新。密钥请勿填写于此，登记后在列表中单独保存。'
      : '单件资产（一台设备）不填库存，同一时间仅可登记在一人名下；成批资产（同一型号多件、耗材）填写库存数量，按件申领。',
    fields: [{ name: 'name', label: '名称', value: r?.name },
      ...(kind === 'api' ? [{ name: 'provider', label: '服务商（选填）', required: false, value: r?.provider ?? '' }, { name: 'model', label: '模型或套餐（选填）', required: false, value: r?.model ?? '' },
        { name: 'ref', label: '账号（选填，请勿填写密钥）', required: false, value: r?.ref ?? '' },
        { name: 'total', label: '总配额（不限量的留空）', type: 'number', required: false, value: r?.total != null ? String(num(r.total)) : '' },
        { name: 'unit', label: '单位（例如 元/月）', required: false, value: r?.unit ?? '' }, { name: 'currency', label: '币种（选填）', required: false, value: r?.currency ?? '' },
        { name: 'balance', label: '服务商账户余额（选填）', type: 'number', required: false, value: r?.balance != null ? String(num(r.balance)) : '' }] as Field[]
      : [{ name: 'category', label: '类别（例如 显卡、显示器、耗材）', required: false, value: r?.category ?? '' }, { name: 'spec', label: '规格型号（选填）', required: false, value: r?.spec ?? '' },
        { name: 'ref', label: '资产编号（成批资产可留空）', required: false, value: r?.ref ?? '' },
        { name: 'total', label: '库存数量（单件资产留空）', type: 'number', required: false, value: r?.total != null ? String(num(r.total)) : '' },
        { name: 'unit', label: '单位（例如 台、个）', required: false, value: r?.unit ?? '' }, { name: 'unit_price', label: '单价（元，选填）', type: 'number', required: false, value: r?.unit_price != null ? String(num(r.unit_price)) : '' },
        { name: 'bundle', label: '随附配件（选填）', required: false, value: r?.bundle ?? '' }, { name: 'location', label: '存放地点（选填）', required: false, value: r?.location ?? '' }] as Field[]),
      { name: 'note', label: '备注（选填）', required: false, value: r?.note ?? '' },
      ...(r ? [{ name: 'active', label: '在用（取消勾选即停用，不可再申请和分配）', type: 'check', value: String(r.active) } as Field] : [])],
    run: async (v) => { const id = await rpc('save_resource', { id: r?.id ?? null, kind, name: v.name, ref: v.ref, total: v.total, unit: v.unit, note: v.note, active: r ? v.active === 'true' : true });
      await rpc('set_resource_info', { id: r?.id ?? id, info: info(r, v, kind) }); },
  }; };
  const giveAct = (r: Resource): Act => ({
    label: '分配', title: `直接分配：${r.name}`,
    hint: `不经申请直接记入指定人员名下，用于补记和续期。${r.total != null ? `${r.kind === 'asset' ? '库存' : '总配额'} ${qty(r.total, r.unit)}，已分配 ${qty(r.allocated, r.unit)}。` : r.kind === 'asset' ? '单件资产同一时间仅可登记在一人名下，变更使用人前须先收回。' : ''}`,
    fields: [{ name: 'user_id', label: '使用人', options: users },
      ...(r.kind === 'api' ? [{ name: 'quota', label: `额度${r.unit ? `（${r.unit}）` : ''}`, type: 'number', required: r.total != null } as Field]
        : r.total != null ? [{ name: 'quota', label: `数量${r.unit ? `（${r.unit}）` : ''}`, type: 'number', value: '1' } as Field] : []),
      { name: 'from_date', label: '起始日', type: 'date', value: today() }, { name: 'to_date', label: '到期日（长期使用的留空）', type: 'date', required: false },
      { name: 'note', label: '用途（选填）', required: false }],
    run: (v) => rpc('allocate_resource', { resource_id: r.id, user_id: v.user_id, quota: v.quota ?? null, from_date: v.from_date, to_date: v.to_date, note: v.note }),
  });
  const bought = data.reqs.filter((q) => ['committed', 'at_school', 'posted'].includes(q.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 80)
    .map((q): [string, string] => [q.id, `${day(q.created_at)} ${q.title} ${money(q.amount)}`]);
  const stockAct = (r: Resource): Act => ({
    label: r.kind === 'api' ? '充值' : '入库', title: `${r.kind === 'api' ? '充值' : '验收入库'}：${r.name}`,
    hint: `${r.kind === 'api' ? '充值后总配额和服务商账户余额同时增加。' : '验收后库存增加。'}采购须先经预算：该笔款项须先在支出申请中由预算行提出并获批准，在此选定对应的支出申请后方可${r.kind === 'api' ? '充值' : '入库'}。`,
    fields: [{ name: 'request_id', label: '对应支出申请（已批准）', options: bought },
      { name: 'qty', label: `${r.kind === 'api' ? '充值额度' : '数量'}${r.unit ? `（${r.unit}）` : ''}`, type: 'number' },
      { name: 'unit_price', label: r.kind === 'api' ? '实付金额（元，选填）' : '单价（元，选填）', type: 'number', required: false, value: r.kind === 'asset' && r.unit_price != null ? String(num(r.unit_price)) : '' },
      { name: 'received_on', label: r.kind === 'api' ? '充值日' : '验收日', type: 'date', value: today() }, { name: 'supplier', label: '供应商（选填）', required: false },
      { name: 'note', label: '备注（选填）', required: false }],
    run: (v) => rpc('stock_in', { resource_id: r.id, qty: v.qty, unit_price: v.unit_price, received_on: v.received_on, supplier: v.supplier, note: v.note, request_id: v.request_id }),
  });
  const useAct = (a: Allocation): Act => a.kind === 'api' ? {
    label: '回写', title: `回写用量：${a.user_name} · ${a.resource_name}`, hint: `按服务商账单填写截至指定日期的累计用量。额度 ${qty(a.quota, a.unit)}。`,
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
      <div className="top"><h2>资产盘点</h2><button onClick={() => setAct(resAct())}>登记{KIND[tab]}</button></div>
      <div className="tiles">
        <Tile k="接口账号" v={apis.length} f={`${apis.filter((r) => r.has_secret).length} 个已保存密钥`} />
        <Tile k="资产" v={assets.length} f={`${assets.filter((r) => r.total == null).length} 件单件，${assets.filter((r) => r.total != null).length} 种成批`} />
        <Tile k="在用分配" v={data.allocs.filter((a) => a.current).length} f={`${new Set(data.allocs.filter((a) => a.current).map((a) => a.user_id)).size} 人名下`} />
        <Tile k="需补货" v={low} f="接口用量达八成，或库存已发完" tone={low ? 'bad' : ''} />
      </div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button aria-pressed={tab === 'api'} onClick={() => setTab('api')}>接口额度</button>
        <button aria-pressed={tab === 'asset'} onClick={() => setTab('asset')}>资产与库存</button>
      </div>

      <section className="card wide">
        <h3>{tab === 'api' ? '接口账号' : '资产与库存'}</h3>
        {list.length === 0 ? <Empty>暂无已登记的{KIND[tab]}。</Empty> : (
          <div className="scroll"><table>
            {tab === 'api'
              ? <thead><tr><th>名称</th><th>账号</th><th className="r">总配额</th><th className="r">已分配</th><th className="r">已用</th><th className="r">服务商余额</th><th className="r">在途需求</th><th>密钥</th><th /></tr></thead>
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
                  {r.kind === 'api' && <button className="sm ghost" onClick={() => setAct(keyAct('resource', r.id, r.name, r.has_secret))}>{r.has_secret ? '更换密钥' : '保存密钥'}</button>}
                  <button className="sm ghost" onClick={() => setAct(resAct(r))}>修改</button></div></td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card wide">
        <h3>{tab === 'api' ? '额度台账' : '领用台账'} <span className="h3sub">各人名下资源</span></h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!past} onClick={() => setPast(false)}>在用 {data.allocs.filter((a) => a.kind === tab && a.current).length}</button>
          <button className="sm" aria-pressed={past} onClick={() => setPast(true)}>全部 {data.allocs.filter((a) => a.kind === tab).length}</button>
        </div>
        {allocs.length === 0 ? <Empty>暂无记录。</Empty> : (
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
                  {tab === 'api' && <button className="sm ghost" onClick={() => setAct(keyAct('allocation', a.id, `${a.user_name} · ${a.resource_name}`, a.has_secret))}>{a.has_secret ? '更换密钥' : '发放密钥'}</button>}
                  <button className="sm ghost danger" onClick={() => setAct({ label: '收回', title: `收回：${a.user_name} · ${a.resource_name}`, danger: true,
                    hint: `使用权至收回日终止${tab === 'api' ? '，发放给该持有人的密钥同时从中台删除。服务商侧的密钥须另行停用或轮换。' : '，成批资产的库存相应恢复。'}`,
                    fields: [{ name: 'returned_on', label: '收回日', type: 'date', value: today() }], run: (v) => rpc('return_allocation', { id: a.id, returned_on: v.returned_on }) })}>收回</button></>}</div></td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>{tab === 'api' ? '充值记录' : '入库记录'}</h3>
        {stock.length === 0 ? <Empty>暂无{tab === 'api' ? '充值' : '入库'}记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>资源</th><th className="r">数量</th><th className="r">{tab === 'api' ? '实付' : '单价'}</th><th>出资项目</th><th>对应支出申请</th><th>供应商</th><th>备注</th><th>经办</th></tr></thead>
            <tbody>{stock.map((s) => (
              <tr key={s.id}><td>{day(s.received_on)}</td><td>{s.resource_name}</td><td className="r">{qty(s.qty, s.unit)}</td><td className="r">{s.unit_price != null ? money(s.unit_price) : '—'}</td>
                <td className="wrap">{s.project_name ?? '—'}{s.line_purpose && <div className="sub2">{s.line_purpose}</div>}</td>
                <td className="wrap">{s.expense_request_id ? reqTitle.get(s.expense_request_id) ?? '已关联' : '—'}</td><td>{s.supplier ?? '—'}</td><td className="wrap">{s.note ?? '—'}</td><td>{s.created_by_name ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {checkYear != null && (
        <section className="card">
          <h3>年末盘点 <span className="h3sub">{checkYear} 年度 · {tab === 'api' ? '接口账户余额' : '设备和库存数量'}</span></h3>
          <p className="hint">年度决算前须核对账面与实际：{tab === 'api' ? '接口核对服务商账户的实际余额' : '设备和库存核对实际清点数量'}。购置的设备属中心公共设备，不分项目，统一在此盘点。实盘与账面不一致的须注明原因；年度决算后盘点结果不可修改。</p>
          {checkYears.length > 1 && <div className="tabs" style={{ marginBottom: 12 }}>{checkYears.map((n) => <button key={n} className="sm" aria-pressed={n === checkYear} onClick={() => setYr(n)}>{n}</button>)}</div>}
          {checks.length === 0 ? <Empty>暂无需盘点的{KIND[tab]}。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>{tab === 'api' ? '接口' : '资产'}</th><th className="r">账面</th><th className="r">实盘</th><th className="r">差异</th><th>说明</th><th>盘点</th><th /></tr></thead>
              <tbody>{checks.map((k) => (
                <tr key={k.resource_id}><td>{k.resource_name}</td><td className="r">{qty(k.book ?? k.book_now, k.unit)}</td><td className="r">{k.actual != null ? qty(k.actual, k.unit) : '—'}</td>
                  <td className={`r ${num(k.diff) !== 0 ? 'neg' : ''}`}>{k.actual == null ? '—' : num(k.diff) === 0 ? '一致' : qty(k.diff, k.unit)}</td>
                  <td className="wrap">{k.note ?? '—'}</td><td>{k.checked_at ? <>{k.checked_by_name ?? ''}<span className="sub2">{day(k.checked_at)}</span></> : <Badge tone="warn">尚未盘点</Badge>}</td>
                  <td className="r"><button className="sm ghost" onClick={() => setAct(checkAct(k))}>{k.checked_at ? '重新盘点' : '盘点'}</button></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      {tab === 'api' && (
        <section className="card">
          <h3>密钥取用记录 <span className="h3sub">最近 {Math.min(50, data.access.length)} 次</span></h3>
          {data.access.length === 0 ? <Empty>暂无密钥取用记录。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>时间</th><th>取用人</th><th>接口</th><th>密钥归属</th></tr></thead>
              <tbody>{[...data.access].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50).map((s) => (
                <tr key={s.id}><td>{s.at.slice(0, 16).replace('T', ' ')}</td><td>{s.user_name}</td><td>{s.resource_name}</td><td>{s.owner_kind === 'resource' ? '账号共用' : s.holder_name ?? '—'}</td></tr>
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
