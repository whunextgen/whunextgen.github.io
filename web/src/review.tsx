import { useState } from 'react';
import { rpc, useViews, type Me, type Project, type ReviewPoint, type ReviewSummary as Row, type ReviewThread, type Submission, type SubmissionReview } from './api';
import { ActionDialog, Badge, Empty, Tile, type Field } from './ui';

// 文章四字：理（为什么要关注这个问题）、据（为什么别人没解决）、体（方法）、用（发现）
const AXES = ['li', 'ju', 'ti', 'yong'] as const;
const AXIS: Record<string, [string, string]> = { li: ['理', '为什么要关注这个问题'], ju: ['据', '为什么别人没解决'], ti: ['体', '方法'], yong: ['用', '发现'] };
const STATUS: Record<string, string> = { review: '在审', resubmitted: '已重投', desk_reject: '未送审退回', withdrawn: '已撤稿', accepted: '已录用', rejected: '未录用' };
const n1 = (v: string | number | null | undefined) => (v == null ? '—' : String(Number(v)));
const round = (s: Submission) => `${s.venue} ${s.cycle.slice(0, 7)}`;
// 重投时作者申请的是沿用上一轮的审稿人，还是换一组；首次投稿没有这一项
const Keep = ({ v, who = '审稿人' }: { v: boolean | null; who?: string }) => (v == null ? null : <span className={`rv-keep ${v ? 'same' : 'new'}`}>{v ? `沿用原${who}` : `更换${who}`}</span>);
const Q = ({ a }: { a: string }) => <span className={`rv-q rv-${a}`}>{AXIS[a]?.[0] ?? a}</span>;
const Text = ({ k, v }: { k: string; v: string | null }) => (v ? <><div className="rv-sec">{k}</div><p className="rv-full">{v}</p></> : null);

// 各轮总评走势：每位审稿人一个点，均分连线，AC 总评另标
function Trend({ rounds, reviews, scale }: { rounds: Submission[]; reviews: SubmissionReview[]; scale: number }) {
  const W = 840, x = (i: number) => (rounds.length === 1 ? W / 2 : 110 + (i * (W - 240)) / (rounds.length - 1)), y = (v: number) => 175 - ((v - 1) * 152) / Math.max(1, scale - 1);
  const ticks = scale <= 6 ? Array.from({ length: scale }, (_, i) => i + 1) : [1, ...Array.from({ length: Math.floor(scale / 2) }, (_, i) => (i + 1) * 2)];
  const pts = rounds.map((s, i) => (s.mean_overall == null ? null : `${x(i)},${y(Number(s.mean_overall))}`)).filter(Boolean).join(' ');
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} 210`} role="img" aria-label="各轮总评分走势">
      {ticks.map((v) => <g key={v}><line x1="60" x2={W - 40} y1={y(v)} y2={y(v)} className="rv-grid" /><text x="48" y={y(v) + 4} className="rv-tick" textAnchor="end">{v}</text></g>)}
      {pts.includes(' ') && <polyline points={pts} className="rv-line" />}
      {rounds.map((s, i) => {
        const seen: Record<string, number> = {};
        return <g key={s.id}>
          {reviews.filter((r) => r.submission_id === s.id && r.overall != null).map((r) => { const k = String(r.overall); seen[k] = (seen[k] ?? 0) + 1;
            return <circle key={r.id} cx={x(i) - 30 + (seen[k] - 1) * 13} cy={y(Number(r.overall))} r="5" className="rv-dot"><title>{`${r.reviewer}：${n1(r.overall)}`}</title></circle>; })}
          {s.mean_overall != null && <><circle cx={x(i)} cy={y(Number(s.mean_overall))} r="4.5" className="rv-mean" /><text x={x(i)} y={y(Number(s.mean_overall)) - 10} className="rv-meant" textAnchor="middle">{n1(s.mean_overall)}</text></>}
          {s.ac_overall != null && <><rect x={x(i) + 40} y={y(Number(s.ac_overall)) - 5} width="10" height="10" className="rv-ac" transform={`rotate(45 ${x(i) + 45} ${y(Number(s.ac_overall))})`} /><text x={x(i) + 58} y={y(Number(s.ac_overall)) + 4} className="rv-act">AC {n1(s.ac_overall)}</text></>}
          <text x={x(i)} y="202" className="rv-xt" textAnchor="middle">{s.cycle.slice(0, 7)}</text>
        </g>;
      })}
    </svg>
  );
}

function Chain({ title, sub, subs, reviews, points: allPoints, threads, edit }: { title: string; sub: string; subs: Submission[]; reviews: SubmissionReview[]; points: ReviewPoint[]; threads: ReviewThread[]; edit: Edit }) {
  const ids = new Set(subs.map((s) => s.id)), points = allPoints.filter((p) => ids.has(p.submission_id));   // 只算这个会议的各轮
  const scale = Number(subs[0].scale) || 5, arr = subs.every((s) => s.source === 'import');
  const asc = [...subs].sort((a, b) => a.cycle.localeCompare(b.cycle)), desc = [...asc].reverse();
  const cur = desc[0], prev = desc[1];
  const of = (s: Submission) => reviews.filter((r) => r.submission_id === s.id).sort((a, b) => a.reviewer.localeCompare(b.reviewer));
  const pts = (s: Submission) => points.filter((p) => p.submission_id === s.id);
  const delta = cur.mean_overall != null && prev?.mean_overall != null ? Number(cur.mean_overall) - Number(prev.mean_overall) : null;
  const acRound = desc.find((s) => s.ac_overall != null);
  const judged = asc.filter((s) => reviews.some((r) => r.submission_id === s.id));   // 有评审的轮次；未送审退回的一轮不算回应
  const tracked = threads.filter((t) => points.some((p) => p.thread_id === t.id)).sort((a, b) => a.ord - b.ord);
  return (
    <section className="card">
      <h3>{title} <span className="h3sub">{sub}</span></h3>
      <div className="rv-key">{AXES.map((a) => <span key={a}><Q a={a} />{AXIS[a][1]}</span>)}</div>

      <h4 className="rv-h">各轮评分</h4>
      <div className="tiles rv-tiles">
        <Tile k="投稿轮次" v={asc.length} f={STATUS[cur.status] ?? cur.status} />
        <Tile k={`本轮审稿人均分（满分 ${scale}）`} v={<>{n1(cur.mean_overall)}{delta != null && delta !== 0 && <small className={delta < 0 ? 'rv-down' : 'rv-up'}> {delta < 0 ? '↓' : '↑'} {n1(Math.abs(delta).toFixed(2))}</small>}</>} f={`${of(cur).length} 位审稿人`} />
        <Tile k="上一轮审稿人均分" v={prev ? n1(prev.mean_overall) : '—'} f={prev ? round(prev) : '首次投稿'} />
        <Tile k="最近一次 AC 总评" v={acRound ? n1(acRound.ac_overall) : '—'} f={acRound ? `${round(acRound)}${cur.ac_overall == null ? '；本轮未出' : ''}` : '尚无'} />
      </div>
      <Trend rounds={asc} reviews={reviews} scale={scale} />
      <div className="rv-legend"><span><i className="rv-ldot" />审稿人总评</span><span><i className="rv-lline" />审稿人均分</span><span><i className="rv-lac" />AC 总评</span></div>

      {points.length > 0 && <><h4 className="rv-h">各轮质疑分布</h4>
      <div className="rv-mx">
        <div />{AXES.map((a) => <div key={a}><Q a={a} /></div>)}<div className="rv-mxh">均分 / AC</div>
        {asc.map((s) => { const p = pts(s); return [
          <div key={s.id} className="rv-mxl">{s.cycle.slice(0, 7)}</div>,
          ...AXES.map((a) => { const n = p.filter((x) => x.axis === a).length; return <div key={s.id + a} className={n ? `rv-cell rv-${a}` : 'rv-cell rv-zero'} style={n ? { opacity: Math.min(1, 0.45 + n * 0.11) } : undefined}>{n || '·'}</div>; }),
          <div key={s.id + 'm'} className="rv-mono">{n1(s.mean_overall)} / {n1(s.ac_overall)}</div>]; })}
      </div></>}

      {tracked.length > 0 && <>
        <h4 className="rv-h">跨轮追踪的质疑</h4>
        <p className="rv-hint">{judged.length > 1 ? `最新一轮评审没有人再提的，记为已回应。圆点依次是 ${judged.map((s) => s.cycle.slice(0, 7)).join('、')}。` : '同一轮里不止一位审稿人提到的问题。'}</p>
        {tracked.map((t) => { const hit = judged.map((s) => pts(s).some((p) => p.thread_id === t.id)); const open = hit[hit.length - 1];
          return <div key={t.id} className="rv-tr"><span><Q a={t.axis} />{t.label}</span>
            <span className="rv-trr">{hit.map((h, i) => <i key={i} className={h ? 'rv-td on' : 'rv-td'} />)}{judged.length > 1 && <b className={open ? 'rv-open' : 'rv-done'}>{open ? '本轮仍被提出' : '已回应'}</b>}</span></div>; })}
      </>}

      <h4 className="rv-h">逐轮评审</h4>
      {desc.map((s, i) => (
        <details key={s.id} className="rv-round" open={i === 0}>
          <summary><span><b>{round(s)}</b> <small>{s.number != null ? `#${s.number} · ` : ''}{STATUS[s.status] ?? s.status}{i === 0 ? ' · 本轮' : ''}</small> <Keep v={s.keep_reviewers} /> <Keep v={s.keep_ac} who=" AC" /></span>
            <span className="rv-mono rv-sum">{of(s).map((r) => n1(r.overall)).join(' / ') || '无评审'} · AC {s.ac_overall == null ? '未出' : n1(s.ac_overall)}</span></summary>
          {s.can_edit && <div className="rv-ops">{s.source === 'manual' && <button className="ghost sm" onClick={() => edit.review(s)}>登记评审</button>}<button className="ghost sm" onClick={() => edit.sub(s)}>{s.source === 'manual' ? '修改这一轮' : '更新状态和 AC 意见'}</button>{s.source === 'manual' && <button className="ghost sm" onClick={() => edit.delSub(s)}>删除这一轮</button>}<span className="sub2">{s.source === 'manual' ? '自行填报' : '导入'}</span></div>}
          <div className="rv-title">{s.title} {s.forum && <a href={`https://openreview.net/forum?id=${encodeURIComponent(s.forum)}`} target="_blank" rel="noreferrer">在 OpenReview 查看</a>}</div>
          {(s.ac_overall != null || s.ac_text) && <div className="rv-rev rv-acbox">
            <div className="rv-rh"><b>AC 意见</b><span className="rv-four"><span>总评 <b>{n1(s.ac_overall)}</b></span></span></div>
            {s.ac_gist && <p className="rv-pt">{s.ac_gist}</p>}
            {(s.ac_text || s.ac_revisions) && <details className="rv-more"><summary>AC 意见全文</summary><Text k="意见" v={s.ac_text} /><Text k="修改建议" v={s.ac_revisions} /></details>}
          </div>}
          {of(s).map((r) => { const ps = points.filter((p) => p.review_id === r.id).sort((a, b) => a.ord - b.ord); return (
            <div key={r.id} className="rv-rev">
              <div className="rv-rh"><b className="rv-mono">{r.reviewer.replace(/^Reviewer_/, '审稿人 ')}</b>
                <span className="rv-four"><span>总评 <b>{n1(r.overall)}</b></span>{(arr || r.soundness != null) && <span>可靠性 <b>{n1(r.soundness)}</b></span>}{(arr || r.excitement != null) && <span>新意 <b>{n1(r.excitement)}</b></span>}<span>把握 <b>{n1(r.confidence)}</b></span>
                  {s.can_edit && s.source === 'manual' && <><button className="ghost sm" onClick={() => edit.review(s, r)}>修改</button><button className="ghost sm" onClick={() => edit.delReview(r)}>删除</button></>}</span></div>
              {ps.length === 0 ? <p className="rv-pt rv-none">{s.source === 'manual' ? '质疑尚未按理据体用归类。' : '没有归出质疑。'}</p> : ps.map((p) => <div key={p.id} className="rv-pt"><Q a={p.axis} /><span>{p.gist}{p.quote && <q>{p.quote}</q>}</span></div>)}
              <details className="rv-more"><summary>评审全文</summary><Text k="概述" v={r.summary} /><Text k="优点" v={r.strengths} /><Text k="不足" v={r.weaknesses} /><Text k="意见与建议" v={r.comments} /></details>
            </div>); })}
        </details>
      ))}
      <p className="rv-foot">「沿用原审稿人」「更换审稿人」是重投时在投稿表里提出的申请，沿用以对方有空为前提；每轮审稿人的代号都会重编，实际是否同一人从评审里看不出。分数为{scale === 5 ? '五' : scale === 10 ? '十' : scale}分制，只在同一会议内比较。质疑的归类和中文概括在导入时做出，灰字是原文出处。</p>
    </section>
  );
}

// 自行填报用的几个动作，由研究单元页的这一节统一开对话框
interface Edit { sub: (s?: Submission) => void; review: (s: Submission, r?: SubmissionReview) => void; delSub: (s: Submission) => void; delReview: (r: SubmissionReview) => void }
interface Act { title: string; hint?: string; fields: Field[]; submitLabel?: string; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const REL: [string, string][] = [['self', '本稿：这个研究单元正在写的稿件'], ['prior', '前作：这个研究单元所依据的已投稿件']];
const KEEP: [string, string][] = [['first', '首次投稿'], ['same', '重投，申请沿用原审稿人'], ['new', '重投，申请更换审稿人']];
const SCALE: [string, string][] = [['5', '5 分制（ACL ARR 等）'], ['6', '6 分制（NeurIPS 等）'], ['10', '10 分制（ICLR、ICML 等）']];

// 研究单元页的「投稿与评审」：中心成员都看得到，按会议分开；名单内成员、负责人和中心负责人可以自行填报
export function UnitReviews({ unit, me }: { unit: Project; me: Me }) {
  const f = { project_id: unit.id };
  const { data, reload } = useViews<{ subs: Submission[]; reviews: SubmissionReview[]; points: ReviewPoint[]; threads: ReviewThread[] }>(
    { subs: ['submission', f], reviews: ['submission_review', f], points: ['review_point', f], threads: ['review_thread', f] }, unit.id);
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return null;
  const canEdit = me.role === 'director' || unit.mine || unit.member;
  if (data.subs.length === 0 && !canEdit) return null;
  const edit: Edit = {
    sub: (s) => setAct(s && s.source === 'import' ? {
      title: '更新状态和 AC 意见', hint: `${s.venue} ${s.cycle.slice(0, 7)}。这一轮是导入的，页面上只能改状态和 AC 的总评、意见。`,
      fields: [{ name: 'status', label: '状态', value: s.status, options: Object.entries(STATUS) }, { name: 'ac_overall', label: `AC 总评（满分 ${Number(s.scale)}，没出就空着）`, type: 'number', value: s.ac_overall ?? '', required: false },
        { name: 'ac_text', label: 'AC 意见原文（没出就空着）', type: 'area', value: s.ac_text ?? '', required: false }],
      run: (v) => rpc('submission_save', { id: s.id, venue: s.venue, cycle: s.cycle, title: s.title, ...v }),
    } : {
      title: s ? '修改这一轮投稿' : '登记投稿', hint: '一轮投稿登记一次；重投的另登一轮，同一会议的各轮会连成一条线。登记后再逐位登记审稿人的评审。评审是保密材料，仅中心成员可见。',
      fields: [{ name: 'relation', label: '这篇稿件是', value: s?.relation ?? 'self', options: REL }, { name: 'venue', label: '会议或期刊，如 ACL ARR、ICLR、NeurIPS', value: s?.venue ?? '' },
        { name: 'cycle', label: '轮次所在的年月', type: 'month', value: s?.cycle.slice(0, 7) ?? '' }, { name: 'number', label: '投稿编号（没有就空着）', type: 'number', value: s?.number != null ? String(s.number) : '', required: false },
        { name: 'title', label: '稿件标题', value: s?.title ?? '' }, { name: 'status', label: '状态', value: s?.status ?? 'review', options: Object.entries(STATUS) },
        { name: 'scale', label: '总评的分制', value: s ? String(Number(s.scale)) : '5', options: SCALE }, { name: 'keep', label: '审稿人', value: s ? (s.keep_reviewers == null ? 'first' : s.keep_reviewers ? 'same' : 'new') : 'first', options: KEEP },
        { name: 'link', label: 'OpenReview 帖子链接（没有就空着）', value: s?.forum ? `https://openreview.net/forum?id=${s.forum}` : '', required: false },
        { name: 'ac_overall', label: 'AC 总评（没出就空着）', type: 'number', value: s?.ac_overall ?? '', required: false }, { name: 'ac_text', label: 'AC 意见原文（没出就空着）', type: 'area', value: s?.ac_text ?? '', required: false }],
      run: (v) => rpc('submission_save', { id: s?.id ?? null, project_id: unit.id, ...v }),
    }),
    review: (s, r) => setAct({
      title: r ? '修改评审' : '登记评审', hint: `${s.venue} ${s.cycle.slice(0, 7)}，满分 ${Number(s.scale)}。一位审稿人登记一份，原文照贴，不要改写。质疑按理据体用的归类由济民统一做。`,
      fields: [{ name: 'reviewer', label: '审稿人代号，如 Reviewer_a1B2 或 R1', value: r?.reviewer ?? '' }, { name: 'overall', label: '总评', type: 'number', value: r?.overall ?? '' },
        { name: 'confidence', label: '把握（审稿人自评的置信度，没有就空着）', type: 'number', value: r?.confidence ?? '', required: false },
        { name: 'soundness', label: '可靠性（ARR 的 Soundness，别的会议空着）', type: 'number', value: r?.soundness ?? '', required: false }, { name: 'excitement', label: '新意（ARR 的 Excitement，别的会议空着）', type: 'number', value: r?.excitement ?? '', required: false },
        { name: 'strengths', label: '优点，原文', type: 'area', value: r?.strengths ?? '', required: false }, { name: 'weaknesses', label: '不足，原文', type: 'area', value: r?.weaknesses ?? '', required: false },
        { name: 'comments', label: '意见与建议，原文', type: 'area', value: r?.comments ?? '', required: false }],
      run: (v) => rpc('review_save', { id: r?.id ?? null, submission_id: s.id, ...v }),
    }),
    delSub: (s) => setAct({ title: '删除这一轮投稿', hint: `${s.venue} ${s.cycle.slice(0, 7)}「${s.title}」连同它名下的评审一并删除，不能恢复。`, fields: [], submitLabel: '删除', danger: true, run: () => rpc('submission_delete', { id: s.id }) }),
    delReview: (r) => setAct({ title: '删除评审', hint: `删除 ${r.reviewer} 的这份评审，不能恢复。`, fields: [], submitLabel: '删除', danger: true, run: () => rpc('review_delete', { id: r.id }) }),
  };
  const note = '评审是保密材料，仅中心成员可见，不得外传';
  // 本稿在前、前作在后；同一类里按会议分开，各会议分制不同，不放在一起比
  const groups = (['self', 'prior'] as const).flatMap((rel) => {
    const of = data.subs.filter((s) => s.relation === rel);
    return [...new Set(of.map((s) => s.venue))].sort().map((venue) => ({ rel, venue, subs: of.filter((s) => s.venue === venue) }));
  });
  return <>
    {groups.map((g) => <Chain key={g.rel + g.venue} title={`${g.rel === 'self' ? '投稿与评审' : '前作的评审'} · ${g.venue}`} sub={g.rel === 'self' ? note : `本研究单元以这篇稿件为基础；${note}`}
      subs={g.subs} reviews={data.reviews} points={data.points} threads={data.threads.filter((t) => t.relation === g.rel)} edit={edit} />)}
    {canEdit && <section className="card rv-add"><h3>{groups.length ? '登记另一轮投稿' : '投稿与评审'} <span className="h3sub">名单内成员、负责人可以自行填报</span></h3>
      <p className="hint">{groups.length ? '重投、改投别的会议，或补登更早的轮次，在这里登记；不同会议分开显示。' : '这个研究单元还没有投稿记录。投稿后在这里登记会议、轮次和各位审稿人的评审；登记后全中心成员可见。'}</p>
      <button className="primary" onClick={() => edit.sub()}>登记投稿</button></section>}
    {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
  </>;
}

// 课题汇总页的「投稿与评审」：每个研究单元的每篇稿件一行，分数和质疑取最近一轮有评审的
export function ReviewSummary() {
  const { data } = useViews<{ rows: Row[] }>({ rows: ['review_summary'] });
  if (!data) return null;
  const rows = [...data.rows].sort((a, b) => a.code.localeCompare(b.code) || b.relation.localeCompare(a.relation) || a.venue.localeCompare(b.venue));
  if (rows.length === 0) return <Empty>暂无投稿记录。</Empty>;
  const units = new Set(rows.map((r) => r.project_id)).size, live = rows.filter((r) => r.status === 'review').length;
  const open = rows.reduce((t, r) => t + r.threads_open, 0);
  return <>
    <p className="hint">{units} 个研究单元、{rows.length} 条投稿线（同一稿件投不同会议的各算一条），{live} 条在审；追踪的质疑中有 {open} 条在最近一轮评审里仍被提出。各会议分制不同，分数只在同一会议内比较；分数和质疑取最近一轮有评审的那一轮。「审稿人」一列是重投时提出的申请：沿用上一轮的，还是换一组。评审是保密材料，仅中心成员可见，不得外传。</p>
    <div className="rv-key">{AXES.map((a) => <span key={a}><Q a={a} />{AXIS[a][1]}</span>)}</div>
    <div className="scroll"><table className="wb-table rv-sumt">
      <thead><tr><th>研究单元</th><th>稿件</th><th>会议</th><th>状态</th><th className="r">轮次</th><th className="r">本轮均分</th><th className="r">上一轮均分</th><th>审稿人</th><th className="r">AC</th>{AXES.map((a) => <th key={a} className="r"><Q a={a} /></th>)}<th className="r">仍被提出</th><th className="r">已回应</th></tr></thead>
      <tbody>{rows.map((r) => { const d = r.mean != null && r.prev_mean != null ? Number(r.mean) - Number(r.prev_mean) : 0;
        return <tr key={r.project_id + r.relation + r.venue}>
          <td><a href={`#/project/${r.project_id}`}>{r.name}</a><span className="sub2 blk">{r.code}{r.owner_name ? ` · ${r.owner_name}` : ''}</span></td>
          <td className="wrap">{r.relation === 'prior' && <Badge>前作</Badge>} {r.title}<span className="sub2 blk">{r.cycle.slice(0, 7)}{r.number != null ? ` · #${r.number}` : ''}{r.judged_cycle && r.judged_cycle !== r.cycle ? ` · 评审取自 ${r.judged_cycle.slice(0, 7)}` : ''}</span></td>
          <td>{r.venue}<span className="sub2 blk">满分 {Number(r.scale)}</span></td>
          <td>{STATUS[r.status] ?? r.status}</td>
          <td className="r rv-mono">{r.rounds}</td>
          <td className="r rv-mono">{n1(r.mean)}{d !== 0 ? <small className={d < 0 ? 'rv-down' : 'rv-up'}> {d < 0 ? '↓' : '↑'}{n1(Math.abs(d).toFixed(2))}</small> : r.judged_rounds > 1 && <small className="sub2"> 持平</small>}</td>
          <td className="r rv-mono">{r.judged_rounds > 1 ? n1(r.prev_mean) : <span className="sub2">首轮</span>}</td>
          <td>{r.keep_reviewers == null ? <span className="sub2">{r.judged_rounds > 1 ? '未注明' : '首轮'}</span> : <Keep v={r.keep_reviewers} />}</td>
          <td className="r rv-mono">{n1(r.ac_overall)}</td>
          {AXES.map((a) => <td key={a} className="r rv-mono">{r[a] || '·'}</td>)}
          <td className="r rv-mono">{r.threads_open ? <b className="rv-open">{r.threads_open}</b> : '·'}</td>
          <td className="r rv-mono">{r.judged_rounds > 1 ? r.threads - r.threads_open || '·' : '—'}</td>
        </tr>; })}</tbody>
    </table></div>
  </>;
}
