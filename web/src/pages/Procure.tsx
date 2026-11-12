import { useMemo, useState } from 'react';
import { useViews, type CardPick, type Me, type Req, type ReqEvent, type Subject } from '../api';
import { ActionDialog, Badge, Empty, Loading, REQ, Tile, day, money, num, today } from '../ui';
import { actionsFor } from './Requests';

type Action = ReturnType<typeof actionsFor>[number];
const STAGES: Record<string, string[]> = {
  直采: ['下单', '审批（约 14 天）', '到货', '验收贴码'],
  集采: ['申报', '集中采购（约 2.5 个月）', '到货', '验收贴码'],
  分散采购: ['备案', '论证', '挂网竞价', '合同', '到货', '验收贴码'],
};
const EVENT: Record<string, string> = { advance: '进到下一阶段' };
const daysTo = (d: string, from: string) => Math.round((Date.parse(day(d)) - Date.parse(from)) / 864e5);

function Steps({ r }: { r: Req }) {
  const names = STAGES[r.path ?? ''] ?? [];
  const n = r.stages ?? names.length, at = r.stage ?? 0;
  const list = names.length === n ? names : Array.from({ length: n }, (_, i) => `第 ${i + 1} 阶段`);
  return <ol className="steps" aria-label={`采购进度 ${at}/${n}`}>{list.map((s, i) => (
    <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}><span>{i < at ? '✓ ' : ''}{s}</span></li>))}</ol>;
}

export function Procure({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ reqs: Req[]; cards: CardPick[]; subjects: Subject[]; events: ReqEvent[] }>({
    reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], events: ['procurement_event'],
  });
  const [tab, setTab] = useState<'doing' | 'ready' | 'done'>('doing');
  const [act, setAct] = useState<Action | null>(null);
  const maps = useMemo(() => ({
    card: new Map((data?.cards ?? []).map((c) => [c.id, c])),
    events: (data?.events ?? []).reduce((m, e) => m.set(e.request_id, [...(m.get(e.request_id) ?? []), e]), new Map<string, ReqEvent[]>()),
    group: (data?.reqs ?? []).reduce((m, r) => (r.split_group ? m.set(r.split_group, [...(m.get(r.split_group) ?? []), r]) : m), new Map<string, Req[]>()),
  }), [data]);
  if (!data) return <Loading error={error} />;

  const now = today();
  const all = data.reqs.filter((r) => r.path && r.stages != null);
  const live = (r: Req) => r.status === 'pending' || r.status === 'committed';
  const doing = all.filter((r) => live(r) && r.stage! < r.stages!);
  const ready = all.filter((r) => r.status === 'committed' && r.stage === r.stages);
  const done = all.filter((r) => !live(r));
  const rows = (tab === 'doing' ? doing : tab === 'ready' ? ready : done).sort((a, b) => a.eta_date.localeCompare(b.eta_date));
  const late = doing.filter((r) => { const c = maps.card.get(r.card_id ?? ''); return day(r.eta_date) < now || (c && day(r.eta_date) > day(c.cutoff_date)); });
  const fails = data.events.filter((e) => e.kind === '废标' || e.kind === '流标').length;

  return (
    <>
      <div className="top"><h2>采购跟踪</h2></div>
      <div className="tiles">
        <Tile k="采购进行中" v={doing.length} f={money(doing.reduce((s, r) => s + num(r.amount), 0))} />
        <Tile k="已验收，待提交学校" v={ready.length} f={money(ready.reduce((s, r) => s + num(r.amount), 0))} />
        <Tile k="预计入账有风险" v={late.length} f="已过预计入账日，或晚于单据截止日" tone={late.length ? 'bad' : ''} />
        <Tile k="废标与流标" v={fails} f="累计次数" />
      </div>
      <section className="card">
        <h3>涉及采购的支出</h3>
        <p className="hint">直采单件 5 万以内，审批约 14 天；集采约 2.5 个月；分散采购要备案、论证、挂网、签合同。验收贴码之后才能提交学校。
          分摊到多张卡的支出共用一条采购，进度记在第一笔上。</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {([['doing', `进行中 ${doing.length}`], ['ready', `待提交学校 ${ready.length}`], ['done', `已结束 ${done.length}`]] as const).map(([k, label]) =>
            <button key={k} className="sm" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {rows.length === 0 ? <Empty>{tab === 'doing' ? '没有进行中的采购。' : tab === 'ready' ? '没有等待提交学校的采购。' : '还没有结束的采购。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>事项与进度</th><th>经费卡</th><th className="r">金额</th><th>预计入账</th><th>状态</th><th /></tr></thead>
            <tbody>{rows.map((r) => {
              const c = maps.card.get(r.card_id ?? ''); const left = daysTo(r.eta_date, now);
              const group = r.split_group ? maps.group.get(r.split_group) ?? [] : [];
              const ev = [...(maps.events.get(r.id) ?? [])].sort((a, b) => b.at.localeCompare(a.at));
              const acts = live(r) ? actionsFor(me, r, []).filter((a) => ['推进采购', '废标/流标', '提交学校'].includes(a.label)) : [];
              return (
                <tr key={r.id}>
                  <td className="wrap">{r.title}<div className="sub2">{[r.code, r.path, group.length > 1 && `分摊 ${group.length} 处，合计 ${money(group.reduce((s, x) => s + num(x.amount), 0))}`].filter(Boolean).join(' · ')}</div>
                    <Steps r={r} />
                    {ev.length > 0 && <div className="sub2" style={{ marginTop: 6 }}>{ev.slice(0, 3).map((e) => `${day(e.at)} ${EVENT[e.kind] ?? e.kind}${e.note ? `（${e.note}）` : ''}`).join('；')}</div>}</td>
                  <td>{c ? <a href={`#/card/${c.id}`}>{c.name}</a> : '—'}<div className="sub2">截止 {day(c?.cutoff_date)}</div></td>
                  <td className="r">{money(r.amount)}</td>
                  <td>{day(r.posted_on ?? r.eta_date)}
                    {live(r) && <div className="sub2">{c && day(r.eta_date) > day(c.cutoff_date) ? <Badge tone="bad">晚于单据截止日</Badge>
                      : left < 0 ? <Badge tone="bad">已过 {-left} 天</Badge> : left <= 30 ? <Badge tone="warn">还有 {left} 天</Badge> : `还有 ${left} 天`}</div>}</td>
                  <td><Badge tone={REQ[r.status][1]}>{REQ[r.status][0]}</Badge></td>
                  <td><div className="acts">{acts.map((a) => <button key={a.label} className={`sm ghost ${a.danger ? 'danger' : ''}`} onClick={() => setAct(a)}>{a.label}</button>)}</div></td>
                </tr>);
            })}</tbody>
          </table></div>
        )}
      </section>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
