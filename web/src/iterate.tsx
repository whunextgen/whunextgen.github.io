import { useState } from 'react';
import { rpc, useViews, type Me, type PeoplePick, type Project, type ProjectMember, type ProjectTag } from './api';
import { ActionDialog, Badge, Empty, Loading, can, day, num, today, type Field } from './ui';
import { OpenMeeting, type Meeting } from './live';

// 快照与质疑：《The Path of an Independent Researcher》草案第五十三版第五、六节。
// 研究单元每期交一次快照，提交给主题研讨会；组织者接收、在会上记入质疑、结束讨论；
// 未回应的质疑全中心公开，负责人组队；下一期无人再提的即为已回应，发 16 名义币由队员平分，同时记入研究单元池子的份额。
export interface Seminar { code: string; name: string; seq: number; organizer_id: string | null; organizer_name: string | null; mine: boolean; can_set: boolean;
  organizers?: { id: string; name: string }[]; oral_minutes?: number; poster_minutes?: number; oral_target?: number; poster_target?: number }
export interface Snapshot { id: string; project_id: string; project_code: string; project_name: string; owner_id: string | null; owner_name: string | null; period_start: string; seq: number;
  link: string; note: string | null; submitted_by_name: string | null; submitted_at: string; authors: { id: string; name: string }[]; can_edit: boolean; person_id?: string | null; person_name?: string | null; title?: string | null }
export interface Pitch { id: string; snapshot_id: string; project_id: string; project_code: string; project_name: string; seq: number; period_start: string; link: string;
  seminar: string; seminar_name: string; status: 'pending' | 'accepted' | 'declined' | 'closed'; note: string | null; decided_by_name: string | null; decided_at: string | null; closed_at: string | null;
  can_run: boolean; new_queries: number; again_queries: number; resolved: number; format?: 'oral' | 'poster' | null; minutes?: number | null;
  card_round?: boolean; pending_drafts?: number; card_authors?: number }
export interface Query { id: string; project_id: string; project_code: string; project_name: string; owner_id: string | null; owner_name: string | null; pitch_id: string; seminar: string; seminar_name: string;
  snapshot_seq: number; period_start: string; axis: Axis; axis_label: string; body: string; raised_by_name: string | null; parent_id: string | null; status: 'open' | 'resolved' | 'again';
  resolved_period: string | null; recorded_at: string; again: number; team: { id: string; name: string; from: string }[]; in_team: boolean; can_team: boolean; can_remove: boolean }
export interface AttendEvent { id: string; kind: 'lecture' | 'seminar' | 'council'; seminar: string | null; seminar_name: string | null; held_on: string; title: string | null; recorded_by_name: string | null;
  present: number; leave: number; absent: number; my_status: string | null }
type Axis = 'li' | 'ju' | 'ti' | 'yong';
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

export const AXES: [Axis, string, string][] = [['li', '理', '为什么读者要关注这个问题'], ['ju', '据', '为什么别人没有解决'], ['ti', '体', '为什么你能解决'], ['yong', '用', '为什么别人要关注你的解决和发现']];
const PITCH: Record<Pitch['status'], [string, string]> = { pending: ['warn', '投稿待定'], accepted: ['ok', '已接收'], declined: ['', '未接收'], closed: ['', '讨论结束'] };
const ATT: Record<AttendEvent['kind'], string> = { lecture: '周日讲座', seminar: '主题研讨会', council: '联席会议' };
// 出勤表里显示用：还有训练课程和自建会议（#77）
const EVENT_KIND: Record<string, string> = { ...ATT, training: '训练课程', other: '自建会议' };
// 两周一期，自 2026-11-23 起
const periodOf = (d: string) => { const b = Date.parse('2026-11-23T00:00:00Z'), x = Date.parse(`${day(d)}T00:00:00Z`); return new Date(b + Math.floor((x - b) / 864e5 / 14) * 14 * 864e5).toISOString().slice(0, 10); };
const ids = (v: string) => v.split(',').filter(Boolean);
const axisOf = (a: Axis) => AXES.find(([k]) => k === a)!;

export function IteratePage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ seminars: Seminar[]; snaps: Snapshot[]; pitches: Pitch[]; queries: Query[]; projects: Project[]; tags: ProjectTag[]; members: ProjectMember[]; people: PeoplePick[]; events: AttendEvent[]; meetings: Meeting[]; cal: { calendar_id: string | null; can_set: boolean }[] }>({
    seminars: ['seminar'], snaps: ['snapshot'], pitches: ['snapshot_pitch'], queries: ['query'], projects: ['project'], tags: ['project_tag'], members: ['project_member'], people: ['people_pick'], events: ['attend_event'], meetings: ['meeting'], cal: ['center_calendar'] });
  const [act, setAct] = useState<Act | null>(null);
  const [axis, setAxis] = useState('');
  const [unit, setUnit] = useState('');
  if (!data) return <Loading error={error} />;
  const per = periodOf(today());
  const waiting = new Set(data.tags.filter((t) => t.proposed).map((t) => t.id));
  const units = data.projects.filter((p) => p.layer === 'paper' && p.active && !waiting.has(p.id));
  const myUnits = units.filter((p) => p.owner_id === me.id || p.member).sort((a, b) => a.code.localeCompare(b.code));
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  // 组织者由 Researcher、Rising Star、PI 担任，Director 不参与组织（#76）
  const organizerPick = [...data.people].filter((p) => ['researcher', 'rising_star', 'pi'].includes(p.rank ?? '')).sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  const roster = (u: Project): [string, string][] => {
    const m = data.members.filter((x) => x.project_id === u.id && !x.left_on).map((x): [string, string] => [x.user_id, x.user_name]);
    return u.owner_id && !m.some(([id]) => id === u.owner_id) ? [[u.owner_id, u.owner_name ?? '负责人'], ...m] : m;
  };
  const semOpts = data.seminars.map((s): [string, string] => [s.code, `${s.name}${s.organizer_name ? `（组织者 ${s.organizer_name}）` : '（尚未指定组织者）'}`]);
  const organizer = data.seminars.some((s) => s.mine);
  const open = data.queries.filter((x) => x.status === 'open');

  const snapAct = (u: Project, s?: Snapshot): Act => ({ title: `${s ? '更新' : '提交'}本期快照：${u.name}`, label: s ? '更新' : '提交',
    hint: '快照就是这一期写作草稿的样子：整篇都在，理、据、体、用四问都有回答。填写可以打开的链接，并勾选本期在草稿里有改动的成员（日常任务按此判定）。快照不打分。',
    fields: [{ name: 'link', label: '写作草稿的链接', value: s?.link ?? '' }, { name: 'note', label: '本期改了什么（选填）', type: 'area', required: false, value: s?.note ?? '' },
      { name: 'authors', label: '本期有改动的成员', type: 'multi', options: roster(u), value: (s?.authors.map((a) => a.id) ?? [me.id]).join(',') }, { name: 'shared', label: '已把这份文档的分享设为「组织内获得链接的人可阅读」（否则别人打不开，没法读稿提质疑）', type: 'check', value: 'false' }],
    run: async (v) => { if (v.shared !== 'true') throw new Error('请先在飞书里把草稿文档的分享设为「组织内获得链接的人可阅读」，再勾选确认'); return rpc('save_snapshot', { project: u.id, link: v.link, note: v.note || null, authors: ids(v.authors) }); } });
  const pitchAct = (s: Snapshot): Act => ({ title: `提交研讨会：第 ${s.seq} 次快照`, label: '提交',
    hint: '四个研讨会都可以提交，同一期也可以交给不止一个，由所提交研讨会的组织者决定是否接收讨论。未接收的，可在下一期重新提交。',
    fields: [{ name: 'seminars', label: '研讨会', type: 'multi', options: semOpts, value: '' }], run: (v) => rpc('pitch_snapshot', { snapshot: s.id, seminars: ids(v.seminars) }) });
  const queryAct = (x: Pitch, parent?: Query): Act => ({ title: parent ? `再次提出：${parent.body.slice(0, 20)}` : `记入质疑：${x.project_name}`, label: '记入',
    hint: parent ? '与会者再次提出了相同或类似的质疑，挂在原来那一条下面，这一条继续留着，本期不结算。' : '与会者当场提出的问题和质疑逐条记入，每条指明针对理、据、体、用中的哪一问。',
    fields: [...(parent ? [] : [{ name: 'axis', label: '针对哪一问', options: AXES.map(([k, n, d]): [string, string] => [k, `${n}：${d}`]) } as Field]),
      { name: 'body', label: '质疑', type: 'area', value: parent?.body ?? '' },
      { name: 'raised_by', label: '提出的人（不在中台的与会者可不选）', options: people, required: false }],
    run: (v) => rpc('add_query', { pitch: x.id, axis: parent ? null : v.axis, body: v.body, raised_by: v.raised_by || null, parent: parent?.id ?? null }) });
  const closeAct = (x: Pitch): Act => { const earlier = open.filter((q) => q.project_id === x.project_id && q.period_start < x.period_start);
    const again = new Set(data.queries.filter((q) => q.status === 'again' && q.pitch_id === x.id).map((q) => q.parent_id));
    const settle = earlier.filter((q) => !again.has(q.id) && q.team.some((m) => m.from <= x.period_start));
    return { title: `结束讨论：${x.project_name} 第 ${x.seq} 次快照`, label: '结束讨论',
      hint: `结束后不能再记入。此前提出的 ${earlier.length} 条未回应质疑里，本次无人再提、且有可参与分配队员的 ${settle.length} 条即为已回应，每条 16 名义币由队员平分，同时记入研究单元池子的份额。${earlier.length - settle.length > 0 ? `其余 ${earlier.length - settle.length} 条继续留着。` : ''}`,
      fields: [], run: () => rpc('close_pitch', { pitch: x.id }) }; };
  // 决定点错了可以撤回（#168）：改回投稿待定再重新决定；已接收的只在还没开始讨论时可以撤回
  const undoAct = (x: Pitch): Act => ({ title: `${x.status === 'accepted' ? '撤回接收' : '撤回不接收'}：${x.project_name} 第 ${x.seq} 次快照`, label: '撤回',
    hint: '改回投稿待定，再重新决定接收为口头报告、海报或不接收。只限本期；已接收的，记入过质疑、有人交了质疑卡或点过名后不能撤回。投稿人会收到通知。',
    fields: [], run: () => rpc('undo_pitch_decision', { pitch: x.id }) });
  const teamAct = (q: Query): Act => ({ title: `组队：${q.axis_label} · ${q.body.slice(0, 24)}`, label: '加入队伍',
    hint: '本研究单元的人和其他研究单元的人都可以入队，由负责人加人。新入队的自下一期起参与分配，入队当期的名义币仍由原有成员平分。',
    fields: [{ name: 'user', label: '成员', options: people.filter(([id]) => !q.team.some((m) => m.id === id)) }], run: (v) => rpc('add_query_member', { query: q.id, user: v.user }) });
  const attendAct = (kind: AttendEvent['kind']): Act => ({ title: `登记出勤：${ATT[kind]}`, label: '登记',
    hint: '名单里勾选出席和事先请假的人；请假的在一周内看完回放后，再标记为已补看。周日讲座和主题研讨会的出勤按学期计，各不低于三分之二。',
    fields: [...(kind === 'seminar' ? [{ name: 'seminar', label: '研讨会', options: data.seminars.filter((s) => s.mine).map((s): [string, string] => [s.code, s.name]) } as Field] : []),
      { name: 'on', label: '日期', type: 'date', value: today() }, { name: 'title', label: '题目（选填）', required: false },
      { name: 'present', label: '出席', type: 'multi', options: people, value: '' }, { name: 'leave', label: '事先请假', type: 'multi', options: people, value: '' }],
    run: (v) => rpc('record_attendance', { kind, seminar: v.seminar || null, on: v.on, title: v.title || null, present: ids(v.present), leave: ids(v.leave), absent: [] }) });

  const cur = data.pitches.filter((x) => x.period_start === per);
  const rows = open.filter((q) => (!axis || q.axis === axis) && (!unit || q.project_id === unit)).sort((a, b) => a.project_code.localeCompare(b.project_code) || a.recorded_at.localeCompare(b.recorded_at));
  const againOf = (id: string) => data.queries.filter((q) => q.parent_id === id);
  const unitsWithOpen = [...new Set(open.map((q) => q.project_id))].map((id) => open.find((q) => q.project_id === id)!).sort((a, b) => a.project_code.localeCompare(b.project_code));
  const canAttend = { lecture: can(me, 'people.manage') || me.role === 'director', seminar: organizer, council: can(me, 'budget.evaluate') || me.role === 'director' };

  return (
    <div className="wb">
      <div className="top"><h2>快照与质疑</h2></div>
      <p className="lede">每两周是一次快照。研究单元把当期的写作草稿提交给主题研讨会，会上提出的质疑逐条记入，每条指明针对理、据、体、用中的哪一问。
        任务就是还没有回应的质疑：几个人组队去回应，把回应写进草稿，随下一次快照展示；下一期的会上没有人再提的，即为已回应，发 16 名义币，由队员平分，同时记入研究单元池子的份额。本期 {per} 至 {day(new Date(Date.parse(`${per}T00:00:00Z`) + 13 * 864e5).toISOString())}。</p>

      <section className="wb-sec">
        <h3>本期快照 <span className="h3sub">本人负责或在名单里的研究单元</span></h3>
        {myUnits.length === 0 ? <Empty>本人尚不在任何已成立的研究单元里。回应某个研究单元的一条质疑、经负责人同意，即进入该研究单元。</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>研究单元</th><th>本期快照</th><th>研讨会</th><th>未回应的质疑</th><th /></tr></thead>
            <tbody>{myUnits.map((u) => { const s = data.snaps.find((x) => x.project_id === u.id && x.period_start === per); const ps = s ? data.pitches.filter((x) => x.snapshot_id === s.id) : [];
              return (<tr key={u.id}>
                <td><a href={`#/project/${u.id}`}>{u.name}</a><span className="sub2">{u.code}{u.owner_id === me.id ? ' · 本人负责' : ''}</span></td>
                <td className="wrap">{s ? <><a href={s.link} target="_blank" rel="noreferrer">第 {s.seq} 次快照</a><span className="sub2">有改动：{s.authors.map((a) => a.name).join('、') || '—'}</span></> : <span className="sub2">本期尚未提交</span>}</td>
                <td className="wrap">{ps.length === 0 ? <span className="sub2">—</span> : ps.map((x) => <div key={x.id}>{x.seminar_name} <Badge tone={PITCH[x.status][0]}>{PITCH[x.status][1]}</Badge></div>)}</td>
                <td className="r">{open.filter((q) => q.project_id === u.id).length}</td>
                <td className="r"><div className="acts">
                  {(!s || s.can_edit) && !ps.some((x) => x.status === 'closed') && <button className="sm" onClick={() => setAct(snapAct(u, s))}>{s ? '更新快照' : '提交快照'}</button>}
                  {s?.can_edit && <button className="ghost sm" onClick={() => setAct(pitchAct(s))}>提交研讨会</button>}
                </div></td></tr>); })}</tbody>
          </table></div>)}
      </section>

      <section className="wb-sec">
        <h3>本人主线上的草稿 <span className="h3sub">开题稿、综述、方案报告、立场论文等，挂在一个课题之下，由该课题的负责人指导</span></h3>
        {(() => { const mine = data.snaps.filter((x) => x.person_id === me.id).sort((a, b) => b.period_start.localeCompare(a.period_start) || b.seq - a.seq); const curP = mine.filter((x) => x.period_start === per);
          const topics = data.projects.filter((p) => p.layer !== 'paper' && p.kind !== 'public' && p.active && !waiting.has(p.id)).sort((a, b) => a.code.localeCompare(b.code));
          return <>
            {mine.length === 0 ? <Empty>还没有交过本人主线草稿的快照。主线上的每一项成果都按同样的办法做：有自己的草稿，每两周取快照，在会上展示并接受质疑。</Empty> : (
              <ul className="path-hist">{mine.slice(0, 8).map((x) => <li key={x.id}>{day(x.period_start)} 起一期 · <a href={`#/snapshot/${x.id}`}>「{x.title}」第 {x.seq} 次快照</a> · 课题 {x.project_name}
                {x.can_edit && <> <button className="ghost sm" onClick={() => setAct(pitchAct(x))}>提交研讨会</button></>}</li>)}</ul>)}
            <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm ghost" onClick={() => setAct({ title: '交本人主线草稿的快照', label: '提交',
              hint: `本期每个课题之下一份，再交即更新${curP.length ? `；本期已交 ${curP.map((x) => `「${x.title}」`).join('')}` : ''}。回应这份草稿上的质疑同样记名义币。`,
              fields: [{ name: 'topic', label: '挂在哪个课题之下', options: topics.map((p): [string, string] => [p.id, `${p.code} ${p.name}`]) }, { name: 'title', label: '哪一项成果（如开题稿、综述、方案报告、立场论文）' },
                { name: 'link', label: '写作草稿的链接' }, { name: 'note', label: '本期改了什么（选填）', type: 'area', required: false }, { name: 'shared', label: '已把这份文档的分享设为「组织内获得链接的人可阅读」（否则别人打不开，没法读稿提质疑）', type: 'check', value: 'false' }],
              run: async (v) => { if (v.shared !== 'true') throw new Error('请先在飞书里把草稿文档的分享设为「组织内获得链接的人可阅读」，再勾选确认'); return rpc('save_personal_snapshot', { topic: v.topic, title: v.title, link: v.link, note: v.note || null }); } })}>交主线草稿的快照</button></div>
          </>; })()}
      </section>

      <section className="wb-sec">
        <h3>主题研讨会 <span className="h3sub">认知基础、医疗、金融、人文社会；研究单元不固定归入某一个</span></h3>
        <div className="tiles">{data.seminars.map((s) => { const n = cur.filter((x) => x.seminar === s.code); return (
          <div className="tile" key={s.code}><div className="k"><a href={`#/seminar/${s.code}`}>{s.name}</a></div>
            <div className="v" style={{ fontSize: 15 }}>{n.filter((x) => x.status !== 'declined').length} 份</div>
            <div className="f">组织者 {s.organizer_name ?? '尚未指定'}{n.some((x) => x.status === 'pending') && ` · 待接收 ${n.filter((x) => x.status === 'pending').length}`}</div>
            {(() => { const om = data.meetings.find((x) => x.open && x.kind === 'seminar' && x.seminar === s.code); return om
              ? <div className="acts" style={{ justifyContent: 'flex-start', marginTop: 6 }}><a className="btn sm" href={`#/live/${om.id}`}>进入现场 · 签到 {om.present}</a></div>
              : s.mine && <div className="acts" style={{ justifyContent: 'flex-start', marginTop: 6 }}><OpenMeeting kind="seminar" seminar={s.code} label="开会" /></div>; })()}
            {s.can_set && <div className="acts" style={{ justifyContent: 'flex-start', marginTop: 6 }}><button className="ghost sm" onClick={() => setAct({ title: `指定组织者：${s.name}`, label: '保存',
              hint: '每个研讨会至少两位组织者，由 Researcher、Rising Star 和 PI 担任（Director 不参与组织），一起接收投稿、决定口头报告或海报、开会并记入质疑，记入各自的「亨」。', fields: [{ name: 'users', label: '组织者（至少两位）', type: 'multi', options: organizerPick, value: (s.organizers ?? []).map((o) => o.id).join(',') }],
              run: (v) => rpc('set_seminar_organizers', { seminar: s.code, users: ids(v.users) }) })}>指定组织者</button></div>}
            {s.mine && <div className="acts" style={{ justifyContent: 'flex-start', marginTop: 6 }}><button className="ghost sm" onClick={() => setAct({ title: `形式与目标：${s.name}`, label: '保存',
              hint: '口头报告和海报的讨论时长，以及每份希望收获的质疑条数。', fields: [{ name: 'om', label: '口头报告（分钟）', type: 'number', value: String(s.oral_minutes ?? 10) }, { name: 'pm', label: '海报（分钟）', type: 'number', value: String(s.poster_minutes ?? 5) },
                { name: 'ot', label: '口头报告的质疑目标（条）', type: 'number', value: String(s.oral_target ?? 3) }, { name: 'pt', label: '海报的质疑目标（条）', type: 'number', value: String(s.poster_target ?? 1) }],
              run: async (v) => { await rpc('set_seminar_minutes', { seminar: s.code, oral: Math.round(Number(v.om)), poster: Math.round(Number(v.pm)) }); await rpc('set_seminar_targets', { seminar: s.code, oral: Math.round(Number(v.ot)), poster: Math.round(Number(v.pt)) }); } })}>形式与目标</button></div>}
          </div>); })}</div>
        {cur.length === 0 ? <Empty>本期还没有快照提交给研讨会。</Empty> : (
          <div className="scroll" style={{ marginTop: 12 }}><table className="wb-table">
            <thead><tr><th>研讨会</th><th>研究单元</th><th>快照</th><th>状态</th><th className="r">本次质疑</th><th /></tr></thead>
            <tbody>{cur.sort((a, b) => a.seminar.localeCompare(b.seminar) || a.project_code.localeCompare(b.project_code)).map((x) => (
              <tr key={x.id}>
                <td><a href={`#/seminar/${x.seminar}`}>{x.seminar_name}</a></td><td>{(x as Pitch & { person_name?: string | null; title?: string | null }).person_name ? `${(x as Pitch & { person_name?: string | null }).person_name} · ${(x as Pitch & { title?: string | null }).title ?? '主线草稿'}` : x.project_name}<span className="sub2">{x.project_code}</span></td>
                <td><a href={`#/snapshot/${x.snapshot_id}`}>第 {x.seq} 次</a></td>
                <td className="wrap"><Badge tone={PITCH[x.status][0]}>{PITCH[x.status][1]}</Badge>{x.format && <span className="sub2">{x.format === 'oral' ? '口头报告' : '海报'} · {x.minutes} 分钟</span>}{x.note && <span className="sub2">{x.note}</span>}
                  {x.status === 'closed' && <span className="sub2">已回应 {x.resolved} 条</span>}</td>
                <td className="r">{x.new_queries}{x.again_queries > 0 && <span className="sub2">再次提出 {x.again_queries}</span>}</td>
                <td className="r">{x.can_run && <div className="acts">
                  {x.status === 'pending' && <><button className="sm" onClick={() => rpc('decide_pitch', { pitch: x.id, accept: true, note: null, format: 'oral' }).then(reload)}>口头报告</button>
                    <button className="sm" onClick={() => rpc('decide_pitch', { pitch: x.id, accept: true, note: null, format: 'poster' }).then(reload)}>海报</button>
                    <button className="ghost sm" onClick={() => setAct({ title: `不接收：${x.project_name}`, label: '不接收', hint: '未接收的，当期不展示，可在下一期重新提交。', fields: [{ name: 'note', label: '说明（选填）', required: false }], run: (v) => rpc('decide_pitch', { pitch: x.id, accept: false, note: v.note || null }) })}>不接收</button></>}
                  {x.status === 'accepted' && <><button className="sm" onClick={() => setAct(queryAct(x))}>记入质疑</button>
                    <button className="ghost sm" onClick={() => setAct({ title: `再次提出：${x.project_name}`, label: '下一步', hint: '选出被再次提出的那一条。', fields: [{ name: 'q', label: '原来那一条', options: open.filter((q) => q.project_id === x.project_id && q.period_start < x.period_start).map((q): [string, string] => [q.id, `${q.axis_label}：${q.body.slice(0, 40)}`]) }],
                      run: async (v) => { const p = open.find((q) => q.id === v.q); if (p) setTimeout(() => setAct(queryAct(x, p)), 0); } })}>再次提出</button>
                    <button className="ghost sm" onClick={() => setAct(closeAct(x))}>结束讨论</button>
                    {x.new_queries + x.again_queries === 0 && !x.card_round && <button className="ghost sm" onClick={() => setAct(undoAct(x))}>撤回接收</button>}</>}
                  {x.status === 'declined' && <button className="ghost sm" onClick={() => setAct(undoAct(x))}>撤回不接收</button>}
                </div>}</td>
              </tr>))}</tbody>
          </table></div>)}
        {cur.filter((x) => x.can_run && x.status === 'accepted').map((x) => { const qs = data.queries.filter((q) => q.pitch_id === x.id); return qs.length === 0 ? null : (
          <div key={x.id} className="path-sel"><h3>{x.seminar_name} · {x.project_name} <span className="h3sub">本次已记入 {qs.length} 条</span></h3>
            <ul className="path-hist">{qs.map((q) => <li key={q.id}><b>{q.axis_label}</b> {q.body}{q.status === 'again' && '（再次提出）'}{q.raised_by_name && ` · ${q.raised_by_name}`}
              {q.can_remove && q.status !== 'again' && <> <button className="ghost sm danger" onClick={() => setAct({ title: '删除这条质疑', label: '删除', danger: true, fields: [], run: () => rpc('remove_query', { query: q.id }) })}>删除</button></>}</li>)}</ul></div>); })}
      </section>

      <section className="wb-sec">
        <h3>未回应的质疑 <span className="h3sub">共 {open.length} 条，全中心公开</span></h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button aria-pressed={axis === ''} onClick={() => setAxis('')}>全部</button>
          {AXES.map(([k, n]) => <button key={k} aria-pressed={axis === k} onClick={() => setAxis(k)}>{n} {open.filter((q) => q.axis === k).length}</button>)}
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="研究单元" style={{ marginLeft: 8 }}>
            <option value="">全部研究单元</option>{unitsWithOpen.map((q) => <option key={q.project_id} value={q.project_id}>{q.project_code} {q.project_name}</option>)}
          </select>
        </div>
        {rows.length === 0 ? <Empty>没有未回应的质疑。</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>研究单元</th><th>一问</th><th>质疑</th><th>提出</th><th>队伍</th><th /></tr></thead>
            <tbody>{rows.map((q) => { const ag = againOf(q.id); return (
              <tr key={q.id}>
                <td>{q.project_name}<span className="sub2">{q.project_code} · 负责人 {q.owner_name ?? '—'}</span></td>
                <td title={axisOf(q.axis)[2]}><b>{q.axis_label}</b></td>
                <td className="wrap"><a href={`#/query/${q.id}`}>{q.body}</a>{ag.length > 0 && <span className="sub2">再次提出 {ag.length} 次：{ag.map((a) => `${day(a.period_start)} ${a.body.slice(0, 30)}`).join('；')}</span>}</td>
                <td>{day(q.period_start)} 起一期<span className="sub2">{q.seminar_name} · 第 {q.snapshot_seq} 次快照</span></td>
                <td className="wrap">{q.team.length === 0 ? <span className="sub2">尚无队员</span> : q.team.map((m) => <span key={m.id} className="sub2" style={{ display: 'block' }}>{m.name}{m.from > per ? `（${m.from} 起参与分配）` : ''}
                  {q.can_team && <> <button className="ghost sm danger" onClick={() => setAct({ title: `移出队伍：${m.name}`, label: '移出', danger: true, fields: [], run: () => rpc('remove_query_member', { query: q.id, user: m.id }) })}>移出</button></>}</span>)}</td>
                <td className="r"><div className="acts">
                  {q.can_team && <button className="sm" onClick={() => setAct(teamAct(q))}>加人</button>}
                  {!q.can_team && !q.in_team && <button className="ghost sm" onClick={() => setAct({ title: `申请入队：${q.body.slice(0, 24)}`, label: '申请', hint: `入队由研究单元的负责人 ${q.owner_name ?? ''} 加人，本人不能自行加入。提交后通知负责人。`,
                    fields: [{ name: 'note', label: '说明（选填）', type: 'area', required: false }], run: (v) => rpc('ask_join_query', { query: q.id, note: v.note || null }) })}>申请入队</button>}
                  {q.in_team && !q.can_team && <Badge tone="ok">已在队里</Badge>}
                </div></td>
              </tr>); })}</tbody>
          </table></div>)}
      </section>

      {(canAttend.lecture || canAttend.seminar || canAttend.council) && (
        <section className="wb-sec">
          <h3>出勤登记 <span className="h3sub">日常任务按此判定</span></h3>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            {canAttend.lecture && (data.meetings.some((x) => x.open && x.kind === 'lecture') ? <a className="btn sm" href={`#/live/${data.meetings.find((x) => x.open && x.kind === 'lecture')!.id}`}>进入讲座现场</a> : <OpenMeeting kind="lecture" label="开周日讲座签到" />)}
            {canAttend.council && (data.meetings.some((x) => x.open && x.kind === 'council') ? <a className="btn sm" href={`#/live/${data.meetings.find((x) => x.open && x.kind === 'council')!.id}`}>进入联席会议现场</a> : <OpenMeeting kind="council" label="开联席会议签到" />)}
            {(['lecture', 'seminar', 'council'] as const).filter((k) => canAttend[k]).map((k) => <button key={k} className="sm ghost" onClick={() => setAct(attendAct(k))}>补登{ATT[k]}出勤</button>)}
            {data.cal[0]?.can_set && <button className="sm ghost" onClick={() => setAct({ title: '中心日历', label: '保存', hint: '飞书会议都加到中心日历上。开会时中台到中心日历里找同一时段、标题含研讨会名称（或「讲座」「联席」）的日程，把其中的飞书会议自动挂上。填中心日历的名称（如 CLAIN日历）或日历编号。',
              fields: [{ name: 'id', label: '日历名称或编号', required: false, value: data.cal[0]?.calendar_id ?? '' }], run: (v) => rpc('set_center_calendar', { id: v.id || null }) })}>中心日历{data.cal[0]?.calendar_id ? '（已设）' : '（未设）'}</button>}
          </div>
          {data.events.length > 0 && <div className="scroll"><table className="wb-table">
            <thead><tr><th>日期</th><th>会议</th><th className="r">出席</th><th className="r">请假</th><th className="r">缺席</th><th>登记人</th></tr></thead>
            <tbody>{[...data.events].sort((a, b) => b.held_on.localeCompare(a.held_on)).slice(0, 12).map((e) => <tr key={e.id}><td>{day(e.held_on)}</td><td><a href={`#/live/${e.id}`}>{e.seminar_name ?? EVENT_KIND[e.kind] ?? '会议'}</a>{e.title && <span className="sub2">{e.title}</span>}</td>
              <td className="r">{e.present}</td><td className="r">{e.leave}</td><td className="r">{e.absent}</td><td>{e.recorded_by_name}</td></tr>)}</tbody>
          </table></div>}
        </section>)}

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}

// 研究单元页：按设计稿 ir-unit-card。本回合、历次快照、四问上的质疑、待回应质疑和队伍、审阅意见
interface ReviewNote { id: string; snapshot_id: string; project_id: string; project_name: string; seq: number; author_id: string; author_name: string; day: string; body: string; adopted_at: string | null; can_adopt: boolean }
export function UnitIterate({ unit, me }: { unit: Project; me: Me }) {
  const { data, reload } = useViews<{ snaps: Snapshot[]; queries: Query[]; reviews: ReviewNote[]; people: PeoplePick[] }>({ snaps: ['snapshot', { project_id: unit.id }], queries: ['query', { project_id: unit.id }],
    reviews: ['review_note', { project_id: unit.id }], people: ['people_pick'] }, unit.id);
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return null;
  const per = periodOf(today());
  const left = Math.max(0, Math.round((Date.parse(`${per}T00:00:00Z`) + 13 * 864e5 - Date.parse(`${today()}T00:00:00Z`)) / 864e5) + 1);
  const snaps = [...data.snaps].sort((a, b) => a.seq - b.seq);
  const curSnap = snaps.find((x) => x.period_start === per);
  const open = data.queries.filter((q) => q.status === 'open').sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const all = data.queries.filter((q) => q.status !== 'again');
  // 连续有快照的期数，从上一期往回数
  let run = 0; for (let d = curSnap ? per : new Date(Date.parse(`${per}T00:00:00Z`) - 14 * 864e5).toISOString().slice(0, 10); snaps.some((x) => x.period_start === d); d = new Date(Date.parse(`${d}T00:00:00Z`) - 14 * 864e5).toISOString().slice(0, 10)) run++;
  const lead = unit.owner_id === me.id || me.role === 'director';
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  const teamAct = (q: Query): Act => ({ title: `组队：${q.axis_label} · ${q.body.slice(0, 24)}`, label: '加入队伍',
    hint: '本研究单元的人和其他研究单元的人都可以入队，由负责人加人。新入队的自下一期起参与分配，并同时进入本研究单元的成员名单（已在名单里的不重复加）。',
    fields: [{ name: 'user', label: '成员', options: people.filter(([id]) => !q.team.some((m) => m.id === id)) }], run: (v) => rpc('add_query_member', { query: q.id, user: v.user }) });
  const pending = data.reviews.filter((r) => !r.adopted_at);
  return (
    <>
      <div className="ir" style={{ marginBottom: 18 }}>
        <div className="ir-bento">
          <section className="ir-t ir-hero">
            <div className="ir-mono"><span>快照 · 每两周一次，依次编号</span><a href="#/iterate">快照与质疑 →</a></div>
            <div className="ir-snaps">{snaps.map((x) => <a key={x.id} href={x.link} target="_blank" rel="noreferrer" className={x.period_start === per ? 'cur' : ''}>{md2(x.period_start)}<b>快照 {x.seq}</b></a>)}
              {!curSnap && <span className="cur">本回合<b>快照 {snaps.length + 1}</b></span>}</div>
            <p className="ir-hint">每一次迭代把整篇再做一轮。研究单元的进度看相邻两次快照之间变了什么，以及理、据、体、用四问上还有哪些质疑没有回应。</p>
          </section>
          <section className="ir-t ir-turn">
            <div className="ir-mono"><span>本回合 · 第 {curSnap ? curSnap.seq : snaps.length + 1} 次快照</span><span>{md2(per)} — {md2(new Date(Date.parse(`${per}T00:00:00Z`) + 13 * 864e5).toISOString().slice(0, 10))}</span></div>
            <div className="ir-big">{left}<small>天</small></div>
            <dl><div><dt>待回应质疑</dt><dd>{open.length} 条</dd></div><div><dt>连续有快照</dt><dd>{run} 期</dd></div></dl>
          </section>
          <section className="ir-q4" style={{ gridColumn: '1 / -1' }}>{AXES.map(([k, n, d], i) => { const o = open.filter((q) => q.axis === k), t = all.filter((q) => q.axis === k), done = t.filter((q) => q.status === 'resolved').length; const top = o[0];
            return <div key={k}><span className="ir-mono" style={{ margin: 0 }}><span>0{i + 1} / 质疑</span><span className="val">{o.length}</span></span><b>{n}</b><small>{d}</small>
              <p>{top ? `「${top.body.slice(0, 40)}」` : ''}</p><small>未回应 {o.length} 条 · 累计 {t.length} 条，已回应 {done} 条{top ? ` · 队伍：${top.team.map((m) => m.name).join('、') || '待组队'}` : ''}</small></div>; })}</section>
        </div>
      </div>
      <section className="card" id="sec-iterate">
        <h3>待回应质疑 <span className="h3sub">每条是一个小副本，下一期无人再提即为已回应 · 共 {open.length} 条，{open.filter((q) => q.team.length === 0).length} 条待组队</span></h3>
        {open.length === 0 ? <Empty>没有未回应的质疑。{curSnap ? '' : '本期快照还没有提交，在「快照与质疑」提交并交给主题研讨会。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>#</th><th>一问</th><th>质疑</th><th>提出</th><th>队伍</th><th /></tr></thead>
            <tbody>{open.map((q, i) => <tr key={q.id}><td className="mono">{String(i + 1).padStart(2, '0')}</td><td><b>{q.axis_label}</b></td>
              <td className="wrap">{q.body}{q.again > 0 && <span className="sub2">再次提出 {q.again} 次</span>}</td>
              <td>{q.raised_by_name ?? '—'}<span className="sub2">第 {q.snapshot_seq} 次快照 · {q.seminar_name}</span></td>
              <td className="wrap">{q.team.length ? `${q.team.map((m) => m.name).join('、')}` : <span className="sub2">待组队</span>}{q.team.length > 0 && <span className="sub2">队伍 {q.team.length} 人</span>}</td>
              <td className="r">{q.can_team ? <button className="ghost sm" onClick={() => setAct(teamAct(q))}>加人</button>
                : !q.in_team && <button className="ghost sm" onClick={() => setAct({ title: `申请入队：${q.body.slice(0, 24)}`, label: '申请', hint: `入队由负责人 ${q.owner_name ?? ''} 加人。`, fields: [{ name: 'note', label: '说明（选填）', type: 'area', required: false }], run: (v) => rpc('ask_join_query', { query: q.id, note: v.note || null }) })}>申请入队</button>}</td></tr>)}</tbody>
          </table></div>)}
        {data.reviews.length > 0 && <>
          <h3 style={{ marginTop: 18 }}>审阅意见 <span className="h3sub">其他研究单元的人当日审阅本单元快照提的意见 · {pending.length} 条待采纳</span></h3>
          <ul className="path-hist">{[...data.reviews].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 8).map((r) => <li key={r.id}>{day(r.day)} {r.author_name} · 第 {r.seq} 次快照：{r.body}
            {r.adopted_at ? '（已采纳）' : r.can_adopt && <> <button className="ghost sm" onClick={() => setAct({ title: '采纳审阅意见', label: '采纳', hint: '采纳后记入审阅人的「利」；可在下一次研讨会上作为质疑提出。', fields: [], run: () => rpc('adopt_review', { id: r.id }) })}>采纳</button></>}</li>)}</ul></>}
        {lead && <p className="hint">质疑由研讨会组织者在会上记入；负责人为质疑组队、把各人写的收成一篇。</p>}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
const md2 = (d: string) => day(d).slice(5);
