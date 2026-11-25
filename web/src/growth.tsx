import { useState } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, num, today, type Field } from './ui';

// 成长主线页上的几节：属性、日常任务、考核、德行确认、须过问的情形（草案第五十三版第三、五、六、七节）
export interface PersonAttr { user_id: string; user_name: string; a_li: string; a_ju: string; a_ti: string; a_yong: string; d_yuan: number; d_heng: number; d_li: string | number; d_zhen: string; streak: number; title?: string | null }
export interface DailyRow { period_start: string; period_end: string; current: boolean; lecture_ok: boolean | null; seminar_ok: boolean | null; change_ok: boolean; biweekly_ok: boolean | null;
  council_ok: boolean | null; done: boolean; streak: number | null; zhen: string | null }
export interface Assessment { id: string; person_id: string; person_name: string; user_id: string | null; mine: boolean; kind: Kind; kind_label: string; period_start: string;
  status: 'applied' | 'examining' | 'recommended' | 'passed' | 'failed' | 'withdrawn'; link: string | null; note: string | null; task_title: string | null; task_detail: string | null;
  task_due: string | null; council_on: string | null; council_note: string | null; mentor_name: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  applied_at: string; examiners: { id: string; name: string; verdict: 'pass' | 'fail' | null; note: string | null }[]; examiner: boolean; can_join: boolean; can_vote: boolean; can_decide: boolean }
export interface PathAlert { kind: 'person' | 'unit'; person_id: string | null; subject: string; project_id: string | null; what: string }
export interface Merit { id: string; user_id: string; user_name: string; virtue: 'heng' | 'li'; what: string; done_on: string; confirmed_by_name: string | null }
type Kind = 'ra' | 'researcher' | 'rising_star' | 'pi';
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

const coin = (v: string | number | null | undefined) => num(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
const AS: Record<Assessment['status'], [string, string]> = { applied: ['warn', '已申请'], examining: ['warn', '考核中'], recommended: ['warn', '待中心负责人决定'], passed: ['ok', '通过'], failed: ['bad', '未通过'], withdrawn: ['', '已撤回'] };
export const KIND_OF: Record<string, Kind> = { intern: 'ra', assistant: 'researcher', researcher: 'rising_star', rising_star: 'pi' };
const KIND_HINT: Record<Kind, string> = {
  ra: '考核的形式就是小任务：由两名 Researcher 布置，取自现有研究单元里的一个真实问题，为期两周，由本人独立完成，两周后向这两名 Researcher 汇报。两人一致认定通过的，即为 RA。',
  researcher: '考核的形式是一份课题提案及其答辩：写明方向及其与中心核心问题的关系、第一年的目标、拟设的研究单元、所需人员和预算。在联席会议上答辩，表决后向 Director 推荐，Director 认可的即为 Researcher。',
  rising_star: '考核的形式是一次面向全中心的研究报告及答辩：讲清长期研究问题、已有的证据、未来三到五年的计划，以及拟前往的方向和机构。联席会议表决后向 Director 推荐，Director 决定。',
  pi: '取得独立的研究岗位或独立主持的经费后提出认定，附聘任或立项文件。联席会议核对记录后报 Director 确认。' };
const tick = (v: boolean | null) => v == null ? <span className="sub2">—</span> : v ? <Badge tone="ok">完成</Badge> : <Badge tone="bad">未完成</Badge>;

// 八项属性：文章四项按回应所得名义币，德行四项按次数
export function Attrs({ a }: { a?: PersonAttr }) {
  if (!a) return null;
  const wen: [string, string, string][] = [['理', '义理', a.a_li], ['据', '考据', a.a_ju], ['体', '方法', a.a_ti], ['用', '发现', a.a_yong]];
  const de: [string, string, string][] = [['元', '体仁', String(a.d_yuan)], ['亨', '嘉会', String(a.d_heng)], ['利', '利物', coin(a.d_li)], ['贞', '贞固', coin(a.d_zhen)]];
  return (
    <div className="path-attrs">
      <div><span className="k">文章</span>{wen.map(([n, s, v]) => <span key={n} className="attr"><b>{n}</b><i>{s}</i>{coin(v)}</span>)}</div>
      <div><span className="k">德行</span>{de.map(([n, s, v]) => <span key={n} className="attr"><b>{n}</b><i>{s}</i>{v}</span>)}</div>
      <p className="sub2">文章四项按回应所得的名义币累加，德行四项按规定的点数累加；属性只增不减。{a.streak > 0 ? `日常任务已连续完成 ${a.streak} 期，本期贞多计 ${a.streak * 10}%。` : ''}</p>
    </div>
  );
}

export function GrowthSections({ me, rank, tasksDone }: { me: Me; rank: string | null; tasksDone: boolean }) {
  const { data, error, reload } = useViews<{ attrs: PersonAttr[]; daily: DailyRow[]; asm: Assessment[]; alerts: PathAlert[]; merits: Merit[]; people: PeoplePick[] }>({
    attrs: ['person_attr'], daily: ['daily_mine'], asm: ['assessment'], alerts: ['path_alert'], merits: ['merit'], people: ['people_pick'] });
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const mine = data.attrs.find((a) => a.user_id === me.id);
  const myAsm = data.asm.filter((a) => a.mine).sort((a, b) => b.applied_at.localeCompare(a.applied_at));
  const openMine = myAsm.find((a) => ['applied', 'examining', 'recommended'].includes(a.status));
  const kind = rank ? KIND_OF[rank] : undefined;
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  const others = data.asm.filter((a) => !a.mine && (a.can_join || a.examiner || a.can_vote || a.can_decide) && ['applied', 'examining', 'recommended'].includes(a.status));
  const daily = [...data.daily].sort((a, b) => b.period_start.localeCompare(a.period_start));
  const applyAct = (k: Kind): Act => ({ title: `申请${k === 'ra' ? ' RA 考核' : k === 'researcher' ? ' Researcher 考核' : k === 'rising_star' ? ' Rising Star 考核' : ' PI 认定'}`, label: '申请', hint: KIND_HINT[k],
    fields: [...(k === 'ra' ? [] : [{ name: 'link', label: k === 'researcher' ? '课题提案的链接' : k === 'rising_star' ? '研究报告的链接' : '聘任或立项文件的链接' } as Field]),
      { name: 'note', label: '说明（选填）', type: 'area', required: false }],
    run: (v) => rpc('apply_assessment', { kind: k, link: v.link || null, note: v.note || null }) });

  const Row = ({ a }: { a: Assessment }) => (
    <tr>
      <td><a href={`#/assessment/${a.id}`}><b>{a.person_name}</b></a><span className="sub2">{a.kind_label} · {day(a.applied_at)} 申请</span></td>
      <td className="wrap"><Badge tone={AS[a.status][0]}>{AS[a.status][1]}</Badge>
        {a.link && <span className="sub2"><a href={a.link} target="_blank" rel="noreferrer">材料</a></span>}
        {a.task_title && <span className="sub2">小任务「{a.task_title}」，{day(a.task_due)} 前汇报</span>}
        {a.examiners.length > 0 && <span className="sub2">考核人：{a.examiners.map((e) => `${e.name}${e.verdict ? (e.verdict === 'pass' ? '（通过）' : '（未通过）') : ''}`).join('、')}</span>}
        {a.council_on && <span className="sub2">联席会议 {day(a.council_on)} 表决{a.council_note ? `：${a.council_note}` : ''}</span>}
        {a.decision_note && <span className="sub2">{a.decision_note}</span>}</td>
      <td className="r"><div className="acts">
        {a.can_join && <button className="sm" onClick={() => setAct({ title: `担任考核人：${a.person_name}`, label: '担任', hint: '与申请人有私人关系的 Researcher，以及申请人所在研究单元的负责人，不担任考核人。两名考核人齐了，由其中一人布置小任务。',
          fields: [{ name: 'ok', label: '本人与申请人没有私人关系', type: 'check', value: 'false' }], run: (v) => rpc('join_examiner', { id: a.id, no_conflict: v.ok === 'true' }) })}>担任考核人</button>}
        {a.examiner && a.status === 'applied' && a.examiners.length >= 2 && <button className="sm" onClick={() => setAct({ title: `布置小任务：${a.person_name}`, label: '布置', hint: '取自现有研究单元里的一个真实问题，为期两周，由申请人独立完成。通过的标准是：结果可以核对；能讲清回答了什么问题、改变了什么判断；过程符合科研规范。',
          fields: [{ name: 'title', label: '题目' }, { name: 'detail', label: '内容', type: 'area' }], run: (v) => rpc('set_small_task', { id: a.id, title: v.title, detail: v.detail }) })}>布置小任务</button>}
        {a.examiner && a.status === 'examining' && !a.examiners.find((e) => e.id === me.id)?.verdict && <>
          <button className="sm" onClick={() => setAct({ title: `认定通过：${a.person_name}`, label: '通过', fields: [{ name: 'note', label: '意见（选填）', type: 'area', required: false }], run: (v) => rpc('judge_small_task', { id: a.id, pass: true, note: v.note || null }) })}>通过</button>
          <button className="ghost sm danger" onClick={() => setAct({ title: `认定未通过：${a.person_name}`, label: '未通过', danger: true, hint: '有一名考核人认定未通过的，即为未通过；可在下一期重新申请。', fields: [{ name: 'note', label: '原因', type: 'area' }], run: (v) => rpc('judge_small_task', { id: a.id, pass: false, note: v.note }) })}>未通过</button></>}
        {a.can_vote && <button className="sm" onClick={() => setAct({ title: `提交联席会议表决：${a.person_name} · ${a.kind_label}`, label: '提交',
          hint: '在中台提交议题，经附议后列入联席会议议程；涉及人员，不记名表决，本人不参加投票。通过且否决期满后，转中心负责人决定。',
          fields: [{ name: 'body', label: '提案（考核人意见、小任务结果等）', type: 'area' }],
          run: (v) => rpc('submit_motion', { title: `${a.person_name}${a.kind_label}推荐`, category: 'assessment', body: v.body, link: null, subjects: [], urgent: false, mtype: 'main', parent: null, ref_kind: 'assessment', ref_id: a.id, two_thirds: false })
            .then((id) => { location.hash = `#/motion/${id}`; }) })}>提交联席会议表决</button>}
        {a.can_vote && <button className="sm ghost" onClick={() => setAct({ title: `录入联席会议表决：${a.person_name}`, label: '录入',
          fields: [{ name: 'pass', label: '表决结果', options: [['true', '同意推荐'], ['false', '不同意']] }, { name: 'on', label: '会议日期', type: 'date', value: today() }, { name: 'note', label: '说明（选填）', required: false }],
          run: (v) => rpc('record_council_vote', { id: a.id, pass: v.pass === 'true', on: v.on, note: v.note || null }) })}>录入表决</button>}
        {a.can_decide && <button className="sm" onClick={() => setAct({ title: `决定：${a.person_name} · ${a.kind_label}`, label: '决定',
          hint: a.kind === 'researcher' ? '通过的，带出此人的人默认记为其研究单元所挂课题的负责人；也可另选。' : '通过的，可选带出此人的人，计入其元和带人类任务。',
          fields: [{ name: 'pass', label: '决定', options: [['true', '认可，通过'], ['false', '不认可']] }, { name: 'mentor', label: '带出此人的人（选填）', options: people, required: false }, { name: 'note', label: '说明（选填）', required: false }],
          run: (v) => rpc('decide_assessment', { id: a.id, pass: v.pass === 'true', note: v.note || null, mentor: v.mentor || null }) })}>决定</button>}
        {a.mine && ['applied', 'examining', 'recommended'].includes(a.status) && <button className="ghost sm danger" onClick={() => setAct({ title: '撤回考核申请', label: '撤回', danger: true, fields: [], run: () => rpc('withdraw_assessment', { id: a.id }) })}>撤回</button>}
      </div></td>
    </tr>);

  return (
    <>
      <section className="wb-sec">
        <h3>属性 <span className="h3sub">记在本人名下，只增不减</span></h3>
        {mine ? <Attrs a={mine} /> : <Empty>本人的人员档案尚未对应中台账号。</Empty>}
      </section>

      <section className="wb-sec">
        <h3>日常任务 <span className="h3sub">每期相同，随回合重置；连续完成的，贞多计</span></h3>
        {daily.length === 0 ? <Empty>还没有可判定的一期。</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>期次</th><th>周日讲座</th><th>主题研讨会</th><th>快照里有本人的改动</th><th>负责的研究单元登记双周表并展示快照</th><th>联席会议</th><th>本期</th></tr></thead>
            <tbody>{daily.map((r) => <tr key={r.period_start}><td>{day(r.period_start)} 起{r.current && <span className="sub2">本期，进行中</span>}</td>
              <td>{tick(r.lecture_ok)}</td><td>{tick(r.seminar_ok)}</td><td>{tick(r.change_ok)}</td><td>{tick(r.biweekly_ok)}</td><td>{tick(r.council_ok)}</td>
              <td>{r.current ? <span className="sub2">—</span> : r.done ? <><Badge tone="ok">完成</Badge><span className="sub2">连续 {r.streak} 期 · 贞 +{coin(r.zhen)}</span></> : <Badge tone="bad">中断</Badge>}</td></tr>)}</tbody>
          </table></div>)}
        <p className="hint">「—」表示这一项对本人不适用，或本期没有登记这类会议。周日讲座线上线下同等计入，不能参加的须事先请假，并在一周内看完回放。</p>
      </section>

      <section className="wb-sec">
        <h3>考核 <span className="h3sub">先完成本级的全部任务，再申请考核</span></h3>
        {kind && !openMine && <div className="actions" style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
          <button className="sm" disabled={!tasksDone} onClick={() => setAct(applyAct(kind))}>申请{kind === 'ra' ? ' RA 考核' : kind === 'researcher' ? ' Researcher 考核' : kind === 'rising_star' ? ' Rising Star 考核' : ' PI 认定'}</button>
          {!tasksDone && <span className="sub2">本级任务还没有做完，不能申请。申请当期的本期任务也须已完成。</span>}</div>}
        {myAsm.length === 0 && others.length === 0 ? <Empty>没有在办的考核。</Empty> : (
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>申请人</th><th>进度</th><th /></tr></thead>
            <tbody>{[...myAsm.slice(0, 3), ...others].map((a) => <Row key={a.id} a={a} />)}</tbody>
          </table></div>)}
      </section>

      {me.role === 'director' && (
        <section className="wb-sec">
          <h3>德行确认 <span className="h3sub">组织和主持中心活动记亨，承担中心的公共事务记利</span></h3>
          <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm ghost" onClick={() => setAct({ title: '确认一项德行', label: '确认',
            fields: [{ name: 'user', label: '成员', options: people }, { name: 'virtue', label: '记入', options: [['heng', '亨 · 组织和主持中心活动'], ['li', '利 · 承担中心的公共事务']] },
              { name: 'what', label: '事项' }, { name: 'on', label: '日期', type: 'date', value: today() }],
            run: (v) => rpc('add_merit', { user: v.user, virtue: v.virtue, what: v.what, on: v.on }) })}>确认一项</button></div>
          {data.merits.length > 0 && <ul className="path-hist">{[...data.merits].sort((a, b) => b.done_on.localeCompare(a.done_on)).slice(0, 10).map((m) => <li key={m.id}>{day(m.done_on)} {m.user_name} · {m.virtue === 'heng' ? '亨' : '利'} · {m.what}</li>)}</ul>}
        </section>)}

      {data.alerts.length > 0 && (
        <section className="wb-sec">
          <h3>须过问的情形 <span className="h3sub">{data.alerts.length} 项，由人事岗通知本人及其接收人</span></h3>
          <div className="scroll"><table className="wb-table">
            <thead><tr><th>对象</th><th>情形</th></tr></thead>
            <tbody>{data.alerts.map((a, i) => <tr key={i}><td>{a.project_id ? <a href={`#/project/${a.project_id}`}>{a.subject}</a> : a.subject}<span className="sub2">{a.kind === 'unit' ? '研究单元' : '成员'}</span></td><td className="wrap">{a.what}</td></tr>)}</tbody>
          </table></div>
          <p className="hint">按第二十一至二十三条列出，中台不自动下调身份。连续两期不在任何研究单元里、快照里没有本人改动，或周日讲座无故缺席连续三次的，收回资源额度；再满两期仍未恢复的，办理离开。</p>
        </section>)}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
