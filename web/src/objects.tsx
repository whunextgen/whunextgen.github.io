import { useState } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, today, type Field } from './ui';
import { AXES, type AttendEvent, type Pitch, type Query, type Seminar, type Snapshot } from './iterate';
import type { Assessment } from './growth';

// 各对象自己的页面：快照、质疑、考核、研讨会，以及训练课程。从列表点进来
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
interface SnapX extends Snapshot { person_id: string | null; person_name: string | null; title: string | null }
interface QueryX extends Query { person_id: string | null; person_name: string | null }
interface ReviewNote { id: string; snapshot_id: string; author_name: string; day: string; body: string; adopted_at: string | null }
interface Course { code: string; name: string; audience: string; audience_label: string; seq: number; intro: boolean; is_new: boolean; sessions: number; last_on: string | null; mine_done: boolean }
const PITCH: Record<Pitch['status'], [string, string]> = { pending: ['warn', '待接收'], accepted: ['ok', '接收讨论'], declined: ['', '未接收'], closed: ['', '讨论结束'] };
const QST: Record<Query['status'], [string, string]> = { open: ['warn', '未回应'], resolved: ['ok', '已回应'], again: ['', '再次提出'] };
const whose = (s: { person_name: string | null; title: string | null; project_name: string }) => s.person_name ? `${s.person_name} 的主线草稿「${s.title ?? ''}」· 课题 ${s.project_name}` : `研究单元 ${s.project_name}`;
const Head = ({ crumb, title, eyebrow }: { crumb: React.ReactNode; title: string; eyebrow: string }) => (
  <><div className="crumb" style={{ fontSize: 12, color: 'var(--mute)', margin: '14px 0 6px' }}>{crumb}</div>
    <div className="top"><h2>{title}</h2></div><p className="lede">{eyebrow}</p></>);

// ---------- 快照 ----------
export function SnapshotPage({ id }: { id: string }) {
  const { data, error } = useViews<{ s: SnapX[]; pitches: Pitch[]; queries: QueryX[]; reviews: ReviewNote[] }>({ s: ['snapshot', { id }], pitches: ['snapshot_pitch', { snapshot_id: id }], queries: ['query'], reviews: ['review_note', { snapshot_id: id }] }, id);
  if (!data) return <Loading error={error} />;
  const s = data.s[0];
  if (!s) return <Empty>快照不存在。</Empty>;
  const pids = new Set(data.pitches.map((x) => x.id));
  const raised = data.queries.filter((q) => pids.has(q.pitch_id));
  const settled = data.queries.filter((q) => q.resolved_period === s.period_start && q.project_id === s.project_id && q.person_id === s.person_id && q.status === 'resolved');
  return (
    <div className="wb">
      <Head crumb={<><a href="#/iterate">快照与质疑</a> › {s.person_name ? `${s.person_name} 的主线草稿` : <a href={`#/project/${s.project_id}`}>{s.project_name}</a>} › 第 {s.seq} 次快照</>}
        title={`第 ${s.seq} 次快照`} eyebrow={`${whose(s)} · ${day(s.period_start)} 起一期 · ${s.submitted_by_name ?? ''} 提交`} />
      <section className="wb-sec">
        <h3>写作草稿</h3>
        <p><a className="btn sm" href={s.link} target="_blank" rel="noreferrer">打开草稿</a></p>
        {s.note && <p className="hint" style={{ whiteSpace: 'pre-wrap' }}>本期改了什么：{s.note}</p>}
        <p className="hint">本期有改动的成员：{s.authors.map((a) => a.name).join('、') || '—'}</p>
      </section>
      <section className="wb-sec">
        <h3>提交的研讨会 <span className="h3sub">{data.pitches.length} 个</span></h3>
        {data.pitches.length === 0 ? <Empty>尚未提交研讨会。</Empty> : <div className="scroll"><table className="wb-table">
          <thead><tr><th>研讨会</th><th>状态</th><th className="r">新记质疑</th><th className="r">再次提出</th><th className="r">本次结算</th></tr></thead>
          <tbody>{data.pitches.map((x) => <tr key={x.id}><td><a href={`#/seminar/${x.seminar}`}>{x.seminar_name}</a></td><td><Badge tone={PITCH[x.status][0]}>{PITCH[x.status][1]}</Badge>{x.note && <span className="sub2">{x.note}</span>}</td>
            <td className="r">{x.new_queries}</td><td className="r">{x.again_queries}</td><td className="r">{x.resolved}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="wb-sec">
        <h3>会上记入的质疑 <span className="h3sub">{raised.length} 条</span></h3>
        {raised.length === 0 ? <Empty>还没有记入质疑。</Empty> : <ol className="path-hist">{raised.map((q) => <li key={q.id}><b>{q.axis_label}</b> <a href={`#/query/${q.parent_id ?? q.id}`}>{q.body}</a>{q.status === 'again' && '（再次提出）'}{q.raised_by_name && ` · ${q.raised_by_name}`}</li>)}</ol>}
        {settled.length > 0 && <p className="hint">本期讨论结束时结算的质疑 {settled.length} 条，每条 16 名义币。</p>}
      </section>
      {data.reviews.length > 0 && <section className="wb-sec"><h3>审阅意见 <span className="h3sub">{data.reviews.length} 条</span></h3>
        <ul className="path-hist">{data.reviews.map((r) => <li key={r.id}>{day(r.day)} {r.author_name}：{r.body}{r.adopted_at ? '（已采纳）' : ''}</li>)}</ul></section>}
    </div>
  );
}

// ---------- 质疑 ----------
export function QueryPage({ id }: { id: string }) {
  const { data, error, reload } = useViews<{ q: QueryX[]; again: QueryX[]; people: PeoplePick[] }>({ q: ['query', { id }], again: ['query', { parent_id: id }], people: ['people_pick'] }, id);
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const q = data.q[0];
  if (!q) return <Empty>质疑不存在。</Empty>;
  const ax = AXES.find(([k]) => k === q.axis);
  const people = [...data.people].filter((p) => !q.team.some((m) => m.id === p.id)).sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  return (
    <div className="wb">
      <Head crumb={<><a href="#/iterate">快照与质疑</a> › {q.person_name ? `${q.person_name} 的主线草稿` : <a href={`#/project/${q.project_id}`}>{q.project_name}</a>} › 质疑</>}
        title={`${q.axis_label} · ${q.body.length > 30 ? q.body.slice(0, 30) + '……' : q.body}`} eyebrow={`${ax ? ax[2] : ''} · 第 ${q.snapshot_seq} 次快照 · ${q.seminar_name} · ${day(q.period_start)} 起一期${q.raised_by_name ? ` · 提出人 ${q.raised_by_name}` : ''}`} />
      <section className="wb-sec">
        <h3>状态 <Badge tone={QST[q.status][0]}>{QST[q.status][1]}</Badge></h3>
        <p style={{ fontSize: 16 }}>{q.body}</p>
        <p className="hint">{q.status === 'resolved' ? `${day(q.resolved_period)} 起一期的会上无人再提，已回应，记 16 名义币由当期有分配资格的队员平分。` : '队伍把回应写进草稿，随下一次快照在会上展示；那一期的会上没有人再提相同或类似的质疑，即为已回应。'}</p>
      </section>
      <section className="wb-sec">
        <h3>再次提出 <span className="h3sub">{data.again.length} 次</span></h3>
        {data.again.length === 0 ? <Empty>没有人再次提出。</Empty> : <ul className="path-hist">{data.again.map((a) => <li key={a.id}>{day(a.period_start)} 起一期 · {a.seminar_name}：{a.body}{a.raised_by_name ? ` · ${a.raised_by_name}` : ''}</li>)}</ul>}
      </section>
      <section className="wb-sec">
        <h3>队伍 <span className="h3sub">{q.team.length} 人</span></h3>
        {q.team.length === 0 ? <Empty>尚无队员。</Empty> : <ul className="path-hist">{q.team.map((m) => <li key={m.id}>{m.name} · {m.from} 起参与分配
          {q.can_team && q.status === 'open' && <> <button className="ghost sm danger" onClick={() => setAct({ title: `移出队伍：${m.name}`, label: '移出', danger: true, fields: [], run: () => rpc('remove_query_member', { query: q.id, user: m.id }) })}>移出</button></>}</li>)}</ul>}
        {q.status === 'open' && <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {q.can_team ? <button className="sm" onClick={() => setAct({ title: '加入队伍', label: '加入', hint: '新入队的自下一期起参与分配。', fields: [{ name: 'user', label: '成员', options: people }], run: (v) => rpc('add_query_member', { query: q.id, user: v.user }) })}>加人</button>
            : !q.in_team && <button className="sm ghost" onClick={() => setAct({ title: '申请入队', label: '申请', hint: `由 ${q.person_name ?? q.owner_name ?? '负责人'} 加人。`, fields: [{ name: 'note', label: '说明（选填）', type: 'area', required: false }], run: (v) => rpc('ask_join_query', { query: q.id, note: v.note || null }) })}>申请入队</button>}
        </div>}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}

// ---------- 考核 ----------
export function AssessmentPage({ id }: { id: string }) {
  const { data, error } = useViews<{ a: Assessment[] }>({ a: ['assessment', { id }] }, id);
  if (!data) return <Loading error={error} />;
  const a = data.a[0];
  if (!a) return <Empty>考核不存在，或本人无权查看。</Empty>;
  const steps = a.kind === 'ra' ? ['申请', '两名考核人认领', '布置小任务', '两周后认定'] : ['申请', '联席会议表决', '中心负责人决定'];
  const at = a.kind === 'ra' ? (a.status === 'applied' ? (a.examiners.length < 2 ? 1 : 2) : a.status === 'examining' ? 3 : 4) : (a.status === 'applied' ? 1 : a.status === 'recommended' ? 2 : 3);
  return (
    <div className="wb">
      <Head crumb={<><a href="#/path">成长主线</a> › 考核</>} title={`${a.person_name} · ${a.kind_label}`} eyebrow={`${day(a.applied_at)} 申请 · ${{ applied: '已申请', examining: '考核中', recommended: '待中心负责人决定', passed: '通过', failed: '未通过', withdrawn: '已撤回' }[a.status]}`} />
      <section className="wb-sec">
        <ol className="path-ladder">{steps.map((s, i) => <li key={s} className={i < at ? 'past' : i === at && !['passed', 'failed', 'withdrawn'].includes(a.status) ? 'now' : ''}><b>{s}</b></li>)}</ol>
        {a.link && <p><a className="btn sm ghost" href={a.link} target="_blank" rel="noreferrer">{a.kind === 'researcher' ? '课题提案' : a.kind === 'rising_star' ? '研究报告' : '材料'}</a></p>}
        {a.note && <p className="hint">申请说明：{a.note}</p>}
      </section>
      {a.kind === 'ra' && <section className="wb-sec"><h3>小任务</h3>
        {a.task_title ? <><p><b>{a.task_title}</b>，{day(a.task_due)} 前向两名考核人汇报</p><p className="hint" style={{ whiteSpace: 'pre-wrap' }}>{a.task_detail}</p></> : <Empty>两名考核人齐了之后由其中一人布置。</Empty>}
        <h3 style={{ marginTop: 14 }}>考核人</h3>
        {a.examiners.length === 0 ? <Empty>尚无 Researcher 认领。</Empty> : <ul className="path-hist">{a.examiners.map((e) => <li key={e.id}>{e.name}：{e.verdict === 'pass' ? '通过' : e.verdict === 'fail' ? '未通过' : '尚未认定'}{e.note ? `。${e.note}` : ''}</li>)}</ul>}
      </section>}
      {a.kind !== 'ra' && <section className="wb-sec"><h3>表决与决定</h3>
        <p className="hint">{a.council_on ? `联席会议 ${day(a.council_on)} 表决${a.council_note ? `：${a.council_note}` : ''}` : '待联席会议表决，由中心助理录入。'}</p>
        {a.decided_at && <p className="hint">{a.decided_by_name ? `${a.decided_by_name} ` : ''}{day(a.decided_at)} 决定{a.decision_note ? `：${a.decision_note}` : ''}</p>}
      </section>}
      {a.mentor_name && <p className="hint">带出此人的：{a.mentor_name}（计入其「元」和带人类主线任务）。</p>}
      <p className="hint">办理（认领、布置、认定、表决、决定）在「<a href="#/path">成长主线</a>」页的「考核」一节。</p>
    </div>
  );
}

// ---------- 研讨会 ----------
export function SeminarPage({ code }: { code: string }) {
  const { data, error } = useViews<{ s: Seminar[]; pitches: Pitch[]; events: AttendEvent[] }>({ s: ['seminar', { code }], pitches: ['snapshot_pitch', { seminar: code }], events: ['attend_event', { seminar: code }] }, code);
  if (!data) return <Loading error={error} />;
  const s = data.s[0];
  if (!s) return <Empty>研讨会不存在。</Empty>;
  const byPeriod = [...new Set(data.pitches.map((x) => x.period_start))].sort().reverse();
  return (
    <div className="wb">
      <Head crumb={<><a href="#/iterate">快照与质疑</a> › 主题研讨会</>} title={`${s.name}主题研讨会`} eyebrow={`组织者 ${s.organizer_name ?? '尚未指定'} · 主题只是开会的名目，研究单元和课题不固定归入某一个`} />
      {byPeriod.length === 0 ? <Empty>还没有快照提交给这个研讨会。</Empty> : byPeriod.map((p) => { const rows = data.pitches.filter((x) => x.period_start === p); return (
        <section className="wb-sec" key={p}>
          <h3>{day(p)} 起一期 <span className="h3sub">{rows.length} 份 · 接收 {rows.filter((x) => x.status === 'accepted' || x.status === 'closed').length} 份</span></h3>
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>稿子</th><th>快照</th><th>状态</th><th className="r">新记质疑</th><th className="r">再次提出</th><th className="r">结算</th></tr></thead>
            <tbody>{rows.map((x) => { const px = x as Pitch & { person_name?: string | null; title?: string | null }; return <tr key={x.id}><td>{px.person_name ? `${px.person_name} · ${px.title ?? '主线草稿'}` : x.project_name}<span className="sub2">{x.project_code}</span></td>
              <td><a href={`#/snapshot/${x.snapshot_id}`}>第 {x.seq} 次</a></td><td><Badge tone={PITCH[x.status][0]}>{PITCH[x.status][1]}</Badge></td>
              <td className="r">{x.new_queries}</td><td className="r">{x.again_queries}</td><td className="r">{x.resolved}</td></tr>; })}</tbody>
          </table></div>
        </section>); })}
      {data.events.length > 0 && <section className="wb-sec"><h3>出勤 <span className="h3sub">{data.events.length} 次会</span></h3>
        <ul className="path-hist">{[...data.events].sort((a, b) => b.held_on.localeCompare(a.held_on)).map((e) => <li key={e.id}>{day(e.held_on)}{e.title ? ` · ${e.title}` : ''}：出席 {e.present}，请假 {e.leave}，缺席 {e.absent}</li>)}</ul></section>}
    </div>
  );
}

// ---------- 训练课程 ----------
export function CoursesPage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ courses: Course[]; people: PeoplePick[] }>({ courses: ['course'], people: ['people_pick'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const hr = me.perms?.includes('people.manage') || me.role === 'director';
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  const groups: [string, string][] = [['intern', 'Intern（RI）'], ['assistant', 'Assistant（RA）'], ['researcher', 'Researcher']];
  return (
    <div className="wb">
      <div className="top"><h2>训练课程</h2></div>
      <p className="lede">课程为完成任务提供方法上的支持，按身份开设，自愿参加。除 Intern 的三项入门训练外，课程不是取得身份的条件。入门训练（T101、T102、T103）按出勤由中台自动认定，请假的在一周内看完回放后计入。</p>
      {groups.map(([k, n]) => { const rows = data.courses.filter((c) => c.audience === k).sort((a, b) => a.seq - b.seq); return (
        <section className="wb-sec" key={k}>
          <h3>面向 {n} <span className="h3sub">{rows.length} 门</span></h3>
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>课程</th><th className="r">已开</th><th>最近一次</th><th>本人</th>{hr && <th />}</tr></thead>
            <tbody>{rows.map((c) => <tr key={c.code}><td><span className="mono">{c.code}</span> {c.name}{c.intro && <> <Badge tone="warn">入门训练</Badge></>}{c.is_new && <span className="sub2">新设</span>}</td>
              <td className="r">{c.sessions} 次</td><td>{c.last_on ? day(c.last_on) : '—'}</td><td>{c.mine_done ? <Badge tone="ok">已完成</Badge> : <span className="sub2">—</span>}</td>
              {hr && <td className="r"><button className="ghost sm" onClick={() => setAct({ title: `登记出勤：${c.code} ${c.name}`, label: '登记',
                fields: [{ name: 'on', label: '日期', type: 'date', value: today() }, { name: 'present', label: '出席', type: 'multi', options: people, value: '' }, { name: 'leave', label: '事先请假', type: 'multi', options: people, value: '' }],
                run: (v) => rpc('record_training', { course: c.code, on: v.on, present: v.present.split(',').filter(Boolean), leave: v.leave.split(',').filter(Boolean) }) })}>登记出勤</button></td>}</tr>)}</tbody>
          </table></div>
        </section>); })}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
