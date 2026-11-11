import { useMemo, useState } from 'react';
import { rpc, useViews, type CardPick, type FundEvent, type Me, type Req, type ReqEvent, type Subject, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, day, money, num, today } from '../ui';
import { RequestTable } from './Requests';

const KINDS = ['到账', '认领', '预借票', '核销', '下达', '冻结', '回收'];

export function School({ me }: { me: Me }) {
  const finance = me.role === 'finance';
  const { data, error, reload } = useViews<{ reqs: Req[]; cards: CardPick[]; subjects: Subject[]; users: User[]; events: FundEvent[]; returns: ReqEvent[]; fails: ReqEvent[] }>({
    reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], users: ['users'], events: ['fund_event'],
    returns: ['request_event', { kind: 'return' }], fails: ['procurement_event'],
  });
  const [adding, setAdding] = useState(false);
  const [finish, setFinish] = useState<FundEvent | null>(null);
  const [all, setAll] = useState(false);
  const maps = useMemo(() => ({
    card: new Map((data?.cards ?? []).map((c) => [c.id, c.name])),
    subject: new Map((data?.subjects ?? []).map((s) => [s.id, s.name])),
    user: new Map((data?.users ?? []).map((u) => [u.id, u.name])),
    req: new Map((data?.reqs ?? []).map((r) => [r.id, r])),
  }), [data]);
  if (!data) return <Loading error={error} />;

  const byEta = (a: Req, b: Req) => a.eta_date.localeCompare(b.eta_date);
  const atSchool = data.reqs.filter((r) => r.status === 'at_school').sort(byEta);
  const returned = data.reqs.filter((r) => r.status === 'returned').sort(byEta);
  const events = [...data.events].sort((a, b) => Number(a.done) - Number(b.done) || b.event_date.localeCompare(a.event_date));
  const open = events.filter((e) => !e.done);
  const shown = all ? events : open;
  const log = [
    ...data.returns.map((e) => ({ ...e, label: '学校退单', tone: 'bad' })),
    ...data.fails.filter((e) => e.kind === '废标' || e.kind === '流标').map((e) => ({ ...e, label: e.kind, tone: 'warn' })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const table = (rows: Req[]) => <RequestTable me={me} rows={rows} cards={data.cards} subjects={data.subjects}
    cardName={maps.card} subjectName={maps.subject} userName={maps.user} onChange={reload} />;

  return (
    <>
      <div className="top"><h2>学校侧进度</h2>
        {finance && <button onClick={() => setAdding(true)}>登记一笔</button>}</div>

      <section className="card">
        <h3>被学校退回</h3>
        <p className="hint">退回的单据仍占用额度。财务岗可以改到别的卡或科目重新送审，也可以释放。</p>
        {returned.length === 0 ? <Empty>没有被退回的单据。</Empty> : table(returned)}
      </section>

      <section className="card">
        <h3>学校审核中</h3>
        {atSchool.length === 0 ? <Empty>没有在学校审核的单据。</Empty> : (
          <>{table(atSchool)}<p className="sub2">{atSchool.length} 笔，合计 {money(atSchool.reduce((s, r) => s + num(r.amount), 0))}</p></>
        )}
      </section>

      <section className="card">
        <h3>到账认领与借票核销</h3>
        <p className="hint">项目经费到校后要在科研系统认领才能使用；预借的发票要在款到后核销。登记时写了待办的记录，办结前列在这里。</p>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={!all} onClick={() => setAll(false)}>未办 {open.length}</button>
          <button className="sm" aria-pressed={all} onClick={() => setAll(true)}>全部 {events.length}</button>
        </div>
        {shown.length === 0 ? <Empty>{all ? '还没有登记过学校侧的记录。' : '没有未办的认领或核销。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>经费卡</th><th>类型</th><th className="r">金额</th><th>待办</th><th /></tr></thead>
            <tbody>{shown.map((e) => (
              <tr key={e.id}><td>{day(e.event_date)}</td><td><a href={`#/card/${e.card_id}`}>{maps.card.get(e.card_id) ?? '—'}</a></td>
                <td>{e.kind}</td><td className="r">{money(e.amount)}</td>
                <td className="wrap">{e.done ? <Badge tone="ok">已办</Badge> : <Badge tone="warn">未办</Badge>} {e.todo}</td>
                <td><div className="acts">{finance && !e.done && <button className="sm ghost" onClick={() => setFinish(e)}>标记已办</button>}</div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>退单与废标记录</h3>
        {log.length === 0 ? <Empty>还没有退单、废标或流标的记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>类型</th><th>事项</th><th>经费卡</th><th className="r">金额</th><th>原因</th></tr></thead>
            <tbody>{log.map((e) => { const r = maps.req.get(e.request_id); return (
              <tr key={e.id}><td>{day(e.at)}</td><td><Badge tone={e.tone}>{e.label}</Badge></td>
                <td className="wrap">{r?.title ?? '—'}</td><td>{r ? maps.card.get(r.card_id) ?? '—' : '—'}</td>
                <td className="r">{r ? money(r.amount) : '—'}</td><td className="wrap">{e.note ?? '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>

      {adding && <ActionDialog title="登记学校侧记录" submitLabel="登记"
        hint="需要后续办理的（例如到账后去认领、借票后等款到核销）写上待办；不写待办的只作为记录。"
        fields={[
          { name: 'card_id', label: '经费卡', options: data.cards.map((c): [string, string] => [c.id, `${c.card_no} ${c.name}`]) },
          { name: 'kind', label: '类型', options: KINDS.map((k): [string, string] => [k, k]) },
          { name: 'event_date', label: '日期', type: 'date', value: today() },
          { name: 'amount', label: '金额（元）', type: 'number' },
          { name: 'todo', label: '待办（没有就不填）', required: false },
        ]}
        onSubmit={async (v) => { await rpc('add_fund_event', v); reload(); }} onClose={() => setAdding(false)} />}
      {finish && <ActionDialog title="标记已办" submitLabel="确认已办" fields={[]}
        hint={`${maps.card.get(finish.card_id) ?? ''} ${day(finish.event_date)} ${finish.kind} ${money(finish.amount)}：${finish.todo ?? ''}`}
        onSubmit={async () => { await rpc('finish_fund_event', { id: finish.id }); reload(); }} onClose={() => setFinish(null)} />}
    </>
  );
}
