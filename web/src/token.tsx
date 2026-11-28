import { useState } from 'react';
import { rpc, useViews, type BudgetCoinExchange, type CoinQuarter, type Me, type Project } from './api';
import { ActionDialog, Badge, Empty, Loading, can, day, money, num, type Field } from './ui';

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
    ucoin: { id: string; kind: 'invest' | 'compute'; amount: string; user_name: string | null; note: string | null; created_at: string }[]; ubal: { project_id: string; balance: string; hours: string; can_buy: boolean }[]; cm: { balance: string; price: string | null }[] }>({ tp: ['token_param'],
    pools: ['unit_pool'], shares: ['unit_share'], outs: ['outcome'], grants: ['compute_grant', { project_id: unit.id }],
    ucoin: ['unit_coin', { project_id: unit.id }], ubal: ['unit_coin_balance', { project_id: unit.id }], cm: ['coin_mine'],
  }, unit.id);
  const [act, setAct] = useState<Act | null>(null);
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
        const inv = data.ucoin.filter((c) => c.kind === 'invest');
        return <>
          <h3 style={{ marginTop: 18 }}>实际币 <span className="h3sub">账上 {coin(ub?.balance ?? 0)} · 已换 GPU 卡时 {coin(ub?.hours ?? 0)}{price ? ` · 标价每卡时 ${coin(price)}` : ' · 卡时标价未定'}</span></h3>
          <p className="hint">代币不是经费。任何人都可以把自己的实际币投给研究单元，由负责人换 GPU 卡时，买后 {hoursValid(data.tp)}内有效，以后也可以换别的资源；换得的卡时集群按此设定额度。</p>
          {inv.length > 0 && <ul className="path-hist">{[...data.ucoin].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8).map((c) => <li key={c.id}>{day(c.created_at)} {c.kind === 'invest' ? `${c.user_name ?? ''} 投入 ${coin(c.amount)}` : `${c.user_name ?? ''} ${c.note ?? '换卡时'}，用去 ${coin(-num(c.amount))}`}{c.kind === 'invest' && c.note ? `：${c.note}` : ''}</li>)}</ul>}
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {mine > 0 && <button className="sm ghost" onClick={() => setAct({ title: `投给研究单元：${unit.name}`, label: '投入', hint: `本人余额 ${coin(mine)} 实际币，先扣先到期的。`, fields: [{ name: 'amount', label: '实际币', type: 'number' }, { name: 'note', label: '说明（选填）', required: false }], run: (v) => rpc('invest_coins', { project: unit.id, amount: v.amount, note: v.note || null }) })}>投入实际币</button>}
            {ub?.can_buy && price && num(ub.balance) >= price && <button className="sm" onClick={() => setAct({ title: `换 GPU 卡时：${unit.name}`, label: '换', hint: `按标价每卡时 ${coin(price)} 实际币，从研究单元的账上扣；账上 ${coin(ub.balance)}，最多可换 ${Math.floor(num(ub.balance) / price)} 卡时。`, fields: [{ name: 'hours', label: '卡时', type: 'number' }], run: (v) => rpc('buy_compute', { project: unit.id, hours: v.hours }) })}>换 GPU 卡时</button>}
          </div>
        </>; })()}
      {(recorder || setup) && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm ghost" onClick={() => setAct({ title: `池子上限：${unit.name}`, label: '保存',
        hint: '按联席会议立项时核定的数填写；超过上限的不计。不设上限请留空。', fields: [{ name: 'cap', label: '上限（名义币）', type: 'number', required: false, value: cap != null ? String(cap) : '' }],
        run: (v) => rpc('set_pool_cap', { project: unit.id, cap: v.cap || null }) })}>{cap != null ? '修改池子上限' : '登记池子上限'}</button></div>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}

// ---------- 预算参数页：本季度预算兑换实际币（0164） ----------
// 财务岗每季度开始时公布：全中心可兑换总额（下季度 API 充值能经学校报销的金额）和兑换比例；有人兑换后比例不能改，总额可以追加
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
    hint: '总额填下季度 API 充值中能经学校报销的金额，全中心兑满即止；财务岗照计划直接充值，没兑满的部分由谢倩倩老师兜底。本季度已有兑换的，比例不能再改，总额只能追加。卡时标价随之更新。',
    fields: [nf('total', '本季度全中心可兑换总额（元）', cur?.total), nf('rate', '1 元预算兑多少实际币', cur?.rate ?? '1'), nf('api_rate', '1 实际币兑多少元 API 额度', cur?.api_rate ?? '1'), nf('gpu_price', '1 卡时多少实际币', cur?.gpu_price ?? '1'),
      { name: 'note', label: '说明（选填）', required: false, value: cur?.note ?? '' }],
    run: (v) => rpc('publish_coin_quarter', { total: v.total, rate: v.rate, api_rate: v.api_rate, gpu_price: v.gpu_price, note: v.note || null }) };
  return (
    <section className="card">
      <h3>预算兑换实际币 <span className="h3sub">{cur ? qname(cur.q_start) : '本季度尚未公布'}</span></h3>
      <p className="hint">课题把「算力与模型接口」科目的预算兑换成实际币，记入研究单元的账上，再换 API 额度或 GPU 卡时。只能单向兑换；兑换比例每季度公布一次，全中心兑满即止。</p>
      {cur ? <table><tbody>
        <tr><th scope="row">可兑换总额</th><td>{money(cur.total)}，已兑 {money(cur.exchanged)}，剩余 <b>{money(num(cur.total) - num(cur.exchanged))}</b></td></tr>
        <tr><th scope="row">兑换比例</th><td>1 元预算 = {num(cur.rate)} 实际币；1 实际币 = {num(cur.api_rate)} 元 API 额度；1 卡时 = {num(cur.gpu_price)} 实际币</td></tr>
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

// ---------- 预算参数页：代币参数 ----------
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
      <p className="hint">名义币来自回应质疑，一个名义币等于一小时，每回应一条记 16 名义币，进入研究单元的池子，不能换资源；实际币代表资源使用权，数量在「总预算与档次」的档次表里填。代币不是钱，不与经费卡和学校账目发生关系。下面与铸造有关的参数在转入市场经济时期后才起作用，现在先定下来供大家查看。</p>
      <div className="scroll"><table>
        <thead><tr><th style={{ width: '18%' }}>参数</th><th style={{ width: '34%' }}>现行</th><th>说明</th>{director && <th />}</tr></thead>
        <tbody>{rows.map(([name, val, note, a]) => <tr key={name}><td>{name}</td><td className="wrap">{val}</td><td className="wrap"><span className="sub2">{note}</span></td>
          {director && <td className="r"><button className="sm ghost" onClick={() => setAct(a)}>修改</button></td>}</tr>)}</tbody>
      </table></div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}
