import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetModule, type BudgetPlan, type BudgetSource, type BudgetTier, type BudgetYear, type ModuleTopic, type Card, type FundProject, type Me, type Project, type TierPick } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, Loading, can, cardTotal, day, money, num, pct, today, type Field } from '../ui';
import { ObjHead, Stages, Track, type Seg } from '../tree';

const wan = (x: number) => `${(x / 1e4).toFixed(Math.abs(x) >= 1e6 || x % 1e4 === 0 ? 0 : 1)} 万`;
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 总预算与档次：财务岗按明年各项目可用的经费测算总预算，先给中心公共开支这样的课题直接确定金额，余下的编成档次。
// 没有单独的一类东西叫模块：中心公共开支就是一个课题，只是金额由方案直接确定，不参加档次评定；
// 中心负责人批准后，各课题带着明细申请档次；评定由联席会议决定、助理录入结果；中心负责人确认评定完成后，档次即课题上限、明细即预算行，转入下达。
export function PlanPage({ me, start }: { me: Me; start: string }) {
  const { data, error, reload } = useViews<{ years: BudgetYear[]; plans: BudgetPlan[]; sources: BudgetSource[]; modules: BudgetModule[]; tiers: BudgetTier[]; picks: TierPick[];
    funds: FundProject[]; cards: Card[]; projects: Project[]; cats: BudgetCategory[]; mtopics: ModuleTopic[] }>({
    mtopics: ['module_topic'],
    years: ['budget_year'], plans: ['budget_plan'], sources: ['budget_source'], modules: ['budget_module'], tiers: ['budget_tier'], picks: ['tier_pick'],
    funds: ['fund_project'], cards: ['card'], projects: ['project'], cats: ['budget_category'],
  });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const finance = can(me, 'budget.setup'), director = can(me, 'budget.approve'), staff = finance || director || can(me, 'read.finance');
  const recorder = can(me, 'budget.evaluate');   // 录入联席会议的评定结果
  const years = [...data.years].sort((a, b) => b.year - a.year);
  const y = years.find((x) => x.year === Number(start)) ?? years.find((x) => x.stage === 'declare') ?? years[0];
  if (!y) return <><div className="top"><h2>总预算与档次</h2></div><Empty>尚未启动任何年度的预算。{finance && <>请先在「<a href="#/budget">预算编制</a>」中启动年度预算。</>}</Empty></>;
  const year = y.year, plan = data.plans.find((p) => p.year === year);
  const published = !!plan?.published, editable = finance && y.stage === 'declare' && !published;
  const sources = data.sources.filter((s) => s.year === year), modules = data.modules.filter((m) => m.year === year).sort((a, b) => num(b.amount) - num(a.amount));
  const tiers = data.tiers.filter((t) => t.year === year).sort((a, b) => a.sort - b.sort);
  const picks = data.picks.filter((k) => k.year === year).sort((a, b) => a.project_name.localeCompare(b.project_name, 'zh'));
  const total = num(plan?.total ?? 0), modSum = modules.reduce((t, m) => t + num(m.amount), 0), tierSum = tiers.reduce((t, x) => t + num(x.amount) * x.slots, 0), room = total - modSum - tierSum;
  const tierOf = (id: string | null) => tiers.find((t) => t.id === id);
  const catName = new Map(data.cats.map((c) => [c.id, c.name]));
  const limitText = (t: BudgetTier) => [t.labor_ratio != null && `劳务类不超过 ${pct(num(t.labor_ratio), 1)}`, ...(t.limits ?? []).map((l) => `${catName.get(l.category_id) ?? '类别'}不超过 ${pct(num(l.ratio), 1)}`)].filter(Boolean).join('；') || '无';
  const undecided = picks.filter((k) => !k.decided_tier_id && !k.rejected).length;
  const KIND: Record<string, string> = { new: '立项', renew: '延续' };
  // 走到哪一环
  const at = y.stage === 'closed' ? 9 : y.stage === 'issued' ? 8 : y.stage === 'fixed' ? 7 : y.stage !== 'declare' ? 7 : published ? (picks.length > 0 && undecided === 0 ? 6 : picks.length > 0 ? 6 : 5) : tiers.length > 0 ? 4 : modules.length > 0 ? 3 : total > 0 ? 2 : 1;

  // ---------- 财务岗：测算、直接确定金额的课题、档次 ----------
  const funds = data.funds.filter((p) => !p.auto && p.status === 'active').sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const liveLeft = (p: FundProject) => data.cards.filter((c) => c.project_id === p.id && c.status === 'active').reduce((t, c) => t + Math.max(cardTotal(c) - num(c.actual) - num(c.commit), 0), 0);
  const sourceAct = (p: FundProject): Act => { const s = sources.find((x) => x.fund_project_id === p.id); return {
    title: `计入 ${year} 年度总预算：${p.name}`, label: '保存',
    hint: `该项目额度剩余 ${p.quota != null ? money(Math.max(num(p.quota) - num(p.granted), 0)) : '未填额度'}，在用经费卡预计结余 ${money(liveLeft(p))}，经费卡到期处理为${END_RULE[p.end_rule]}。按预计明年可用于中心的数填写；不计入的留空。`,
    fields: [{ name: 'amount', label: '计入金额（元）', type: 'number', required: false, value: s ? String(num(s.amount)) : '' }, { name: 'note', label: '说明（选填）', required: false, value: s?.note ?? '' }],
    run: (v) => rpc('save_budget_source', { year, fund_project: p.id, amount: v.amount || null, note: v.note || null }) }; };
  // 可由方案直接确定金额的课题：已立项、本年度没有申请档次、方案里还没有的
  const fixable = data.projects.filter((p) => p.layer !== 'paper' && p.active && !picks.some((k) => k.project_id === p.id) && !modules.some((m) => m.project_id === p.id)).sort((a, b) => a.code.localeCompare(b.code));
  const moduleAct = (m?: BudgetModule): Act => ({
    title: m ? `修改金额：${m.name}` : '直接确定课题的金额', label: '保存',
    hint: m ? '该课题的金额由本方案直接确定，从总预算中先行扣除，不参加档次评定。' : `中心公共开支这样的课题，金额由本方案直接确定，从总预算中先行扣除，不参加档次评定；课题连同研究单元的明细合计不得超过这个金额。${fixable.length === 0 ? '目前没有可选的课题，请先在课题管理中新立课题。' : ''}`,
    fields: [...(m ? [] : [{ name: 'project', label: '课题', options: fixable.map((p): [string, string] => [p.id, `${p.code} ${p.name}`]) }]),
      { name: 'amount', label: '金额（元）', type: 'number' as const, value: m ? String(num(m.amount)) : '' },
      { name: 'note', label: '说明（选填）', required: false, value: m?.note ?? '' }],
    run: (v) => rpc('save_budget_module', { id: m?.id ?? null, year, project: m?.project_id ?? v.project, amount: v.amount, note: v.note || null }) });
  const cats: [string, string][] = data.cats.filter((c) => c.active && !c.labor).sort((a, b) => a.sort - b.sort).map((c) => [c.id, c.name]);
  const tierAct = (t?: BudgetTier): Act => ({
    title: t ? `修改档次：${t.name}` : '新增档次', label: '保存',
    hint: `扣除直接确定金额的课题后，可按档次分配 ${money(total - modSum)}，现有档次合计 ${money(tierSum)}。各档「金额 × 名额」合计不得超过可按档次分配的数。限制按该档金额的比例计，课题连同研究单元的明细须符合。`,
    fields: [{ name: 'name', label: '档次名称', value: t?.name }, { name: 'amount', label: '每个课题的金额（元）', type: 'number', value: t ? String(num(t.amount)) : '' },
      { name: 'slots', label: '名额', type: 'number', value: t ? String(t.slots) : '' },
      { name: 'labor', label: '劳务类比例上限（%，选填）', type: 'number', required: false, value: t?.labor_ratio != null ? String(num(t.labor_ratio) * 100) : '' },
      { name: 'cat1', label: '其他限制一：类别（选填）', options: cats, required: false, value: t?.limits?.[0]?.category_id ?? '' },
      { name: 'r1', label: '其他限制一：比例上限（%）', type: 'number', required: false, value: t?.limits?.[0] ? String(num(t.limits[0].ratio) * 100) : '' },
      { name: 'cat2', label: '其他限制二：类别（选填）', options: cats, required: false, value: t?.limits?.[1]?.category_id ?? '' },
      { name: 'r2', label: '其他限制二：比例上限（%）', type: 'number', required: false, value: t?.limits?.[1] ? String(num(t.limits[1].ratio) * 100) : '' }],
    run: (v) => rpc('save_budget_tier', { id: t?.id ?? null, year, name: v.name, amount: v.amount, slots: Math.round(Number(v.slots)), labor_ratio: v.labor ? Number(v.labor) / 100 : null,
      limits: [[v.cat1, v.r1], [v.cat2, v.r2]].filter(([c, r]) => c && r).map(([c, r]) => ({ category_id: c, ratio: Number(r) / 100 })) }) });
  const del = (title: string, run: () => Promise<unknown>): Act => ({ title, label: '删除', danger: true, fields: [], hint: '删除后不可恢复。', run });

  // ---------- 课题负责人：申请档次 ----------
  // 方案直接确定金额的课题不申请档次，不列在申请里
  const moduleIds = new Set(data.mtopics.filter((m) => m.year === year).map((m) => m.project_id));
  const myTopics = data.projects.filter((p) => p.layer !== 'paper' && p.kind !== 'public' && p.active && !moduleIds.has(p.id) && (p.mine || finance));
  // 任何成员都可以申请立项；通过立项即为该课题的负责人
  const canPropose = true;
  const tierOpts = tiers.map((t): [string, string] => [t.id, `${t.name}：每个课题 ${money(t.amount)}，名额 ${t.slots}，已有 ${t.picked} 个课题申请；限制：${limitText(t)}`]);
  const proposeAct = (): Act => ({
    title: `申请立项：${year} 年度`, label: '提交申请',
    hint: '新课题通过立项申请成立。填写课题名称、研究内容和申请的档次，可同时列出下面的研究单元（每行一个，负责人先记为申请人，成立后可再调整）。提交后课题记为待立项，随后在「预算编制」中填写明细并提交；联席会议评定通过、中心负责人确认后正式成立。',
    fields: [{ name: 'name', label: '课题名称' }, { name: 'tier', label: '申请的档次', options: tierOpts },
      { name: 'reason', label: '研究内容和申请理由', type: 'area' }, { name: 'units', label: '研究单元（每行一个，选填）', type: 'area', required: false }],
    run: (v) => rpc('propose_project', { year, name: v.name, tier: v.tier, reason: v.reason, units: v.units || null }) });
  const pickAct = (p: Project): Act => { const k = picks.find((x) => x.project_id === p.id); return {
    title: `${k?.kind === 'new' ? '修改立项申请' : '申请延续'}：${p.name}`, label: '保存',
    hint: '已有课题每年通过延续申请进入新一年度。每个课题申请一个档次。选定后在「预算编制」中填写课题和各研究单元的明细并提交；明细合计不得超过该档金额，并须符合该档的限制。评定前可以改申请的档次。',
    fields: [{ name: 'tier', label: '档次', value: k?.tier_id, options: tierOpts },
      { name: 'reason', label: '申请理由（上年度执行情况和本年度计划）', type: 'area', value: k?.reason ?? '' }],
    run: (v) => rpc('pick_tier', { year, project: p.id, tier: v.tier, reason: v.reason }) }; };
  const decideAct = (k: TierPick): Act => ({
    title: `录入评定结果：${k.project_name}`, label: '录入',
    hint: `申请「${tierOf(k.tier_id)?.name ?? ''}」，已提交明细合计 ${money(k.total)}${k.drafts > 0 ? `，另有 ${k.drafts} 份预算尚未提交` : ''}。申请理由：${k.reason ?? '未填写'}。评定由联席会议决定，此处按会议结果录入。所定档次的名额未满、明细符合该档的金额和限制方可录入；需调整明细的，由财务岗在「预算编制」中退回该课题。`,
    fields: [{ name: 'on', label: '联席会议日期', type: 'date', value: k.meeting_on ? day(k.meeting_on) : today() }, { name: 'tier', label: '评定的档次', value: k.decided_tier_id ?? k.tier_id, options: tiers.map((t): [string, string] => [t.id, `${t.name}：${money(t.amount)}，名额 ${t.slots}，已评 ${t.decided}`]) },
      { name: 'note', label: '会议意见（选填）', required: false, value: k.decide_note ?? '' }],
    run: (v) => rpc('decide_tier', { year, project: k.project_id, tier: v.tier, note: v.note || null, on: v.on }) });

  const segs: Seg[] = [...modules.map((m, i): Seg => ({ cls: `${i % 2 ? 'sy1' : 'sy0'} big`, value: num(m.amount), text: m.name, tip: `课题「${m.name}」由方案直接确定 ${money(m.amount)}，占总预算 ${pct(num(m.amount), total)}` })),
    ...tiers.map((t, i): Seg => ({ cls: `u${i % 3} big`, value: num(t.amount) * t.slots, text: `${t.name} ${t.slots} 个`, tip: `「${t.name}」每个课题 ${money(t.amount)} × ${t.slots} 个名额，合计 ${money(num(t.amount) * t.slots)}` })),
    ...(room > 0 ? [{ cls: 'hatch big', value: room, text: '未分配', tip: `未分配 ${money(room)}` }] : [])];
  const rejectAct = (k: TierPick): Act => ({
    title: `不予通过：${k.project_name}`, label: '录入', danger: true,
    hint: `${KIND[k.kind]}申请，申请「${tierOf(k.tier_id)?.name ?? ''}」。按联席会议结果录入。${k.kind === 'new' ? '立项不予通过的，评定完成后课题不成立。' : '延续不予通过的，课题保留，本年度没有预算。'}`,
    fields: [{ name: 'on', label: '联席会议日期', type: 'date', value: k.meeting_on ? day(k.meeting_on) : today() }, { name: 'note', label: '不予通过的原因', type: 'area', value: k.rejected ? k.decide_note ?? '' : '' }],
    run: (v) => rpc('reject_tier', { year, project: k.project_id, note: v.note, on: v.on }) });
  const btn = (label: string, a: Act, cls = 'sm ghost') => <button className={a.danger ? `${cls} danger` : cls} onClick={() => setAct(a)}>{label}</button>;

  return (
    <div className="wb obj">
      <ObjHead crumb={<>财务 › 年度预算 › 总预算与档次{years.length > 1 && <> · {years.map((n) => <a key={n.year} href={`#/plan/${n.year}`} style={{ marginLeft: 8, fontWeight: n.year === year ? 600 : 400 }}>{n.year}</a>)}</>}</>}
        eyebrow={`年度预算 · ${year} 年度 · ${published ? `方案已批准${plan?.plan_by_name ? `（${plan.plan_by_name}）` : ''}` : '方案编制中'}`} title={`${year} 年度预算`}
        badge={y.stage === 'declare' ? <Badge tone={published ? 'pri' : 'warn'}>{published ? '课题申请与评定中' : '方案编制中'}</Badge> : <Badge tone="ok">{y.stage === 'closed' ? '已决算' : y.stage === 'issued' ? '已下达，执行中' : '评定完成，待下达'}</Badge>}
        label={staff ? '年度总预算' : '档次合计'} value={staff ? total : tierSum}
        chart={staff ? (segs.length > 0 ? <Track cap="总预算的去向 · 直接确定金额的课题、各档次与未分配" segs={segs} /> : <Empty>尚未测算总预算。</Empty>)
          : tiers.length > 0 ? <Track cap="各档次 · 金额 × 名额" segs={tiers.map((t, i): Seg => ({ cls: `u${i % 3} big`, value: num(t.amount) * t.slots, text: `${t.name} ${t.slots} 个`, tip: `「${t.name}」每个课题 ${money(t.amount)}，名额 ${t.slots}` }))} /> : <Empty>档次方案尚未批准公布。</Empty>}
        facts={staff ? [['直接确定金额的课题', money(modSum)], ['可按档次分配', money(total - modSum)], ['档次合计', money(tierSum)], ['未分配', money(room), room < 0], ['已申请课题', `${picks.length} 个`]]
          : [['档次', `${tiers.length} 档`], ['名额', `${tiers.reduce((t, x) => t + x.slots, 0)} 个`], ['申报截止', day(y.due_date)]]}
        actions={director && y.stage === 'declare' ? (published
          ? <button className="sm ghost" onClick={() => setAct({ title: '撤回批准', label: '撤回', danger: true, fields: [], hint: '撤回后财务岗可继续修改总预算、直接确定金额的课题和档次。已有课题申请档次的不得撤回。', run: () => rpc('publish_budget_plan', { year, on: false }) })}>撤回批准</button>
          : <button className="sm" onClick={() => setAct({ title: `批准 ${year} 年度预算方案`, label: '批准', fields: [], hint: `总预算 ${money(total)}，直接确定金额的课题合计 ${money(modSum)}，档次合计 ${money(tierSum)}，未分配 ${money(room)}。批准后向各课题公布档次，课题即可申请。`, run: () => rpc('publish_budget_plan', { year, on: true }) })}>批准方案</button>) : undefined} />
      <Stages path="测算总预算 › 直接确定金额的课题 › 编档次 › 批准方案 › 立项与延续申请 › 评定 › 下达执行 › 年度决算" at={at} items={[
        { nm: '测算总预算', ds: '财务岗按各项目可用经费测算', v: staff ? wan(total) : '—', f: staff ? `${sources.length} 个项目计入` : '' },
        { nm: '直接确定金额', ds: '中心公共开支等课题，不参加评定', v: staff ? wan(modSum) : '—', f: staff ? `${modules.length} 个课题` : '' },
        { nm: '编档次', ds: '每档金额、名额、限制', v: `${tiers.length} 档`, f: tiers.length ? `名额 ${tiers.reduce((t, x) => t + x.slots, 0)} 个` : '' },
        { nm: '批准方案', ds: '中心负责人批准后公布', v: published ? '已批准' : '未批准', f: plan?.plan_at ? day(plan.plan_at) : '' },
        { nm: '立项与延续', ds: '课题选档并提交明细', v: `${picks.length} 个课题`, f: published ? `申报截止 ${day(y.due_date)}` : '方案批准后开始' },
        { nm: '评定', ds: '联席会议决定，助理录入', v: picks.length ? `${picks.length - undecided} / ${picks.length}` : '—', f: undecided > 0 ? `${undecided} 个待评定` : '' },
        { nm: '下达执行', ds: '档次即上限，明细即预算行', v: ['fixed', 'issued', 'closed'].includes(y.stage) ? (y.stage === 'fixed' ? '待下达' : '已下达') : '—', f: '' },
        { nm: '年度决算', ds: '年末复盘', v: y.stage === 'closed' ? '已决算' : '—', f: '' },
      ]} />

      {staff && (
        <section className="card">
          <h3>测算依据 <span className="h3sub">明年各项目可用的经费；财务岗填「计入总预算」一栏</span></h3>
          {funds.length === 0 ? <Empty>暂无在执行的项目。请先在「<a href="#/funds">项目管理</a>」中建立项目。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>项目</th><th className="r">额度剩余（可申请下达）</th><th className="r">在用经费卡预计结余</th><th>经费卡到期处理</th><th className="r">计入总预算</th><th>说明</th>{editable && <th />}</tr></thead>
              <tbody>{funds.map((p) => { const s = sources.find((x) => x.fund_project_id === p.id); return (
                <tr key={p.id}><td><a href={`#/fund/${p.id}`}>{p.name}</a></td><td className="r">{p.quota != null ? money(Math.max(num(p.quota) - num(p.granted), 0)) : <span className="sub2">未填额度</span>}</td>
                  <td className="r">{money(liveLeft(p))}</td><td>{END_RULE[p.end_rule]}</td><td className="r">{s ? <b>{money(s.amount)}</b> : '—'}</td><td className="wrap">{s?.note ?? '—'}</td>
                  {editable && <td className="r">{btn(s ? '修改' : '填写', sourceAct(p))}</td>}</tr>); })}</tbody>
              <tfoot><tr><th scope="row">年度总预算</th><td /><td /><td /><td className="r">{money(total)}</td><td />{editable && <td />}</tr></tfoot>
            </table></div>
          )}
        </section>
      )}

      {staff && (
        <section className="card">
          <h3>直接确定金额的课题 <span className="h3sub">中心公共开支这样的课题，金额由方案直接确定，从总预算中先行扣除，不参加档次评定</span></h3>
          {modules.length === 0 ? <Empty>尚未给任何课题直接确定金额。</Empty> : (
            <table><thead><tr><th>课题</th><th>负责人</th><th className="r">金额</th><th className="r">已提交明细</th><th>说明</th>{editable && <th />}</tr></thead>
              <tbody>{modules.map((m) => <tr key={m.id}><td><a href={`#/project/${m.project_id}/${year}`}>{m.name}</a><div className="sub2">{m.code}</div></td><td>{m.owner_name ?? <span className="sub2">未指定</span>}</td><td className="r">{money(m.amount)}</td><td className="r">{num(m.used) > 0 ? money(m.used) : '—'}</td><td className="wrap">{m.note ?? '—'}</td>
                {editable && <td className="r"><div className="acts">{btn('修改', moduleAct(m))}{btn('移出', del(`移出方案：${m.name}`, () => rpc('save_budget_module', { id: m.id, year, project: m.project_id, amount: null, note: null })))}</div></td>}</tr>)}</tbody>
              <tfoot><tr><th scope="row">扣除后可按档次分配</th><td /><td className="r">{money(total - modSum)}</td><td /><td />{editable && <td />}</tr></tfoot></table>
          )}
          {editable && <div className="actions" style={{ justifyContent: 'flex-start' }}>{btn('直接确定课题的金额', moduleAct(), 'sm')}</div>}
        </section>
      )}

      <section className="card">
        <h3>档次 <span className="h3sub">{staff ? '各档「金额 × 名额」合计不得超过可分给课题的数' : '每个课题申请一个档次'}</span></h3>
        {tiers.length === 0 ? <Empty>{staff ? '尚未编制档次。' : '档次方案尚未批准公布。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>档次</th><th className="r">每个课题</th><th className="r">名额</th><th className="r">小计</th><th>限制</th><th className="r">已申请</th><th className="r">已评定</th>{editable && <th />}</tr></thead>
            <tbody>{tiers.map((t) => <tr key={t.id}><td>{t.name}</td><td className="r">{money(t.amount)}</td><td className="r">{t.slots}</td><td className="r">{money(num(t.amount) * t.slots)}</td><td className="wrap">{limitText(t)}</td>
              <td className="r">{t.picked}</td><td className="r">{t.decided}{t.decided >= t.slots && <> <Badge>已评满</Badge></>}</td>
              {editable && <td className="r"><div className="acts">{btn('修改', tierAct(t))}{btn('删除', del(`删除档次：${t.name}`, () => rpc('save_budget_tier', { id: t.id, year, name: t.name, amount: null, slots: null })))}</div></td>}</tr>)}</tbody>
            <tfoot><tr><th scope="row">合计</th><td /><td className="r">{tiers.reduce((s, t) => s + t.slots, 0)}</td><td className="r">{money(tierSum)}</td><td /><td /><td />{editable && <td />}</tr></tfoot>
          </table></div>
        )}
        {editable && <div className="actions" style={{ justifyContent: 'flex-start' }}>{btn('新增档次', tierAct(), 'sm')}</div>}
        {finance && y.stage === 'declare' && published && <p className="hint">方案已批准。如需修改总预算、直接确定金额的课题或档次，请中心负责人先撤回批准。</p>}
      </section>

      {published && y.stage === 'declare' && (myTopics.length > 0 || canPropose) && (
        <section className="card">
          <h3>立项与延续申请 <span className="h3sub">{finance ? '各课题的申请' : '本人负责的课题；任何成员都可以申请立项，通过后即为该课题的负责人'}</span></h3>
          <p className="hint">申请档次是课题每一年的起点：新课题申请立项，已有课题申请延续。先选档次，再在「<a href={`#/budget/${year}`}>预算编制</a>」中填写课题和各研究单元的明细并提交。明细合计不得超过该档金额，并须符合该档的限制；不符合的提交时会提示。</p>
          {myTopics.length === 0 ? <Empty>本人名下暂无课题。新课题请申请立项。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>课题</th><th>类别</th><th>申请的档次</th><th className="r">已提交明细合计</th><th>情况</th><th /></tr></thead>
              <tbody>{myTopics.map((p) => { const k = picks.find((x) => x.project_id === p.id); const t = tierOf(k?.tier_id ?? null); const fresh = k?.kind === 'new'; return (
                <tr key={p.id}><td><a href={`#/project/${p.id}/${year}`}>{p.name}</a>{fresh && k && k.units > 0 && <span className="sub2">{k.units} 个研究单元</span>}</td>
                  <td>{fresh ? <Badge tone="pri">立项</Badge> : <Badge>延续</Badge>}</td>
                  <td>{t ? `${t.name}（${money(t.amount)}）` : <span className="sub2">尚未申请</span>}</td>
                  <td className="r">{k ? money(k.total) : '—'}</td>
                  <td className="wrap">{!k ? <span className="sub2">尚未申请延续，本年度没有预算</span> : k.rejected ? <><Badge tone="bad">不予通过</Badge>{k.decide_note && <div className="sub2" style={{ marginLeft: 0 }}>{k.decide_note}</div>}</>
                    : k.decided_tier_id ? <Badge tone="ok">已评定：{tierOf(k.decided_tier_id)?.name}</Badge> : k.violation ? <Badge tone="bad">{k.violation}</Badge> : num(k.total) === 0 ? <Badge tone="warn">尚未提交明细</Badge> : k.drafts > 0 ? <Badge tone="warn">另有 {k.drafts} 份预算尚未提交</Badge> : <Badge tone="pri">已提交，待评定</Badge>}</td>
                  <td className="r"><div className="acts">{(!k || (!k.decided_tier_id && !k.rejected)) && (p.mine || finance) && btn(k ? '改申请' : '申请延续', pickAct(p), k ? 'sm ghost' : 'sm')}
                    {fresh && k && !k.decided_tier_id && !k.rejected && (p.mine || finance) && btn('撤回申请', { title: `撤回立项申请：${p.name}`, label: '撤回', danger: true, fields: [], hint: '撤回后该课题、研究单元和未提交的预算一并删除。已提交的预算须先撤回。', run: () => rpc('withdraw_proposal', { year, project: p.id }) })}</div></td></tr>); })}</tbody>
            </table></div>
          )}
          {canPropose && <div className="actions" style={{ justifyContent: 'flex-start' }}>{btn('申请立项', proposeAct(), 'sm')}</div>}
        </section>
      )}

      {(staff || recorder) && published && (
        <section className="card">
          <h3>评定 <span className="h3sub">{picks.filter((k) => k.kind === 'new').length} 个立项申请、{picks.filter((k) => k.kind === 'renew').length} 个延续申请，{picks.length - undecided} 个已录入结果</span></h3>
          <p className="hint">评定由联席会议决定，结果由助理在此录入；全部录入后由中心负责人确认评定完成，转入下达。</p>
          {picks.length === 0 ? <Empty>尚无课题申请档次。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>课题</th><th>类别</th><th>负责人</th><th>申请的档次</th><th className="r">明细合计</th><th>限制</th><th>评定结果</th>{recorder && y.stage === 'declare' && <th />}</tr></thead>
              <tbody>{picks.map((k) => { const t = tierOf(k.tier_id), d = tierOf(k.decided_tier_id); return (
                <tr key={k.project_id}><td><a href={`#/project/${k.project_id}/${year}`}>{k.project_name}</a>{k.reason && <div className="sub2" style={{ marginLeft: 0 }}>{k.reason}</div>}</td><td>{k.kind === 'new' ? <Badge tone="pri">立项</Badge> : <Badge>延续</Badge>}{k.kind === 'new' && k.units > 0 && <div className="sub2" style={{ marginLeft: 0 }}>{k.units} 个研究单元</div>}</td><td>{k.owner_name ?? '—'}</td>
                  <td>{t?.name}<span className="sub2">{t ? money(t.amount) : ''}</span></td><td className="r">{money(k.total)}{k.drafts > 0 && <div className="sub2" style={{ marginLeft: 0 }}>另有 {k.drafts} 份未提交</div>}</td>
                  <td className="wrap">{k.violation ? <Badge tone="bad">{k.violation}</Badge> : <Badge tone="ok">符合</Badge>}</td>
                  <td>{k.rejected ? <><Badge tone="bad">不予通过</Badge><div className="sub2" style={{ marginLeft: 0 }}>{[k.meeting_on && `${day(k.meeting_on)} 联席会议`, k.decided_by_name && `${k.decided_by_name} 录入`, k.decide_note].filter(Boolean).join(' · ')}</div></> : d ? <><Badge tone="ok">{d.name}</Badge><div className="sub2" style={{ marginLeft: 0 }}>{[k.meeting_on && `${day(k.meeting_on)} 联席会议`, k.decided_by_name && `${k.decided_by_name} 录入`, k.decide_note].filter(Boolean).join(' · ')}</div></> : <Badge tone="warn">待评定</Badge>}</td>
                  {recorder && y.stage === 'declare' && <td className="r"><div className="acts">{btn(d || k.rejected ? '改为定档' : '定档', decideAct(k), d || k.rejected ? 'sm ghost' : 'sm')}{!k.rejected && btn('不予通过', rejectAct(k))}
                    {(d || k.rejected) && btn('撤销', { title: `撤销已录入的评定结果：${k.project_name}`, label: '撤销', danger: true, fields: [], run: () => rpc('decide_tier', { year, project: k.project_id, tier: null, note: null }) })}</div></td>}</tr>); })}</tbody>
            </table></div>
          )}
          {director && y.stage === 'declare' && picks.length > 0 && <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="sm" disabled={undecided > 0} title={undecided > 0 ? '全部课题的评定结果录入后方可办理' : undefined} onClick={() => setAct({ title: `${year} 年度评定完成，转入下达`, label: '确认',
              hint: `${picks.length} 个课题的评定结果已全部录入。确认后：定档的课题档次金额成为年度上限，已提交的明细成为核定的预算行；立项通过的课题正式成立，立项未通过的不成立；延续未通过的课题保留，本年度没有预算；财务岗随后在「预算编制」中下达到经费卡。尚未提交的预算不带入。`, fields: [], run: () => rpc('settle_tiers', { year }) })}>评定完成，转入下达</button>
            {undecided > 0 && <span className="sub2">尚有 {undecided} 个课题的评定结果未录入。</span>}</div>}
          {director && y.stage === 'fixed' && <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="sm ghost" onClick={() => setAct({ title: '撤回评定完成', label: '撤回', danger: true, fields: [], hint: '回到评定阶段，各课题的上限和核定数一并撤销。已有预算行下达到经费卡的不得撤回。', run: () => rpc('unsettle_tiers', { year }) })}>撤回评定完成</button>
            <a className="btn sm" href={`#/budget/${year}`}>前往预算编制下达</a></div>}
        </section>
      )}

      {!published && !staff && <section className="card"><Empty>{year} 年度的预算方案正在编制，批准后在此公布档次，届时可为本人负责的课题申请档次。今日 {today()}。</Empty></section>}

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
