import { useState } from 'react';
import { rpc, useViews, type Me } from './api';
import { ActionDialog, Badge, Empty, Loading, day, type Field } from './ui';

// 成长主线：每人当前身份的主线任务清单（The Path of an Independent Researcher，草案第五十三版）。
// 本人看自己的；有人员查看权限的人和中心负责人看全中心的，并在此确认任务、认定身份。
export interface PathPerson { person_id: string; person_name: string; no: string | null; kind: string | null; user_id: string | null; mine: boolean;
  rank: Rank; rank_label: string; tasks: number; done: number; rank_since: string | null; can_set_rank: boolean }
export interface PathTask { person_id: string; person_name: string; mine: boolean; rank: Rank; rank_label: string; code: string; seq: number; title: string; detail: string | null;
  verify: string; verify_label: string; edition: number; status: 'done' | 'open' | 'waiting'; progress: string | null; done_on: string | null; note: string | null;
  confirmed_by_name: string | null; can_confirm: boolean }
export interface RankChange { id: string; person_id: string; person_name: string; from_label: string; to_label: string; basis: string; decided_by_name: string | null; decided_at: string }
type Rank = 'intern' | 'assistant' | 'researcher' | 'rising_star' | 'pi' | 'director';
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

export const RANKS: [Rank, string, string][] = [
  ['intern', 'Intern', 'RI'], ['assistant', 'Assistant', 'RA'], ['researcher', 'Researcher', ''],
  ['rising_star', 'Rising Star', ''], ['pi', 'Principal Investigator', 'PI'], ['director', 'Director', ''],
];
const NEXT: Partial<Record<Rank, string>> = { intern: 'RA 考核（小任务）', assistant: 'Researcher 考核（课题提案）', researcher: 'Rising Star 考核', rising_star: 'PI 认定', pi: 'Director 认定' };
const ST: Record<PathTask['status'], [string, string]> = { done: ['ok', '已完成'], open: ['warn', '待完成'], waiting: ['', '待中台开通'] };

// 六种身份的阶梯，当前一级高亮
function Ladder({ rank }: { rank: Rank }) {
  const at = RANKS.findIndex(([k]) => k === rank);
  return (
    <ol className="path-ladder" aria-label="身份">
      {RANKS.map(([k, en, ab], i) => <li key={k} className={i < at ? 'past' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
        <b>{en}</b>{ab && <span>{ab}</span>}</li>)}
    </ol>
  );
}

// 一个人的任务清单
function Track({ p, tasks, onAct }: { p: PathPerson; tasks: PathTask[]; onAct?: (a: Act) => void }) {
  const list = tasks.filter((t) => t.person_id === p.person_id).sort((a, b) => a.seq - b.seq);
  const confirmAct = (t: PathTask): Act => ({ title: `确认完成：${t.title}`, label: '确认',
    hint: `${p.person_name} · ${p.rank_label}。认定方：${t.verify_label}。确认后通知本人；确认错了可以撤销。`,
    fields: [{ name: 'done_on', label: '完成日期', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'note', label: '说明（选填，如会议日期、纪要或证明）', type: 'area', required: false }],
    run: (v) => rpc('confirm_path_task', { person: p.person_id, code: t.code, done_on: v.done_on, note: v.note || null }) });
  const undoAct = (t: PathTask): Act => ({ title: `撤销确认：${t.title}`, label: '撤销', danger: true, hint: `撤销后这一条回到待完成。${p.person_name} 不会收到通知。`,
    fields: [], run: () => rpc('undo_path_task', { person: p.person_id, code: t.code }) });
  if (p.rank === 'director') return <Empty>Director 是这条路的终点，没有更高一级的主线任务。</Empty>;
  const all = list.length > 0 && list.every((t) => t.status === 'done');
  return (
    <>
      <div className="scroll"><table className="wb-table path-track">
        <thead><tr><th>#</th><th>任务</th><th>认定</th><th>状态</th>{onAct && <th />}</tr></thead>
        <tbody>{list.map((t) => (
          <tr key={t.code} className={t.status === 'done' ? 'done' : ''}>
            <td className="mono">{String(t.seq).padStart(2, '0')}</td>
            <td className="wrap"><b>{t.title}</b>{t.detail && <span className="sub2">{t.detail}</span>}</td>
            <td>{t.verify_label}</td>
            <td className="wrap"><Badge tone={ST[t.status][0]}>{ST[t.status][1]}</Badge>
              {t.status === 'done' && t.done_on && <span className="sub2">{day(t.done_on)}{t.confirmed_by_name ? ` · ${t.confirmed_by_name} 确认` : ''}{t.note ? ` · ${t.note}` : ''}</span>}
              {t.status !== 'done' && t.progress && <span className="sub2">{t.progress}</span>}
              {t.status === 'waiting' && <span className="sub2">所需功能上线后由中台自动认定</span>}</td>
            {onAct && <td className="r">{t.can_confirm && (t.status === 'done' && t.done_on
              ? <button className="ghost sm danger" onClick={() => onAct(undoAct(t))}>撤销</button>
              : t.status === 'open' && <button className="sm" onClick={() => onAct(confirmAct(t))}>确认完成</button>)}</td>}
          </tr>))}</tbody>
      </table></div>
      <p className="hint" style={{ marginTop: 10 }}>{all ? `本级任务已全部完成，可以申请${NEXT[p.rank] ?? '考核'}；考核的办理入口随后在中台开通。`
        : `先完成本级的全部任务，再申请${NEXT[p.rank] ?? '考核'}。高一级身份同时拥有低一级的全部权限。`}</p>
    </>
  );
}

// 首页「我的事项」里的一节：本人的身份和主线进度
export function PathMine() {
  const { data } = useViews<{ people: PathPerson[] }>({ people: ['path_person'] });
  const p = data?.people.find((x) => x.mine);
  if (!data) return null;
  if (!p) return <Empty>本人的人员档案尚未对应中台账号，请联系人事岗。</Empty>;
  return (
    <div className="path-mine">
      <Ladder rank={p.rank} />
      <p>当前身份 <b>{p.rank_label}</b>{p.rank !== 'director' && <> · 本级主线任务已完成 <b>{p.done} / {p.tasks}</b></>} · <a href="#/path">查看任务清单 →</a></p>
    </div>
  );
}

// 成长主线页
export function PathPage({ me, start }: { me: Me; start?: string }) {
  const { data, error, reload } = useViews<{ people: PathPerson[]; tasks: PathTask[]; changes: RankChange[] }>({
    people: ['path_person'], tasks: ['path_tracker'], changes: ['rank_change'] });
  const [act, setAct] = useState<Act | null>(null);
  const [pick, setPick] = useState(start ?? '');
  const [rank, setRank] = useState('');
  if (!data) return <Loading error={error} />;
  const mine = data.people.find((p) => p.mine);
  const others = data.people.filter((p) => !p.mine);
  const seesAll = others.length > 0;
  const sel = data.people.find((p) => p.person_id === pick && !p.mine);
  const rows = others.filter((p) => !rank || p.rank === rank).sort((a, b) => RANKS.findIndex(([k]) => k === b.rank) - RANKS.findIndex(([k]) => k === a.rank)
    || (a.no ? 0 : 1) - (b.no ? 0 : 1) || (a.no ?? '').localeCompare(b.no ?? '', 'en', { numeric: true }) || a.person_name.localeCompare(b.person_name, 'zh'));
  const rankAct = (p: PathPerson): Act => ({ title: `认定身份：${p.person_name}`, label: '认定',
    hint: `当前为 ${p.rank_label}。身份靠完成任务并通过考核取得，由中心负责人认定；升降都记一条，写明依据，并通知本人。`,
    fields: [{ name: 'rank', label: '身份', options: RANKS.filter(([k]) => k !== p.rank).map(([k, en, ab]) => [k, ab ? `${en}（${ab}）` : en]) },
      { name: 'basis', label: '依据', type: 'area', value: '' }],
    run: (v) => rpc('set_rank', { person: p.person_id, rank: v.rank, basis: v.basis }) });
  const histOf = (id: string) => data.changes.filter((c) => c.person_id === id).sort((a, b) => b.decided_at.localeCompare(a.decided_at));
  const History = ({ id }: { id: string }) => { const h = histOf(id); return h.length === 0 ? null : (
    <ul className="path-hist">{h.map((c) => <li key={c.id}>{day(c.decided_at)} {c.from_label} → <b>{c.to_label}</b>{c.decided_by_name ? `，${c.decided_by_name} 认定` : ''}。依据：{c.basis}</li>)}</ul>); };

  return (
    <div className="wb">
      <div className="top"><h2>成长主线</h2></div>
      <p className="lede">每个人加入中心即为独立研究者。身份分 Intern（RI）、Assistant（RA）、Researcher、Rising Star、PI、Director 六种，靠完成本级的全部主线任务并通过考核取得，不看学籍。
        每条任务写明由谁认定：中台自动的按记录判定，其余由对应岗位确认。依据《The Path of an Independent Researcher》草案第五十三版。</p>

      <section className="wb-sec">
        <h3>本人 {mine && <span className="h3sub">{mine.person_name} · {mine.rank_label}</span>}</h3>
        {!mine ? <Empty>本人的人员档案尚未对应中台账号，请联系人事岗。</Empty> : <>
          <Ladder rank={mine.rank} />
          <Track p={mine} tasks={data.tasks} onAct={data.tasks.some((t) => t.mine && t.can_confirm) ? setAct : undefined} />
          <History id={mine.person_id} />
        </>}
      </section>

      {seesAll && (
        <section className="wb-sec">
          <h3>全中心 <span className="h3sub">{others.length} 人 · 在岗与非编</span></h3>
          <div className="tabs" style={{ marginBottom: 12 }}>
            <button aria-pressed={rank === ''} onClick={() => setRank('')}>全部</button>
            {RANKS.map(([k, en, ab]) => { const n = others.filter((p) => p.rank === k).length; return n === 0 ? null :
              <button key={k} aria-pressed={rank === k} onClick={() => setRank(k)}>{ab || en} {n}</button>; })}
          </div>
          {rows.length === 0 ? <Empty>没有符合条件的人员。</Empty> : (
            <div className="scroll"><table className="wb-table">
              <thead><tr><th>姓名</th><th>身份</th><th className="r">本级任务</th><th>最近认定</th><th /></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.person_id} className={p.person_id === pick ? 'sel' : ''}>
                  <td><b>{p.person_name}</b>{p.no && <span className="sub2">{p.no}</span>}{!p.user_id && <span className="sub2">尚未登录</span>}</td>
                  <td>{p.rank_label}</td>
                  <td className="r">{p.rank === 'director' ? '—' : `${p.done} / ${p.tasks}`}</td>
                  <td>{p.rank_since ? day(p.rank_since) : '—'}</td>
                  <td className="r"><div className="acts">
                    <button className="ghost sm" onClick={() => setPick(p.person_id === pick ? '' : p.person_id)}>{p.person_id === pick ? '收起' : '任务清单'}</button>
                    {p.can_set_rank && <button className="ghost sm" onClick={() => setAct(rankAct(p))}>认定身份</button>}
                  </div></td>
                </tr>))}</tbody>
            </table></div>
          )}
          {sel && <div className="path-sel">
            <h3>{sel.person_name} <span className="h3sub">{sel.rank_label}</span></h3>
            <Ladder rank={sel.rank} />
            <Track p={sel} tasks={data.tasks} onAct={setAct} />
            <History id={sel.person_id} />
          </div>}
        </section>
      )}
      {mine?.can_set_rank && !seesAll && <p className="hint">认定身份在「全中心」一节办理。</p>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
      {me.role === 'director' && mine && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="ghost sm" onClick={() => setAct(rankAct(mine))}>认定本人身份</button></div>}
    </div>
  );
}
