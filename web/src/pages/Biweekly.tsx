import { useState, type FormEvent } from 'react';
import { rpc, useViews, type BiweeklyReport, type BiweeklyStatus, type BwStage } from '../api';
import { Badge, Empty, Loading, day } from '../ui';
import { addDays } from '../token';

// 双周表：每个研究单元每两周登记一次，只在每期第一天（登记日）登记，交上一期的结果和这一期的计划；过了当天不补登。期次与名义币相同。
// 上半部分是本人所在研究单元的登记，下半部分按课题列出全部研究单元的登记情况，点研究单元看历次登记。
export const BW_STAGE: [BwStage, string][] = [['idea', '想法'], ['abstract', '摘要'], ['first_figure', '首图'], ['results_table', '核心结果表'], ['full_draft', '完整初稿'], ['submitted', '投稿稿']];
export const bwStage = (s: string | null | undefined) => BW_STAGE.find(([k]) => k === s)?.[1] ?? '—';
// 未登记的期数：一期未登记由联席会议优先过问；连续两期未登记转为停滞（培养路径第二十二条）
export const bwMissed = (s: BiweeklyStatus) => s.missed <= 0 ? null
  : s.missed === 1 ? <Badge tone="warn">未登记 1 期</Badge>
  : <Badge tone="bad">停滞 · 连续 {s.missed} 期未登记</Badge>;

const FIELDS: { k: 'question' | 'done' | 'changed' | 'issues' | 'division' | 'next'; label: string; max: number; rows: number; opt?: boolean }[] = [
  { k: 'question', label: '本轮回答的问题（每轮只回答一个问题）', max: 300, rows: 3 },
  { k: 'done', label: '已完成的工作与阶段结果', max: 2000, rows: 3 },
  { k: 'changed', label: '本轮改变的判断', max: 1000, rows: 3 },
  { k: 'issues', label: '遇到的问题（选填）', max: 1000, rows: 3, opt: true },
  { k: 'division', label: '成员分工', max: 500, rows: 3 },
  { k: 'next', label: '下一轮安排与预期', max: 1000, rows: 3 },
];

function ReportForm({ unit, period, cur, last, onSaved }: { unit: BiweeklyStatus; period: string; cur?: BiweeklyReport; last?: BiweeklyReport; onSaved: () => void }) {
  // 本期已登记的按已登记的改；没登记的沿用上一次的写作进度和成员分工，其余按本轮填写
  const [v, setV] = useState({ stage: cur?.stage ?? last?.stage ?? '', question: cur?.question ?? '', done: cur?.done ?? '', changed: cur?.changed_judgment ?? '',
    issues: cur?.issues ?? '', division: cur?.division ?? last?.division ?? '', next: cur?.next_plan ?? '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg('');
    try {
      await rpc('save_biweekly_report', { project: unit.project_id, period, ...v, issues: v.issues || null });
      setMsg('已登记。'); onSaved();
    } catch (err) { setMsg((err as Error).message); }
    setBusy(false);
  };
  return (
    <form onSubmit={save}>
      {last && !cur && <p className="hint">上一次登记（{day(last.period_start)} 起）：本轮问题「{last.question}」；下一轮安排与预期：{last.next_plan}</p>}
      <div className="grid">
        <label className="field"><span>写作进度</span>
          <select required value={v.stage} onChange={(e) => setV({ ...v, stage: e.target.value })}>
            <option value="">请选择</option>{BW_STAGE.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select></label>
        {FIELDS.map((f) => (
          <label key={f.k} className="field"><span>{f.label}</span>
            <textarea rows={f.rows} required={!f.opt} maxLength={f.max} value={v[f.k]} onChange={(e) => setV({ ...v, [f.k]: e.target.value })} /></label>))}
      </div>
      <div className="actions" style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
        <button type="submit" className="sm" disabled={busy}>{busy ? '处理中…' : cur ? '更新登记' : '登记'}</button>
        {cur && <span className="sub2">{cur.submitted_by_name} 登记于 {day(cur.submitted_at)}{cur.updated_by_name ? `，${cur.updated_by_name} 修改于 ${day(cur.updated_at)}` : ''}</span>}
        {msg && <span className="sub2">{msg}</span>}
      </div>
    </form>
  );
}

function History({ rows }: { rows: BiweeklyReport[] }) {
  if (rows.length === 0) return <Empty>尚无登记。</Empty>;
  return (
    <div className="scroll"><table className="recon">
      <thead><tr><th style={{ width: 110 }}>期次</th><th style={{ width: 90 }}>写作进度</th><th>本轮问题与结果</th><th>本轮改变的判断</th><th>问题、分工与下一轮</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}><td>{day(r.period_start)}<span className="sub2 blk">至 {day(r.period_end)}</span><span className="sub2 blk">{r.updated_by_name ?? r.submitted_by_name}</span></td>
          <td>{bwStage(r.stage)}</td>
          <td className="wrap" style={{ whiteSpace: 'pre-wrap' }}><b>{r.question}</b>{'\n'}{r.done}</td>
          <td className="wrap" style={{ whiteSpace: 'pre-wrap' }}>{r.changed_judgment}</td>
          <td className="wrap" style={{ whiteSpace: 'pre-wrap' }}>{r.issues && <>问题：{r.issues}{'\n'}</>}分工：{r.division}{'\n'}下一轮：{r.next_plan}</td></tr>))}</tbody>
    </table></div>
  );
}

export function Biweekly() {
  const { data, error, reload } = useViews<{ st: BiweeklyStatus[]; reps: BiweeklyReport[] }>({ st: ['biweekly_status'], reps: ['biweekly_report'] });
  const [pick, setPick] = useState<Record<string, string>>({});   // 各研究单元在填哪一期
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const all = [...data.st].sort((a, b) => (a.topic_code ?? '').localeCompare(b.topic_code ?? '') || a.unit_code.localeCompare(b.unit_code));
  const reps = [...data.reps].sort((a, b) => b.period_start.localeCompare(a.period_start));
  const of = (id: string) => reps.filter((r) => r.project_id === id);
  const mine = all.filter((s) => s.can_fill);
  const cur = all[0] ? day(all[0].period_start) : '';
  const topics = [...new Map(all.map((s) => [s.topic_id ?? '', s.topic_name ?? '未挂课题'])).entries()];
  const filled = all.filter((s) => s.filled).length, late = all.filter((s) => s.missed > 0).length;
  return (
    <>
      <div className="top"><h2>双周表</h2></div>
      <p className="lede">每个研究单元每两周登记一次：写作进度、本轮回答的问题、已完成的工作与阶段结果、本轮改变的判断、遇到的问题、成员分工和下一轮安排。双周表只在每期第一天（登记日）登记，交上一期的结果和这一期的计划，当天 24:00 截止，不补登。一期未登记的研究单元由联席会议优先过问，连续两期未登记的转为停滞；未登记双周表的研究单元不参加方向会汇报。
        两周一期，与名义币的期次相同。本期的时间去向在<a href="#/">首页「我的事项」</a>登记。</p>
      <section className="card">
        <h3>我的研究单元 {cur && <span className="h3sub">本期 {cur} 至 {day(all[0].period_end)}</span>}</h3>
        {mine.length === 0 ? <Empty>本人尚不在任何已成立的研究单元里，暂无需登记的双周表。</Empty> : (
          <div className="stack">{mine.map((s) => {
            const p = day(s.period_start);
            const here = of(s.project_id), now = here.find((r) => day(r.period_start) === p), last = here.find((r) => day(r.period_start) < p);
            return (
              <div key={s.project_id}>
                <h4 className="subhd">{s.unit_name}<span className="sub2">{s.unit_code} · {s.topic_name ?? '—'} · 负责人 {s.leader_name ?? '—'}</span>{' '}
                  {s.filled ? <Badge tone="ok">本期已登记</Badge> : s.open ? <Badge tone="warn">今天是登记日，尚未登记</Badge> : <Badge tone="bad">本期逾期未登记</Badge>} {bwMissed(s)}</h4>
                {s.open ? <ReportForm key={`${s.project_id}-${p}`} unit={s} period={p} cur={now} last={last} onSaved={reload} />
                  : <p className="hint">{s.filled ? '本期已登记。' : '本期的登记日已过，不能补登。'}下一个登记日是 {day(s.register_day)}，届时登记这一期的结果和下一期的计划。{now ? '本期登记的内容在下方「全部研究单元」里点名称查看。' : ''}</p>}
              </div>); })}</div>
        )}
      </section>
      <section className="card">
        <h3>全部研究单元 <span className="h3sub">{all.length} 个 · 本期已登记 {filled} 个{late > 0 ? ` · 未登记 ${late} 个，其中停滞 ${all.filter((s) => s.missed >= 2).length} 个` : ''}</span></h3>
        <p className="hint">点研究单元名称查看历次登记。登记日过了仍未登记的，当期即计为未登记一期；连续两期未登记的转为停滞。研究单元成立之前的期次不计。</p>
        {all.length === 0 ? <Empty>暂无已成立的研究单元。</Empty> : (
          <div className="stack">{topics.map(([tid, tname]) => (
            <div key={tid}>
              <h4 className="subhd">{tname}</h4>
              <div className="scroll"><table>
                <thead><tr><th>研究单元</th><th>负责人</th><th>本期</th><th>最近写作进度</th><th>最近登记</th><th>连续未登记</th></tr></thead>
                <tbody>{all.filter((s) => (s.topic_id ?? '') === tid).map((s) => [
                  <tr key={s.project_id}>
                    <td><button type="button" className="ghost sm" aria-expanded={open === s.project_id} onClick={() => setOpen(open === s.project_id ? null : s.project_id)}>{s.unit_name}</button><span className="sub2">{s.unit_code}</span></td>
                    <td>{s.leader_name ?? '—'}</td>
                    <td>{s.filled ? <Badge tone="ok">已登记</Badge> : <span className="sub2">未登记</span>}</td>
                    <td>{bwStage(s.last_stage)}</td>
                    <td>{s.last_period ? day(s.last_period) : '—'}</td>
                    <td>{s.missed > 0 ? <>{s.missed} 期 {bwMissed(s)}</> : '—'}</td></tr>,
                  open === s.project_id && <tr key={`${s.project_id}-h`}><td colSpan={6}><History rows={of(s.project_id)} /></td></tr>,
                ])}</tbody>
              </table></div>
            </div>))}</div>
        )}
      </section>
    </>
  );
}
