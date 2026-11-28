import { useState } from 'react';
import { rpc, useViews, type ApiQuarter, type BudgetCoinExchange, type CoinFlow, type CoinNow, type CoinQuarter, type Me, type Project, type UnitApiKey, type UnitKeyAccess } from './api';
import { ActionDialog, Badge, Empty, Loading, Tile, can, day, money, num, type Field } from './ui';
import { SecretDialog } from './pages/Resource';

// 代币：只用名义币、实际币两个叫法。名义币来自回应质疑，进入研究单元的池子；实际币代表资源使用权。
// 代币不另设页面，加在已有的对象上：首页的我的事项、研究单元页、档次表、预算参数。
export interface TokenMe { user_id: string; kind: string | null; nominal: string | null; period_start: string; period_end: string; prev_open: boolean }
export interface TimeLog { id: string; period_start: string; user_id: string; user_name: string; user_kind: string | null; project_id: string; percent: number; coins: string;
  confirmed: boolean; confirmed_by_name: string | null; lapsed: boolean }
export interface UnitPool { project_id: string; parent_id: string | null; pool_cap: string | null; coins: string; people: number; pending: number; level: number }
export interface UnitShare { project_id: string; user_id: string; user_name: string; user_kind: string | null; coins: string; share: string | null }
export interface Outcome { id: string; project_id: string; level: number; link: string; venue: string | null; note: string | null; submitted_by_name: string | null; submitted_at: string;
  status: 'pending' | 'checked' | 'rejected'; checked_by_name: string | null; checked_at: string | null; check_note: string | null; can_check: boolean }
export interface TokenParam { key: string; value: unknown }
export interface TierToken { tier_id: string; year: number; token_amount: string | null }

export const LEVEL = ['', '一级 · 公开发布', '二级 · 完整发布', '三级 · 外部反响', '四级 · 同行认可'];
const RK: [string, string][] = [['intern', 'Intern'], ['assistant', 'Assistant'], ['researcher', 'Researcher'], ['rising_star', 'Rising Star'], ['pi', 'PI'], ['director', 'Director']];
const LEVEL_HINT = ['', 'arXiv 预印本或公开的投稿页', '项目网页、演示视频、代码或数据或模型公开', 'HuggingFace 论文榜排名靠前，星标、下载量过线', '会议或期刊录用，口头报告、奖项'];
const coin = (v: string | number | null | undefined) => (v == null ? '—' : num(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 }));
const pctOf = (v: string | number | null | undefined) => (v == null ? '—' : `${Math.round(num(v) * 100)}%`);
export const levelBadge = (level: number) => level >= 4 ? <Badge tone="ok">已录用</Badge> : level >= 1 ? <Badge tone="ok">已解锁</Badge> : <Badge>锁定中</Badge>;
export const addDays = (d: string, n: number) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// ---------- 首页 · 我的事项：我在各研究单元池子里的份额 ----------
// 名义币不发到个人手里，也不需要本人去投：回应质疑所得直接进入研究单元的池子，记为本人的份额
// 卡时有效期按参数 hours_days（默认 56 天）显示，整周的写周数
export const hoursValid = (tp: { key: string; value: unknown }[]) => { const d = Number(tp.find((x) => x.key === 'hours_days')?.value ?? 56) || 56; return d % 7 === 0 ? `${d / 7} 周` : `${d} 天`; };

export function TokenMine({ me }: { me: Me }) {
  const { data, error } = useViews<{ projects: Project[]; shares: UnitShare[]; pools: UnitPool[] }>({ projects: ['project'], shares: ['unit_share'], pools: ['unit_pool'] });
  if (!data) return <Loading error={error} />;
  const myShares = data.shares.filter((s) => s.user_id === me.id);
  return (
    <>
      <p className="hint" style={{ margin: '0 0 10px' }}>名义币来自回应质疑：一条质疑在下一期无人再提即为已回应，记 16 名义币，由当期有分配资格的队员平分，直接进入该研究单元的名义池子，记为各人的份额。研究单元取得第一个外部成果时池子解锁，按份额铸造实际币。未回应的质疑在「<a href="#/iterate">快照与质疑</a>」。</p>
      {myShares.length === 0 ? <Empty>本人尚未在任何研究单元的池子里有份额。</Empty> : (
        <div className="scroll"><table className="wb-table">
          <thead><tr><th>研究单元</th><th>状态</th><th className="r">本人的名义币</th><th className="r">我的份额</th></tr></thead>
          <tbody>{myShares.map((s) => { const u = data.projects.find((p) => p.id === s.project_id); const pool = data.pools.find((p) => p.project_id === s.project_id); return (
            <tr key={s.project_id}><td><a href={`#/project/${s.project_id}`}>{u?.name ?? '研究单元'}</a></td><td>{levelBadge(pool?.level ?? 0)}{(pool?.level ?? 0) === 0 && <span className="sub2"> 尚未取得外部成果</span>}</td>
              <td className="r">{coin(s.coins)}</td><td className="r">{pctOf(s.share)}</td></tr>); })}</tbody>
        </table></div>)}
    </>
  );
}

// ---------- 研究单元页：池子与成果 ----------
export function UnitToken({ me, unit }: { me: Me; unit: Project }) {
  const { data, error, reload } = useViews<{ tp: { key: string; value: unknown }[]; pools: UnitPool[]; shares: UnitShare[]; outs: Outcome[]; grants: { id: string; project_id: string; hours: string; coins: string; bought_by_name: string | null; bought_at: string }[];
    ucoin: { id: string; kind: 'invest' | 'compute' | 'budget' | 'api' | 'expire'; amount: string; user_name: string | null; note: string | null; created_at: string }[]; ubal: { project_id: string; balance: string; hours: string; can_buy: boolean; api_quota: string; api_unit: string | null }[]; cm: { balance: string; price: string | null }[];
    aq: ApiQuarter[]; ukey: UnitApiKey[]; kacc: UnitKeyAccess[] }>({ tp: ['token_param'],
    pools: ['unit_pool'], shares: ['unit_share'], outs: ['outcome'], grants: ['compute_grant', { project_id: unit.id }],
    ucoin: ['unit_coin', { project_id: unit.id }], ubal: ['unit_coin_balance', { project_id: unit.id }], cm: ['coin_mine'],
    aq: ['api_quarter'], ukey: ['unit_api_key', { project_id: unit.id }], kacc: ['unit_key_access', { project_id: unit.id }],
  }, unit.id);
  const [act, setAct] = useState<Act | null>(null);
  const [showKey, setShowKey] = useState(false);
  if (!data) return <Loading error={error} />;
  const pool = data.pools.find((p) => p.project_id === unit.id);
  if (!pool) return null;
  const lead = unit.mine, recorder = can(me, 'budget.evaluate'), setup = can(me, 'budget.setup');
  const outs = data.outs.filter((o) => o.project_id === unit.id).sort((a, b) => a.level - b.level);
  const shares = data.shares.filter((s) => s.project_id === unit.id).sort((a, b) => num(b.coins) - num(a.coins));
  const outAct = (level: number): Act => { const o = outs.find((x) => x.level === level); return {
    title: `提交成果：${LEVEL[level]}`, label: '提交',
    hint: `${LEVEL_HINT[level]}。只认外部可验收的成果：填写可公开访问的链接，由助理核对是否属实，不评价好坏。${o?.status === 'rejected' ? `上次被退回：${o.check_note ?? ''}` : ''}`,
    fields: [{ name: 'link', label: level === 1 ? 'arXiv 或公开投稿页的链接' : '链接', value: o?.status === 'rejected' ? o.link : '' },
      ...(level === 4 ? [{ name: 'venue', label: '录用的去向（会议或期刊）', value: o?.venue ?? '' } as Field] : []),
      { name: 'note', label: '说明（选填）', required: false, value: o?.note ?? '' }],
    run: (v) => rpc('submit_outcome', { project: unit.id, level, link: v.link, venue: v.venue || null, note: v.note || null }) }; };
  const next = [1, 2, 3, 4].filter((lv) => { const o = outs.find((x) => x.level === lv); return (!o || o.status === 'rejected') && (lv === 1 || outs.some((x) => x.level === 1 && x.status !== 'rejected')); });
  const cap = pool.pool_cap == null ? null : num(pool.pool_cap);
  return (
    <section className="card" id="sec-token">
      <h3>池子与成果 <span className="h3sub">{pool.level >= 1 ? '已解锁，铸造率挂牌后按份额铸造实际币' : '锁定中，取得第一个外部成果时解锁'}</span></h3>
      <p className="hint">回应质疑所得的名义币直接进入本研究单元的池子，记为队员各自的份额：一条质疑在下一期无人再提即为已回应，记 16 名义币，由当期有分配资格的队员平分。研究单元取得第一个经核对的外部成果时池子解锁。成果只认链接，由助理核对。</p>
      <div className="tiles">
        {[1, 2, 3, 4].map((lv) => { const o = outs.find((x) => x.level === lv); return (
          <div className="tile" key={lv}><div className="k">{LEVEL[lv]}</div>
            <div className="v" style={{ fontSize: 15 }}>{!o ? <span className="sub2">尚未达到</span> : o.status === 'checked' ? <Badge tone="ok">已核对</Badge> : o.status === 'rejected' ? <Badge tone="bad">已退回</Badge> : <Badge tone="warn">待核对</Badge>}</div>
            <div className="f">{o ? <><a href={o.link} target="_blank" rel="noreferrer">{o.venue ?? '查看链接'}</a>{o.status === 'checked' && o.checked_at && ` · ${day(o.checked_at)}`}{o.status === 'rejected' && o.check_note && ` · ${o.check_note}`}</> : LEVEL_HINT[lv]}</div>
            {o?.status === 'pending' && o.can_check && <div className="acts" style={{ justifyContent: 'flex-start', marginTop: 6 }}>
              <button className="sm" onClick={() => setAct({ title: `核对成果：${LEVEL[lv]}`, label: '属实', fields: [], hint: `请打开链接核对：${o.link}。只核对是否属实、是否属于本研究单元，不评价好坏。`, run: () => rpc('check_outcome', { id: o.id, ok: true, note: null }) })}>属实</button>
              <button className="sm ghost danger" onClick={() => setAct({ title: `退回成果：${LEVEL[lv]}`, label: '退回', danger: true, fields: [{ name: 'note', label: '原因' }], run: (v) => rpc('check_outcome', { id: o.id, ok: false, note: v.note }) })}>退回</button></div>}
          </div>); })}
      </div>
      {lead && next.length > 0 && <div className="actions" style={{ justifyContent: 'flex-start' }}>{next.map((lv) => <button key={lv} className="sm ghost" onClick={() => setAct(outAct(lv))}>提交{LEVEL[lv].slice(0, 2)}成果</button>)}</div>}
      <h3 style={{ marginTop: 18 }}>池子 <span className="h3sub">名义币 {coin(pool.coins)}{cap != null ? `，核定上限 ${coin(cap)}${num(pool.coins) > cap ? '，超出部分不计' : ''}` : ''} · 未回应的质疑 {pool.pending} 条 · {levelBadge(pool.level)}</span></h3>
      {shares.length === 0 ? <Empty>{pool.people > 0 ? '各人的份额仅本研究单元的成员可见。' : '尚无已回应的质疑。'}</Empty> : (
        <div className="scroll"><table>
          <thead><tr><th>成员</th><th className="r">名义币</th><th className="r">份额</th></tr></thead>
          <tbody>{shares.map((s) => <tr key={s.user_id}><td>{s.user_name}</td><td className="r">{coin(s.coins)}</td><td className="r">{pctOf(s.share)}</td></tr>)}</tbody>
        </table></div>)}
      {(() => { const ub = data.ubal[0]; const price = data.cm[0]?.price != null ? num(data.cm[0].price) : null; const mine = num(data.cm[0]?.balance);
        // 实际币兑换 API key（0171）：按本季度公布的比例换 API 额度，折成 key 所在资源的计价单位（如美元），全中心本季度换满即止；额度计入研究单元的 key，名单内成员在这里取用
        const aq = data.aq[0], uk = data.ukey[0], room = aq ? Math.max(num(aq.room), 0) : 0;
        const fx = aq?.fx_rate != null ? num(aq.fx_rate) : 1, perCoin = aq ? num(aq.api_rate) / fx : 0;
        const maxCoins = aq ? Math.min(num(ub?.balance ?? 0), Math.floor(room / perCoin * 100) / 100) : 0;
        return <>
          <h3 style={{ marginTop: 18 }}>实际币 <span className="h3sub">账上 {coin(ub?.balance ?? 0)} · 已换 GPU 卡时 {coin(ub?.hours ?? 0)}{price ? ` · 标价每卡时 ${coin(price)}` : ' · 卡时标价未定'} · 已换 API 额度 {money(ub?.api_quota ?? 0)}{ub?.api_unit ? ` ${ub.api_unit}` : ''}</span></h3>
          <p className="hint">代币不是经费。任何人都可以把自己的实际币投给研究单元（个人投入的按原有效期过期，到期作废；课题预算兑入的不过期），课题也可以把「算力与模型接口」的预算兑成实际币记入研究单元的账上；由负责人按标价换 GPU 卡时（买后 {hoursValid(data.tp)}内有效，集群按此设定额度）或 API 额度。API 额度计入本研究单元的 key，名单内成员共用，在这里取用。</p>
          {data.ucoin.length > 0 && <ul className="path-hist">{[...data.ucoin].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8).map((c) => <li key={c.id}>{day(c.created_at)} {c.kind === 'invest' ? `${c.user_name ?? ''} 投入 ${coin(c.amount)}` : c.kind === 'budget' ? `课题预算兑入 ${coin(c.amount)}` : c.kind === 'expire' ? `到期作废 ${coin(-num(c.amount))}` : `${c.user_name ?? ''} ${c.note ?? '换卡时'}，用去 ${coin(-num(c.amount))}`}{c.kind === 'invest' && c.note ? `：${c.note}` : ''}</li>)}</ul>}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {mine > 0 && <button className="sm ghost" onClick={() => setAct({ title: `投给研究单元：${unit.name}`, label: '投入', hint: `本人余额 ${coin(mine)} 实际币，先扣先到期的。`, fields: [{ name: 'amount', label: '实际币', type: 'number' }, { name: 'note', label: '说明（选填）', required: false }], run: (v) => rpc('invest_coins', { project: unit.id, amount: v.amount, note: v.note || null }) })}>投入实际币</button>}
            {ub?.can_buy && price && num(ub.balance) >= price && <button className="sm" onClick={() => setAct({ title: `换 GPU 卡时：${unit.name}`, label: '换', hint: `按标价每卡时 ${coin(price)} 实际币，从研究单元的账上扣；账上 ${coin(ub.balance)}，最多可换 ${Math.floor(num(ub.balance) / price)} 卡时。`, fields: [{ name: 'hours', label: '卡时', type: 'number' }], run: (v) => rpc('buy_compute', { project: unit.id, hours: v.hours }) })}>换 GPU 卡时</button>}
            {ub?.can_buy && num(ub.balance) > 0 && <button className="sm" disabled={!aq || !aq.resource_id || room <= 0} title={!aq ? '本季度的兑换比例尚未公布' : !aq.resource_id ? '财务岗尚未指定研究单元的 key 开在哪个接口资源上' : room <= 0 ? '本季度全中心可换的 API 额度已换满' : undefined} onClick={() => aq && setAct({ title: `换 API 额度：${unit.name}`, label: '换',
              hint: `本季度 1 实际币兑 ${num(aq.api_rate)} 元 API 额度${aq.fx_rate != null ? `，按 1 ${aq.unit} = ${num(aq.fx_rate)} 元折成 ${Math.round(perCoin * 10000) / 10000} ${aq.unit}` : ''}，从研究单元的账上扣，计入本研究单元的 key（${aq.resource_name}）。全中心本季度还可换 ${money(room)} ${aq.unit}，换满即止；账上 ${coin(ub.balance)}，这次最多用 ${coin(maxCoins)} 实际币。只能单向兑换。`,
              fields: [{ name: 'coins', label: '换出的实际币', type: 'number' }], run: (v) => rpc('buy_api_quota', { project: unit.id, coins: v.coins }) })}>换 API 额度</button>}
          </div>
          {uk && <>
            <h3 style={{ marginTop: 18 }}>API key <span className="h3sub">本研究单元一个 key，名单内共用 · 已计入 {money(uk.api_quota)}{uk.api_unit ? ` ${uk.api_unit}` : ''}</span></h3>
            {uk.rotate_since && <div className="msg warn" role="status">{uk.rotate_who} 已移出名单，财务岗将更换 key，旧 key 届时作废。</div>}
            {!uk.has_key ? <Empty>财务岗尚未发放 key。发放后通知名单内成员，在这里取用。</Empty>
              : <p>key <span className="code">{uk.key_hint ?? '已保存'}</span>{uk.key_set_at && <span className="sub2"> · {day(uk.key_set_at)} 发放</span>}
                {uk.can_get && <button className="sm" style={{ marginLeft: 8 }} onClick={() => setShowKey(true)}>取用 key</button>}</p>}
            {data.kacc.length > 0 && <ul className="path-hist">{[...data.kacc].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8).map((x) => <li key={x.id}>{x.at.slice(0, 16).replace('T', ' ')} {x.user_name ?? '系统'} 取用</li>)}</ul>}
          </>}
          {showKey && <SecretDialog kind="unit" id={unit.id} title={`API key：${unit.name}`} onClose={() => { setShowKey(false); reload(); }} />}
        </>; })()}
      {(recorder || setup) && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm ghost" onClick={() => setAct({ title: `池子上限：${unit.name}`, label: '保存',
        hint: '按联席会议立项时核定的数填写；超过上限的不计。不设上限请留空。', fields: [{ name: 'cap', label: '上限（名义币）', type: 'number', required: false, value: cap != null ? String(cap) : '' }],
        run: (v) => rpc('set_pool_cap', { project: unit.id, cap: v.cap || null }) })}>{cap != null ? '修改池子上限' : '登记池子上限'}</button></div>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}

// ---------- 预算参数页：本季度预算兑换实际币（0164） ----------
// 财务岗每季度开始时公布：本季度全中心可兑换的总额和兑换比例。总额对应的 API 额度从现有库存出；课题兑进来的预算补回库存，兑不满的由谢倩倩老师从自己项目的预算补足。有人兑换后比例不能改，总额可以追加
export function CoinQuarterCard({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ qs: CoinQuarter[]; xs: BudgetCoinExchange[] }>({ qs: ['coin_quarter'], xs: ['budget_coin_exchange'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const fin = can(me, 'budget.issue');
  const cur = data.qs.find((q) => q.current);
  const qname = (d: string) => `${d.slice(0, 4)} 年第 ${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1} 季度`;
  const xs = cur ? data.xs.filter((x) => x.q_start === cur.q_start).sort((a, b) => b.at.localeCompare(a.at)) : [];
  const nf = (name: string, label: string, v?: string): Field => ({ name, label, type: 'number', value: v ?? '' });
  const pub: Act = { title: cur ? '修改本季度的兑换总额和比例' : '公布本季度的兑换总额和比例', label: '公布',
    hint: '总额是本季度全中心可换 API 额度（按 key 所在资源的汇率折算，从现有库存出），也是课题预算本季度可兑换实际币的上限，换满、兑满即止。课题兑进来的预算用来补回库存；兑不满的部分由谢倩倩老师从自己项目的预算补足。本季度已有兑换的，比例不能再改，总额只能追加。卡时标价随之更新',
    fields: [nf('total', '本季度全中心可兑换总额（元）', cur?.total), nf('rate', '1 元预算兑多少实际币', cur?.rate ?? '1'), nf('api_rate', '1 实际币兑多少元 API 额度', cur?.api_rate ?? '1'), nf('gpu_price', '1 卡时多少实际币', cur?.gpu_price ?? '1'), { ...nf('gpu_hours', '本季度集群可供 GPU 卡时（用于通胀监控，可不填）', cur?.gpu_hours ?? ''), required: false },
      { name: 'note', label: '说明（选填）', required: false, value: cur?.note ?? '' }],
    run: (v) => rpc('publish_coin_quarter', { total: v.total, rate: v.rate, api_rate: v.api_rate, gpu_price: v.gpu_price, gpu_hours: v.gpu_hours || null, note: v.note || null }) };
  return (
    <section className="card">
      <h3>预算兑换实际币 <span className="h3sub">{cur ? qname(cur.q_start) : '本季度尚未公布'}</span></h3>
      <p className="hint">课题把「算力与模型接口」科目的预算兑换成实际币，记入研究单元的账上，再换 API 额度或 GPU 卡时。只能单向兑换；兑换比例每季度公布一次，全中心兑满即止。</p>
      {cur ? <table><tbody>
        <tr><th scope="row">可兑换总额</th><td>{money(cur.total)}，已兑 {money(cur.exchanged)}，剩余 <b>{money(num(cur.total) - num(cur.exchanged))}</b></td></tr>
        <tr><th scope="row">兑换比例</th><td>1 元预算 = {num(cur.rate)} 实际币；1 实际币 = {num(cur.api_rate)} 元 API 额度；1 卡时 = {num(cur.gpu_price)} 实际币</td></tr>
        <tr><th scope="row">可供资源</th><td>API：总额 {money(cur.total)} 对应的额度{cur.api_fx != null ? `（约 ${(num(cur.total) / num(cur.api_fx)).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 美元）` : ''}，从现有库存出，课题预算兑换补回；GPU：{cur.gpu_hours != null ? `${num(cur.gpu_hours)} 卡时` : '未填'}</td></tr>
        <tr><th scope="row">公布</th><td>{cur.published_by_name ?? '—'} · {day(cur.published_at)}{cur.note && <div className="sub2" style={{ marginLeft: 0 }}>{cur.note}</div>}</td></tr>
      </tbody></table> : <Empty>本季度的兑换总额和比例尚未公布，课题暂不能兑换。</Empty>}
      {xs.length > 0 && <div className="scroll"><table>
        <thead><tr><th>日期</th><th>课题</th><th>记入研究单元</th><th className="r">兑掉的预算</th><th className="r">实际币</th><th>经办</th></tr></thead>
        <tbody>{xs.map((x) => <tr key={x.id}><td>{day(x.at)}</td><td>{x.topic_code} {x.topic_name}</td><td>{x.unit_code} {x.unit_name}</td><td className="r">{money(x.amount)}</td><td className="r">{num(x.coins)}</td><td>{x.by_name ?? '—'}</td></tr>)}</tbody>
      </table></div>}
      {fin && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(pub)}>{cur ? '修改本季度' : '公布本季度'}</button></div>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}

// ---------- 代币系统：发行、兑换、通胀监控（0165） ----------
// 流通量 = 个人账 + 研究单元账。可兑资源折合实际币 = 总额 ÷ 每币 API 额度 + 可供卡时 × 卡时标价（总额对应的 API 从库存出）。
// 流通量超过可兑资源，就是币多于货：有通胀压力
export function TokenSystem({ me }: { me: Me }) {
  const { data, error } = useViews<{ flow: CoinFlow[]; now: CoinNow[]; qs: CoinQuarter[] }>({ flow: ['coin_flow'], now: ['coin_now'], qs: ['coin_quarter'] });
  if (!data) return <Loading error={error} />;
  const n = data.now[0];
  const out = n ? num(n.out_person) + num(n.out_unit) : 0;
  const flow = [...data.flow].sort((a, b) => b.q_start.localeCompare(a.q_start));
  const qOf = (d: string) => data.qs.find((q) => q.q_start === d);
  const issued = (f: CoinFlow) => num(f.issued_salary) + num(f.issued_mint) + num(f.issued_budget) + num(f.adjusted);
  const burned = (f: CoinFlow) => num(f.spent_compute) + num(f.spent_api) + num(f.expired);
  const endOut = (f: CoinFlow) => num(f.out_person) + num(f.out_unit);
  const cur = data.qs.find((q) => q.current), fc = flow[0], prev = flow[1];
  const supply = (q?: CoinQuarter) => q ? num(q.total) / num(q.api_rate) + (q.gpu_hours != null ? num(q.gpu_hours) * num(q.gpu_price) : 0) : null;
  const cover = cur && out > 0 ? (supply(cur) ?? 0) / out : null;
  const growth = fc && prev && endOut(prev) > 0 ? endOut(fc) / endOut(prev) - 1 : null;
  const qname = (d: string) => `${d.slice(0, 4)} Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  const pc = (v: number) => `${(v * 100).toFixed(0)}%`;
  const warn: string[] = [];
  if (cover != null && cover < 1) warn.push(`流通的实际币（${out.toFixed(0)}）多于本季度可兑的资源（折合 ${(supply(cur) ?? 0).toFixed(0)}），覆盖率 ${pc(cover)}：币多于货，有通胀压力。可以下季度提高标价、减少按期发放，或缩短有效期。`);
  if (!cur) warn.push('本季度还没有公布兑换总额和比例，覆盖率无从计算。');
  else if (cur.gpu_hours == null) warn.push('本季度没有填集群可供卡时，覆盖率只算了 API，偏低。');
  if (growth != null && growth > 0.25) warn.push(`流通量比上季度增长 ${pc(growth)}，发得多、用得少。`);
  if (fc && issued(fc) > 0 && burned(fc) / issued(fc) < 0.3) warn.push(`本季度新发 ${issued(fc).toFixed(0)}，用掉和过期合计 ${burned(fc).toFixed(0)}，不到三成，币在积压。`);
  return (
    <>
      <div className="top"><h2>代币系统</h2></div>
      <p className="lede">实际币的发行、兑换和流通。进：按期发放、成果铸造、课题预算兑换；出：研究单元换 GPU 卡时、换 API 额度、到期作废。投给研究单元只是从个人账转到单元账，总量不变。</p>
      <div className="tiles">
        <Tile k="流通量" v={out.toFixed(0)} f={n ? `个人 ${num(n.out_person).toFixed(0)} · 研究单元 ${num(n.out_unit).toFixed(0)}` : ''} />
        <Tile k="本季度新发" v={fc ? issued(fc).toFixed(0) : '0'} f={fc ? `发放 ${num(fc.issued_salary).toFixed(0)} · 铸造 ${num(fc.issued_mint).toFixed(0)} · 预算兑换 ${num(fc.issued_budget).toFixed(0)}` : ''} />
        <Tile k="本季度用掉" v={fc ? burned(fc).toFixed(0) : '0'} f={fc ? `换卡时 ${num(fc.spent_compute).toFixed(0)} · 换 API ${num(fc.spent_api).toFixed(0)} · 过期 ${num(fc.expired).toFixed(0)}` : ''} />
        <Tile k="可兑资源覆盖率" v={cover != null ? pc(cover) : '—'} f="本季度可兑资源折合实际币 ÷ 流通量" tone={cover != null && cover < 1 ? 'warn' : undefined} />
        <Tile k="三个月内到期" v={n ? num(n.expiring_90d).toFixed(0) : '0'} f={n ? `持币 ${n.holders} 人 · ${n.unit_holders} 个研究单元` : ''} />
      </div>
      <section className="card">
        <h3>通胀监控 <span className="h3sub">按季度</span></h3>
        {warn.length > 0 ? warn.map((w, i) => <div key={i} className="msg warn" role="status">{w}</div>) : <div className="msg" role="status">流通量在可兑资源之内，发行和消耗大致平衡。</div>}
        {flow.length === 0 ? <Empty>还没有实际币的流水。</Empty> : <div className="scroll"><table>
          <thead><tr><th>季度</th><th className="r">按期发放</th><th className="r">铸造</th><th className="r">预算兑换</th><th className="r">换卡时</th><th className="r">换 API</th><th className="r">过期</th><th className="r">期末流通</th><th className="r">环比</th><th className="r">可兑资源</th><th className="r">覆盖率</th><th>比例（预算·API·卡时）</th></tr></thead>
          <tbody>{flow.map((f, i) => { const q = qOf(f.q_start), s = supply(q), o = endOut(f), p = flow[i + 1]; return (
            <tr key={f.q_start}><td>{qname(f.q_start)}</td><td className="r">{num(f.issued_salary).toFixed(0)}</td><td className="r">{num(f.issued_mint).toFixed(0)}</td><td className="r">{num(f.issued_budget).toFixed(0)}</td>
              <td className="r">{num(f.spent_compute).toFixed(0)}</td><td className="r">{num(f.spent_api).toFixed(0)}</td><td className="r">{num(f.expired).toFixed(0)}</td><td className="r">{o.toFixed(0)}</td>
              <td className="r">{p && endOut(p) > 0 ? pc(o / endOut(p) - 1) : '—'}</td><td className="r">{s != null ? s.toFixed(0) : '—'}</td>
              <td className={`r ${s != null && o > 0 && s / o < 1 ? 'neg' : ''}`}>{s != null && o > 0 ? pc(s / o) : '—'}</td>
              <td>{q ? `${num(q.rate)} · ${num(q.api_rate)} · ${num(q.gpu_price)}` : '未公布'}</td></tr>); })}</tbody>
        </table></div>}
      </section>
      <CoinQuarterCard me={me} />
      <TokenParams me={me} />
    </>
  );
}

// ---------- 代币参数 ----------
type Num = Record<string, number>;
export function TokenParams({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ params: TokenParam[] }>({ params: ['token_param'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const get = (k: string) => data.params.find((p) => p.key === k)?.value;
  const lv = (get('levels') ?? {}) as Num, rs = (get('resubmit') ?? {}) as Num, sp = (get('split') ?? {}) as Num;
  const sal = (get('salary') ?? {}) as Record<string, number | null>, price = get('price') as number | null;
  const spn = Number(get('salary_periods') ?? 2), hd = Number(get('hours_days') ?? 56);
  const phase = get('phase'), reserve = Number(get('reserve') ?? 0), valid = Number(get('valid') ?? 0), rate = get('rate') as number | null;
  const director = can(me, 'budget.approve');
  const set = (key: string, value: unknown) => rpc('set_token_param', { key, value });
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  const fold = (v: number) => `${['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][Math.round(v * 10)] ?? v}折`;
  const nf = (name: string, label: string, v: number): Field => ({ name, label, type: 'number', value: String(v) });
  const rows: [string, string, string, Act][] = [
    ['一级（公开发布）铸造系数', `按名义币的 ${lv.r1 ?? 1} 倍乘挂牌铸造率`, '研究单元第一个外部成果核对通过时，按各人在池子里的名义币铸造实际币到个人。',
      { title: '一级的铸造系数', label: '保存', fields: [nf('r1', '一级', lv.r1 ?? 1)], run: (v) => set('levels', { ...lv, r1: Number(v.r1) }) }],
    ['二、三、四级追加', `加 ${lv.l2 ?? 0} 倍、加 ${lv.l3 ?? 0} 倍、加 ${lv.l4 ?? 0} 倍`, '在一级之上逐级追加。四级（同行认可）是主要收益。',
      { title: '二、三、四级的追加倍数', label: '保存', fields: [nf('l2', '二级 · 完整发布', lv.l2 ?? 0), nf('l3', '三级 · 外部反响', lv.l3 ?? 0), nf('l4', '四级 · 同行认可', lv.l4 ?? 0)],
        run: (v) => set('levels', { ...lv, l2: Number(v.l2), l3: Number(v.l3), l4: Number(v.l4) }) }],
    ['挂牌铸造率', rate == null ? '未挂牌：暂不铸造' : `每 1 名义币铸 ${rate} 实际币`, '研究单元的成果核对通过后，按各人在池子里的名义币乘以这个数铸造；二、三、四级按上面的系数追加。',
      { title: '挂牌铸造率', label: '保存', hint: '留空表示暂不铸造。', fields: [{ name: 'v', label: '每 1 点铸多少实际币', type: 'number', required: false, value: rate == null ? '' : String(rate) }], run: (v) => set('rate', v.v ? Number(v.v) : null) }],
    ['各身份每期发放的实际币', RK.map(([k, n]) => `${n} ${sal[k] ?? '未定'}`).join('，'), '每两周按身份发到个人账户，各身份都有；个人只能投给研究单元。未定的不发。',
      { title: '各身份每期发放的实际币', label: '保存', hint: '每两周发放到个人，按「按期发放的有效期」作废；个人只能投给研究单元。留空表示这一身份暂不发放。', fields: RK.map(([k, n]) => ({ name: k, label: n, type: 'number', required: false, value: sal[k] != null ? String(sal[k]) : '' })),
        run: (v) => set('salary', Object.fromEntries(RK.map(([k]) => [k, v[k] === '' ? null : Number(v[k])]))) }],
    ['卡时标价', price == null ? '未定：暂不能换卡时' : `每卡时 ${price} 实际币`, '研究单元的负责人用研究单元账上的实际币换 GPU 卡时，集群按换得的卡时设定额度。',
      { title: '卡时标价', label: '保存', hint: '每卡时多少实际币。留空表示暂不开放兑换。', fields: [{ name: 'v', label: '每卡时的实际币', type: 'number', required: false, value: price == null ? '' : String(price) }], run: (v) => set('price', v.v ? Number(v.v) : null) }],
    ['按期发放的有效期', `${spn} 期（${spn * 2} 周）`, '按期发放的实际币只在发放的这一期起若干期内有效，用不掉作废，防止攒起来一次用。',
      { title: '按期发放的有效期', label: '保存', fields: [nf('v', '期数（每期两周）', spn)], run: (v) => set('salary_periods', Math.round(Number(v.v))) }],
    ['卡时的有效期', `${hd} 天`, '研究单元换得的 GPU 卡时，买后这些天内有效；报给集群的剩余卡时扣掉过期的部分。',
      { title: '卡时的有效期', label: '保存', fields: [nf('v', '天数', hd)], run: (v) => set('hours_days', Math.round(Number(v.v))) }],
    ['铸造所得的有效期', `${valid} 个月`, '成果铸造的实际币，过期作废。',
      { title: '铸造所得的有效期', label: '保存', fields: [nf('v', '月数', valid)], run: (v) => set('valid', Math.round(Number(v.v))) }],
  ];
  return (
    <section className="card">
      <h3>代币参数 <span className="h3sub">名义币来自回应质疑；实际币按期发放、按成果铸造，用来换卡时</span></h3>
      <p className="hint">名义币来自回应质疑，一个名义币等于一小时，每回应一条记 16 名义币，进入研究单元的池子，不能换资源；实际币代表资源使用权，来自按期发放、成果铸造和课题预算兑换（只能单向兑换，不能兑回预算或人民币），用来换 API 额度和 GPU 卡时。下面与铸造有关的参数在转入市场经济时期后才起作用，现在先定下来供大家查看。</p>
      <div className="scroll"><table>
        <thead><tr><th style={{ width: '18%' }}>参数</th><th style={{ width: '34%' }}>现行</th><th>说明</th>{director && <th />}</tr></thead>
        <tbody>{rows.map(([name, val, note, a]) => <tr key={name}><td>{name}</td><td className="wrap">{val}</td><td className="wrap"><span className="sub2">{note}</span></td>
          {director && <td className="r"><button className="sm ghost" onClick={() => setAct(a)}>修改</button></td>}</tr>)}</tbody>
      </table></div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}
