import { useState, type ReactNode } from 'react';
import { rpc, useViews, type Me, type PeoplePick } from './api';
import { ActionDialog, Badge, Empty, Loading, day, type Field } from './ui';
import { SelectionRoster } from './SelectionRoster';
import { ResearchIntro } from './ResearchIntro';

// 项目双选与试做期：成员找可以参与的研究、表达意向；负责人维护招募信息、加人并开试做期；指导人给反馈和期满结论
interface Recruit { id: string; code: string; name: string; layer: 'big' | 'paper'; parent_id: string | null; parent_name: string | null; owner_id: string | null; owner_name: string | null; owner_scholar_url: string | null;
  intro: string | null; snapshot: { id: string; seq: number; link: string; period_start: string } | null; open_queries: number; queries: { id: string; axis: string; body: string }[];
  members: number; can_manage: boolean; am_member: boolean; my_interest: boolean }
interface Interest { id: string; project_id: string; project_name: string; user_id: string; user_name: string; rank_label: string; note: string; link: string | null; status: string; created_at: string; mine: boolean }
interface Trial { id: string; project_id: string; project_name: string; user_id: string; user_name: string; rank_label: string; mentor_id: string; mentor_name: string; start_on: string; end_on: string; extended: boolean;
  task_title: string; task_detail: string; task_due: string; status: 'running' | 'done'; mid_note: string | null; mid_link: string | null; mid_at: string | null; mid_feedback: string | null;
  final_note: string | null; final_link: string | null; final_at: string | null; conclusion: string | null; conclusion_label: string | null; conclusion_note: string | null; concluded_at: string | null;
  stage: 'running' | 'mid' | 'feedback' | 'final' | 'done'; mine: boolean; am_mentor: boolean; can_manage: boolean; can_appeal: boolean; appeal_motion_id: string | null }
interface Act { title: string; hint?: ReactNode; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const STAGE: Record<Trial['stage'], string> = { running: '试做中', mid: '待阶段进展', feedback: '待指导人反馈', final: '待期满结论', done: '已办结' };
const plus = (n: number) => new Date(Date.now() + n * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
const STANDARD = '考察标准按身份：Intern 和硕士研究生看研究热情和投入（按时交付，讲清做了什么、遇到什么问题、下一步打算）；Assistant 另看研究能力（结果可以核对，说明回答了什么问题、改变了什么判断，过程符合科研规范）。均不以发表为标准，负责人和指导人不另设标准。';

export function SelectPage({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ rec: Recruit[]; ints: Interest[]; trials: Trial[]; people: PeoplePick[] }>(
    { rec: ['recruit'], ints: ['recruit_interest'], trials: ['trial'], people: ['people_pick'] });
  const [act, setAct] = useState<Act | null>(null);
  const [only, setOnly] = useState(false);
  if (!data) return <Loading error={error} />;
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((p): [string, string] => [p.id, p.name]);
  const topics = data.rec.filter((r) => r.layer === 'big').sort((a, b) => a.code.localeCompare(b.code));
  const unitsOf = (id: string) => data.rec.filter((r) => r.parent_id === id).sort((a, b) => a.code.localeCompare(b.code));
  const hasQ = (r: Recruit) => r.open_queries > 0;
  const shown = (r: Recruit) => !only || hasQ(r) || unitsOf(r.id).some(hasQ);
  const mine = data.rec.filter((r) => r.can_manage).sort((a, b) => a.code.localeCompare(b.code));
  const myTrials = data.trials.filter((t) => t.mine);
  const mentoring = data.trials.filter((t) => t.am_mentor && t.status === 'running');
  const interestAct = (r: Recruit): Act => ({ title: `表达意向：${r.name}`, label: '提交', hint: `提交后负责人 ${r.owner_name ?? ''} 会收到通知。也可以直接私聊联系，谈妥后由负责人在正则上把你加入成员名单。`,
    fields: [{ name: 'note', label: '本人情况，对哪个方向感兴趣', type: 'area' }, { name: 'link', label: '研究兴趣、能力或作品的链接（选填）', required: false }],
    run: (v) => rpc('express_interest', { project: r.id, note: v.note, link: v.link || null }) });
  const trialAct = (r: Recruit, who?: string): Act => ({ title: `加入并开始试做：${r.name}`, label: '开始',
    hint: <>成员加入名单，同时开试做期（一个月，可延长一次）。适用于 Intern 和 Assistant；已在名单中的成员不重新试做。{STANDARD}</>,
    fields: [{ name: 'user', label: '成员', options: people, value: who ?? '' }, { name: 'mentor', label: '指导人（Researcher 及以上）', options: people, value: me.id },
      { name: 'end', label: '试做期至', type: 'date', value: plus(30) }, { name: 'title', label: '首个小任务：做什么' }, { name: 'detail', label: '交付什么', type: 'area' },
      { name: 'due', label: '何时提交', type: 'date', value: plus(10) }, { name: 'ok', label: '指导人与该成员没有私人关系', type: 'check', value: 'false' }],
    run: (v) => rpc('start_trial', { project: r.id, user: v.user, mentor: v.mentor, end: v.end, task_title: v.title, task_detail: v.detail, task_due: v.due, no_conflict: v.ok === 'true' }) });
  const TrialCard = ({ t }: { t: Trial }) => (
    <li style={{ marginBottom: 12 }}><b>{t.mine ? t.project_name : `${t.user_name}（${t.rank_label}）· ${t.project_name}`}</b> · 指导人 {t.mentor_name} · {day(t.start_on)} 至 {day(t.end_on)}{t.extended ? '（已延长）' : ''} · <Badge tone={t.stage === 'done' ? '' : 'warn'}>{STAGE[t.stage]}</Badge>
      <div className="sub2" style={{ marginLeft: 0 }}>首个小任务：{t.task_title}，{day(t.task_due)} 前提交。{t.task_detail}</div>
      {t.mid_note && <div className="sub2" style={{ marginLeft: 0 }}>阶段进展：{t.mid_note}{t.mid_link && <> <a href={t.mid_link} target="_blank" rel="noreferrer">链接</a></>}</div>}
      {t.mid_feedback && <div className="sub2" style={{ marginLeft: 0 }}>指导人反馈：{t.mid_feedback}</div>}
      {t.final_note && <div className="sub2" style={{ marginLeft: 0 }}>期满交付：{t.final_note}{t.final_link && <> <a href={t.final_link} target="_blank" rel="noreferrer">链接</a></>}</div>}
      {t.conclusion_label && <div className="sub2" style={{ marginLeft: 0 }}>期满结论：{t.conclusion_label}。{t.conclusion_note}</div>}
      <div className="ir-acts">
        {t.mine && t.status === 'running' && <><button className="sm ghost" onClick={() => setAct({ title: '提交阶段进展', label: '提交', fields: [{ name: 'note', label: '已完成什么、遇到什么困难、下一步', type: 'area', value: t.mid_note ?? '' }, { name: 'link', label: '文档、代码或成果链接（选填）', required: false, value: t.mid_link ?? '' }],
          run: (v) => rpc('submit_trial', { id: t.id, stage: 'mid', note: v.note, link: v.link || null }) })}>提交阶段进展</button>
          <button className="sm ghost" onClick={() => setAct({ title: '提交期满交付', label: '提交', fields: [{ name: 'note', label: '交付物说明和简短自述', type: 'area', value: t.final_note ?? '' }, { name: 'link', label: '交付物链接（选填）', required: false, value: t.final_link ?? '' }],
            run: (v) => rpc('submit_trial', { id: t.id, stage: 'final', note: v.note, link: v.link || null }) })}>提交期满交付</button></>}
        {t.can_appeal && <button className="sm ghost" onClick={() => setAct({ title: `申诉：${t.project_name}`, label: '提交', hint: '申诉由正则列入联席会议议程（免附议、不记名），你可以到会陈述；表决通过的恢复成员资格。须在结论作出后七日内提出。',
          fields: [{ name: 'r', label: '申诉理由', type: 'area' }], run: (v) => rpc('appeal_trial', { id: t.id, reason: v.r }).then((id) => { location.hash = `#/motion/${id}`; }) })}>向联席会议申诉</button>}
        {t.appeal_motion_id && <a className="sm" href={`#/motion/${t.appeal_motion_id}`}>申诉议题 →</a>}
        {t.am_mentor && t.status === 'running' && <><button className="sm ghost" onClick={() => setAct({ title: `反馈：${t.user_name}`, label: '反馈', fields: [{ name: 'n', label: '已完成什么、遇到什么困难、下一阶段继续或调整什么', type: 'area', value: t.mid_feedback ?? '' }],
          run: (v) => rpc('trial_feedback', { id: t.id, note: v.n }) })}>阶段反馈</button>
          <button className="sm" onClick={() => setAct({ title: `期满结论：${t.user_name} · ${t.project_name}`, label: '给出结论', hint: <>{STANDARD} 结论只影响这里的成员资格，不影响身份；报联席会议备案。结束参与的，本人可以在七日内向联席会议申诉。</>,
            fields: [{ name: 'c', label: '结论', options: [['continue', '继续参与'], ['extend', '延长试做（只能一次，不超过一个月）'], ['adjust', '调整课题或指导安排（由科研助理协调）'], ['end', '结束本课题参与']] },
              { name: 'n', label: '对照考察标准写明理由', type: 'area' }, { name: 'e', label: '延长至（只在延长时填）', type: 'date', required: false }, { name: 'k', label: '延长期间的任务（只在延长时填）', required: false }],
            run: (v) => rpc('conclude_trial', { id: t.id, conclusion: v.c, note: v.n, new_end: v.e || null, new_task: v.k || null }) })}>期满结论</button></>}
      </div></li>);
  const Card = ({ r }: { r: Recruit }) => (
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
      <div><b>{r.layer === 'big' ? '课题' : '研究单元'}「{r.name}」</b> <span className="sub2">{r.code} · 负责人 {r.owner_name ?? '—'}{r.owner_scholar_url && <> <a href={r.owner_scholar_url} target="_blank" rel="noreferrer">学术主页</a></>} · 成员 {r.members} 人</span></div>
      {r.intro && <ResearchIntro text={r.intro} />}
      {r.snapshot && <div className="sub2" style={{ marginLeft: 0 }}>最新快照：<a href={r.snapshot.link} target="_blank" rel="noreferrer">第 {r.snapshot.seq} 次（{day(r.snapshot.period_start)} 起一期）</a></div>}
      {r.queries.length > 0 && <div style={{ marginTop: 4 }}>还没回应的质疑 {r.open_queries} 条，回应它们可以加入质疑小队：
        <ul className="path-hist" style={{ margin: '2px 0' }}>{r.queries.map((x) => <li key={x.id}><a href={`#/query/${x.id}`}>{x.axis}：{x.body}</a></li>)}</ul></div>}
      <div className="ir-acts" style={{ alignItems: 'center' }}>
        {r.am_member ? <span className="sub2" style={{ marginLeft: 0 }}>已在名单里</span> : r.my_interest ? <span className="sub2" style={{ marginLeft: 0 }}>已表达意向</span> : <button className="sm ghost" onClick={() => setAct(interestAct(r))}>表达意向</button>}</div>
    </div>);
  return (
    <div className="wb">
      <div className="top"><h2>双选</h2><a href="#/guide">查看使用指南</a></div>
      <p className="lede">中心已有的 Intern、Assistant 和硕士研究生选择参与的课题和研究单元。看课题和研究单元的介绍、快照和还没回应的质疑，表达意向或直接私聊负责人，谈妥后由负责人加入成员名单；新加入的可以开一个月的试做期，期满结论报联席会议备案。规则见联席会议议题《项目双选与试做期规则（草案）》。</p>
      {(myTrials.length > 0 || mentoring.length > 0) && <section className="wb-sec"><h3>我的试做</h3>
        <ul className="path-hist">{myTrials.map((t) => <TrialCard key={t.id} t={t} />)}{mentoring.filter((t) => !t.mine).map((t) => <TrialCard key={t.id} t={t} />)}</ul></section>}
      {mine.length > 0 && <section className="wb-sec"><h3>我负责的招募与成员 <span className="h3sub">{mine.length} 个课题或研究单元</span></h3>
        {mine.map((r) => { const ints = data.ints.filter((i) => i.project_id === r.id && i.status === 'open'); const trs = data.trials.filter((t) => t.project_id === r.id && !t.mine && !t.am_mentor); return (
          <div key={r.id} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
            <div><b>{r.name}</b> <span className="sub2">{r.code} · 成员 {r.members} 人</span>
              <span className="ir-acts" style={{ display: 'inline-flex', marginLeft: 8 }}><button className="sm ghost" onClick={() => setAct(trialAct(r))}>加入并开始试做</button></span></div>
            {ints.length > 0 && <ul className="path-hist">{ints.map((i) => <li key={i.id}>{i.user_name}（{i.rank_label}）：{i.note}{i.link && <> <a href={i.link} target="_blank" rel="noreferrer">资料</a></>} <span className="sub2">{day(i.created_at)}</span>
              <button className="sm ghost" style={{ marginLeft: 8 }} onClick={() => setAct(trialAct(r, i.user_id))}>加入并开始试做</button></li>)}</ul>}
            {trs.length > 0 && <ul className="path-hist">{trs.map((t) => <TrialCard key={t.id} t={t} />)}</ul>}
          </div>); })}
      </section>}
      <section className="wb-sec"><h3>可以参与的研究 <span className="h3sub">课题和研究单元的介绍取自立项时的说明，负责人不另填；<label><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> 只看有待回应质疑的</label></span></h3>
        {topics.filter(shown).length === 0 ? <Empty>没有符合条件的课题或研究单元。</Empty> : topics.filter(shown).map((tp) => (
          <div key={tp.id} style={{ marginBottom: 18 }}><Card r={tp} />
            <div style={{ marginLeft: 20 }}>{unitsOf(tp.id).filter((u) => !only || hasQ(u)).map((u) => <Card key={u.id} r={u} />)}</div></div>))}
      </section>
      {data.ints.some((i) => i.mine && i.status === 'open') && <section className="wb-sec"><h3>我的意向</h3>
        <ul className="path-hist">{data.ints.filter((i) => i.mine && i.status === 'open').map((i) => <li key={i.id}>{i.project_name}：{i.note} <button className="sm ghost" onClick={() => rpc('withdraw_interest', { id: i.id }).then(reload)}>撤回</button></li>)}</ul></section>}
      <SelectionRoster me={me} />
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
