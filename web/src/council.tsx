import { useEffect, useState, type ReactNode } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, type Field } from './ui';

// 联席会议：议题从提案、附议、讨论、表决到否决期和生效，全在中台办。会上表决在会议现场页，紧急议题可以会外表决
export interface Motion { id: string; seq: number; mtype: 'main' | 'amend' | 'reconsider' | 'procedural' | 'inquiry'; decided_note?: string | null; director_decision?: string | null; can_decide?: boolean; can_execute?: boolean; auto?: boolean; category: string; title: string; body: string; link: string | null;
  parent_id: string | null; parent_seq: number | null; parent_title: string | null; proposer_id: string; proposer_name: string; seconder_name: string | null; subject_names: string[];
  threshold: 'majority' | 'two_thirds'; ballot: 'open' | 'secret'; urgent: boolean; ref_kind: string | null; ref_id: string | null;
  status: 'proposed' | 'seconded' | 'voting' | 'passed' | 'failed' | 'vetoed' | 'effective' | 'withdrawn'; round: number; meeting_id: string | null; online: boolean;
  vote_open_at: string | null; vote_until: string | null; yes: number | null; no: number | null; abstain: number | null; eligible: number | null; note: string | null;
  decided_at: string | null; veto_until: string | null; veto_reason: string | null; effective_at: string | null; body_prev: string | null; created_at: string; seconded_at: string | null;
  cast_count: number; my_vote: 'yes' | 'no' | 'abstain' | null; can_vote: boolean; can_second: boolean; can_withdraw: boolean; can_chair: boolean; can_veto: boolean;
  recused: boolean; recused_names: string[]; meeting_requests: number; my_request: boolean; open_amendments: number }
interface Info { term: string; electorate: number; am_voter: boolean; am_rep: boolean; can_rep_vote: boolean; can_chair: boolean; am_director: boolean; rep_name: string | null; my_rep_vote: string | null }
interface Speech { id: string; motion_id: string; round: number; user_id: string; user_name: string; side: 'pro' | 'con' | 'neutral'; requested_at: string; spoke_at: string | null; mine: boolean; spoken: number }
interface Act { title: string; hint?: ReactNode; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

export const CAT: Record<string, string> = { research: '研究方向与项目', unit: '研究单元', topic: '课题立项与延续', path: '成长主线认定', budget: '预算', assessment: '考核推荐', personnel: '人员推荐', removal: '建议退组', rules: '议事规则', other: '其他事务', procedure: '程序' };
const TYPE: Record<Motion['mtype'], string> = { main: '议题', amend: '修正案', reconsider: '复议', procedural: '程序动议', inquiry: '过问' };
const ST: Record<Motion['status'], [string, string]> = { proposed: ['warn', '待附议'], seconded: ['', '待表决'], voting: ['warn', '表决中'], passed: ['ok', '通过，否决期内'],
  failed: ['bad', '未通过'], vetoed: ['bad', '被否决'], effective: ['ok', '已生效'], withdrawn: ['', '已撤回'] };
const SIDE: Record<Speech['side'], string> = { pro: '支持', con: '反对', neutral: '中立' };
const CHOICE: Record<string, string> = { yes: '同意', no: '反对', abstain: '弃权' };
const t = (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const label = (m: Motion) => `第 ${m.seq} 号${m.mtype === 'main' ? '' : TYPE[m.mtype]}`;
const stLabel = (m: Motion) => m.mtype === 'inquiry' ? (m.status === 'effective' ? '已过问' : m.status === 'withdrawn' ? '已撤下' : '待过问') : ST[m.status][1];
const rule = (m: Motion) => m.mtype === 'inquiry' ? '过问，不表决' : `${m.threshold === 'two_thirds' ? '三分之二' : '过半数'} · ${m.ballot === 'secret' ? '不记名' : '记名'}${m.urgent ? ' · 紧急' : ''}`;

const motionFields = (people: PeoplePick[]): Field[] => [
  { name: 'title', label: '题目（不超过 80 字）' },
  { name: 'category', label: '类别', options: Object.entries(CAT).filter(([k]) => !['procedure', 'assessment', 'unit', 'topic'].includes(k)) },
  { name: 'body', label: '提案（一页以内：问题、与个人研究愿景及中心核心问题的关系、首个最小实验、所需算力与合作者、预算、计划投稿去向；不涉及的可略）', type: 'area' },
  { name: 'link', label: '附件链接（选填）', required: false },
  { name: 'subjects', label: '涉及的人（本人或其合作者，不参加投票）', type: 'multi', required: false, options: [...people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]), value: '' },
  { name: 'urgent', label: '紧急事项（可以不等开会，由科研助理召集会外表决）', type: 'check', required: false, value: 'false' },
];
const submit = (v: Record<string, string>, extra: Record<string, unknown> = {}) => rpc('submit_motion', { title: v.title, category: v.category ?? null, body: v.body, link: v.link || null,
  subjects: (v.subjects ?? '').split(',').filter(Boolean), urgent: v.urgent === 'true', mtype: 'main', parent: null, ref_kind: null, ref_id: null, two_thirds: false, ...extra });

// ---------- 联席会议页 ----------
export function CouncilPage(_: { me: Me }) {
  const { data, error, reload } = useViews<{ ms: Motion[]; info: Info[]; rep: { id: string; name: string; votes: number }[]; pick: { id: string; name: string }[]; people: PeoplePick[];
    targets: { id: string; code: string; name: string; layer: string; owner_name: string | null }[]; persons: { id: string; name: string; rank_label: string }[] }>(
    { ms: ['council_motion'], info: ['council_info'], rep: ['council_rep'], pick: ['council_rep_pick'], people: ['people_pick'], targets: ['council_targets'], persons: ['council_people'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const info = data.info[0];
  const mains = data.ms.filter((m) => m.mtype === 'main' || m.mtype === 'inquiry').sort((a, b) => b.seq - a.seq);
  const groups: [string, Motion[]][] = [
    ['表决中', mains.filter((m) => m.status === 'voting')], ['待附议', mains.filter((m) => m.status === 'proposed')], ['已列入议程，待表决或过问', mains.filter((m) => m.status === 'seconded')],
    ['已通过，否决期内', mains.filter((m) => m.status === 'passed')], ['已生效', mains.filter((m) => m.status === 'effective')],
    ['未通过、被否决、已撤回', mains.filter((m) => ['failed', 'vetoed', 'withdrawn'].includes(m.status))]];
  const canPropose = info && (info.am_voter || info.am_director || info.am_rep);
  return (
    <div className="wb">
      <div className="top"><h2>联席会议</h2>{canPropose && <button onClick={() => setAct({ title: '提交提案', label: '提交', fields: motionFields(data.people),
        hint: '研究单元申请、课题立项与延续、预算、考核和主线任务审核在各自的申请里提交，由正则自动列入议程；研究单元停滞由正则自动列入过问。其他事项在这里提案，须经另一名有表决权的成员附议才列入议程；表决前三天提交。涉及人员的事项不记名表决；建议退组、修订议事规则须三分之二同意。', run: (v) => submit(v).then((id) => { location.hash = `#/motion/${id}`; }) })}>提交提案</button>}
        {canPropose && <button className="ghost" onClick={() => setAct({ title: '提议终止或结项', label: '提交', hint: '负责人本人申请的免附议，直接列入议程；其他成员提议的须附议。研究单元决议生效即停用；课题转中心负责人和财务办理。',
          fields: [{ name: 'p', label: '研究单元或课题', options: [...data.targets].sort((a, b) => a.code.localeCompare(b.code)).map((x): [string, string] => [x.id, `${x.code} ${x.layer === 'paper' ? '研究单元' : '课题'}「${x.name}」${x.owner_name ? `（${x.owner_name}）` : ''}`]) },
            { name: 'k', label: '类别', options: [['close', '结项：工作完成'], ['end', '终止：不再继续']] }, { name: 'r', label: '理由', type: 'area' }],
          run: (v) => rpc('propose_project_end', { project: v.p, kind: v.k, reason: v.r }).then((id) => { location.hash = `#/motion/${id}`; }) })}>提议终止或结项</button>}
        {info?.am_voter && <button className="ghost" onClick={() => setAct({ title: '建议退组', label: '提交', danger: true, hint: '按章程，连续两次需改进且未达成改进目标的，可以表决建议退组：须附议，投票者三分之二同意，不记名；本人可以到会申辩。通过后由中心负责人决定。',
          fields: [{ name: 'p', label: '成员', options: [...data.persons].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((x): [string, string] => [x.id, `${x.name}（${x.rank_label}）`]) }, { name: 'r', label: '依据', type: 'area' }],
          run: (v) => rpc('propose_removal', { person: v.p, reason: v.r }).then((id) => { location.hash = `#/motion/${id}`; }) })}>建议退组</button>}</div>
      <p className="lede">有表决权的成员 {info?.electorate ?? '—'} 人（Researcher、Rising Star、PI）· {info?.term}学期代表 {info?.rep_name ?? '尚未推选'}（列席，有发言权）· Director 不参加，决议通过后三个工作日内可以否决。会上表决在会议现场页进行。</p>
      {groups.map(([name, rows]) => rows.length > 0 && <section className="wb-sec" key={name}>
        <h3>{name} <span className="h3sub">{rows.length} 份</span></h3>
        <div className="scroll"><table className="wb-table"><thead><tr><th>议题</th><th>类别</th><th>提案人</th><th>规则</th><th>状态</th></tr></thead>
          <tbody>{rows.map((m) => <tr key={m.id}><td><a href={`#/motion/${m.id}`}>{label(m)} {m.title}</a>{m.open_amendments > 0 && <span className="sub2">修正案 {m.open_amendments} 份待表决</span>}</td>
            <td>{CAT[m.category]}</td><td>{m.proposer_name}{m.seconder_name ? <span className="sub2">附议 {m.seconder_name}</span> : m.auto ? <span className="sub2">申请自动列入</span> : null}</td><td className="sub2">{rule(m)}</td>
            <td><Badge tone={ST[m.status][0]}>{stLabel(m)}</Badge>{m.status === 'voting' && m.online && <span className="sub2">会外表决，{t(m.vote_until)} 截止</span>}
              {m.status === 'passed' && <span className="sub2">{t(m.veto_until)} 前未否决即生效</span>}</td></tr>)}</tbody></table></div>
      </section>)}
      {mains.length === 0 && <Empty>还没有议题。</Empty>}
      <Filings />
      <section className="wb-sec"><h3>{info?.term}学期代表 <span className="h3sub">Assistant 和 Intern 推选一名，列席联席会议，有发言权、无表决权；得票最多者当选，可以改票</span></h3>
        <p>{data.rep.length ? [...data.rep].sort((a, b) => b.votes - a.votes).map((r) => `${r.name} ${r.votes} 票`).join('，') : '还没有人投票。'}</p>
        {info?.can_rep_vote && <div className="ir-acts"><button className="sm ghost" onClick={() => setAct({ title: '推选代表', label: '投票', fields: [{ name: 'c', label: '代表', options: data.pick.map((p): [string, string] => [p.id, p.name]), value: info.my_rep_vote ?? '' }],
          run: (v) => rpc('vote_council_rep', { candidate: v.c }) })}>{info.my_rep_vote ? '改票' : '推选代表'}</button></div>}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}

// ---------- 议题页 ----------
export function MotionPage({ id }: { id: string; me: Me }) {
  const { data, error, reload } = useViews<{ ms: Motion[]; info: Info[]; ballot: { motion_id: string; name: string; choice: string }[]; people: PeoplePick[]; meetings: { id: string; kind: string; open: boolean }[] }>(
    { ms: ['council_motion'], info: ['council_info'], ballot: ['council_ballot', { motion_id: id }], people: ['people_pick'], meetings: ['meeting'] }, id);
  const [act, setAct] = useState<Act | null>(null);
  const [err, setErr] = useState('');
  if (!data) return <Loading error={error} />;
  const m = data.ms.find((x) => x.id === id);
  if (!m) return <Empty>议题不存在。</Empty>;
  const info = data.info[0];
  const kids = data.ms.filter((x) => x.parent_id === m.id).sort((a, b) => a.seq - b.seq);
  const council = data.meetings.find((e) => e.kind === 'council' && e.open);
  const go = (p: Promise<unknown>) => { setErr(''); p.then(reload).catch((e) => setErr((e as Error).message)); };
  const decided = ['passed', 'failed', 'vetoed', 'effective'].includes(m.status);
  return (
    <div className="wb">
      <div className="crumb" style={{ fontSize: 12, color: 'var(--mute)', margin: '14px 0 6px' }}><a href="#/council">联席会议</a> › {label(m)}</div>
      <div className="top"><h2>{m.title}</h2></div>
      <p className="lede">{TYPE[m.mtype]}{m.parent_id && <> · 针对 <a href={`#/motion/${m.parent_id}`}>第 {m.parent_seq} 号「{m.parent_title}」</a></>} · {CAT[m.category]} · {rule(m)} · 提案人 {m.proposer_name}，{t(m.created_at)} 提交
        {m.seconder_name ? ` · ${m.seconder_name} 附议` : ''}{m.subject_names.length ? ` · 涉及 ${m.subject_names.join('、')}（不参加投票）` : ''}{m.recused_names.length ? ` · 回避 ${m.recused_names.join('、')}` : ''}</p>
      <section className="wb-sec"><h3>状态 <Badge tone={ST[m.status][0]}>{stLabel(m)}</Badge>
        <span className="h3sub">{m.status === 'voting' ? (m.online ? `会外表决，${t(m.vote_until)} 截止；已投 ${m.cast_count} 人${m.meeting_requests ? `；${m.meeting_requests} 人要求当面讨论（两人即转到会上）` : ''}` : `会上表决中，已投 ${m.cast_count} 人`)
          : m.status === 'passed' ? `${t(m.veto_until)} 前未否决即生效` : m.status === 'effective' ? `${t(m.effective_at)} 生效` : ''}</span></h3>
        {m.decided_note && <p>{m.mtype === 'inquiry' ? '过问结果' : '中心负责人说明'}：{m.decided_note}</p>}
        {m.director_decision && <p>中心负责人决定：{m.director_decision === 'accepted' ? '同意退组' : '不予采纳'}</p>}
        {decided && m.mtype !== 'inquiry' && <p>同意 {m.yes}，反对 {m.no}，弃权 {m.abstain}（可以投票的 {m.eligible} 人）{m.note ? `。${m.note}` : ''}{m.veto_reason ? `。否决理由：${m.veto_reason}` : ''}</p>}
        {decided && data.ballot.length > 0 && <p className="sub2">{data.ballot.map((b) => `${b.name} ${CHOICE[b.choice]}`).join('、')}</p>}
        {m.my_vote && <p className="sub2">我的票：{CHOICE[m.my_vote]}{m.status === 'voting' ? '（截止前可以改）' : ''}</p>}
        <div className="ir-acts" style={{ alignItems: 'center' }}>
          {m.can_second && <button className="sm" onClick={() => go(rpc('second_motion', { id: m.id }))}>附议</button>}
          {m.status === 'voting' && m.can_vote && (['yes', 'no', 'abstain'] as const).map((c) => <button key={c} className={m.my_vote === c ? 'sm' : 'sm ghost'} onClick={() => go(rpc('cast_vote', { id: m.id, choice: c }))}>{CHOICE[c]}</button>)}
          {m.status === 'voting' && m.online && info?.am_voter && !m.my_request && <button className="sm ghost" onClick={() => go(rpc('request_meeting', { id: m.id }))}>要求当面讨论</button>}
          {m.can_chair && m.status === 'seconded' && m.urgent && m.mtype === 'main' && <button className="sm ghost" onClick={() => setAct({ title: `会外表决：${m.title}`, label: '开始表决',
            hint: '正则通知每一名有表决权的成员。有表决权的成员过半数投票方为有效；两名成员要求当面讨论的，转到下次会议。', fields: [{ name: 'h', label: '开放时长（小时）', type: 'number', value: '48' }], run: (v) => rpc('open_online_vote', { id: m.id, hours: Number(v.h) }) })}>召集会外表决</button>}
          {m.can_chair && m.status === 'seconded' && council && <a className="btn sm ghost" href={`#/live/${council.id}`}>到会议现场表决 →</a>}
          {info?.am_voter && !m.recused && ['proposed', 'seconded', 'voting'].includes(m.status) && <button className="sm ghost" onClick={() => setAct({ title: '申报回避', label: '回避',
            hint: '与表决事项有私人关系等情形的，申报后不参加这一份的投票，可以陈述。', fields: [{ name: 'note', label: '说明（选填）', required: false }], run: (v) => rpc('recuse_motion', { id: m.id, note: v.note || null }) })}>申报回避</button>}
          {m.mtype === 'main' && ['proposed', 'seconded'].includes(m.status) && (info?.am_voter || info?.am_director || info?.am_rep) && <button className="sm ghost" onClick={() => setAct({ title: `修正案：${m.title}`, label: '提交',
            hint: '写出修正后的全文。修正案须有人附议，先于原议题表决；通过的，原议题按修正后的文本表决。', fields: [{ name: 'title', label: '修正要点' }, { name: 'body', label: '修正后的全文', type: 'area', value: m.body }],
            run: (v) => submit(v, { mtype: 'amend', parent: m.id, category: null }) })}>提修正案</button>}
          {m.mtype === 'main' && ['passed', 'failed'].includes(m.status) && info?.am_voter && <button className="sm ghost" onClick={() => setAct({ title: `复议：${m.title}`, label: '提交',
            hint: '由投了多数一方票的成员在本次或下一次会议提出，经附议、过半数同意的，原议题重新表决。同一议题只能复议一次。', fields: [{ name: 'title', label: '复议理由（一句话）' }, { name: 'body', label: '说明', type: 'area' }],
            run: (v) => submit(v, { mtype: 'reconsider', parent: m.id, category: null }) })}>提复议</button>}
          {m.can_execute && <button className="sm" onClick={() => go(rpc('execute_fixed_change', { id: m.ref_id }))}>按决议调整核定数</button>}
          {m.mtype === 'inquiry' && m.can_chair && ['proposed', 'seconded'].includes(m.status) && <button className="sm" onClick={() => setAct({ title: `记下过问结果：${m.title}`, label: '记下', fields: [{ name: 'n', label: '过问结果（负责人的说明、恢复计划、会上意见）', type: 'area' }], run: (v) => rpc('close_inquiry', { id: m.id, note: v.n }) })}>记下过问结果</button>}
          {m.can_decide && <><button className="sm" onClick={() => setAct({ title: `决定：${m.title}`, label: '同意退组', danger: true, hint: '同意的，人员档案记为已离开，并通知本人。', fields: [{ name: 'n', label: '说明（选填）', required: false }], run: (v) => rpc('decide_removal', { id: m.id, accept: true, note: v.n || null }) })}>同意退组</button>
            <button className="sm ghost" onClick={() => setAct({ title: `决定：${m.title}`, label: '不予采纳', fields: [{ name: 'n', label: '说明（选填）', required: false }], run: (v) => rpc('decide_removal', { id: m.id, accept: false, note: v.n || null }) })}>不予采纳</button></>}
          {m.can_withdraw && <button className="sm ghost danger" onClick={() => go(rpc('withdraw_motion', { id: m.id }))}>撤回</button>}
          {m.can_veto && <button className="sm danger" onClick={() => setAct({ title: `否决：${m.title}`, label: '否决', danger: true, hint: '否决须写明理由，理由向全体成员公开。',
            fields: [{ name: 'r', label: '理由', type: 'area' }], run: (v) => rpc('veto_motion', { id: m.id, reason: v.r }) })}>否决</button>}
          {err && <span className="sub2" style={{ color: 'var(--bad)' }}>{err}</span>}
        </div>
      </section>
      <section className="wb-sec"><h3>提案</h3>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{m.body}</div>
        {m.link && <p><a href={m.link} target="_blank" rel="noreferrer">附件 →</a></p>}
        {m.body_prev && <details><summary className="sub2">修正前的文本</summary><div style={{ whiteSpace: 'pre-wrap' }}>{m.body_prev}</div></details>}</section>
      {kids.length > 0 && <section className="wb-sec"><h3>修正案与复议 <span className="h3sub">{kids.length} 份</span></h3>
        <ul className="path-hist">{kids.map((k) => <li key={k.id}><a href={`#/motion/${k.id}`}>{label(k)} {k.title}</a> · {k.proposer_name} · <Badge tone={ST[k.status][0]}>{stLabel(k)}</Badge></li>)}</ul></section>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}

// ---------- 会议现场：联席会议 ----------
// 议程是已附议、待表决的议题；选一份，按发言规则安排讨论，开放表决，出席的成员各自投票，结束后当场公布
export function CouncilLive({ meetingId, open, canRun }: { meetingId: string; open: boolean; canRun: boolean }) {
  const { data, reload } = useViews<{ ms: Motion[]; sp: Speech[]; cm: { id: string; electorate: number; present_voters: number }[]; info: Info[] }>(
    { ms: ['council_motion'], sp: ['council_speech'], cm: ['council_meeting', { id: meetingId }], info: ['council_info'] }, meetingId);
  const [cur, setCur] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { const x = setInterval(reload, 10000); return () => clearInterval(x); }, [reload]);
  if (!data) return null;
  const info = data.info[0];
  const cm = data.cm[0];
  const agenda = data.ms.filter((m) => m.status === 'seconded' || m.meeting_id === meetingId)
    .sort((a, b) => (a.status === 'voting' ? 0 : a.status === 'seconded' ? 1 : 2) - (b.status === 'voting' ? 0 : b.status === 'seconded' ? 1 : 2) || a.seq - b.seq);
  const m = agenda.find((x) => x.id === cur) ?? agenda.find((x) => x.status === 'voting') ?? agenda[0];
  const go = (p: Promise<unknown>) => { setErr(''); p.then(reload).catch((e) => setErr((e as Error).message)); };
  const sp = m ? data.sp.filter((s) => s.motion_id === m.id) : [];
  const done = sp.filter((s) => s.spoke_at).sort((a, b) => (a.spoke_at ?? '').localeCompare(b.spoke_at ?? ''));
  const last = done[done.length - 1]?.side;
  // 发言顺序：没发过言的在前；支持和反对轮流；同等情况按申请先后
  const queue = sp.filter((s) => !s.spoke_at).sort((a, b) => a.spoken - b.spoken || Number(a.side === last && last !== 'neutral') - Number(b.side === last && last !== 'neutral') || a.requested_at.localeCompare(b.requested_at));
  const mineQ = sp.find((s) => s.mine && !s.spoke_at);
  const canSpeak = !!(info?.am_voter || info?.am_rep);
  const quorum = cm ? cm.present_voters * 2 > cm.electorate : false;
  return <>
    <section className="ir-t ir-third">
      <div className="ir-mono"><span>议程</span><span>{agenda.filter((x) => !['seconded', 'voting'].includes(x.status)).length} / {agenda.length} 已表决</span></div>
      <p className="ir-hint" style={{ marginTop: 0 }}>出席的有表决权成员 {cm?.present_voters ?? 0} / {cm?.electorate ?? 0} 人，{quorum ? '已过半数，可以表决' : '不足半数，不能表决'}。</p>
      {agenda.length === 0 ? <p className="ir-hint">没有待表决的议题。议题在「联席会议」页提交，经附议后列入议程。</p>
        : <ol className="ir-ch">{agenda.map((x) => <li key={x.id} className={['seconded', 'voting'].includes(x.status) ? '' : 'd'} style={{ cursor: 'pointer', background: m?.id === x.id ? 'var(--i-soft)' : undefined }} onClick={() => setCur(x.id)}>
          <i /><div>{label(x)} {x.title}<small>{TYPE[x.mtype]} · {rule(x)} · {stLabel(x)}</small></div></li>)}</ol>}
    </section>
    <section className="ir-t ir-main">
      {!m ? <p className="ir-hint">选一份议题开始。</p> : <>
        <div className="ir-mono"><span>{label(m)} · {CAT[m.category]} · {rule(m)}</span><a href={`#/motion/${m.id}`}>议题页 →</a></div>
        <h2 style={{ font: '700 28px/1.3 var(--i-serif)', margin: '0 0 6px' }}>{m.title}</h2>
        <p className="ir-hint">提案人 {m.proposer_name}{m.seconder_name ? ` · ${m.seconder_name} 附议` : ''}{m.subject_names.length ? ` · 涉及 ${m.subject_names.join('、')}，不参加投票` : ''}{m.open_amendments ? ` · 修正案 ${m.open_amendments} 份待表决，先表决修正案` : ''}</p>
        <details><summary className="ir-hint">提案全文</summary><div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{m.body}</div></details>
        {['seconded', 'voting'].includes(m.status) && <>
          <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>讨论 <span className="h3sub">提案人先陈述；没发过言的在前，支持和反对轮流；每人最多两次</span></h3>
          {queue.length ? <div className="ir-acts" style={{ alignItems: 'center' }}><b style={{ font: '700 20px/1.3 var(--i-serif)' }}>请 {queue[0].user_name}（{SIDE[queue[0].side]}）发言</b>
            {canRun && open && <button className="sm" onClick={() => go(rpc('mark_spoken', { speech: queue[0].id }))}>发言完毕，下一位</button>}</div> : <p className="ir-hint">发言队列是空的。</p>}
          {queue.length > 1 && <p className="ir-hint">之后：{queue.slice(1).map((s) => `${s.user_name}（${SIDE[s.side]}）`).join('、')}</p>}
          {done.length > 0 && <p className="ir-hint">已发言：{done.map((s) => `${s.user_name}（${SIDE[s.side]}）`).join('、')}</p>}
          {open && canSpeak && <div className="ir-acts" style={{ alignItems: 'center' }}>{mineQ ? <><span className="ir-hint" style={{ margin: 0 }}>已申请发言（{SIDE[mineQ.side]}）</span>
            <button className="sm ghost" onClick={() => go(rpc('cancel_speech', { speech: mineQ.id }))}>取消</button></>
            : (['pro', 'con', 'neutral'] as const).map((s) => <button key={s} className="sm ghost" onClick={() => go(rpc('request_speech', { id: m.id, side: s }))}>申请发言：{SIDE[s]}</button>)}</div>}
        </>}
        {m.mtype === 'inquiry' ? <>{['proposed', 'seconded'].includes(m.status) && canRun && open && <InquiryClose id={m.id} onDone={reload} />}
          {m.decided_note && <p>过问结果：{m.decided_note}</p>}</> : <>
        <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>表决 <span className="h3sub">出席的有表决权成员在自己的手机或电脑上投票，结束前可以改票</span></h3>
        {m.status === 'seconded' && (canRun && open ? <div className="ir-acts"><button className="sm" disabled={!quorum} onClick={() => go(rpc('open_vote', { id: m.id, meeting: meetingId }))}>开始表决</button></div>
          : <p className="ir-hint">等主持人开始表决。</p>)}
        {m.status === 'voting' && <>
          <div className="ir-conv" style={{ marginTop: 0 }}><div><small>已投票</small><b>{m.cast_count}</b><em>/ 出席 {cm?.present_voters ?? 0} 人</em></div></div>
          {m.can_vote ? <div className="ir-acts">{(['yes', 'no', 'abstain'] as const).map((c) => <button key={c} className={m.my_vote === c ? 'sm' : 'sm ghost'} onClick={() => go(rpc('cast_vote', { id: m.id, choice: c }))}>{CHOICE[c]}</button>)}
            {m.my_vote && <span className="ir-hint" style={{ margin: 0 }}>已投：{CHOICE[m.my_vote]}</span>}</div>
            : <p className="ir-hint">{info?.am_voter ? '这份涉及本人或已申报回避，不参加投票。' : '列席的成员不参加投票。'}</p>}
          {canRun && !m.online && <div className="ir-acts"><button className="sm" onClick={() => go(rpc('close_vote', { id: m.id }))}>结束表决，公布结果</button></div>}
        </>}
        {['passed', 'failed', 'effective', 'vetoed'].includes(m.status) && <p style={{ font: '700 20px/1.4 var(--i-serif)' }}>{m.status === 'failed' ? '未通过' : '通过'}：同意 {m.yes}，反对 {m.no}，弃权 {m.abstain}
          {m.mtype === 'main' && m.status === 'passed' ? `；${t(m.veto_until)} 前中心主任未否决即生效` : ''}</p>}</>}
        {err && <p className="sub2" style={{ color: 'var(--bad)' }}>{err}</p>}
      </>}
    </section>
  </>;
}

function InquiryClose({ id, onDone }: { id: string; onDone: () => void }) {
  const [n, setN] = useState('');
  const [err, setErr] = useState('');
  return <><h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>过问 <span className="h3sub">负责人说明情况和恢复计划，不表决；主持人记下结果</span></h3>
    <textarea rows={3} value={n} onChange={(e) => setN(e.target.value)} placeholder="负责人的说明、恢复计划、会上意见" style={{ width: '100%' }} aria-label="过问结果" />
    <div className="ir-acts"><button className="sm" onClick={() => rpc('close_inquiry', { id, note: n }).then(onDone).catch((e) => setErr((e as Error).message))}>记下过问结果</button>{err && <span className="sub2" style={{ color: 'var(--bad)' }}>{err}</span>}</div></>;
}

// 报联席会议备案：项目双选的试做期结论
function Filings() {
  const { data } = useViews<{ f: { id: string; project_name: string; user_name: string; rank_label: string; mentor_name: string; start_on: string; end_on: string; conclusion_label: string; conclusion: string; conclusion_note: string | null; concluded_at: string }[] }>({ f: ['trial_filing'] });
  if (!data || data.f.length === 0) return null;
  const rows = [...data.f].sort((a, b) => b.concluded_at.localeCompare(a.concluded_at));
  return <section className="wb-sec"><h3>试做期结论备案 <span className="h3sub">项目双选的期满结论，指导人给出，报联席会议备案；结束参与的本人可以申诉</span></h3>
    <div className="scroll"><table className="wb-table"><thead><tr><th>成员</th><th>课题或研究单元</th><th>指导人</th><th>试做期</th><th>结论</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{r.user_name}<span className="sub2">{r.rank_label}</span></td><td>{r.project_name}</td><td>{r.mentor_name}</td><td className="sub2">{day(r.start_on)} 至 {day(r.end_on)}</td>
        <td><Badge tone={r.conclusion === 'end' ? 'bad' : r.conclusion === 'continue' ? 'ok' : 'warn'}>{r.conclusion_label}</Badge>{r.conclusion_note && <span className="sub2">{r.conclusion_note}</span>}</td></tr>)}</tbody></table></div></section>;
}
