import { useState, type ReactNode } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, money, type Field } from './ui';

// 加入与考核：人员加入（推荐、名额、联席会议表决、中心负责人决定、人事建档）和学期成员考核（进展小组、合作者评价、匿名短评、改进目标）
interface Quota { year: number; kind: string; kind_label: string; quota: number | null; used: number }
interface Admission { id: string; seq: number; year: number; name: string; kind: string; kind_label: string; needs_vote: boolean; school: string | null; direction: string | null; intro: string; link: string | null;
  recommender: string; recommender_name: string; status: 'pending' | 'voting' | 'recommended' | 'admitted' | 'declined' | 'withdrawn'; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  created_at: string; motion_id: string | null; motion_seq: number | null; can_withdraw: boolean; can_confirm: boolean; can_decide: boolean }
interface Newcomer { person_id: string; name: string; kind_label: string | null; joined_on: string; days: number; units: string | null; flagged: boolean }
interface Review { id: string; term: string; user_id: string; user_name: string; rank_label: string; track: 'group' | 'collab'; status: 'open' | 'voting' | 'leave_pending' | 'done';
  conclusion: string | null; conclusion_label: string | null; opinion: string | null; goals: string | null; goals_due: string | null; goals_met: boolean | null; goals_note: string | null;
  drafted_by_name: string | null; defense: string | null; decided_note: string | null; reviewers: { id: string; name: string; signed: boolean }[];
  am_reviewer: boolean; i_signed: boolean; mine: boolean; can_comment: boolean; my_comment: string | null; comment_count: number; comments: string[] | null;
  motion_id: string | null; motion_seq: number | null; prev_conclusion: string | null; prev_goals_met: boolean | null; can_decide: boolean; can_chair: boolean }
interface Record_ { id: string; term_from: string; term_to: string; units: string | null; biweekly_count: number; path_done: number; path_titles: string | null; snapshots: number; queries: number; queries_raised: number;
  spent: string; spent_count: number; lecture_total: number; lecture_ok: number; seminar_total: number; seminar_ok: number }
interface Act { title: string; hint?: ReactNode; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

const ADM: Record<Admission['status'], [string, string]> = { pending: ['warn', '待人事确认'], voting: ['warn', '联席会议议程中'], recommended: ['warn', '待中心负责人决定'], admitted: ['ok', '已加入'], declined: ['', '未接收'], withdrawn: ['', '已撤回'] };
const REV: Record<Review['status'], [string, string]> = { open: ['warn', '审阅中'], voting: ['warn', '联席会议议程中'], leave_pending: ['warn', '待中心负责人决定'], done: ['ok', '已办结'] };
const KINDS: [string, string][] = [['phd', '博士研究生（联席会议表决）'], ['postdoc', '博士后（联席会议表决）'], ['ra', '研究助理（联席会议表决）'], ['master', '硕士研究生'], ['ri', '研究实习生（本科生）'], ['visitor', '访问学生']];
const plus = (n: number) => new Date(Date.now() + n * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
const LAB = { normal: '正常', improve: '需改进', leave: '建议退组' } as Record<string, string>;

export function MembersPage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ quota: Quota[]; adm: Admission[]; newc: Newcomer[]; rev: Review[]; rec: Record_[]; people: PeoplePick[] }>(
    { quota: ['admission_quota'], adm: ['admission'], newc: ['newcomer'], rev: ['term_review'], rec: ['term_record'], people: ['people_pick'] });
  const [act, setAct] = useState<Act | null>(null);
  const [tab, setTab] = useState<'join' | 'term'>('join');
  if (!data) return <Loading error={error} />;
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  const isDirector = me.role === 'director';
  const chair = data.rev.some((r) => r.can_chair) || isDirector || me.perms.includes('budget.evaluate');
  const recOf = (id: string) => data.rec.find((x) => x.id === id);
  const curTerm = data.rev.map((r) => r.term).sort().pop();
  const rows = data.rev.filter((r) => r.term === curTerm);

  const submitAct = (): Act => ({ title: '推荐加入', label: '提交', hint: <>加入中心即为 Intern（RI），不做小任务。博士研究生、博士后、研究助理在中心负责人确定的年度名额内推荐，由正则列入联席会议议程表决，决议生效后由中心负责人决定；
      硕士研究生、研究实习生、访问学生由人事确认建档。建档后本人用飞书登录即可使用，加入后第一期内写出开题稿。与申请人有私人关系的，在联席会议表决时申报回避。</>,
    fields: [{ name: 'name', label: '姓名' }, { name: 'kind', label: '类别', options: KINDS }, { name: 'school', label: '学校或单位（选填）', required: false }, { name: 'dir', label: '研究方向（选填）', required: false },
      { name: 'intro', label: '推荐理由：研究兴趣、已有工作、拟参与的课题或研究单元', type: 'area' }, { name: 'link', label: '主页、简历或作品链接（选填）', required: false }],
    run: (v) => rpc('submit_admission', { name: v.name, kind: v.kind, school: v.school || null, direction: v.dir || null, intro: v.intro, link: v.link || null }) });

  const AdmRow = ({ a }: { a: Admission }) => (
    <li style={{ marginBottom: 10 }}><b>{a.name}</b> · {a.kind_label}{a.school ? ` · ${a.school}` : ''}{a.direction ? ` · ${a.direction}` : ''} <Badge tone={ADM[a.status][0]}>{ADM[a.status][1]}</Badge>
      <div className="sub2" style={{ marginLeft: 0 }}>第 {a.seq} 号 · 推荐人 {a.recommender_name} · {day(a.created_at)}{a.motion_seq ? <> · <a href={`#/motion/${a.motion_id}`}>联席会议第 {a.motion_seq} 号</a></> : null}</div>
      <div className="sub2" style={{ marginLeft: 0 }}>{a.intro}{a.link && <> <a href={a.link} target="_blank" rel="noreferrer">材料</a></>}</div>
      {a.decision_note && <div className="sub2" style={{ marginLeft: 0 }}>说明：{a.decision_note}</div>}
      <div className="ir-acts">
        {a.can_withdraw && <button className="sm ghost" onClick={() => setAct({ title: `撤回：${a.name}`, label: '撤回', danger: true, fields: [], run: () => rpc('withdraw_admission', { id: a.id }) })}>撤回</button>}
        {a.can_confirm && <><button className="sm" onClick={() => setAct({ title: `确认建档：${a.name}`, label: '建档', hint: '建一条在岗档案，身份为 Intern（RI），加入日期为今天。本人首次飞书登录时，请在人员档案里并入这一条。', fields: [{ name: 'n', label: '说明（选填）', required: false }],
          run: (v) => rpc('confirm_admission', { id: a.id, accept: true, note: v.n || null }) })}>确认建档</button>
          <button className="sm ghost" onClick={() => setAct({ title: `不予建档：${a.name}`, label: '不予建档', danger: true, fields: [{ name: 'n', label: '原因', type: 'area' }], run: (v) => rpc('confirm_admission', { id: a.id, accept: false, note: v.n }) })}>不予建档</button></>}
        {a.can_decide && <><button className="sm" onClick={() => setAct({ title: `决定接收：${a.name}`, label: '接收', hint: '接收的，建档为 Intern（RI），以后按成长路径认定身份；并通知人事在本人首次登录时并入档案。', fields: [{ name: 'n', label: '说明（选填）', required: false }],
          run: (v) => rpc('decide_admission', { id: a.id, accept: true, note: v.n || null }) })}>接收</button>
          <button className="sm ghost" onClick={() => setAct({ title: `不予采纳：${a.name}`, label: '不予采纳', fields: [{ name: 'n', label: '说明（选填）', required: false }], run: (v) => rpc('decide_admission', { id: a.id, accept: false, note: v.n || null }) })}>不予采纳</button></>}
      </div></li>);

  const reviewerAct = (r: Review): Act => ({ title: `${r.track === 'group' ? '登记进展小组' : '指定合作者'}：${r.user_name}`, label: '登记',
    hint: r.track === 'group' ? '进展小组由联席会议指定两名成员组成（Researcher 及以上），这里按联席会议的指定登记。本人、与本人有私人关系的不担任。' : '由合作的 Researcher 及以上成员评价，默认取本人所在研究单元的负责人。本人、与本人有私人关系的不担任。',
    fields: [{ name: 'a', label: '考核人一', options: people, value: r.reviewers[0]?.id ?? '' }, { name: 'b', label: r.track === 'group' ? '考核人二' : '考核人二（选填）', options: people, value: r.reviewers[1]?.id ?? '', required: r.track === 'group' },
      { name: 'ok', label: '考核人与本人没有私人关系', type: 'check', value: 'false' }],
    run: (v) => rpc('set_term_reviewers', { id: r.id, users: [v.a, v.b].filter(Boolean), no_conflict: v.ok === 'true' }) });
  const draftAct = (r: Review): Act => ({ title: `出具意见：${r.user_name}`, label: '起草并签署',
    hint: <>依据下面汇总的记录和合作者匿名短评，不要求本人另写总结。需改进的，写明与本人商定的两个月改进目标。{r.track === 'group' ? '进展小组两人都签署后，由正则列入联席会议议程表决。' : '正常、需改进的报联席会议备案；'}建议退组的，列入联席会议议程，须投票者三分之二同意、不记名，本人可以书面申辩一次。改了意见，另一人的签署作废。</>,
    fields: [{ name: 'c', label: '结论', options: [['normal', '正常'], ['improve', '需改进'], ['leave', '建议退组']], value: r.conclusion ?? '' }, { name: 'o', label: '意见', type: 'area', value: r.opinion ?? '' },
      { name: 'g', label: '改进目标（需改进的填）', type: 'area', required: false, value: r.goals ?? '' }, { name: 'd', label: '改进期限（需改进的填，约两个月）', type: 'date', required: false, value: r.goals_due ?? plus(60) }],
    run: (v) => rpc('draft_term_review', { id: r.id, conclusion: v.c, opinion: v.o, goals: v.c === 'improve' ? v.g : null, goals_due: v.c === 'improve' ? v.d : null }) });

  const RevCard = ({ r }: { r: Review }) => { const rc = recOf(r.id); return (
    <li style={{ marginBottom: 14 }}><b>{r.user_name}</b>（{r.rank_label}）· {r.track === 'group' ? '进展小组' : '合作者评价'}：{r.reviewers.length ? r.reviewers.map((x) => `${x.name}${x.signed ? '✓' : ''}`).join('、') : '未指定'}
      {' '}<Badge tone={REV[r.status][0]}>{REV[r.status][1]}</Badge>{r.conclusion_label && r.status !== 'open' && <> <Badge tone={r.conclusion === 'normal' ? 'ok' : 'warn'}>{r.conclusion_label}</Badge></>}
      {r.prev_conclusion && <span className="sub2"> 上学期：{LAB[r.prev_conclusion]}{r.prev_conclusion === 'improve' ? (r.prev_goals_met == null ? '，改进目标未记录' : r.prev_goals_met ? '，改进目标已达成' : '，改进目标未达成') : ''}</span>}
      {rc && <div className="sub2" style={{ marginLeft: 0 }}>记录（{day(rc.term_from)} 至 {day(rc.term_to)}）：研究单元 {rc.units ?? '无'}；负责的研究单元登记双周表 {rc.biweekly_count} 次；快照署名 {rc.snapshots} 次；
        入队回应质疑 {rc.queries} 条，提出质疑 {rc.queries_raised} 条；主线完成 {rc.path_done} 项{rc.path_titles ? `（${rc.path_titles}）` : ''}；周日讲座 {rc.lecture_ok}/{rc.lecture_total}，主题研讨会 {rc.seminar_ok}/{rc.seminar_total}；
        支出申请 {rc.spent_count} 笔 {money(rc.spent)}</div>}
      {r.comments && <div className="sub2" style={{ marginLeft: 0 }}>合作者匿名短评 {r.comments.length} 条：{r.comments.length ? r.comments.map((c, i) => <span key={i}>{i ? '；' : ''}「{c}」</span>) : '暂无'}</div>}
      {!r.comments && r.comment_count > 0 && <div className="sub2" style={{ marginLeft: 0 }}>已收到合作者匿名短评 {r.comment_count} 条</div>}
      {r.opinion && <div className="sub2" style={{ marginLeft: 0 }}>意见（{r.drafted_by_name} 起草）：{r.opinion}</div>}
      {r.goals && <div className="sub2" style={{ marginLeft: 0 }}>改进目标（{day(r.goals_due)} 前）：{r.goals}{r.goals_met != null && <>。{r.goals_met ? '已达成' : '未达成'}{r.goals_note ? `：${r.goals_note}` : ''}</>}</div>}
      {r.defense && <div className="sub2" style={{ marginLeft: 0 }}>本人书面申辩：{r.defense}</div>}
      {r.decided_note && <div className="sub2" style={{ marginLeft: 0 }}>{r.decided_note}</div>}
      <div className="ir-acts">
        {r.motion_seq && <a className="sm" href={`#/motion/${r.motion_id}`}>联席会议第 {r.motion_seq} 号 →</a>}
        {r.can_chair && r.status === 'open' && <button className="sm ghost" onClick={() => setAct(reviewerAct(r))}>{r.reviewers.length ? '更换考核人' : r.track === 'group' ? '登记进展小组' : '指定合作者'}</button>}
        {r.am_reviewer && r.status === 'open' && <button className="sm" onClick={() => setAct(draftAct(r))}>{r.conclusion ? '修改意见' : '出具意见'}</button>}
        {r.am_reviewer && r.status === 'open' && r.conclusion && !r.i_signed && <button className="sm" onClick={() => setAct({ title: `签署：${r.user_name}`, label: '签署', hint: `结论：${r.conclusion_label}。签署后${r.track === 'group' || r.conclusion === 'leave' ? '两人都签署的，列入联席会议议程' : '报联席会议备案'}。`, fields: [], run: () => rpc('sign_term_review', { id: r.id }) })}>签署</button>}
        {r.can_comment && <button className="sm ghost" onClick={() => setAct({ title: `匿名短评：${r.user_name}`, label: '提交', hint: '合作者短评只给考核人和联席会议主持人看，不显示作者；考核意见出具之前可以修改。三百字以内，写具体的事。', fields: [{ name: 'b', label: '短评', type: 'area', value: r.my_comment ?? '' }],
          run: (v) => rpc('write_term_comment', { id: r.id, body: v.b }) })}>{r.my_comment ? '修改短评' : '写匿名短评'}</button>}
        {r.mine && r.status === 'voting' && !r.defense && r.conclusion !== 'normal' && <button className="sm ghost" onClick={() => setAct({ title: '书面申辩', label: '提交', hint: '书面申辩只有一次，附在联席会议议题后；也可以在议题页申请到会陈述。', fields: [{ name: 't', label: '申辩', type: 'area' }], run: (v) => rpc('defend_term_review', { id: r.id, text: v.t }) })}>书面申辩</button>}
        {r.am_reviewer && r.status === 'done' && r.conclusion === 'improve' && r.goals_met == null && <button className="sm ghost" onClick={() => setAct({ title: `改进目标：${r.user_name}`, label: '记录', fields: [{ name: 'm', label: '是否达成', options: [['true', '已达成'], ['false', '未达成']] }, { name: 'n', label: '说明（选填）', required: false }],
          run: (v) => rpc('check_term_goals', { id: r.id, met: v.m === 'true', note: v.n || null }) })}>记录改进目标</button>}
        {r.can_decide && <><button className="sm" onClick={() => setAct({ title: `决定：${r.user_name} 退组`, label: '同意退组', danger: true, hint: '同意的，人员档案记为已离开，账号随即停用，并通知本人。', fields: [{ name: 'n', label: '说明（选填）', required: false }], run: (v) => rpc('decide_term_leave', { id: r.id, accept: true, note: v.n || null }) })}>同意退组</button>
          <button className="sm ghost" onClick={() => setAct({ title: `决定：${r.user_name} 退组`, label: '不予采纳', fields: [{ name: 'n', label: '说明（选填）', required: false }], run: (v) => rpc('decide_term_leave', { id: r.id, accept: false, note: v.n || null }) })}>不予采纳</button></>}
      </div></li>); };

  const mineRev = rows.filter((r) => r.mine);
  const todo = rows.filter((r) => !r.mine && (r.am_reviewer && r.status === 'open' || r.can_comment || r.can_decide));
  const open = data.adm.filter((a) => ['pending', 'voting', 'recommended'].includes(a.status));
  const done = data.adm.filter((a) => !['pending', 'voting', 'recommended'].includes(a.status)).slice(0, 20);
  return (
    <div className="wb">
      <div className="top"><h2>加入与考核</h2>
        <div className="ir-acts" role="tablist">{([['join', '人员加入'], ['term', '学期考核']] as const).map(([k, n]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'sm' : 'sm ghost'} onClick={() => setTab(k)}>{n}</button>)}</div></div>
      {tab === 'join' ? <>
        <p className="lede">加入中心即为 Intern（RI），不需要考核，也不做小任务。博士研究生、博士后、研究助理在中心负责人确定的年度名额内推荐，经联席会议表决、中心负责人决定后建档（章程第十八条、第三十条）；硕士研究生、研究实习生、访问学生由人事确认建档。加入满两期仍未进入任何研究单元的，办理离开（成长路径第三节）。</p>
        <div className="ir-acts"><button className="sm" onClick={() => setAct(submitAct())}>推荐加入</button></div>
        <section className="wb-sec"><h3>年度名额 <span className="h3sub">由中心负责人确定；已用含在办和已加入的</span></h3>
          <table className="wb-table"><thead><tr><th>年度</th><th>类别</th><th className="r">名额</th><th className="r">已用</th><th /></tr></thead>
            <tbody>{data.quota.map((x) => <tr key={`${x.year}${x.kind}`}><td>{x.year}</td><td>{x.kind_label}</td><td className="r">{x.quota ?? '未确定'}</td><td className="r">{x.used}</td>
              <td className="r">{isDirector && <button className="sm ghost" onClick={() => setAct({ title: `${x.year} 年度${x.kind_label}名额`, label: '确定', fields: [{ name: 'q', label: '名额（人）', type: 'number', value: String(x.quota ?? '') }],
                run: (v) => rpc('set_admission_quota', { year: x.year, kind: x.kind, quota: v.q }) })}>确定名额</button>}</td></tr>)}</tbody></table></section>
        <section className="wb-sec"><h3>在办 <span className="h3sub">{open.length} 份</span></h3>
          {open.length === 0 ? <Empty>没有在办理中的加入申请。</Empty> : <ul className="path-hist">{open.map((a) => <AdmRow key={a.id} a={a} />)}</ul>}</section>
        <section className="wb-sec"><h3>新加入的成员 <span className="h3sub">加入四个月内的 Intern；满两期仍未进入研究单元的已通知人事</span></h3>
          {data.newc.length === 0 ? <Empty>近四个月没有新加入的成员。</Empty> : <table className="wb-table"><thead><tr><th>姓名</th><th>类别</th><th>加入</th><th className="r">天数</th><th>所在研究单元</th></tr></thead>
            <tbody>{[...data.newc].sort((a, b) => b.joined_on.localeCompare(a.joined_on)).map((n) => <tr key={n.person_id}><td>{n.name}</td><td>{n.kind_label ?? '—'}</td><td>{day(n.joined_on)}</td><td className="r">{n.days}</td>
              <td>{n.units ?? (n.days >= 28 ? <Badge tone="bad">满两期未进研究单元</Badge> : <span className="sub2">尚未进入</span>)}</td></tr>)}</tbody></table>}</section>
        {done.length > 0 && <section className="wb-sec"><h3>已办结</h3><ul className="path-hist">{done.map((a) => <AdmRow key={a.id} a={a} />)}</ul></section>}
      </> : <>
        <p className="lede">联席会议每学期组织一次成员考核，依据双周表、成长主线、研究单元名单、支出和出勤记录，以及合作者匿名短评，不另写总结（章程第三十六至三十八条）。Researcher、Rising Star 由进展小组两人审阅，出具意见后提交联席会议表决；Intern、Assistant 由合作的 Researcher 及以上成员评价，报联席会议备案。结论分正常、需改进、建议退组；需改进的商定两个月的改进目标；建议退组的经联席会议三分之二同意、中心负责人决定，本人可以书面申辩一次。</p>
        {chair && <div className="ir-acts"><button className="sm" onClick={() => setAct({ title: '发起本学期成员考核', label: '发起', hint: '本学期在册的 Intern、Assistant、Researcher、Rising Star 每人一条；Intern、Assistant 默认由所在研究单元的负责人评价，进展小组按联席会议的指定登记。已发起的不重复。', fields: [],
          run: () => rpc('open_term_review', {}) })}>发起本学期考核</button></div>}
        {rows.length === 0 ? <Empty>本学期的成员考核尚未发起。</Empty> : <>
          {mineRev.length > 0 && <section className="wb-sec"><h3>我的考核 <span className="h3sub">{curTerm} 学期</span></h3><ul className="path-hist">{mineRev.map((r) => <RevCard key={r.id} r={r} />)}</ul></section>}
          {todo.length > 0 && <section className="wb-sec"><h3>待我办理 <span className="h3sub">出具意见、写匿名短评或决定</span></h3><ul className="path-hist">{todo.map((r) => <RevCard key={r.id} r={r} />)}</ul></section>}
          <section className="wb-sec"><h3>{curTerm} 学期全部 <span className="h3sub">{rows.length} 人；有表决权的成员和主持人看得到全部</span></h3>
            <ul className="path-hist">{[...rows].filter((r) => !mineRev.includes(r) && !todo.includes(r)).sort((a, b) => a.user_name.localeCompare(b.user_name, 'zh')).map((r) => <RevCard key={r.id} r={r} />)}</ul></section>
        </>}
      </>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
