import { useEffect, useState } from 'react';
import { rpc, useViews, type Me, type Project, type ProjectTag } from './api';
import { ActionDialog, Badge, Empty, Loading, PERSON, can, day, num, type Field } from './ui';

// 代币试行（计划经济时期）：只记录，不铸造。只用名义币、实际币两个叫法。
// 名义币按人、每两周按身份发，代表时间；实际币按课题按档次发，代表资源使用权。
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
const LEVEL_HINT = ['', 'arXiv 预印本或公开的投稿页', '项目网页、演示视频、代码或数据或模型公开', 'HuggingFace 论文榜排名靠前，星标、下载量过线', '会议或期刊录用，口头报告、奖项'];
const coin = (v: string | number | null | undefined) => (v == null ? '—' : num(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 }));
const pctOf = (v: string | number | null | undefined) => (v == null ? '—' : `${Math.round(num(v) * 100)}%`);
export const levelBadge = (level: number) => level >= 4 ? <Badge tone="ok">已录用</Badge> : level >= 1 ? <Badge tone="ok">已解锁</Badge> : <Badge>锁定中</Badge>;
export const addDays = (d: string, n: number) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// ---------- 首页 · 我的事项：本期时间去向、我在各研究单元的份额 ----------
export function TokenMine({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ tm: TokenMe[]; logs: TimeLog[]; projects: Project[]; tags: ProjectTag[]; shares: UnitShare[]; pools: UnitPool[] }>({
    tm: ['token_me'], logs: ['time_log'], projects: ['project'], tags: ['project_tag'], shares: ['unit_share'], pools: ['unit_pool'],
  });
  const [pc, setPc] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const tm = data?.tm[0];
  const period = tm ? day(tm.period_start) : '';
  const mine = (data?.logs ?? []).filter((l) => l.user_id === me.id);
  const cur = mine.filter((l) => day(l.period_start) === period);
  const prev = mine.filter((l) => tm && day(l.period_start) === addDays(tm.period_start, -14));
  // 默认沿用上期的比例；本期已登记的以本期为准
  useEffect(() => {
    if (!data) return;
    const base = cur.length > 0 ? cur : prev;
    setPc(Object.fromEntries(base.map((l) => [l.project_id, String(l.percent)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  if (!data) return <Loading error={error} />;
  if (!tm) return null;
  const waiting = new Set(data.tags.filter((t) => t.proposed).map((t) => t.id));
  const units = data.projects.filter((p) => p.layer === 'paper' && p.active && !waiting.has(p.id) && (p.member || p.mine)).sort((a, b) => a.code.localeCompare(b.code));
  const total = units.reduce((s, u) => s + (Number(pc[u.id]) || 0), 0);
  const locked = new Set(cur.filter((l) => l.confirmed).map((l) => l.project_id));
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await rpc('save_time_log', { period, items: units.filter((u) => Number(pc[u.id]) > 0).map((u) => ({ project_id: u.id, percent: Math.round(Number(pc[u.id])) })) });
      setMsg('已登记，待研究单元负责人确认。'); reload();
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };
  const myShares = data.shares.filter((s) => s.user_id === me.id);
  return (
    <>
      <p className="hint" style={{ margin: '0 0 10px' }}>
        {tm.nominal == null ? '本人身份尚未登记，暂无名义币。请财务岗先登记身份。'
          : <>本期 {period} 至 {day(tm.period_end)}，名义币 <b>{coin(tm.nominal)}</b>（{PERSON[tm.kind ?? ''] ?? '—'}）。名义币代表这两周的时间：登记时间花在哪些研究单元上，由研究单元负责人确认后计入该研究单元的池子；当期未登记的作废。目前是试行期，只记录，不铸造。</>}
      </p>
      {tm.nominal != null && (units.length === 0 ? <Empty>本人尚不在任何已成立的研究单元里，暂无可登记的去向。</Empty> : (
        <div className="scroll"><table className="wb-table">
          <thead><tr><th>研究单元</th><th>所属课题</th><th className="r" style={{ width: 130 }}>比例（%）</th><th className="r">折合名义币</th><th>本期状态</th></tr></thead>
          <tbody>{units.map((u) => { const l = cur.find((x) => x.project_id === u.id); return (
            <tr key={u.id}><td><a href={`#/project/${u.id}`}>{u.name}</a><span className="sub2"> {u.code}</span></td><td>{u.parent_name ?? '—'}</td>
              <td className="r"><input type="number" min={0} max={100} step={5} disabled={locked.has(u.id)} value={pc[u.id] ?? ''} placeholder="0" aria-label={`${u.name} 的比例`}
                style={{ width: 90, textAlign: 'right' }} onChange={(e) => setPc({ ...pc, [u.id]: e.target.value })} /></td>
              <td className="r">{coin(num(tm.nominal) * (Number(pc[u.id]) || 0) / 100)}</td>
              <td>{!l ? <span className="sub2">未登记</span> : l.confirmed ? <Badge tone="ok">已确认</Badge> : <Badge tone="warn">待负责人确认</Badge>}</td></tr>); })}</tbody>
          <tfoot><tr><th scope="row">合计</th><td /><td className="r">{total}%</td><td className="r">{coin(num(tm.nominal) * total / 100)}</td><td /></tr></tfoot>
        </table></div>))}
      {tm.nominal != null && units.length > 0 && <div className="actions" style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
        <button className="sm" disabled={busy || total > 100 || total <= 0} onClick={save}>{cur.length > 0 ? '更新本期登记' : '确认本期登记'}</button>
        {cur.length === 0 && prev.length > 0 && <span className="sub2">已按上期的比例填好，没有变化直接确认即可。</span>}
        {total > 100 && <span className="sub2" style={{ color: 'var(--bad)' }}>合计不得超过 100%。</span>}
        {msg && <span className="sub2">{msg}</span>}</div>}
      {myShares.length > 0 && <>
        <h3 style={{ margin: '18px 0 6px', fontSize: 15 }}>我在各研究单元的份额</h3>
        <div className="scroll"><table className="wb-table">
          <thead><tr><th>研究单元</th><th>状态</th><th className="r">已计入的名义币</th><th className="r">我的份额</th></tr></thead>
          <tbody>{myShares.map((s) => { const u = data.projects.find((p) => p.id === s.project_id); const pool = data.pools.find((p) => p.project_id === s.project_id); return (
            <tr key={s.project_id}><td><a href={`#/project/${s.project_id}`}>{u?.name ?? '研究单元'}</a></td><td>{levelBadge(pool?.level ?? 0)}{(pool?.level ?? 0) === 0 && <span className="sub2"> 尚未公开发布</span>}</td>
              <td className="r">{coin(s.coins)}</td><td className="r">{pctOf(s.share)}</td></tr>); })}</tbody>
        </table></div></>}
    </>
  );
}

// ---------- 研究单元页：池子与成果 ----------
export function UnitToken({ me, unit }: { me: Me; unit: Project }) {
  const { data, error, reload } = useViews<{ tm: TokenMe[]; logs: TimeLog[]; pools: UnitPool[]; shares: UnitShare[]; outs: Outcome[] }>({
    tm: ['token_me'], logs: ['time_log'], pools: ['unit_pool'], shares: ['unit_share'], outs: ['outcome'],
  }, unit.id);
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const pool = data.pools.find((p) => p.project_id === unit.id);
  if (!pool) return null;
  const lead = unit.mine, recorder = can(me, 'budget.evaluate'), setup = can(me, 'budget.setup');
  const outs = data.outs.filter((o) => o.project_id === unit.id).sort((a, b) => a.level - b.level);
  const shares = data.shares.filter((s) => s.project_id === unit.id).sort((a, b) => num(b.coins) - num(a.coins));
  const pend = data.logs.filter((l) => l.project_id === unit.id && !l.confirmed && !l.lapsed);
  const periods = [...new Set(pend.map((l) => day(l.period_start)))].sort();
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
      <h3>池子与成果 <span className="h3sub">试行期：只记录，不铸造</span></h3>
      <p className="hint">成员每两周登记的时间，经负责人确认后以名义币计入本研究单元的池子，各人据此占有份额。研究单元拿出外部可验收的成果才解锁：一级是公开发布，四级是同行认可。成果只认链接，由助理核对。</p>
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
      <h3 style={{ marginTop: 18 }}>池子 <span className="h3sub">已计入名义币 {coin(pool.coins)}{cap != null ? `，核定上限 ${coin(cap)}${num(pool.coins) > cap ? '，超出部分不计' : ''}` : '，上限尚未核定'} · {levelBadge(pool.level)}</span></h3>
      {shares.length === 0 ? <Empty>{pool.people > 0 ? '各人的份额仅本研究单元的成员可见。' : '尚无已确认的时间登记。'}</Empty> : (
        <div className="scroll"><table>
          <thead><tr><th>成员</th><th>身份</th><th className="r">已计入的名义币</th><th className="r">份额</th></tr></thead>
          <tbody>{shares.map((s) => <tr key={s.user_id}><td>{s.user_name}</td><td>{PERSON[s.user_kind ?? ''] ?? '—'}</td><td className="r">{coin(s.coins)}</td><td className="r">{pctOf(s.share)}</td></tr>)}</tbody>
        </table></div>)}
      {pend.length > 0 && <>
        <h3 style={{ marginTop: 18 }}>待确认的时间登记 <span className="h3sub">{pend.length} 条；期满七日未确认的作废</span></h3>
        <div className="scroll"><table>
          <thead><tr><th>期次</th><th>成员</th><th>身份</th><th className="r">比例</th><th className="r">名义币</th></tr></thead>
          <tbody>{pend.map((l) => <tr key={l.id}><td>{day(l.period_start)} 起</td><td>{l.user_name}</td><td>{PERSON[l.user_kind ?? ''] ?? '—'}</td><td className="r">{l.percent}%</td><td className="r">{coin(l.coins)}</td></tr>)}</tbody>
        </table></div>
        {(lead || setup) && <div className="actions" style={{ justifyContent: 'flex-start' }}>{periods.map((p) => <button key={p} className="sm" onClick={() => setAct({ title: `确认 ${p} 起这一期的时间登记`, label: '全部确认', fields: [],
          hint: `${pend.filter((l) => day(l.period_start) === p).map((l) => `${l.user_name} ${l.percent}%`).join('，')}。确认后计入池子，本人不得再改。`, run: () => rpc('confirm_time_logs', { project: unit.id, period: p }) })}>确认 {p} 起这一期</button>)}</div>}
      </>}
      {(recorder || setup) && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm ghost" onClick={() => setAct({ title: `池子上限：${unit.name}`, label: '保存',
        hint: '按联席会议立项时核定的所需人周折算成名义币填写；超过上限的投入不计。不设上限请留空。', fields: [{ name: 'cap', label: '上限（名义币）', type: 'number', required: false, value: cap != null ? String(cap) : '' }],
        run: (v) => rpc('set_pool_cap', { project: unit.id, cap: v.cap || null }) })}>{cap != null ? '修改池子上限' : '登记池子上限'}</button></div>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}

// ---------- 预算参数页：代币参数 ----------
const KINDS = ['postdoc', 'phd', 'ra', 'master', 'ri', 'visitor'];
type Num = Record<string, number>;
export function TokenParams({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ params: TokenParam[] }>({ params: ['token_param'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const get = (k: string) => data.params.find((p) => p.key === k)?.value;
  const nominal = (get('nominal') ?? {}) as Num, lv = (get('levels') ?? {}) as Num, rs = (get('resubmit') ?? {}) as Num, sp = (get('split') ?? {}) as Num;
  const phase = get('phase'), reserve = Number(get('reserve') ?? 0), valid = Number(get('valid') ?? 0), rate = get('rate') as number | null;
  const director = can(me, 'budget.approve');
  const set = (key: string, value: unknown) => rpc('set_token_param', { key, value });
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  const fold = (v: number) => `${['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][Math.round(v * 10)] ?? v}折`;
  const nf = (name: string, label: string, v: number): Field => ({ name, label, type: 'number', value: String(v) });
  const rows: [string, string, string, Act][] = [
    ['评定与成果的比例', `${pc(sp.eval ?? 1)} 按档次评定发，${pc(1 - (sp.eval ?? 1))} 留给成果`, '每年的资源容量先分两块。成果那一块在转入市场经济时期后按成果铸造；每年调整不宜超过 5 个点。',
      { title: '评定与成果的比例', label: '保存', hint: '填按档次评定发的占比（%）。测算显示一次调整过大时机器闲置率会明显上升，建议每年不超过 5 个点。', fields: [nf('eval', '按档次评定发的占比（%）', Math.round((sp.eval ?? 1) * 100))],
        run: (v) => set('split', { eval: Number(v.eval) / 100 }) }],
    ['预备', pc(reserve), '年中新立的课题和突发需要从这里出。',
      { title: '预备占资源容量的比例', label: '保存', fields: [nf('v', '预备（%）', Math.round(reserve * 100))], run: (v) => set('reserve', Number(v.v) / 100) }],
    ['一级（公开发布）', `花掉的实际币等额解锁；时间按 ${lv.t1 ?? 0} 计`, '一级只是解锁。时间每两周都会再发，所以对时间打折，防止只为解锁而凑数。',
      { title: '一级的系数', label: '保存', fields: [nf('r1', '对花掉的实际币', lv.r1 ?? 1), nf('t1', '对投入的时间', lv.t1 ?? 0.3)], run: (v) => set('levels', { ...lv, r1: Number(v.r1), t1: Number(v.t1) }) }],
    ['二、三、四级追加', `加 ${lv.l2 ?? 0} 倍、加 ${lv.l3 ?? 0} 倍、加 ${lv.l4 ?? 0} 倍`, '在一级之上逐级追加。四级（同行认可）是主要收益。',
      { title: '二、三、四级的追加倍数', label: '保存', fields: [nf('l2', '二级 · 完整发布', lv.l2 ?? 0), nf('l3', '三级 · 外部反响', lv.l3 ?? 0), nf('l4', '四级 · 同行认可', lv.l4 ?? 0)],
        run: (v) => set('levels', { ...lv, l2: Number(v.l2), l3: Number(v.l3), l4: Number(v.l4) }) }],
    ['投稿与重投', `低一档去向${fold(rs.lower ?? 1)}，每多投一轮${fold(rs.decay ?? 1)}，最多 ${rs.rounds ?? 0} 轮，每轮追加投入不超过首轮池子的 ${pc(rs.extra ?? 0)}`,
      '四级的铸造量按首轮池子定，重投不会把它做大；录用在计划去向之外的打折，清单之外的不算。',
      { title: '投稿与重投', label: '保存', fields: [nf('lower', '低一档去向的折扣（0 到 1）', rs.lower ?? 0.4), nf('decay', '每多投一轮的折扣（0 到 1）', rs.decay ?? 0.8), nf('rounds', '最多投稿轮数', rs.rounds ?? 3), nf('extra', '每轮追加投入的上限（占首轮池子，0 到 1）', rs.extra ?? 0.3)],
        run: (v) => set('resubmit', { lower: Number(v.lower), decay: Number(v.decay), rounds: Math.round(Number(v.rounds)), extra: Number(v.extra) }) }],
    ['挂牌铸造率', rate == null ? '未挂牌：试行期只记录，不铸造' : `每 1 点铸 ${rate} 实际币`, '转入市场经济时期后启用：事先公布，成果核对通过当天按这个数铸造。',
      { title: '挂牌铸造率', label: '保存', hint: '计划经济时期须留空。', fields: [{ name: 'v', label: '每 1 点铸多少实际币', type: 'number', required: false, value: rate == null ? '' : String(rate) }], run: (v) => set('rate', v.v ? Number(v.v) : null) }],
    ['铸造所得的有效期', `${valid} 个月`, '个人和课题凭成果得到的实际币，过期作废。',
      { title: '铸造所得的有效期', label: '保存', fields: [nf('v', '月数', valid)], run: (v) => set('valid', Math.round(Number(v.v))) }],
  ];
  return (
    <section className="card">
      <h3>代币参数 <span className="h3sub">{phase === 'plan' ? '计划经济时期：只记录，不铸造' : '市场经济时期'}</span></h3>
      <p className="hint">名义币按人发，每两周一次，按身份定量，代表时间，不能换资源；实际币按课题、按档次发，代表资源使用权，数量在「总预算与档次」的档次表里填。代币不是钱，不与经费卡和学校账目发生关系。下面与铸造有关的参数在转入市场经济时期后才起作用，现在先定下来供大家查看。</p>
      <div className="scroll"><table>
        <thead><tr><th>身份</th>{KINDS.map((k) => <th key={k} className="r">{PERSON[k]}</th>)}{director && <th />}</tr></thead>
        <tbody><tr><td>每两周的名义币</td>{KINDS.map((k) => <td key={k} className="r">{nominal[k] ?? 0}</td>)}
          {director && <td className="r"><button className="sm ghost" onClick={() => setAct({ title: '各身份每两周的名义币', label: '保存', hint: '数量反映该身份可投入科研的时间。修改后从下一次登记起生效，已登记的不变。',
            fields: KINDS.map((k) => nf(k, PERSON[k], nominal[k] ?? 0)), run: (v) => set('nominal', Object.fromEntries(KINDS.map((k) => [k, Number(v[k]) || 0]))) })}>修改</button></td>}</tr></tbody>
      </table></div>
      <div className="scroll" style={{ marginTop: 14 }}><table>
        <thead><tr><th style={{ width: '18%' }}>参数</th><th style={{ width: '34%' }}>现行</th><th>说明</th>{director && <th />}</tr></thead>
        <tbody>{rows.map(([name, val, note, a]) => <tr key={name}><td>{name}</td><td className="wrap">{val}</td><td className="wrap"><span className="sub2">{note}</span></td>
          {director && <td className="r"><button className="sm ghost" onClick={() => setAct(a)}>修改</button></td>}</tr>)}</tbody>
      </table></div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}
