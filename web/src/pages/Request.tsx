import { useViews, type CardPick, type LinePick, type Me, type Project, type ProjectTag, type Req, type ReqEvent, type Subject, type User } from '../api';
import { Badge, Empty, Loading, can, day, money, num, reqBadge } from '../ui';
import { ObjHead, Stages, Track, type Seg } from '../tree';
import { RequestTable } from './Requests';

// 办理记录里各类动作的叫法
const EVENT: Record<string, string> = {
  submit: '提交申请', backfill: '补登在途支出', confirm: '研究单元负责人确认', check: '财务岗核对', approve: '批准', to_school: '提交学校', post: '学校入账',
  return: '学校退回', release: '释放', reject: '驳回', move: '变更经费卡', advance: '采购进入下一阶段',
};

// 支出申请页：一笔支出从申请到入账的全过程。采购是其中一个环节，办理的入口也在这一页
export function RequestPage({ me, id }: { me: Me; id: string }) {
  const f = { id };
  const { data, error, reload } = useViews<{ req: Req[]; events: ReqEvent[]; buys: ReqEvent[]; cards: CardPick[]; subjects: Subject[]; users: User[]; picks: LinePick[]; projects: Project[]; tags: ProjectTag[] }>({
    req: ['request', f], events: ['request_event', { request_id: id }], buys: ['procurement_event', { request_id: id }],
    cards: ['card_pick'], subjects: ['subject'], users: ['users'], picks: ['line_pick'], projects: ['project'], tags: ['project_tag'],
  }, id);
  if (!data) return <Loading error={error} />;
  const r = data.req[0];
  if (!r) return <><div className="top"><h2>支出申请</h2></div><Empty>该支出申请不存在或无权查看。<a href="#/requests">返回支出申请</a></Empty></>;
  const staff = can(me, 'read.finance');
  const card = data.cards.find((c) => c.id === r.card_id);
  const subject = data.subjects.find((s) => s.id === r.subject_id);
  const userName = new Map(data.users.map((u) => [u.id, u.name]));
  const tagged = new Set(data.tags.filter((t) => t.morningstar).map((t) => t.id));
  const lines = data.picks.map((l): [string, string] => [l.id, `${l.project_name} · ${l.category_name} · ${l.purpose}`]);
  const buying = !!r.path && r.stage != null && r.stages != null;
  const bought = buying && r.stage! >= r.stages!;
  const dead = r.status === 'released' || r.status === 'rejected';
  const amount = num(r.status === 'posted' ? r.posted_amount ?? r.amount : r.amount);
  const [badge, tone] = reqBadge(r);
  // 走到哪一环：申请、确认与核对、采购、提交学校、入账
  const at = dead ? 0 : r.status === 'posted' ? 6 : r.status === 'at_school' || r.status === 'returned' ? 4 : r.status === 'committed' ? (buying && !bought ? 3 : 4) : r.step ? 2 : 2;
  const seg = (on: boolean, done: boolean, text: string): Seg => ({ cls: `${done ? 'sa' : on ? 'sc' : 'sr'} big`, value: 1, text, tip: `${text}：${done ? '已完成' : on ? '当前环节' : '尚未到'}` });
  const names = ['申请', '确认与核对', buying ? '采购' : '无须采购', '提交学校', '入账'];
  const evs = [...data.events].sort((a, b) => a.at.localeCompare(b.at));
  const last = (k: string) => [...evs].reverse().find((e) => e.kind === k);
  const when = (k: string) => { const e = last(k); return e ? day(e.at) : ''; };
  return (
    <div className="wb obj">
      <ObjHead crumb={<><a href="#/s-topic">课题</a> › <a href={`#/requests/${r.status}`}>支出申请</a> › {r.code ?? r.title}</>}
        eyebrow={['支出申请', r.code, r.requester_name ?? userName.get(r.requested_by ?? ''), r.split_group && '分摊', r.project_id && tagged.has(r.project_id) && '晨星', r.emergency && '紧急通道'].filter(Boolean).join(' · ')}
        title={r.title} badge={<Badge tone={tone}>{badge}</Badge>}
        label={r.status === 'posted' ? '已入账金额' : '申请金额'} value={amount}
        chart={dead ? <Empty>该申请已{r.status === 'released' ? '释放' : '驳回'}，不再占用预算和经费卡。</Empty>
          : <Track cap="所在环节" segs={names.map((n, i) => seg(i + 1 === at, i + 1 < at, n))} />}
        facts={[['研究单元 · 预算行', r.project_id ? <a href={`#/project/${r.project_id}`}>{r.project_name}{r.line_purpose ? ` · ${r.line_purpose}` : ''}</a> : '—'],
          ['经费卡', r.card_id && staff ? <a href={`#/card/${r.card_id}`}>{card?.name ?? '经费卡'}</a> : card?.name ?? '—'],
          ['科目', subject?.name ?? '—'], ['预计入账', day(r.eta_date)], ...(r.voucher_no ? [['凭证号', r.voucher_no] as [string, string]] : [])]} />
      {!dead && <Stages path={`申请 › 确认与核对 › ${buying ? '采购' : '无须采购'} › 提交学校 › 入账`} at={at} items={[
        { nm: '申请', ds: '先申请、后支出', v: day(r.created_at), f: `${r.requester_name ?? userName.get(r.requested_by ?? '') ?? '申请人'} 提交` },
        { nm: '确认与核对', ds: '负责人确认，财务岗核对', v: r.status === 'pending' ? badge : '已通过', f: [r.confirmed_by_name && `${r.confirmed_by_name} 确认`, r.checked_by_name && `${r.checked_by_name} 核对`, r.self_confirmed && '负责人本人提交'].filter(Boolean).join('，') || (num(r.over_amount ?? 0) > 0 ? `超出预算行 ${money(r.over_amount)}` : '') },
        { nm: buying ? '采购' : '无须采购', ds: buying ? `${r.path}，至验收贴码` : '不涉及采购', v: buying ? `${r.stage} / ${r.stages} 阶段` : '—', f: buying ? (bought ? '已验收贴码' : '采购中') : '' },
        { nm: '提交学校', ds: '报销材料交学校审核', v: r.status === 'at_school' ? '学校审核中' : r.status === 'returned' ? '已退回' : r.status === 'posted' ? '已通过' : '未提交', f: r.status === 'returned' ? r.return_note ?? '' : when('to_school') ? `${when('to_school')} 提交` : '' },
        { nm: '入账', ds: '以学校正式入账为准', v: r.status === 'posted' ? money(amount) : '未入账', f: r.posted_on ? `${day(r.posted_on)} 入账` : '' },
      ]} />}

      <section className="card">
        <h3>办理 <span className="h3sub">当前可办理的操作列在右侧</span></h3>
        <RequestTable me={me} rows={[r]} tagged={tagged} cards={data.cards} subjects={data.subjects} cardName={staff ? new Map(data.cards.map((c) => [c.id, c.name])) : undefined}
          subjectName={new Map(data.subjects.map((s) => [s.id, s.name]))} userName={userName} projectName={new Map(data.projects.map((p) => [p.id, p.name]))} lines={lines} onChange={reload} />
        {r.status === 'rejected' && r.return_note && <p className="hint">驳回原因：{r.return_note}</p>}
      </section>

      {buying && (
        <section className="card">
          <h3>采购 <span className="h3sub">{r.path} · 第 {r.stage} / {r.stages} 阶段</span></h3>
          {data.buys.length === 0 ? <Empty>暂无采购记录。</Empty> : (
            <table><thead><tr><th>日期</th><th>事项</th><th>说明</th></tr></thead>
              <tbody>{[...data.buys].sort((a, b) => a.at.localeCompare(b.at)).map((e) => <tr key={e.id}><td>{day(e.at)}</td><td>{EVENT[e.kind] ?? e.kind}</td><td className="wrap">{e.note ?? '—'}</td></tr>)}</tbody></table>
          )}
          {staff && <p className="hint">采购各阶段在「<a href="#/procure">采购</a>」中推进；最后一个阶段为验收贴码，完成后方可提交学校。</p>}
        </section>
      )}

      <section className="card">
        <h3>办理记录 <span className="h3sub">{evs.length} 条</span></h3>
        {evs.length === 0 ? <Empty>暂无办理记录。</Empty> : (
          <table><thead><tr><th>时间</th><th>动作</th><th>说明</th></tr></thead>
            <tbody>{evs.map((e) => <tr key={e.id}><td>{day(e.at)}</td><td>{EVENT[e.kind] ?? e.kind}</td><td className="wrap">{e.note ?? '—'}</td></tr>)}</tbody></table>
        )}
      </section>
    </div>
  );
}
