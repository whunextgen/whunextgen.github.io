import { useEffect, useState, type ReactNode } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, type Field } from './ui';
import { AXES, type Pitch, type Query, type Seminar } from './iterate';

// 会议现场：组织者开会时共享这一页。研讨会逐份过快照、当场记入质疑、结束讨论并结算；讲座和联席会议只签到。散会出纪要。
export interface Meeting { id: string; kind: 'lecture' | 'seminar' | 'council' | 'training' | 'other'; seminar: string | null; seminar_name: string | null; held_on: string; title: string | null;
  host_name: string | null; started_at: string | null; ended_at: string | null; open: boolean; code: string | null; code_until: string | null; minutes_link: string | null; can_run: boolean;
  present: number; leave: number; absent: number; my_status: 'present' | 'leave' | 'absent' | null; my_made_up: boolean | null; roll: { name: string; status: string; made_up: boolean }[] | null }
interface Act { title: string; hint?: ReactNode; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const KIND: Record<Meeting['kind'], string> = { lecture: '周日讲座', seminar: '主题研讨会', council: '联席会议', training: '训练课程', other: '自建会议' };
interface Draft { id: string; pitch_id: string; axis: string; axis_label: string; body: string; parent_id: string | null; author_id: string | null; author_name: string | null; status: 'pending' | 'accepted' | 'dropped'; mine: boolean; can_accept: boolean;
  source: 'card' | 'transcript'; speaker: string | null; quote: string | null }
interface Transcript { id: string; source: 'feishu' | 'zoom' | null; fetched_at: string | null; tries: number; note: string | null; extracted_at: string | null; extract_note: string | null; drafts: number | null; chars: number | null; body: string | null }
export const meetingName = (m: Meeting) => m.kind === 'seminar' ? `${m.seminar_name ?? ''}主题研讨会` : m.title ?? KIND[m.kind];

export function LivePage({ id }: { id: string; me: Me }) {
  const { data, error, reload } = useViews<{ m: Meeting[]; pitches: Pitch[]; queries: Query[]; people: PeoplePick[]; sync: { id: string; feishu_no: string | null; zoom_id: string | null; sync_note: string | null; synced_at: string | null; sync_unmatched: string[] | null }[]; drafts: Draft[]; seminars: Seminar[]; order: { pitch_id: string; user_id: string; user_name: string; this_turn: 'query' | 'pass' | null; recent_turns: number; seq: number }[]; tr: Transcript[] }>({ m: ['meeting', { id }], pitches: ['snapshot_pitch'], queries: ['query'], people: ['people_pick'], sync: ['meeting_sync', { id }], drafts: ['query_draft'], seminars: ['seminar'], order: ['speak_order'], tr: ['meeting_transcript', { id }] }, id);
  const [mine, setMine] = useState('');

  const [act, setAct] = useState<Act | null>(null);
  const [cur, setCur] = useState('');
  const [body, setBody] = useState('');
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  // 现场每 15 秒刷新一次，签到人数和别人记入的质疑跟着更新
  useEffect(() => { const t = setInterval(reload, 15000); return () => clearInterval(t); }, [reload]);
  if (!data) return <Loading error={error} />;
  const m = data.m[0];
  if (!m) return <Empty>会议不存在。</Empty>;
  const per = data.pitches.length ? data.pitches.map((x) => x.period_start).sort().reverse()[0] : '';
  // 议程：先口头报告，再海报，待定的投稿放最后
  const rankOf = (x: Pitch) => x.status === 'pending' ? 2 : x.format === 'poster' ? 1 : 0;
  const agenda = m.kind === 'seminar' ? data.pitches.filter((x) => x.seminar === m.seminar && x.period_start === per && x.status !== 'declined').sort((a, b) => rankOf(a) - rankOf(b)) : [];
  const sem = data.seminars.find((x) => x.code === m.seminar);
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
  const target = item?.format === 'poster' ? sem?.poster_target ?? 1 : sem?.oral_target ?? 3;
  const got = here.length;
  const drafts = item ? data.drafts.filter((d) => d.pitch_id === item.id && d.status === 'pending') : [];
  // 写卡：到场的人（汇报人除外）里还没交卡的
  const carded = new Set(item ? data.drafts.filter((d) => d.pitch_id === item.id && d.source === 'card').map((d) => d.author_id) : []);
  const noCard = item ? data.order.filter((o) => o.pitch_id === item.id && !carded.has(o.user_id)) : [];
  const tr = data.tr[0];
  const accept = (d: Draft, ok: boolean) => rpc('accept_query_draft', { id: d.id, accept: ok, raised_by: ok ? (pick[d.id] ?? d.author_id ?? null) || null : null }).then(reload).catch((e) => setMsg((e as Error).message));
  const order = item ? data.order.filter((o) => o.pitch_id === item.id).sort((a, b) => a.seq - b.seq) : [];
  const nextUp = order.find((o) => !o.this_turn);
  const submitDraft = async (axis: string) => {
    if (!item || !mine.trim()) { setMsg('先写下质疑'); return; }
    setBusy(true); setMsg('');
    try { await rpc('submit_query_draft', { pitch: item.id, axis, body: mine, parent: null }); setMine(''); setMsg('已提交，等组织者记入'); reload(); } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };
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
                <i /><div>{px.person_name ? `${px.person_name} · ${px.title ?? '主线草稿'}` : x.project_name}<small>{x.format === 'oral' ? `口头报告 ${x.minutes} 分钟` : x.format === 'poster' ? `海报 ${x.minutes} 分钟` : '投稿待定'} · 第 {x.seq} 次快照 · {x.status === 'closed' ? `已讨论，结算 ${x.resolved} 条` : x.status === 'accepted' ? (x.card_round ? '写卡中' : '待讨论') : ''}{m.can_run && x.pending_drafts ? ` · 待记入 ${x.pending_drafts} 条` : ''}</small></div></li>); })}</ol>}
          </section>
          <section className="ir-t ir-main">
            {!item ? <p className="ir-hint">选一份快照开始。</p> : <>
              <div className="ir-mono"><span>正在讨论 · {item.format === 'oral' ? '口头报告' : item.format === 'poster' ? '海报' : '投稿待定'}{item.minutes ? ` · ${item.minutes} 分钟` : ''}</span><a href={item.link} target="_blank" rel="noreferrer">打开草稿 →</a></div>
              {item.status === 'accepted' && <div className="ir-conv" style={{ marginTop: 0, marginBottom: 12 }}>
                <div><small>收获质疑</small><b style={{ color: got >= target ? 'var(--i-ink)' : 'var(--i-red)' }}>{got}</b><em>/ 目标 {target} 条</em></div><i />
                <div><small>轮流发言</small><b>{order.filter((o) => o.this_turn).length}</b><em>/ 到场 {order.length} 人</em></div><i />
                {item.card_round ? <div><small>写卡中</small><b>{item.card_authors ?? 0}</b><em>/ 到场 {order.length} 人已交卡</em></div>
                  : <div><small>待记入</small><b>{drafts.length}</b><em>条与会者提的</em></div>}</div>}
              <h2 style={{ font: '700 28px/1.3 var(--i-serif)', margin: '0 0 6px' }}>{pp?.person_name ? `${pp.person_name} · ${pp.title}` : item.project_name} · 第 {item.seq} 次快照</h2>
              {item.status === 'pending' && live && <div className="ir-acts"><button className="sm" onClick={() => rpc('decide_pitch', { pitch: item.id, accept: true, note: null, format: 'oral' }).then(reload)}>接收为口头报告</button>
                <button className="sm" onClick={() => rpc('decide_pitch', { pitch: item.id, accept: true, note: null, format: 'poster' }).then(reload)}>接收为海报</button>
                <button className="ghost sm" onClick={() => rpc('decide_pitch', { pitch: item.id, accept: false, note: null, format: null }).then(reload)}>不接收</button></div>}
              {live && item.status === 'accepted' && <>
                <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>写质疑卡 <span className="h3sub">讲完后请到场的每个人在自己的手机或电脑上写一张，同时写、互不影响；收卡后挑几条请汇报人回应</span></h3>
                <div className="ir-acts" style={{ alignItems: 'center' }}>{item.card_round
                  ? <><button className="sm" onClick={() => rpc('set_card_round', { pitch: item.id, open: false }).then(reload)}>收卡</button>
                    <span className="ir-hint" style={{ margin: 0 }}>{noCard.length ? `还没交：${noCard.map((o) => o.user_name).join('、')}` : '到场的人都已交卡'}</span></>
                  : <button className="sm" onClick={() => rpc('set_card_round', { pitch: item.id, open: true }).then(reload)}>请大家写质疑卡</button>}</div></>}
              {live && item.status === 'accepted' && order.length > 0 && <>
                <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>轮流发言 <span className="h3sub">按签到名单逐个点名，本场没轮到的、平时发言少的在前；汇报人不在名单里</span></h3>
                {nextUp ? <div className="ir-acts" style={{ alignItems: 'center' }}><b style={{ font: '700 20px/1.3 var(--i-serif)' }}>请 {nextUp.user_name} 发言</b>
                  <button className="sm" onClick={() => setWho(nextUp.user_id)}>提了质疑，记在其名下</button>
                  <button className="ghost sm" onClick={() => rpc('record_turn', { pitch: item.id, user: nextUp.user_id, result: 'pass' }).then(reload)}>没有质疑，下一位</button></div>
                  : <p className="ir-hint">到场的人都已轮到。</p>}
                <p className="ir-hint">{order.map((o) => `${o.user_name}${o.this_turn === 'query' ? '（提了）' : o.this_turn === 'pass' ? '（跳过）' : ''}`).join('、')}</p></>}
              {item.status === 'accepted' && m.open && <>
                <h3 style={{ margin: '14px 0 6px', fontSize: 14, color: item.card_round ? 'var(--i-red)' : undefined }}>{item.card_round ? '现在写卡：请写一张质疑卡' : '写质疑卡'} <span className="h3sub">与会者都可以写，会前也可以在研讨会页写；组织者记入后计在提出人名下（记入「利」）</span></h3>
                <textarea rows={2} value={mine} onChange={(e) => setMine(e.target.value)} placeholder="针对这份快照的问题或质疑" style={{ width: '100%' }} aria-label="我的质疑" />
                <div className="ir-acts" style={{ alignItems: 'center' }}>{AXES.map(([k, n, d]) => <button key={k} className="sm ghost" disabled={busy} title={d} onClick={() => submitDraft(k)}>提「{n}」</button>)}</div></>}
              {m.can_run && drafts.length > 0 && <>
                <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>待记入 {drafts.length} 条 <span className="h3sub">质疑卡和录音里找到的；录音里的讨论结束后 7 天内仍可记入</span></h3>
                <ul className="ir-sc">{drafts.map((d) => <li key={d.id}><span><b>{d.axis_label}</b> {d.body}
                  <small style={{ display: 'block', color: 'var(--i-mut)' }}>{d.source === 'transcript' ? `录音 · ${d.speaker ?? '未知发言人'}${d.quote ? `：「${d.quote}」` : ''}` : `质疑卡 · ${d.author_name ?? ''}`}</small>
                  {d.source === 'transcript' && <select value={pick[d.id] ?? d.author_id ?? ''} onChange={(e) => setPick({ ...pick, [d.id]: e.target.value })} aria-label="提出的人" style={{ marginTop: 4 }}>
                    <option value="">提出的人（不在中台的可不选）</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</span>
                  <em><button className="sm" onClick={() => accept(d, true)}>记入</button> <button className="ghost sm" onClick={() => accept(d, false)}>不记入</button></em></li>)}</ul></>}
              {!live && msg && <p className="sub2" style={{ color: 'var(--bad)' }}>{msg}</p>}
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
          {m.can_run && (data.sync[0]?.sync_unmatched ?? []).length > 0 && <div className="ir-hint">Zoom 参会名单里对不上中台账号的：{(data.sync[0]?.sync_unmatched ?? []).map((n) => <button key={n} className="ghost sm" style={{ margin: '2px 4px' }} onClick={() => setAct({ title: `认领：${n}`, label: '认领',
            hint: '选出这个名字对应的成员，即为其签到；以后 Zoom 上用这个名字的自动对上。', fields: [{ name: 'user', label: '成员', options: people.map((p): [string, string] => [p.id, p.name]) }], run: (v) => rpc('claim_name', { event: m.id, name: n, user: v.user }) })}>{n}</button>)}</div>}
          {m.kind === 'seminar' && m.can_run && !m.open && <div className="ir-hint">录音补漏：{!tr ? '散会后的第二天凌晨，中台取飞书妙记或 Zoom 云录制的逐字稿（研讨会请开录制），从中找出会上提的质疑，交组织者核对记入。'
            : !tr.body ? `还没取到逐字稿（已试 ${tr.tries} 次，每天凌晨再试，最多 3 次）。${tr.note ?? ''}`
            : !tr.extracted_at ? `已取到逐字稿 ${tr.chars} 字，正在找会上提的质疑。`
            : `已从逐字稿里找到 ${tr.drafts ?? 0} 条质疑，在各份快照的「待记入」里核对。${tr.extract_note ?? ''}`}
            {tr?.body && <details style={{ marginTop: 6 }}><summary>看逐字稿</summary><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto', fontSize: 12 }}>{tr.body}</pre></details>}</div>}
          {m.kind === 'seminar' && !m.open && <p className="ir-hint">本次讨论 {agenda.filter((x) => x.status === 'closed').length} 份快照，新记质疑 {agenda.reduce((t, x) => t + x.new_queries, 0)} 条，再次提出 {agenda.reduce((t, x) => t + x.again_queries, 0)} 条，结算 {agenda.reduce((t, x) => t + x.resolved, 0)} 条。</p>}
          {m.can_run && (() => { const sy = data.sync[0]; return <p className="ir-hint">
            {sy?.zoom_id ? `Zoom 会议：${sy.zoom_id}。散会后中台读 Zoom 的参会报告，按邮箱、姓名对上的自动签到，对不上的在下面认领。` : <>飞书会议：{sy?.feishu_no ? `${sy.feishu_no.slice(0, 3)} ${sy.feishu_no.slice(3, 6)} ${sy.feishu_no.slice(6)}` : '未填（加在中心日历上的飞书会议会自动找到）'}。中台每 5 分钟读一次飞书会议的参会名单，线上参会的自动签到。</>}会后读到录制即挂上链接。
            {sy?.synced_at && <><br />上次同步 {new Date(sy.synced_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })}：{sy.sync_note}</>}</p>; })()}
          {m.can_run && <div className="ir-acts">
            <button className="sm ghost" onClick={() => setAct({ title: '填飞书会议', label: '保存', hint: '粘贴飞书会议链接或 9 位会议号。会议请开录制。', fields: [{ name: 'link', label: '飞书会议链接或会议号', required: false, value: data.sync[0]?.feishu_no ?? '' }], run: (v) => rpc('set_feishu_meeting', { event: m.id, link: v.link || null }) })}>{data.sync[0]?.feishu_no ? '改飞书会议' : '填飞书会议'}</button>
            <button className="sm ghost" onClick={() => setAct({ title: '填 Zoom 会议', label: '保存', hint: '粘贴 Zoom 会议链接或会议号。会议请开云录制。', fields: [{ name: 'link', label: 'Zoom 会议链接或会议号', required: false, value: data.sync[0]?.zoom_id ?? '' }], run: (v) => rpc('set_zoom_meeting', { event: m.id, link: v.link || null }) })}>{data.sync[0]?.zoom_id ? '改 Zoom 会议' : '填 Zoom 会议'}</button>
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
      <button className="sm ghost" onClick={() => setAct({ title: '自建会议', label: '开会', hint: '自己组织的会也可以在正则上开：有签到码，可以挂飞书或 Zoom 会议自动签到，散会后挂纪要。自建会议只作记录，不计入日常任务。',
        fields: [{ name: 'title', label: '题目' }], run: async (v) => { const id = await rpc('open_meeting', { kind: 'other', seminar: null, title: v.title }); location.hash = `#/live/${id}`; } })}>自建会议</button>
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
