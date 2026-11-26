import { useState, type ReactNode } from 'react';
import { rpc, useViews, type Me, type PeoplePick, type Project, type ProjectTag } from './api';
import { ActionDialog, day, num, today, type Field } from './ui';
import type { PathPerson, PathTask } from './path';
import type { Query, Seminar } from './iterate';
import type { DailyRow, PersonAttr } from './growth';
import { hoursValid, type UnitPool, type UnitShare } from './token';
import { SignIn } from './live';

// 个人主页「我的事项」：按设计稿 ir-character-card。身份、本回合、当日、属性、任务列表、主线、份额、实际币、嘉许、各期记录；
// 待办、本期登记、支出申请、备用金和资源申领由首页传进来，放在同一版式里。
interface TodayMine { day: string; period_start: string; day_no: number; rev_done: boolean; rev_yesterday: number; rev_streak: number;
  pick_query: string | null; pick_query_body: string | null; pick_query_axis: string | null; pick_query_project: string | null; pick_query_project_name: string | null; push_done: boolean;
  pick_snapshot: string | null; pick_snapshot_seq: number | null; pick_snapshot_link: string | null; pick_snapshot_project_name: string | null; review_done: boolean }
interface Challenge { code: string; seq: number; title: string; detail: string | null; need: number; reward: string; progress: number; semester: string }
interface TitleMine { code: string; seq: number; name: string; rule: string; earned: boolean }
interface PraiseRow { id: string; from_user: string; from_name: string; to_user: string; to_name: string; virtue: 'yuan' | 'heng' | 'li' | 'zhen'; period_start: string; note: string | null; created_at: string }
interface CoinMine { balance: string; expiring: string; next_expiry: string | null; price: string | null; rate: string | null; salary: string | null }
interface CoinRow { id: string; kind: 'salary' | 'mint' | 'invest' | 'expire' | 'adjust'; amount: string; expires_on: string | null; project_name: string | null; note: string | null; created_at: string }
interface PeriodRec { period_start: string; lecture: number | null; seminar: number | null; biweekly: number | null; snapshot: number }
interface Act { title: string; hint?: ReactNode; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

const RANKS: [string, string][] = [['intern', 'Intern'], ['assistant', 'Assistant'], ['researcher', 'Researcher'], ['rising_star', 'Rising Star'], ['pi', 'PI'], ['director', 'Director']];
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const AX: Record<string, string> = { li: '理', ju: '据', ti: '体', yong: '用' };
const VIRTUE: [PraiseRow['virtue'], string, string][] = [['yuan', '元', '指导'], ['heng', '亨', '展示'], ['li', '利', '协助'], ['zhen', '贞', '守时']];
const KIND: Record<CoinRow['kind'], string> = { salary: '按期发放', mint: '成果铸造', invest: '投给研究单元', expire: '到期作废', adjust: '调整' };
const n1 = (v: string | number | null | undefined) => num(v).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
const addDays = (d: string, k: number) => new Date(Date.parse(`${day(d)}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
const md = (d: string) => day(d).slice(5);

// 个人卡片要的视图；首页一开始取数时据此预取，合进同一批请求（见 Home）
const v = (n: string, f?: Record<string, string>): [string, Record<string, string>?] => (f ? [n, f] : [n]);
export const cardViews = (uid: string) => ({
  people: v('path_person', { mine: 'true' }), tasks: v('path_tracker', { mine: 'true' }), attrs: v('person_attr', { user_id: uid }), td: v('today_mine'), daily: v('daily_mine'), rec: v('period_record'), queries: v('query'),
  ch: v('challenge_mine'), titles: v('title_mine'), praise: v('praise_mine'), coin: v('coin_mine'), ledger: v('coin_ledger'), shares: v('unit_share'), pools: v('unit_pool'),
  projects: v('project'), tags: v('project_tag'), pick: v('people_pick'), seminars: v('seminar'), tp: v('token_param'),
});

export function MyCard({ me, todoCount, todo, register, requests, petty, initiated }: {
  me: Me; todoCount: number; todo: ReactNode; register: ReactNode; requests: ReactNode; petty: ReactNode; initiated: number }) {
  const { data, error, reload } = useViews<{ people: PathPerson[]; tasks: PathTask[]; attrs: PersonAttr[]; td: TodayMine[]; daily: DailyRow[]; rec: PeriodRec[]; queries: Query[];
    ch: Challenge[]; titles: TitleMine[]; praise: PraiseRow[]; coin: CoinMine[]; ledger: CoinRow[]; shares: UnitShare[]; pools: UnitPool[]; projects: Project[]; tags: ProjectTag[]; pick: PeoplePick[]; seminars: Seminar[]; tp: { key: string; value: unknown }[] }>({
    ...cardViews(me.id) });
  const [act, setAct] = useState<Act | null>(null);
  const [tab, setTab] = useState('all');
  if (!data) return error ? <div className="msg bad" role="alert">{error.message}</div> : <p className="empty">加载中…</p>;

  const p = data.people.find((x) => x.mine);
  const attr = data.attrs.find((a) => a.user_id === me.id);
  const td = data.td[0];
  const per = day(td?.period_start ?? today());
  const left = Math.max(0, Date.parse(`${addDays(per, 13)}T00:00:00Z`) / 864e5 - Date.parse(`${today()}T00:00:00Z`) / 864e5 + 1);
  const tasks = data.tasks.filter((t) => t.mine).sort((a, b) => a.seq - b.seq);
  const doneN = tasks.filter((t) => t.status === 'done').length;
  const cur = tasks.find((t) => t.status !== 'done');
  const waiting = new Set(data.tags.filter((t) => t.proposed).map((t) => t.id));
  const myUnits = data.projects.filter((u) => u.layer === 'paper' && u.active && !waiting.has(u.id) && (u.owner_id === me.id || u.member));
  const topics = [...new Set(myUnits.map((u) => u.parent_name).filter(Boolean))];
  const myQ = data.queries.filter((q) => q.status === 'open' && q.in_team);
  const dm = data.daily.find((d) => d.current);
  const streak = attr?.streak ?? 0;
  const coin = data.coin[0];
  const shares = data.shares.filter((s) => s.user_id === me.id);
  const inPool = shares.reduce((x, s) => x + num(s.coins), 0);
  const rate = coin?.rate != null ? num(coin.rate) : null, price = coin?.price != null ? num(coin.price) : null;
  const gotPraise = (v: string) => data.praise.filter((x) => x.to_user === me.id && x.virtue === v).length;
  const gaveNow = data.praise.filter((x) => x.from_user === me.id && x.period_start === per).length;
  const people = data.pick.filter((x) => x.id !== me.id).sort((a, b) => a.name.localeCompare(b.name, 'zh')).map((x): [string, string] => [x.id, x.name]);
  const rankAt = RANKS.findIndex(([k]) => k === p?.rank);

  // 当日的三项
  const revAct = (): Act => ({ title: '登记当日修订', label: '登记', hint: '当日第一次修订写作草稿后登记，记入贞。修订的是哪个研究单元的稿子；推进了队里的某条质疑的，一并选上。',
    fields: [{ name: 'project', label: '研究单元', options: [...myUnits.map((u): [string, string] => [u.id, u.name]), ...myQ.filter((q) => !myUnits.some((u) => u.id === q.project_id)).map((q): [string, string] => [q.project_id, q.project_name])].filter((x, i, a) => a.findIndex((y) => y[0] === x[0]) === i), value: td?.pick_query_project ?? myUnits[0]?.id ?? '' },
      { name: 'query', label: '推进的质疑（选填）', options: myQ.map((q): [string, string] => [q.id, `${q.project_name} · ${q.axis_label}：${q.body.slice(0, 30)}`]), required: false, value: td?.pick_query ?? '' },
      { name: 'note', label: '改了什么（选填）', required: false }],
    run: (v) => rpc('log_revision', { project: v.project, query: v.query || null, note: v.note || null }) });
  const reviewAct = (): Act => ({ title: `审阅：${td?.pick_snapshot_project_name} 第 ${td?.pick_snapshot_seq} 次快照`, label: '提交意见',
    hint: <>打开 <a href={td?.pick_snapshot_link ?? '#'} target="_blank" rel="noreferrer">快照</a>，读其中一节并提交意见。负责人采纳的意见记入「利」，可在下一次研讨会上作为质疑提出。</>,
    fields: [{ name: 'body', label: '意见', type: 'area' }], run: (v) => rpc('submit_review', { snapshot: td?.pick_snapshot, body: v.body }) });
  const praiseAct = (): Act => ({ title: '嘉许', label: '嘉许', hint: `每期至多给出两次，本期尚可给出 ${2 - gaveNow} 次。记入对方的元、亨、利、贞中的一项。`,
    fields: [{ name: 'to', label: '嘉许谁', options: people }, { name: 'virtue', label: '记入', options: VIRTUE.map(([k, g, w]): [string, string] => [k, `${g} · ${w}`]) }, { name: 'note', label: '为什么（选填）', required: false }],
    run: (v) => rpc('give_praise', { to: v.to, virtue: v.virtue, note: v.note || null }) });
  const investAct = (): Act => ({ title: '投给研究单元', label: '投入', hint: '实际币只能投给研究单元，进研究单元的账，由负责人换 GPU 卡时，以后也可以换别的资源。投给哪个研究单元不限，先扣先到期的。',
    fields: [{ name: 'project', label: '研究单元', options: data.projects.filter((x) => x.layer === 'paper' && x.active && !waiting.has(x.id)).sort((a, b) => Number(b.member || b.owner_id === me.id) - Number(a.member || a.owner_id === me.id) || a.code.localeCompare(b.code)).map((x): [string, string] => [x.id, `${x.code} ${x.name}${x.member || x.owner_id === me.id ? '（本人所在）' : ''}`]) },
      { name: 'amount', label: '实际币', type: 'number' }, { name: 'note', label: '说明（选填）', required: false }],
    run: (v) => rpc('invest_coins', { project: v.project, amount: v.amount, note: v.note || null }) });

  // 日历：本回合十四天
  const cal = Array.from({ length: 14 }, (_, i) => { const d = addDays(per, i); const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    const mark = i === 0 ? '开始' : i === 7 ? '半程' : i === 13 ? '快照' : w === 0 ? '讲座' : '';
    return { d, w, mark, past: d < today(), me: d === today() }; });

  // 任务列表
  type Item = { k: 'main' | 'side' | 'turn' | 'term'; kd: string; title: string; sub: string; right: string; trk?: boolean; done?: boolean; href?: string };
  const items: Item[] = [
    ...(cur ? [{ k: 'main' as const, kd: '主线', title: `${p?.rank_label ?? ''} · 第 ${cur.seq} 步：${cur.title}`, sub: cur.detail ?? `认定：${cur.verify_label}`, right: cur.progress ?? '当前步骤', trk: true, href: '#/path' }] : []),
    ...myQ.map((q) => { const team = q.team.map((m) => m.name).join('、'); const mine = q.team.find((m) => m.name === me.name);
      return { k: 'side' as const, kd: `副本 · ${AX[q.axis]}`, title: q.body, sub: `${q.project_name} · ${q.raised_by_name ? `提出人 ${q.raised_by_name} · ` : ''}队伍 ${q.team.length} 人：${team}`,
        right: mine && mine.from > per ? '本期不分配' : `名义币 16，队伍平分`, href: '#/iterate' }; }),
    ...(dm ? [
      { k: 'turn' as const, kd: '本期', title: '主题研讨会', sub: dm.seminar_ok == null ? '本期尚未登记研讨会出勤' : '本期出席', right: dm.seminar_ok ? '已完成' : '贞', done: !!dm.seminar_ok },
      { k: 'turn' as const, kd: '本期', title: '周日讲座', sub: dm.lecture_ok == null ? '本期尚未登记讲座出勤' : dm.lecture_ok ? '已出席或补看' : '有缺席', right: dm.lecture_ok ? '已完成' : '贞', done: !!dm.lecture_ok },
      { k: 'turn' as const, kd: '本期', title: '快照里有本人的改动', sub: '所在研究单元本期快照勾选了本人', right: dm.change_ok ? '已完成' : '贞', done: dm.change_ok, href: '#/iterate' },
      ...(dm.biweekly_ok != null ? [{ k: 'turn' as const, kd: '本期', title: '负责的研究单元登记双周表并展示快照', sub: '每个负责的研究单元都要', right: dm.biweekly_ok ? '已完成' : '贞', done: dm.biweekly_ok, href: '#/biweekly' }] : []),
    ] : []),
    ...data.ch.sort((a, b) => a.seq - b.seq).map((c) => ({ k: 'term' as const, kd: '学期', title: c.title, sub: `已完成 ${c.progress} / ${c.need}${c.detail ? ` · ${c.detail}` : ''}`, right: c.reward, done: c.progress >= c.need })),
  ];
  const shown = items.filter((x) => tab === 'all' || x.k === tab);
  const count = (k: string) => items.filter((x) => x.k === k).length;

  return (
    <div className="ir">
      <div className="ir-tick" aria-hidden><div>{Array.from({ length: 4 }, () => `本回合 ${md(per)} — ${md(addDays(per, 13))}　·　还剩 ${left} 天　·　待办 ${todoCount} 项　·　未回应的队伍质疑 ${myQ.length} 条　·　一切为写作服务　·　`).join('')}</div></div>
      <div className="ir-bento">
        <section className="ir-t ir-hero">
          <div>
            <div className="ir-eyebrow">我的事项 · {me.name}{p ? ` · ${p.rank_label}` : ''}</div>
            <h1>{me.name}</h1>
            {attr?.title && <span className="ir-title">称号　{attr.title}</span>}
            <div className="ir-facts">
              <div><span>本人发起、进行中</span><b>{initiated} 项</b></div>
              <div><span>所在研究单元</span><b>{myUnits.length} 个</b></div>
              <div><span>所属课题</span><b>{topics.join('、') || '—'}</b></div>
            </div>
          </div>
          <div className="ir-lvl">{RANKS.map(([k, n], i) => <span key={k} className={i === rankAt ? 'me' : i < rankAt ? 'past' : ''}>{n}</span>)}</div>
        </section>
        <section className="ir-t ir-turn">
          <div className="ir-mono"><span>本回合</span><span>{md(per)} — {md(addDays(per, 13))}</span></div>
          <div className="ir-big">{left}<small>天</small></div>
          <dl><div><dt>待办</dt><dd>{todoCount} 项</dd></div><div><dt>主线</dt><dd>{p?.rank === 'director' ? '—' : `${doneN} / ${tasks.length}`}</dd></div></dl>
        </section>
        <section className="ir-t ir-full" style={{ paddingTop: 14, paddingBottom: 14 }}><div className="ir-mono" style={{ margin: 0 }}><span>签到、请假、补看回放、自建会议 · 周日讲座、主题研讨会、联席会议、训练课程都在这里</span></div><SignIn onDone={reload} /></section>
        <nav className="ir-nav">{[['ir-today', '当日'], ['ir-attr', '属性'], ['ir-todo', '待办'], ['ir-reg', '本期登记'], ['ir-tasks', '任务列表'], ['ir-req', '本人的支出申请'], ['ir-petty', '本人的备用金和资源申领'], ['ir-share', '份额']]
          .map(([id, n]) => <a key={id} href={`#/`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>{n}</a>)}</nav>

        <section className="ir-t ir-full" id="ir-today">
          <div className="ir-mono"><span>当日 · {md(today())} {WEEK[new Date(`${today()}T00:00:00Z`).getUTCDay()]} · 本回合第 {td?.day_no ?? '—'} 日</span><span>每日 0 时更新</span></div>
          <div className="ir-cal">{cal.map((c) => <div key={c.d} className={c.me ? 'me' : c.past ? 'd' : ''}><small>{WEEK[c.w]}</small><b>{c.d.slice(8)}</b>{c.mark && <em>{c.mark}</em>}</div>)}</div>
          <div className="ir-td3">
            <div className={td?.rev_done ? '' : 'now'}><span className="ir-mono">日常 01 · 修订 · 每日固定</span><h4>当日首次修订草稿</h4>
              <p>当日首次修订记入「贞」。{td && td.rev_yesterday > 0 ? '昨日已修订。' : '昨日没有修订。'}</p>
              {td?.rev_done ? <b>已完成{td.rev_streak > 0 ? ` · 连续修订 ${td.rev_streak + 1} 日` : ''}</b> : <button className="sm" onClick={() => setAct(revAct())}>登记修订</button>}</div>
            <div className={td?.pick_query && !td.push_done ? 'now' : ''}><span className="ir-mono">日常 02 · 推进 · 当日抽取</span>
              <h4>{td?.pick_query_body ?? '队里没有未回应的质疑'}</h4>
              <p>{td?.pick_query ? `自本人所在队伍的质疑中抽取：${td.pick_query_project_name} · ${AX[td.pick_query_axis ?? ''] ?? ''}。当日有所推进并修订草稿。` : <>到「<a href="#/iterate">快照与质疑</a>」申请入队。</>}</p>
              <b>{td?.push_done ? '已完成' : '次日更换'}</b></div>
            <div className={td?.pick_snapshot && !td.review_done ? 'now' : ''}><span className="ir-mono">日常 03 · 审阅 · 当日抽取</span>
              <h4>{td?.pick_snapshot ? `审阅「${td.pick_snapshot_project_name}」第 ${td.pick_snapshot_seq} 次快照并提交意见` : '近两期没有其他研究单元的快照'}</h4>
              <p>自其他研究单元最近的快照中抽取。意见被负责人采纳的，记入「利」。</p>
              {td?.review_done ? <b>已完成</b> : td?.pick_snapshot ? <button className="sm ghost" onClick={() => setAct(reviewAct())}>提交意见</button> : <b>次日更换</b>}</div>
          </div>
        </section>

        <section className="ir-glyphs" id="ir-attr" aria-label="属性">{attr && ([
          ['01 / 文章', '理', attr.a_li, '选题意义'], ['02 / 文章', '据', attr.a_ju, '前人工作与不足'], ['03 / 文章', '体', attr.a_ti, '方法'], ['04 / 文章', '用', attr.a_yong, '发现'],
          ['05 / 德行', '元', attr.d_yuan, '指导他人'], ['06 / 德行', '亨', attr.d_heng, '展示与组织'], ['07 / 德行', '利', attr.d_li, '质疑与协助'], ['08 / 德行', '贞', attr.d_zhen, streak > 0 ? `连续完成 ${streak} 期` : '各期任务完成情况'],
        ] as [string, string, string | number, string][]).map(([no, g, v, cap]) => { const max = Math.max(1, ...[attr.a_li, attr.a_ju, attr.a_ti, attr.a_yong, attr.d_yuan, attr.d_heng, attr.d_li, attr.d_zhen].map(num));
          return <div key={g} className={`ir-g${num(v) === 0 ? ' zero' : ''}`}><i className="fill" style={{ height: `${Math.round((num(v) / max) * 100)}%` }} /><span className="no">{no}</span><span className="val">{n1(v)}</span><b>{g}</b><span className="cap">{cap}</span></div>; })}</section>

        <section className="ir-t ir-half" id="ir-todo"><div className="ir-mono"><span>待办 · 只列与本人有关的事项</span><span>{todoCount} 项</span></div>{todo}</section>
        <section className="ir-t ir-half" id="ir-reg"><div className="ir-mono"><span>本期登记 · 双周表每两周登记一次</span><a href="#/biweekly">双周表 →</a></div>{register}</section>

        <section className="ir-t ir-tlist" id="ir-tasks">
          <div className="ir-mono"><span>任务列表</span><span>共 {items.length} 项</span></div>
          <div className="ir-tabs" role="tablist">{[['all', '全部', items.length], ['main', '主线', count('main')], ['side', '副本', count('side')], ['turn', '本期', count('turn')], ['term', '学期', count('term')]].map(([k, n, c]) =>
            <button key={k as string} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k as string)}>{n} {c}</button>)}</div>
          {shown.length === 0 ? <p className="ir-hint">没有这一类任务。</p> : <ol>{shown.map((x, i) => (
            <li key={i} className={`${x.trk ? 'trk' : ''}${x.done ? ' done' : ''}`}>
              <span className={`ir-kd${x.k === 'side' ? ' q' : ''}`}>{x.kd}</span>
              <div><h4>{x.href ? <a href={x.href}>{x.title}</a> : x.title}</h4><p>{x.sub}</p></div>
              <em>{x.right}</em>
            </li>))}</ol>}
          <p className="ir-hint">副本就是本人所在队伍里还没有回应的质疑：下一期无人再提即为已回应，记 16 名义币，队伍平分，进入研究单元的池子。</p>
        </section>
        <section className="ir-t ir-chainv">
          <div className="ir-mono"><span>主线 · {p?.rank_label ?? '—'}</span><span>{p?.rank === 'director' ? '' : (cur ? `第 ${cur.seq} 步 / 共 ${tasks.length} 步` : `已完成 ${tasks.length} 步`)}</span></div>
          {p?.rank === 'director' ? <p className="ir-hint">Director 是这条路的终点。</p> : <ol>
            {tasks.map((t) => <li key={t.code} className={t.status === 'done' ? 'd' : t === cur ? 'c' : ''}><b>{String(t.seq).padStart(2, '0')}</b><div>{t.title}<small>{t.status === 'waiting' ? '待中台开通' : t.progress ?? t.verify_label}</small></div></li>)}
            <li className={cur ? '' : 'c'}><b>考核</b><div>{p ? ({ intern: 'RA 考核：小任务', assistant: 'Researcher 考核：课题提案', researcher: 'Rising Star 考核', rising_star: 'PI 认定', pi: 'Director 认定' } as Record<string, string>)[p.rank] ?? '' : ''}<small>全部完成后在「<a href="#/path">成长主线</a>」申请</small></div></li>
          </ol>}
          <div className="ir-streak"><div><span className="ir-mono">连续全勤</span><b>{streak} 期</b></div>
            <div className="pips">{Array.from({ length: 6 }, (_, i) => <i key={i} className={i < Math.min(streak, 6) ? 'on' : i === Math.min(streak, 6) ? 'cur' : ''} />)}</div>
            <div><span className="ir-mono">当前加计</span><b>贞 +{streak * 10}%</b></div></div>
          <p className="ir-hint">中断即清零，已有的属性不受影响。</p>
        </section>

        <section className="ir-t ir-half" id="ir-req"><div className="ir-mono"><span>本人的支出申请</span><a href="#/requests">全部申请 →</a></div>{requests}</section>
        <section className="ir-t ir-half" id="ir-petty"><div className="ir-mono"><span>本人的备用金和资源申领</span><a href="#/resource">资源申领 →</a></div>{petty}</section>

        <section className="ir-t ir-third" id="ir-share">
          <div className="ir-mono"><span>我在各研究单元的份额</span><span>{rate != null ? `铸造率 ${rate}` : '铸造率未挂牌'}</span></div>
          {shares.length === 0 ? <p className="ir-hint">尚未在任何研究单元的池子里有份额。回应质疑后自动计入。</p> : <table className="ir-share"><tbody>
            {shares.map((s) => { const pool = data.pools.find((x) => x.project_id === s.project_id); const u = data.projects.find((x) => x.id === s.project_id);
              return <tr key={s.project_id}><td><a href={`#/project/${s.project_id}`}>{u?.name ?? '研究单元'}</a><small><span className={`ir-lock${(pool?.level ?? 0) >= 1 ? ' ok' : ''}`}>{(pool?.level ?? 0) >= 1 ? '已解锁' : '锁定中'}</span></small></td>
                <td>{n1(s.coins)}</td><td>{Math.round(num(s.share) * 100)}%</td></tr>; })}</tbody></table>}
          <div className="ir-conv"><div><small>累计入池</small><b>{n1(inPool)}</b><em>名义币</em></div><i>→</i>
            <div><small>解锁后期望铸造</small><b>{rate != null ? n1(inPool * rate) : '—'}</b><em>实际币</em></div><i>→</i>
            <div><small>投入研究单元可换</small><b>{rate != null && price ? n1(inPool * rate / price) : '—'}</b><em>卡时</em></div></div>
          <p className="ir-hint">一个名义币等于一小时。研究单元取得第一个外部成果时池子解锁，按挂牌铸造率铸造实际币到个人；二、三、四级成果按系数追加。</p>
        </section>
        <section className="ir-t ir-third">
          <div className="ir-mono"><span>实际币</span><span>{coin?.salary != null ? `每期发放 ${n1(coin.salary)}` : '本身份的发放额度未定'}</span></div>
          <div className="ir-num">{n1(coin?.balance)}<i> 实际币</i></div>
          <div className="ir-kv"><span>两个月内到期<b>{n1(coin?.expiring)}</b></span><span>最近到期日<b>{coin?.next_expiry ? day(coin.next_expiry) : '—'}</b></span><span>卡时标价<b>{price ? `${n1(price)} / 卡时` : '未定'}</b></span></div>
          {num(coin?.balance) > 0 ? <div className="ir-acts"><button className="sm" onClick={() => setAct(investAct())}>投给研究单元</button></div> : null}
          {data.ledger.length > 0 && <ul className="ir-sc">{[...data.ledger].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5).map((l) =>
            <li key={l.id}><span>{KIND[l.kind]}{l.project_name ? ` · ${l.project_name}` : ''}</span><em>{num(l.amount) > 0 ? '+' : ''}{n1(l.amount)}</em></li>)}</ul>}
          <p className="ir-hint">代币不是经费。按期发放的实际币只在当期和下一期有效，用不掉作废；成果铸造的 12 个月有效。实际币只能投给研究单元，由研究单元换 GPU 卡时（买后 {hoursValid(data.tp)}内有效），以后也可以换别的资源。投出时先扣先到期的。</p>
        </section>
        <section className="ir-t ir-third">
          <div className="ir-mono"><span>嘉许 · 每期限两次</span><span>本期尚可给出 {Math.max(0, 2 - gaveNow)} 次</span></div>
          <div className="ir-pz">{VIRTUE.map(([k, g, w]) => <div key={k}><b>{g}</b><span>{gotPraise(k)}</span><small>{w}</small></div>)}</div>
          {gaveNow < 2 && <div className="ir-acts"><button className="sm ghost" onClick={() => setAct(praiseAct())}>嘉许一位同伴</button></div>}
          {data.praise.filter((x) => x.to_user === me.id).length > 0 && <ul className="ir-sc">{data.praise.filter((x) => x.to_user === me.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 4).map((x) =>
            <li key={x.id}><span>{x.from_name}{x.note ? `：${x.note}` : ''}</span><em>{VIRTUE.find(([k]) => k === x.virtue)?.[1]}</em></li>)}</ul>}
        </section>

        <section className="ir-t ir-past">
          <div className="ir-mono"><span>各期记录</span><span>斜线为请假补看</span></div>
          <table className="ir-rec"><thead><tr><th />{[...data.rec].sort((a, b) => a.period_start.localeCompare(b.period_start)).map((r) => <th key={r.period_start}>{md(r.period_start)}</th>)}</tr></thead>
            <tbody>{([['周日讲座', 'lecture'], ['主题研讨会', 'seminar'], ['双周表已登记', 'biweekly'], ['快照收录', 'snapshot']] as [string, keyof PeriodRec][]).map(([n, k]) => (
              <tr key={k}><td>{n}</td>{[...data.rec].sort((a, b) => a.period_start.localeCompare(b.period_start)).map((r) => { const v = r[k] as number | null; return <td key={r.period_start}><i className={v === 2 ? 'c2' : v === 1 ? 'c1' : v == null ? 'na' : ''} title={v == null ? '不适用或未登记' : v === 2 ? '完成' : v === 1 ? '请假补看' : '未完成'} /></td>; })}</tr>))}</tbody></table>
        </section>
        <section className="ir-t ir-third">
          <div className="ir-mono"><span>称号</span><span>按记录取得，不收回</span></div>
          <ul className="ir-ch">{[...data.titles].sort((a, b) => a.seq - b.seq).map((t) => <li key={t.code} className={t.earned ? 'd' : ''}><i /><div>{t.name}<small>{t.rule}</small></div></li>)}</ul>
        </section>
      </div>
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </div>
  );
}
