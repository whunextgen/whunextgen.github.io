import { useViews, type Project, type ReviewPoint, type ReviewSummary as Row, type ReviewThread, type Submission, type SubmissionReview } from './api';
import { Badge, Empty, Tile } from './ui';

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
function Trend({ rounds, reviews }: { rounds: Submission[]; reviews: SubmissionReview[] }) {
  const W = 840, x = (i: number) => (rounds.length === 1 ? W / 2 : 110 + (i * (W - 240)) / (rounds.length - 1)), y = (v: number) => 175 - (v - 1) * 38;
  const pts = rounds.map((s, i) => (s.mean_overall == null ? null : `${x(i)},${y(Number(s.mean_overall))}`)).filter(Boolean).join(' ');
  return (
    <svg className="rv-chart" viewBox={`0 0 ${W} 210`} role="img" aria-label="各轮总评分走势">
      {[1, 2, 3, 4, 5].map((v) => <g key={v}><line x1="60" x2={W - 40} y1={y(v)} y2={y(v)} className="rv-grid" /><text x="48" y={y(v) + 4} className="rv-tick" textAnchor="end">{v}</text></g>)}
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

function Chain({ title, sub, subs, reviews, points, threads }: { title: string; sub: string; subs: Submission[]; reviews: SubmissionReview[]; points: ReviewPoint[]; threads: ReviewThread[] }) {
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
        <Tile k="本轮审稿人均分" v={<>{n1(cur.mean_overall)}{delta != null && delta !== 0 && <small className={delta < 0 ? 'rv-down' : 'rv-up'}> {delta < 0 ? '↓' : '↑'} {n1(Math.abs(delta).toFixed(2))}</small>}</>} f={`${of(cur).length} 位审稿人`} />
        <Tile k="上一轮审稿人均分" v={prev ? n1(prev.mean_overall) : '—'} f={prev ? round(prev) : '首次投稿'} />
        <Tile k="最近一次 AC 总评" v={acRound ? n1(acRound.ac_overall) : '—'} f={acRound ? `${round(acRound)}${cur.ac_overall == null ? '；本轮未出' : ''}` : '尚无'} />
      </div>
      <Trend rounds={asc} reviews={reviews} />
      <div className="rv-legend"><span><i className="rv-ldot" />审稿人总评</span><span><i className="rv-lline" />审稿人均分</span><span><i className="rv-lac" />AC 总评</span></div>

      <h4 className="rv-h">各轮质疑分布</h4>
      <div className="rv-mx">
        <div />{AXES.map((a) => <div key={a}><Q a={a} /></div>)}<div className="rv-mxh">均分 / AC</div>
        {asc.map((s) => { const p = pts(s); return [
          <div key={s.id} className="rv-mxl">{s.cycle.slice(0, 7)}</div>,
          ...AXES.map((a) => { const n = p.filter((x) => x.axis === a).length; return <div key={s.id + a} className={n ? `rv-cell rv-${a}` : 'rv-cell rv-zero'} style={n ? { opacity: Math.min(1, 0.45 + n * 0.11) } : undefined}>{n || '·'}</div>; }),
          <div key={s.id + 'm'} className="rv-mono">{n1(s.mean_overall)} / {n1(s.ac_overall)}</div>]; })}
      </div>

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
          <div className="rv-title">{s.title} <a href={`https://openreview.net/forum?id=${encodeURIComponent(s.forum)}`} target="_blank" rel="noreferrer">在 OpenReview 查看</a></div>
          {(s.ac_overall != null || s.ac_text) && <div className="rv-rev rv-acbox">
            <div className="rv-rh"><b>AC 意见</b><span className="rv-four"><span>总评 <b>{n1(s.ac_overall)}</b></span></span></div>
            {s.ac_gist && <p className="rv-pt">{s.ac_gist}</p>}
            {(s.ac_text || s.ac_revisions) && <details className="rv-more"><summary>AC 意见全文</summary><Text k="意见" v={s.ac_text} /><Text k="修改建议" v={s.ac_revisions} /></details>}
          </div>}
          {of(s).map((r) => { const ps = points.filter((p) => p.review_id === r.id).sort((a, b) => a.ord - b.ord); return (
            <div key={r.id} className="rv-rev">
              <div className="rv-rh"><b className="rv-mono">{r.reviewer.replace(/^Reviewer_/, '审稿人 ')}</b>
                <span className="rv-four"><span>总评 <b>{n1(r.overall)}</b></span><span>可靠性 <b>{n1(r.soundness)}</b></span><span>新意 <b>{n1(r.excitement)}</b></span><span>把握 <b>{n1(r.confidence)}</b></span></span></div>
              {ps.length === 0 ? <p className="rv-pt rv-none">没有归出质疑。</p> : ps.map((p) => <div key={p.id} className="rv-pt"><Q a={p.axis} /><span>{p.gist}{p.quote && <q>{p.quote}</q>}</span></div>)}
              <details className="rv-more"><summary>评审全文</summary><Text k="概述" v={r.summary} /><Text k="优点" v={r.strengths} /><Text k="不足" v={r.weaknesses} /><Text k="意见与建议" v={r.comments} /></details>
            </div>); })}
        </details>
      ))}
      <p className="rv-foot">「沿用原审稿人」「更换审稿人」是重投时在投稿表里提出的申请，沿用以对方有空为前提；每轮审稿人的代号都会重编，实际是否同一人从评审里看不出。分数为五分制。质疑的归类和中文概括在导入时做出，灰字是原文出处。</p>
    </section>
  );
}

// 研究单元页的「投稿与评审」：中心成员都看得到；没有投稿记录的，这一节不出现
export function UnitReviews({ unit }: { unit: Project }) {
  const f = { project_id: unit.id };
  const { data } = useViews<{ subs: Submission[]; reviews: SubmissionReview[]; points: ReviewPoint[]; threads: ReviewThread[] }>(
    { subs: ['submission', f], reviews: ['submission_review', f], points: ['review_point', f], threads: ['review_thread', f] }, unit.id);
  if (!data || data.subs.length === 0) return null;
  const part = (rel: 'self' | 'prior') => data.subs.filter((s) => s.relation === rel);
  const self = part('self'), prior = part('prior');
  const note = '评审是保密材料，仅中心成员可见，不得外传';
  return <>
    {self.length > 0 && <Chain title="投稿与评审" sub={note} subs={self} reviews={data.reviews} points={data.points} threads={data.threads.filter((t) => t.relation === 'self')} />}
    {prior.length > 0 && <Chain title="前作的评审" sub={`本研究单元以这篇稿件为基础；${note}`} subs={prior} reviews={data.reviews} points={data.points} threads={data.threads.filter((t) => t.relation === 'prior')} />}
  </>;
}

// 课题汇总页的「投稿与评审」：每个研究单元的每篇稿件一行，分数和质疑取最近一轮有评审的
export function ReviewSummary() {
  const { data } = useViews<{ rows: Row[] }>({ rows: ['review_summary'] });
  if (!data) return null;
  const rows = [...data.rows].sort((a, b) => a.code.localeCompare(b.code) || b.relation.localeCompare(a.relation));
  if (rows.length === 0) return <Empty>暂无投稿记录。</Empty>;
  const units = new Set(rows.map((r) => r.project_id)).size, live = rows.filter((r) => r.status === 'review').length;
  const open = rows.reduce((t, r) => t + r.threads_open, 0);
  return <>
    <p className="hint">{units} 个研究单元、{rows.length} 篇稿件，{live} 篇在审；追踪的质疑中有 {open} 条在最近一轮评审里仍被提出。分数为五分制，分数和质疑取最近一轮有评审的那一轮。「审稿人」一列是重投时提出的申请：沿用上一轮的，还是换一组。评审是保密材料，仅中心成员可见，不得外传。</p>
    <div className="rv-key">{AXES.map((a) => <span key={a}><Q a={a} />{AXIS[a][1]}</span>)}</div>
    <div className="scroll"><table className="wb-table rv-sumt">
      <thead><tr><th>研究单元</th><th>稿件</th><th>状态</th><th className="r">轮次</th><th className="r">本轮均分</th><th className="r">上一轮均分</th><th>审稿人</th><th className="r">AC</th>{AXES.map((a) => <th key={a} className="r"><Q a={a} /></th>)}<th className="r">仍被提出</th><th className="r">已回应</th></tr></thead>
      <tbody>{rows.map((r) => { const d = r.mean != null && r.prev_mean != null ? Number(r.mean) - Number(r.prev_mean) : 0;
        return <tr key={r.project_id + r.relation}>
          <td><a href={`#/project/${r.project_id}`}>{r.name}</a><span className="sub2 blk">{r.code}{r.owner_name ? ` · ${r.owner_name}` : ''}</span></td>
          <td className="wrap">{r.relation === 'prior' && <Badge>前作</Badge>} {r.title}<span className="sub2 blk">{r.venue} {r.cycle.slice(0, 7)}{r.number != null ? ` · #${r.number}` : ''}{r.judged_cycle && r.judged_cycle !== r.cycle ? ` · 评审取自 ${r.judged_cycle.slice(0, 7)}` : ''}</span></td>
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
