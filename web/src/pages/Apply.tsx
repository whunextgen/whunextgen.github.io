import { useState } from 'react';
import { rpc, useViews, type BudgetCategory, type BudgetPlan, type BudgetTier, type BudgetYear, type Me, type ModuleTopic, type Project, type ProjectTag, type TierPick, type UnitApply, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, money, num, pct, today, type Field } from '../ui';

interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 立项与延续申请、研究单元申请都是课题这一侧的事：前者在课题之下自成一页，后者放在「课题管理」页。
// 「总预算与档次」只办年度预算方案和评定：评定只评课题，研究单元不参加评定，全年随时可以申请。

// ---------- 立项与延续申请：每年一次，预算方案批准后开放 ----------
export function TopicApply({ me, onChange }: { me: Me; onChange?: () => void }) {
  const { data, error, reload } = useViews<{ years: BudgetYear[]; plans: BudgetPlan[]; tiers: BudgetTier[]; picks: TierPick[]; projects: Project[]; cats: BudgetCategory[]; mtopics: ModuleTopic[] }>({
    years: ['budget_year'], plans: ['budget_plan'], tiers: ['budget_tier'], picks: ['tier_pick'], projects: ['project'], cats: ['budget_category'], mtopics: ['module_topic'],
  });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <section className="card"><h3>立项与延续申请</h3><Loading error={error} /></section>;
  const finance = can(me, 'budget.setup');
  const y = [...data.years].sort((a, b) => b.year - a.year).find((x) => x.stage === 'declare');
  const head = (sub: string) => <h3>立项与延续申请 <span className="h3sub">{sub}</span></h3>;
  if (!y) return <section className="card">{head('每年一次')}<Empty>目前没有处于申请阶段的年度。新一年度的预算方案批准后，在此申请立项或延续。</Empty></section>;
  const year = y.year, published = !!data.plans.find((p) => p.year === year)?.published;
  if (!published) return <section className="card">{head(`${year} 年度`)}<Empty>{year} 年度的预算方案正在编制，批准并公布档次后，在此申请立项或延续。今日 {today()}。</Empty></section>;
  const tiers = data.tiers.filter((t) => t.year === year).sort((a, b) => a.sort - b.sort);
  const picks = data.picks.filter((k) => k.year === year);
  const tierOf = (id: string | null) => tiers.find((t) => t.id === id);
  const catName = new Map(data.cats.map((c) => [c.id, c.name]));
  const limitText = (t: BudgetTier) => [t.labor_ratio != null && `劳务类不超过 ${pct(num(t.labor_ratio), 1)}`, ...(t.limits ?? []).map((l) => `${catName.get(l.category_id) ?? '类别'}不超过 ${pct(num(l.ratio), 1)}`)].filter(Boolean).join('；') || '无';
  // 方案直接确定金额的课题不申请档次，不列在申请里
  const moduleIds = new Set(data.mtopics.filter((m) => m.year === year).map((m) => m.project_id));
  const myTopics = data.projects.filter((p) => p.layer !== 'paper' && p.kind !== 'public' && p.active && !moduleIds.has(p.id) && (p.mine || finance));
  const tierOpts = tiers.map((t): [string, string] => [t.id, `${t.name}：每个课题 ${money(t.amount)}，名额 ${t.slots}，已有 ${t.picked} 个课题申请；限制：${limitText(t)}`]);
  const proposeAct = (): Act => ({
    title: `申请立项：${year} 年度`, label: '提交申请',
    hint: '新课题通过立项申请成立。填写课题名称、研究内容和申请的档次。提交后课题记为待立项，随后在「预算编制」中填写明细并提交；联席会议评定通过、中心负责人确认后正式成立。评定只评课题；研究单元在课题成立后单独申请，全年随时可以提。',
    fields: [{ name: 'name', label: '课题名称' }, { name: 'tier', label: '申请的档次', options: tierOpts }, { name: 'reason', label: '研究内容和申请理由', type: 'area' }],
    run: (v) => rpc('propose_project', { year, name: v.name, tier: v.tier, reason: v.reason, units: null }) });
  const pickAct = (p: Project): Act => { const k = picks.find((x) => x.project_id === p.id); return {
    title: `${k?.kind === 'new' ? '修改立项申请' : '申请延续'}：${p.name}`, label: '保存',
    hint: '已有课题每年通过延续申请进入新一年度。每个课题申请一个档次。选定后在「预算编制」中填写课题的明细并提交；明细合计不得超过该档金额，并须符合该档的限制。评定前可以改申请的档次。',
    fields: [{ name: 'tier', label: '档次', value: k?.tier_id, options: tierOpts }, { name: 'reason', label: '申请理由（上年度执行情况和本年度计划）', type: 'area', value: k?.reason ?? '' }],
    run: (v) => rpc('pick_tier', { year, project: p.id, tier: v.tier, reason: v.reason }) }; };
  const btn = (label: string, a: Act, cls = 'sm ghost') => <button className={a.danger ? `${cls} danger` : cls} onClick={() => setAct(a)}>{label}</button>;
  return (
    <section className="card">
      {head(`${year} 年度 · 申报截止 ${day(y.due_date)} · ${finance ? '各课题的申请' : '本人负责的课题；任何成员都可以申请立项，通过后即为该课题的负责人'}`)}
      <p className="hint">申请档次是课题每一年的起点：新课题申请立项，已有课题申请延续。先选档次，再在「<a href={`#/budget/${year}`}>预算编制</a>」中填写课题的明细并提交。各档的金额、名额和限制见「<a href={`#/plan/${year}`}>{finance ? '总预算与档次' : '年度档次'}</a>」。评定由联席会议决定，只评课题；年度预算只编在课题上，研究单元使用所挂课题的预算。</p>
      {myTopics.length === 0 ? <Empty>本人名下暂无课题。新课题请申请立项。</Empty> : (
        <div className="scroll"><table>
          <thead><tr><th>课题</th><th>类别</th><th>申请的档次</th><th className="r">已提交明细合计</th><th>情况</th><th /></tr></thead>
          <tbody>{myTopics.map((p) => { const k = picks.find((x) => x.project_id === p.id); const t = tierOf(k?.tier_id ?? null); const fresh = k?.kind === 'new'; return (
            <tr key={p.id}><td><a href={`#/project/${p.id}/${year}`}>{p.name}</a></td>
              <td>{fresh ? <Badge tone="pri">立项</Badge> : <Badge>延续</Badge>}</td>
              <td>{t ? `${t.name}（${money(t.amount)}）` : <span className="sub2">尚未申请</span>}</td>
              <td className="r">{k ? money(k.total) : '—'}</td>
              <td className="wrap">{!k ? <span className="sub2">尚未申请延续，本年度没有预算</span> : k.rejected ? <><Badge tone="bad">不予通过</Badge>{k.decide_note && <div className="sub2" style={{ marginLeft: 0 }}>{k.decide_note}</div>}</>
                : k.decided_tier_id ? <Badge tone="ok">已评定：{tierOf(k.decided_tier_id)?.name}</Badge> : k.violation ? <Badge tone="bad">{k.violation}</Badge> : num(k.total) === 0 ? <Badge tone="warn">尚未提交明细</Badge> : k.drafts > 0 ? <Badge tone="warn">另有 {k.drafts} 份预算尚未提交</Badge> : <Badge tone="pri">已提交，待评定</Badge>}</td>
              <td className="r"><div className="acts">{(!k || (!k.decided_tier_id && !k.rejected)) && (p.mine || finance) && btn(k ? '改申请' : '申请延续', pickAct(p), k ? 'sm ghost' : 'sm')}
                {fresh && k && !k.decided_tier_id && !k.rejected && (p.mine || finance) && btn('撤回申请', { title: `撤回立项申请：${p.name}`, label: '撤回', danger: true, fields: [], hint: '撤回后该课题和未提交的预算一并删除。已提交的预算须先撤回。', run: () => rpc('withdraw_proposal', { year, project: p.id }) })}</div></td></tr>); })}</tbody>
        </table></div>
      )}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>{btn('申请立项', proposeAct(), 'sm')}</div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={(v) => act.run(v).then(() => { reload(); onChange?.(); })} onClose={() => setAct(null)} />}
    </section>
  );
}

// 课题之下的一页：只放立项与延续申请。研究单元申请在「课题管理」页。
export function ApplyPage({ me }: { me: Me }) {
  return (
    <>
      <div className="top"><h2>立项与延续申请</h2></div>
      <p className="lede">课题每年申请一次：新课题申请立项，已有课题申请延续。年度预算方案批准后开放，由联席会议评定档次。评定只评课题；研究单元不参加评定，全年随时可以在「<a href="#/projects">课题管理</a>」中申请。</p>
      <TopicApply me={me} />
    </>
  );
}

// ---------- 研究单元申请：全年随时。在这里提交，所挂课题的负责人同意后，联席会议成员在线投票，赞成超过总人数一半的予以立项 ----------
export function UnitApplyCard({ me, onChange }: { me: Me; onChange?: () => void }) {
  const { data, error, reload } = useViews<{ units: UnitApply[]; tags: ProjectTag[]; projects: Project[]; users: User[] }>({ units: ['unit_apply'], tags: ['project_tag'], projects: ['project'], users: ['users'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <section className="card"><h3>研究单元申请</h3><Loading error={error} /></section>;
  const finance = can(me, 'budget.setup'), recorder = can(me, 'budget.evaluate');
  const waiting = new Set(data.tags.filter((t) => t.proposed).map((t) => t.id));
  const hosts = data.projects.filter((p) => p.layer !== 'paper' && p.kind !== 'public' && p.active && !waiting.has(p.id)).sort((a, b) => a.code.localeCompare(b.code));
  const unitRows = data.units.filter((u) => u.proposed || u.mine).sort((a, b) => Number(b.proposed) - Number(a.proposed) || b.applied_at.localeCompare(a.applied_at));
  const unitAct = (u?: UnitApply): Act => ({
    title: u ? `修改研究单元申请：${u.name}` : '申请成立研究单元', label: u ? '重新提交' : '提交申请',
    hint: `研究单元一律独立申请，挂在一个已立项的课题下面，中心公共开支之下不设。全年随时可以申请，不必等年度预算。提交后先由所挂课题的负责人同意（本人即该课题负责人的免），再由联席会议成员在线投票，赞成人数超过联席会议总人数一半的，予以立项，申请人即为负责人。研究单元不参加评定，使用所挂课题的预算，不单独编预算。${u ? '修改后重新提交的，已投的票作废，须经课题负责人再次同意后重新审核。' : hosts.length === 0 ? '目前没有可挂靠的已立项课题。' : ''}`,
    fields: [...(u ? [] : [{ name: 'parent', label: '所挂课题', options: hosts.map((p): [string, string] => [p.id, `${p.code} ${p.name}${p.owner_name ? `（负责人 ${p.owner_name}）` : ''}`]) } as Field]),
      { name: 'name', label: '研究单元名称', value: u?.name },
      { name: 'note', label: '说明（研究内容，拟使用的经费和资源）', type: 'area', value: u?.apply_note ?? '' },
      { name: 'members', label: '拟加入的成员（选填，成立后可再调整）', type: 'multi', required: false, value: u?.member_ids ?? '',
        options: data.users.filter((x) => x.active && x.id !== me.id).sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((x): [string, string] => [x.id, x.name]) }],
    run: (v) => rpc('propose_unit', { id: u?.id ?? null, parent: u?.parent_id ?? v.parent, name: v.name, note: v.note, members: v.members || null }) });
  const btn = (label: string, a: Act, cls = 'sm ghost') => <button className={a.danger ? `${cls} danger` : cls} onClick={() => setAct(a)}>{label}</button>;
  const voteAct = (u: UnitApply, yes: boolean): Act => ({ title: `${yes ? '赞成' : '反对'}成立研究单元：${u.name}`, label: yes ? '赞成' : '反对', danger: !yes, fields: [],
    hint: `${u.owner_name ?? '申请人'}申请在「${u.parent_name}」之下成立该研究单元，课题负责人已同意。联席会议共 ${u.review_total} 人，赞成满 ${u.review_need} 票予以立项；反对票多到赞成已不可能超过一半的，即为未通过，退回申请人。审核有结果之前可以改投。页面只显示票数，不显示谁投了什么。`,
    run: () => rpc('vote_unit', { unit: u.id, yes }) });
  const tally = (u: UnitApply) => `赞成 ${u.yes_count}、反对 ${u.no_count}`;
  return (
    <section className="card">
      <h3>研究单元申请 <span className="h3sub">全年随时 · {recorder || finance ? '全部申请' : '本人提交的申请，本人所负责课题之下的申请；联席会议成员另可看到审核中的申请'}</span></h3>
      <p className="hint">研究单元一律独立申请，挂在一个已立项的课题下面，全年随时可以提，不必等年度预算。申请人在此提交，经所挂课题的负责人同意后，由联席会议成员（博士研究生和博士后）在线审核，采用简单投票，赞成人数超过联席会议总人数一半的，予以立项；审核结果由中台记录存档。成立后申请人即为负责人。研究单元不参加评定，使用所挂课题的预算。</p>
      {unitRows.length === 0 ? <Empty>暂无研究单元申请。</Empty> : (
        <div className="scroll"><table>
          <thead><tr><th>研究单元</th><th>所挂课题</th><th>申请人</th><th>情况</th><th /></tr></thead>
          <tbody>{unitRows.map((u) => (
            <tr key={u.id}><td className="wrap">{u.proposed ? u.name : <a href={`#/project/${u.id}`}>{u.name}</a>}<span className="sub2">{u.code}</span>{u.apply_note && <div className="sub2" style={{ marginLeft: 0 }}>{u.apply_note}</div>}
                {u.member_names && <div className="sub2" style={{ marginLeft: 0 }}>成员：{u.member_names}</div>}</td>
              <td><a href={`#/project/${u.parent_id}`}>{u.parent_name}</a></td><td>{u.owner_name ?? '—'}<div className="sub2" style={{ marginLeft: 0 }}>{day(u.applied_at)} 提交</div></td>
              <td className="wrap">{u.status === 'established' ? <><Badge tone="ok">已成立</Badge>{u.review_total != null ? <div className="sub2" style={{ marginLeft: 0 }}>联席会议{tally(u)}，共 {u.review_total} 人</div>
                  : u.checked_by_name && <div className="sub2" style={{ marginLeft: 0 }}>{u.checked_by_name} 核对</div>}</>
                : u.status === 'returned' ? <><Badge tone="bad">已退回</Badge><div className="sub2" style={{ marginLeft: 0 }}>{u.return_note}</div></>
                : u.status === 'consent' ? <><Badge tone="warn">待课题负责人同意</Badge>{u.parent_owner_name && <div className="sub2" style={{ marginLeft: 0 }}>{u.parent_owner_name}</div>}</>
                : <><Badge tone="pri">联席会议审核中</Badge><div className="sub2" style={{ marginLeft: 0 }}>{tally(u)}，满 {u.review_need} 票通过（共 {u.review_total} 人）</div>
                  {u.can_vote && <div className="sub2" style={{ marginLeft: 0 }}>本人：{u.my_vote == null ? '尚未投票' : u.my_vote ? '赞成' : '反对'}</div>}</>}</td>
              <td className="r"><div className="acts">
                {u.can_ok && u.status === 'consent' && btn('同意', { title: `同意成立研究单元：${u.name}`, label: '同意', fields: [],
                  hint: `${u.owner_name ?? '申请人'}申请在「${u.parent_name}」之下成立该研究单元。成立后，研究单元名单里的人使用本课题的预算提交支出申请、申领资源。同意后转入联席会议在线审核，赞成人数超过联席会议总人数一半的，予以立项。`, run: () => rpc('approve_unit', { unit: u.id }) }, 'sm')}
                {u.can_vote && u.my_vote !== true && btn(u.my_vote === false ? '改投赞成' : '赞成', voteAct(u, true), 'sm')}
                {u.can_vote && u.my_vote !== false && btn(u.my_vote === true ? '改投反对' : '反对', voteAct(u, false))}
                {(recorder || u.can_ok) && u.proposed && !u.return_note && btn('退回', { title: `退回申请：${u.name}`, label: '退回', danger: true, hint: '所挂课题的负责人不同意，或申请内容有误的，在审核有结果之前可以退回并写明原因，本轮审核随之停止。申请人可修改后重新提交。', fields: [{ name: 'note', label: '退回原因', type: 'area' }], run: (v) => rpc('return_unit', { unit: u.id, note: v.note }) })}
                {u.mine && u.proposed && btn('修改', unitAct(u))}
                {(u.mine || finance) && u.proposed && btn('撤回', { title: `撤回申请：${u.name}`, label: '撤回', danger: true, fields: [], hint: '撤回后该申请删除。', run: () => rpc('withdraw_unit', { unit: u.id }) })}</div></td></tr>))}</tbody>
        </table></div>
      )}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>{btn('申请成立研究单元', unitAct(), 'sm')}</div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={(v) => act.run(v).then(() => { reload(); onChange?.(); })} onClose={() => setAct(null)} />}
    </section>
  );
}
