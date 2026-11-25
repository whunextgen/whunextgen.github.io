import { useEffect, useState, type ReactNode } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, type Field } from './ui';
import { AXES, type Pitch, type Query } from './iterate';

// 会议现场：组织者开会时共享这一页。研讨会逐份过快照、当场记入质疑、结束讨论并结算；讲座和联席会议只签到。散会出纪要。
export interface Meeting { id: string; kind: 'lecture' | 'seminar' | 'council' | 'training'; seminar: string | null; seminar_name: string | null; held_on: string; title: string | null;
  host_name: string | null; started_at: string | null; ended_at: string | null; open: boolean; code: string | null; code_until: string | null; minutes_link: string | null; can_run: boolean;
  present: number; leave: number; absent: number; my_status: 'present' | 'leave' | 'absent' | null; my_made_up: boolean | null; roll: { name: string; status: string; made_up: boolean }[] | null }
interface Act { title: string; hint?: ReactNode; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const KIND: Record<Meeting['kind'], string> = { lecture: '周日讲座', seminar: '主题研讨会', council: '联席会议', training: '训练课程' };
export const meetingName = (m: Meeting) => m.kind === 'seminar' ? `${m.seminar_name ?? ''}主题研讨会` : m.title ?? KIND[m.kind];

export function LivePage({ id }: { id: string; me: Me }) {
  const { data, error, reload } = useViews<{ m: Meeting[]; pitches: Pitch[]; queries: Query[]; people: PeoplePick[]; sync: { id: string; feishu_no: string | null; sync_note: string | null; synced_at: string | null }[] }>({ m: ['meeting', { id }], pitches: ['snapshot_pitch'], queries: ['query'], people: ['people_pick'], sync: ['meeting_sync', { id }] }, id);
  const [act, setAct] = useState<Act | null>(null);
  const [cur, setCur] = useState('');
  const [body, setBody] = useState('');
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 现场每 15 秒刷新一次，签到人数和别人记入的质疑跟着更新
  useEffect(() => { const t = setInterval(reload, 15000); return () => clearInterval(t); }, [reload]);
  if (!data) return <Loading error={error} />;
  const m = data.m[0];
  if (!m) return <Empty>会议不存在。</Empty>;
  const per = data.pitches.length ? data.pitches.map((x) => x.period_start).sort().reverse()[0] : '';
  const agenda = m.kind === 'seminar' ? data.pitches.filter((x) => x.seminar === m.seminar && x.period_start === per && x.status !== 'declined') : [];
  const item = agenda.find((x) => x.id === cur) ?? agenda.find((x) => x.status === 'accepted') ?? agenda[0];
  const pp = item as (Pitch & { person_id?: string | null; person_name?: string | null; title?: string | null }) | undefined;
  const prior = item ? data.queries.filter((q) => q.project_id === item.project_id && (q as Query & { person_id?: string | null }).person_id == pp?.person_id && q.status === 'open' && q.period_start < item.period_start) : [];
  const here = item ? data.queries.filter((q) => q.pitch_id === item.id) : [];
  const againIds = new Set(here.filter((q) => q.status === 'again').map((q) => q.parent_id));
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const record = async (axis: string | null, parent?: string) => {
    if (!item) return;
    if (!parent && !body.trim()) { setMsg('先写下质疑'); return; }
    setBusy(true); setMsg('');
    try { await rpc('add_query', { pitch: item.id, axis, body: parent ? prior.find((q) => q.id === parent)?.body ?? '' : body, raised_by: who || null, parent: parent ?? null }); if (!parent) setBody(''); reload(); }
    catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };
  const live = m.open && m.can_run;
  return (
    <div className="ir live">
      <div className="ir-bento">
        <section className="ir-t ir-hero">
          <div>
            <div className="ir-eyebrow">{KIND[m.kind]} · {day(m.held_on)}{m.host_name ? ` · 开会 ${m.host_name}` : ''}</div>
            <h1 style={{ fontSize: 'clamp(40px,6vw,88px)' }}>{meetingName(m)}</h1>
            <div className="ir-facts">{!m.open && <div><span>缺席</span><b>{m.absent} 人</b></div>}
              {m.kind === 'seminar' && <div><span>议程</span><b>{agenda.length} 份快照</b></div>}</div>
          </div>
        </section>
        <section className="ir-t ir-turn">
          <div className="ir-mono"><span>{m.open ? '签到码' : '已散会'}</span><span>{m.open && m.code_until ? `${new Date(m.code_until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })} 前有效` : m.ended_at ? new Date(m.ended_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''}</span></div>
          <div className="ir-big">{m.open ? (m.code ?? '····') : '—'}</div>
          <dl><div><dt>已签到</dt><dd>{m.present} 人</dd></div><div><dt>请假</dt><dd>{m.leave} 人</dd></div></dl>
          <p style={{ margin: '10px 0 0', fontSize: 12, opacity: .85 }}>在正则「我的事项」点「签到」输入签到码，线上线下同等计入。</p>
        </section>

        {m.kind === 'seminar' && <>
          <section className="ir-t ir-third">
            <div className="ir-mono"><span>议程 · {day(per)} 起一期</span><span>{agenda.filter((x) => x.status === 'closed').length} / {agenda.length} 已讨论</span></div>
            {agenda.length === 0 ? <p className="ir-hint">本期没有快照提交给这个研讨会。</p> : <ol className="ir-ch">{agenda.map((x) => { const px = x as Pitch & { person_name?: string | null; title?: string | null }; return (
              <li key={x.id} className={x.status === 'closed' ? 'd' : ''} style={{ cursor: 'pointer', background: item?.id === x.id ? 'var(--i-soft)' : undefined }} onClick={() => setCur(x.id)}>
                <i /><div>{px.person_name ? `${px.person_name} · ${px.title ?? '主线草稿'}` : x.project_name}<small>第 {x.seq} 次快照 · {x.status === 'pending' ? '待接收' : x.status === 'closed' ? `已讨论，结算 ${x.resolved} 条` : '讨论中'}</small></div></li>); })}</ol>}
          </section>
          <section className="ir-t ir-main">
            {!item ? <p className="ir-hint">选一份快照开始。</p> : <>
              <div className="ir-mono"><span>正在讨论</span><a href={item.link} target="_blank" rel="noreferrer">打开草稿 →</a></div>
              <h2 style={{ font: '700 28px/1.3 var(--i-serif)', margin: '0 0 6px' }}>{pp?.person_name ? `${pp.person_name} · ${pp.title}` : item.project_name} · 第 {item.seq} 次快照</h2>
              {item.status === 'pending' && live && <div className="ir-acts"><button className="sm" onClick={() => rpc('decide_pitch', { pitch: item.id, accept: true, note: null }).then(reload)}>接收讨论</button></div>}
              {prior.length > 0 && <>
                <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>上期还没回应的 {prior.length} 条 <span className="h3sub">会上有人再次提出的，点「再次提出」；没人再提的，结束讨论时即为已回应</span></h3>
                <ul className="ir-sc">{prior.map((q) => <li key={q.id}><span><b>{q.axis_label}</b> {q.body}<small style={{ display: 'block', color: 'var(--i-mut)' }}>队伍：{q.team.map((t) => t.name).join('、') || '无'}</small></span>
                  <em>{againIds.has(q.id) ? '已再次提出' : live && item.status === 'accepted' ? <button className="ghost sm" disabled={busy} onClick={() => record(null, q.id)}>再次提出</button> : ''}</em></li>)}</ul></>}
              {live && item.status === 'accepted' && <>
                <h3 style={{ margin: '16px 0 6px', fontSize: 14 }}>记入新的质疑</h3>
                <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="与会者提出的问题或质疑，一条一记" style={{ width: '100%' }} aria-label="质疑" />
                <div className="ir-acts" style={{ alignItems: 'center' }}>
                  <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="提出的人"><option value="">提出的人（不在中台的可不选）</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  {AXES.map(([k, n, d]) => <button key={k} className="sm" disabled={busy} title={d} onClick={() => record(k)}>记入「{n}」</button>)}
                  {msg && <span className="sub2" style={{ color: 'var(--bad)' }}>{msg}</span>}
                </div></>}
              <h3 style={{ margin: '16px 0 6px', fontSize: 14 }}>本次记入 {here.length} 条</h3>
              {here.length === 0 ? <p className="ir-hint">还没有。</p> : <ul className="ir-sc">{here.map((q) => <li key={q.id}><span><b>{q.axis_label}</b> {q.body}{q.status === 'again' ? '（再次提出）' : ''}{q.raised_by_name ? ` · ${q.raised_by_name}` : ''}</span>
                <em>{q.can_remove && q.status !== 'again' ? <button className="ghost sm danger" onClick={() => rpc('remove_query', { query: q.id }).then(reload)}>删除</button> : ''}</em></li>)}</ul>}
              {live && item.status === 'accepted' && <div className="ir-acts"><button onClick={() => setAct({ title: `结束这份的讨论：${item.project_name}`, label: '结束讨论',
                hint: `结束后不能再记入。上期未回应的 ${prior.length} 条里，本次无人再提、且有可参与分配队员的，即为已回应，每条 16 名义币由队员平分。`, fields: [], run: () => rpc('close_pitch', { pitch: item.id }) })}>结束这份的讨论并结算</button></div>}
            </>}
          </section>
        </>}

        <section className="ir-t ir-half">
          <div className="ir-mono"><span>签到名单</span><span>{m.present + m.leave} 人</span></div>
          {!m.roll ? <p className="ir-hint">名单由开会的人查看。{m.my_status ? `本人：${m.my_status === 'present' ? '已签到' : m.my_status === 'leave' ? `请假${m.my_made_up ? '，已补看' : ''}` : '缺席'}` : ''}</p>
            : m.roll.length === 0 ? <p className="ir-hint">还没有人签到。</p>
            : <p style={{ lineHeight: 2 }}>{m.roll.map((r, i) => <span key={i} style={{ marginRight: 12, color: r.status === 'present' ? 'var(--i-ink)' : 'var(--i-mut)' }}>{r.name}{r.status === 'leave' ? `（请假${r.made_up ? '，已补看' : ''}）` : r.status === 'absent' ? '（缺席）' : ''}</span>)}</p>}
        </section>
        <section className="ir-t ir-half">
          <div className="ir-mono"><span>纪要</span><span>{m.open ? '开会中' : '已散会'}</span></div>
          {m.minutes_link ? <p><a className="btn sm ghost" href={m.minutes_link} target="_blank" rel="noreferrer">飞书妙记或录屏</a></p> : <p className="ir-hint">会后挂上飞书妙记或录屏的链接，请假的据此补看。</p>}
          {m.kind === 'seminar' && !m.open && <p className="ir-hint">本次讨论 {agenda.filter((x) => x.status === 'closed').length} 份快照，新记质疑 {agenda.reduce((t, x) => t + x.new_queries, 0)} 条，再次提出 {agenda.reduce((t, x) => t + x.again_queries, 0)} 条，结算 {agenda.reduce((t, x) => t + x.resolved, 0)} 条。</p>}
          {m.can_run && (() => { const sy = data.sync[0]; return <p className="ir-hint">
            飞书会议：{sy?.feishu_no ? `${sy.feishu_no.slice(0, 3)} ${sy.feishu_no.slice(3, 6)} ${sy.feishu_no.slice(6)}` : '未填'}。填了会议号的，中台每 5 分钟读一次飞书会议的参会名单，线上参会的自动签到；会后读到录制即挂上链接。
            {sy?.synced_at && <><br />上次同步 {new Date(sy.synced_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}：{sy.sync_note}</>}</p>; })()}
          {m.can_run && <div className="ir-acts">
            <button className="sm ghost" onClick={() => setAct({ title: '填飞书会议', label: '保存', hint: '粘贴飞书会议链接或 9 位会议号。会议请开录制。', fields: [{ name: 'link', label: '飞书会议链接或会议号', required: false, value: data.sync[0]?.feishu_no ?? '' }], run: (v) => rpc('set_feishu_meeting', { event: m.id, link: v.link || null }) })}>{data.sync[0]?.feishu_no ? '改飞书会议' : '填飞书会议'}</button>
            <button className="sm ghost" onClick={() => setAct({ title: '挂纪要链接', label: '保存', fields: [{ name: 'link', label: '飞书妙记或录屏的链接', required: false, value: m.minutes_link ?? '' }], run: (v) => rpc('set_minutes', { event: m.id, link: v.link || null }) })}>挂纪要链接</button>
            {m.open && <button className="sm" onClick={() => setAct({ title: `散会：${meetingName(m)}`, label: '散会', danger: true,
              hint: `签到码随即作废。事先请假的记为请假${m.kind === 'lecture' ? '；在岗人员没有签到也没有请假的，记为缺席' : ''}。${agenda.some((x) => x.status === 'accepted') ? '还有快照没有结束讨论，散会后仍可结束。' : ''}`, fields: [], run: () => rpc('end_meeting', { event: m.id }) })}>散会</button>}
          </div>}
        </section>
      </div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}

// 签到、请假、补看：放在「我的事项」
export function SignIn({ onDone }: { onDone?: () => void }) {
  const { data, reload } = useViews<{ ms: Meeting[] }>({ ms: ['meeting'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return null;
  const open = data.ms.filter((m) => m.open);
  const toMakeUp = data.ms.filter((m) => !m.open && m.my_status === 'leave' && !m.my_made_up && Date.parse(`${m.held_on}T00:00:00Z`) + 8 * 864e5 > Date.now());
  return (
    <div className="ir-acts" style={{ alignItems: 'center' }}>
      <button className="sm" onClick={() => setAct({ title: '签到', label: '签到', hint: open.length ? `正在开的会：${open.map(meetingName).join('、')}。签到码在会上共享的屏幕上。` : '现在没有正在开的会。', fields: [{ name: 'code', label: '四位签到码' }],
        run: (v) => rpc('check_in', { code: v.code }) })}>签到</button>
      <button className="sm ghost" onClick={() => setAct({ title: '请假', label: '请假', hint: '须事先请假。不能参加的，会后一周内看完回放并在这里登记补看，计为出勤。',
        fields: [{ name: 'kind', label: '哪一类会', options: [['lecture', '周日讲座'], ['seminar', '主题研讨会'], ['council', '联席会议'], ['training', '训练课程']] }, { name: 'on', label: '日期', type: 'date' }, { name: 'note', label: '原因（选填）', required: false }],
        run: (v) => rpc('ask_leave', { kind: v.kind, on: v.on, seminar: null, note: v.note || null }) })}>请假</button>
      {toMakeUp.map((m) => <button key={m.id} className="sm ghost" onClick={() => setAct({ title: `登记补看：${meetingName(m)}（${day(m.held_on)}）`, label: '已看完回放', fields: [],
        hint: m.minutes_link ? <>回放：<a href={m.minutes_link} target="_blank" rel="noreferrer">打开</a></> : '会议还没有挂回放链接。', run: () => rpc('report_makeup', { event: m.id }) })}>补看 {day(m.held_on).slice(5)} {meetingName(m)}</button>)}
      {open.map((m) => <a key={m.id} className="sm" href={`#/live/${m.id}`}>正在开：{meetingName(m)} →</a>)}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(() => { reload(); onDone?.(); })} onClose={() => setAct(null)} />}
    </div>
  );
}

// 开会：放在「快照与质疑」页的研讨会和出勤一节
export function OpenMeeting({ kind, seminar, label }: { kind: 'lecture' | 'seminar' | 'council'; seminar?: string; label: string }) {
  const [err, setErr] = useState('');
  return <><button className="sm" onClick={async () => { setErr(''); try { const id = await rpc('open_meeting', { kind, seminar: seminar ?? null, title: null }); location.hash = `#/live/${id}`; } catch (e) { setErr((e as Error).message); } }}>{label}</button>{err && <span className="sub2" style={{ color: 'var(--bad)' }}> {err}</span>}</>;
}
