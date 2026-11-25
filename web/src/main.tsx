import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, logout, rpc, view, type Me, type Project, type ProjectTag } from './api';
import { ActionDialog, ROLE, can, today } from './ui';
import { Overview } from './pages/Overview';
import { Funds } from './pages/Funds';
import { SyncPage } from './pages/Sync';
import { PlanPage } from './pages/Plan';
import { RequestPage } from './pages/Request';
import { ResourceOne } from './pages/ResourceOne';
import { Home } from './pages/Home';
import { History } from './pages/Legacy';
import { CardPage } from './pages/Card';
import { Requests } from './pages/Requests';
import { Rules } from './pages/Rules';
import { School } from './pages/School';
import { StaffPage } from './pages/Staff';
import { Settle } from './pages/Settle';
import { Admin } from './pages/Admin';
import { Procure } from './pages/Procure';
import { PoolPage, ResourcePage, StockPage } from './pages/Resource';
import { PettyPage, TrackPage } from './pages/Petty';
import { BudgetPage } from './pages/Budget';
import { Projects } from './pages/Projects';
import { ApplyPage } from './pages/Apply';
import { Agent } from './pages/Agent';
import { Naming } from './pages/Naming';
import { Biweekly } from './pages/Biweekly';
import { People } from './pages/People';
import { PathPage } from './path';
import { IteratePage } from './iterate';
import { Desk } from './pages/Desk';
import { Review } from './pages/Review';
import { Ask } from './pages/Ask';
import { CapsPage } from './pages/Caps';
import { ProjectPage } from './pages/Project';
import { Tasks } from './pages/Tasks';
import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource/instrument-serif/latin-400-italic.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './styles.css';

declare const __APP_VERSION__: string;

const useRoute = () => {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => { setHash(location.hash.slice(1) || '/'); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
};

// 标志：甲骨文「正」，上为囗（城邑），下为止（脚）
const Mark = () => (
  <svg viewBox="0 0 160 160" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round">
    <rect x="55" y="28" width="50" height="36" rx="3" /><path d="M48 82C46 108 58 124 80 128" /><path d="M80 80V128" /><path d="M112 82C114 104 102 122 80 128" /><path d="M80 128C96 132 110 131 122 124" />
  </svg>
);

// 登录后回到原来要打开的页面
const loginHref = () => `/auth/feishu/login?to=${encodeURIComponent(location.hash.slice(1) || '/')}`;
// 在飞书客户端里打开的，不停在登录页，直接走授权（飞书对本单位应用不再询问）。一分钟内试过一次就不再自动跳，避免来回跳转
const autoLogin = () => {
  if (!/Lark|Feishu/i.test(navigator.userAgent)) return false;
  try {
    if (sessionStorage.getItem('fp_out')) return false;
    const last = Number(sessionStorage.getItem('fp_auto') ?? 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem('fp_auto', String(Date.now()));
  } catch { return false; }
  return true;
};

function Login({ reason }: { reason?: string }) {
  const [auto] = useState(() => !reason && autoLogin());
  useEffect(() => { if (auto) location.replace(loginHref()); }, [auto]);
  if (auto) return <p className="empty">正在登录…</p>;
  return (
    <div className="login">
      <div className="login-in">
        <span className="eyebrow">CLAIN 中心</span>
        <h1>正则</h1>
        <p>按课题和研究单元编制年度预算，按当年经费卡执行，按学校入账决算。请使用中心飞书账号登录。</p>
        {reason && <div className="msg bad" role="alert">{reason}</div>}
        <a className="btn" href={loginHref()}>飞书登录 →</a>
      </div>
      <div className="login-word" aria-hidden="true">预算<i>与</i><br />决算</div>
    </div>
  );
}

// 一个页面出错只影响这个页面，导航还在，可以去别的页面
class PageGuard extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <section className="card">
        <h3>页面加载异常</h3>
        <p className="hint">其他页面不受影响。可重新加载后重试；仍无法恢复的，请将以下信息发送管理员。</p>
        <p className="sub2" style={{ wordBreak: 'break-all' }}>{this.state.err.message}</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </section>
    );
  }
}

function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null | undefined>(undefined);   // undefined 加载中，null 未登录
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);   // 窄屏上的导航抽屉
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    view<Me>('me').then((rows) => setMe(rows[0] ?? null))
      .catch((e: ApiError) => { if (e.status !== 401) setError(e.message); setMe(null); });
  }, []);
  // 本人是否在已立项的课题或研究单元里（负责人或成员）：支出申请、备用金、资源申领的入口据此显示。待立项的不算
  const [inTopic, setInTopic] = useState(false);
  const [owns, setOwns] = useState(false);   // 本人是否负责某个已立项的课题或研究单元
  const [scholar, setScholar] = useState(false);   // 填写本人的谷歌学术主页
  const uid = me?.id;
  useEffect(() => {
    if (!uid) return;
    Promise.all([view<Project>('project'), view<ProjectTag>('project_tag')]).then(([ps, tags]) => {
      const waiting = new Set(tags.filter((t) => t.proposed).map((t) => t.id));
      setInTopic(ps.some((p) => p.active && !waiting.has(p.id) && (p.mine || p.member)));
      setOwns(ps.some((p) => p.active && !waiting.has(p.id) && p.owner_id === uid));
    }).catch(() => setInTopic(false));
  }, [uid, route === '/plan']);
  if (me === undefined) return <p className="empty">加载中…</p>;
  const waiting = new URLSearchParams(location.search).has('wait');
  if (me === null) return <Login reason={waiting ? '账号尚未启用：没有对应的人员档案，或者账号已停用。已通知人事岗，确认后即可登录。' : error} />;

  // 经费卡只给中心负责人和财务岗看；单独授权了某张卡的人也看得到
  const seesCards = can(me, 'read.finance') || me.scoped?.includes('card.read');
  const seesStaff = can(me, 'read.finance');
  const seesPeople = can(me, 'read.people'), seesRes = can(me, 'read.resource');
  const seesDesk = can(me, 'budget.setup', 'ledger.post');
  const seesAdmin = can(me, 'read.admin', 'rbac.manage', 'user.manage', 'rule.manage', 'card.manage');
  const seesCaps = can(me, 'budget.approve', 'budget.setup'), seesReview = can(me, 'budget.review'), seesLegacy = can(me, 'read.legacy') || seesAdmin;
  // 导航按对象分组：项目（及其经费卡、入账、结清）、课题（及其研究单元、预算、决算）、支出、资源、系统。每组标题下一行说这一组管什么
  const canUse = seesStaff || can(me, 'request.process') || inTopic;   // 能用支出申请、备用金、资源申领
  type Page = [string, string];
  const keep = (...p: (Page | false)[]) => p.filter(Boolean) as Page[];
  const SUB = new Set(['/cards']);   // 缩进显示的下一级：经费卡在项目之下
  // 每个部分的标题可以点，进入该部分的汇总页（home）
  // top：上一级目录。财务之下并列项目和资源两组
  const groups = [
    { top: '', label: '', home: '', note: '', pages: keep(['/', '我的事项'], seesCards && ['/center', '中心总览'], ['/path', '成长主线'], ['/tasks', '任务管理']) },
    // 课题：成员和负责人办的事——登记双周表、从预算行支出、领备用金、申领资源
    { top: '', label: '课题', home: '/s-topic', note: '研究单元、双周表、快照与质疑、预算编制、支出申请、资源申领', pages: keep(['/projects', '课题管理'], ['/apply', '立项与延续申请'], ['/biweekly', '双周表'], ['/iterate', '快照与质疑'], !seesStaff && ['/plan', '年度档次'], !seesStaff && ['/budget', '预算编制'], canUse && ['/requests', '支出申请'], canUse && ['/petty', '备用金管理'], canUse && ['/resource', '资源申领'], ['/ask', '报销咨询']) },
    // 财务：并列三组。年度预算是每年申报、核定、下达、决算这一轮；项目是学校这一侧的经费；资源是中心的接口额度和资产
    { top: '财务', label: '年度预算', home: '', note: '总预算、档次、下达、决算', pages: keep(seesStaff && ['/plan', '总预算与档次'], seesStaff && ['/budget', '预算编制'], seesCaps && ['/caps', '预算控制'], seesReview && ['/review', '年度决算'], seesDesk && ['/desk', '预算参数']) },
    { top: '财务', label: '项目', home: seesCards ? '/s-fund' : '', note: '经费卡、采购、报销入账、结清', pages: keep(seesCards && ['/funds', '项目管理'], seesCards && ['/cards', '经费卡管理'], seesCards && ['/procure', '采购'], seesCards && ['/school', '报销与入账'], seesPeople && ['/staff', '人员经费'], seesCards && ['/ledger', '明细账校准'], seesCards && ['/settle', '经费结清']) },
    { top: '财务', label: '资源', home: '/s-res', note: '调配、盘点', pages: keep(seesRes && ['/pool', '资源调配'], seesRes && ['/stock', '资产盘点']) },
    { top: '', label: '系统', home: '', note: '', pages: keep(seesPeople && ['/people', '人员档案'], seesAdmin && ['/admin', '权限管理'], seesCards && ['/rules', '采购与报销要求'], seesLegacy && ['/history', '历史数据'], ['/agent', '智能体接入'], ['/naming', '中台征名']) },
  ].filter((g) => g.pages.length > 0);
  // 不在导航里、从别的页面点进去的页面
  const side = keep(['/track', '在途事项'], ['/center', '中心总览'], ['/s-spend', '课题汇总'], ['/s-res', '资源汇总'], ...groups.filter((g) => g.home).map((g): Page => [g.home, `${g.label}汇总`]), !seesReview && ['/review', '年度决算'], !seesLegacy && ['/history', '历史数据']);

  const reqId = route.match(/^\/req\/([^/]+)$/)?.[1];
  const resId = route.match(/^\/res\/([^/]+)$/)?.[1];
  const cardId = seesCards ? route.match(/^\/card\/([0-9a-f-]{36})$/)?.[1] : undefined;
  const fundId = seesCards ? route.match(/^\/fund\/([^/]+)$/)?.[1] : undefined;
  const proj = route.match(/^\/project\/([^/]+)(?:\/(\d{4}))?$/);
  const [, seg0 = '', arg = ''] = route.split('/');
  // 采购并进学校侧进度，旧的 #/procure 链接照样能用
  const procure = seg0 === 'school' && arg === 'procure';
  const seg = seg0;
  const allowed = new Set([...groups.flatMap((g) => g.pages), ...side].map(([to]) => to));
  const current = reqId ? '/requests' : resId ? '/s-res' : cardId ? '/cards' : fundId ? '/funds' : proj ? '/projects' : allowed.has(`/${seg}`) ? `/${seg}` : '/';
  const group = groups.find((g) => g.home === current || g.pages.some(([to]) => to === current));
  const page = reqId ? <RequestPage me={me} id={reqId} />
    : resId ? <ResourceOne me={me} id={resId} />
    : cardId ? <CardPage me={me} id={cardId} />
    : fundId ? <Funds me={me} only={fundId} />
    : proj ? <ProjectPage me={me} id={proj[1]} start={proj[2] ?? ''} />
    : current === '/budget' ? <BudgetPage me={me} start={arg} />
    : current === '/caps' ? <CapsPage me={me} start={arg} />
    : current === '/ask' ? <Ask me={me} />
    : current === '/tasks' ? <Tasks me={me} only={arg || undefined} />
    : current === '/projects' ? <Projects me={me} />
    : current === '/apply' ? <ApplyPage me={me} />
    : current === '/biweekly' ? <Biweekly />
    : current === '/people' ? <People me={me} />
    : current === '/path' ? <PathPage me={me} start={arg || undefined} />
    : current === '/iterate' ? <IteratePage me={me} />
    : current === '/agent' ? <Agent me={me} />
    : current === '/naming' ? <Naming />
    : current === '/desk' ? <Desk me={me} />
    : current === '/funds' ? <Funds me={me} />
    : current === '/center' ? <Home me={me} view="center" />
    : current === '/s-fund' ? <Home me={me} view="fund" />
    : current === '/s-topic' ? <Home me={me} view="topic" />
    : current === '/s-spend' ? <Home me={me} view="topic" />
    : current === '/s-res' ? <Home me={me} view="res" />
    : current === '/ledger' ? <SyncPage />
    : current === '/plan' ? <PlanPage me={me} start={arg} />
    : current === '/procure' ? <Procure me={me} />
    : current === '/cards' ? <Overview me={me} />
    : current === '/rules' ? <Rules me={me} />
    : current === '/requests' ? <Requests me={me} start={arg} />
    : current === '/staff' ? <StaffPage me={me} />
    : current === '/school' ? <>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <a className="btn sm" aria-current={procure ? undefined : 'page'} href="#/school">报销与入账</a>
        <a className="btn sm" aria-current={procure ? 'page' : undefined} href="#/school/procure">采购</a>
      </div>
      {procure ? <Procure me={me} /> : <School me={me} />}</>
    : current === '/review' ? <Review me={me} start={arg} />
    : current === '/settle' ? <Settle me={me} />
    : current === '/resource' ? <ResourcePage me={me} />
    : current === '/pool' ? <PoolPage me={me} />
    : current === '/stock' ? <StockPage />
    : current === '/petty' ? <PettyPage me={me} only={arg || undefined} />
    : current === '/track' ? <TrackPage me={me} />
    : current === '/history' ? <History staff={can(me, 'read.legacy')} />
    : current === '/admin' ? <Admin me={me} />
    : <Home me={me} canUse={canUse} />;
  const link = ([to, label]: Page) => <a key={to} href={`#${to}`} className={`${current === to ? 'on' : ''}${SUB.has(to) ? ' sub' : ''}`} aria-current={current === to ? 'page' : undefined}>{label}</a>;
  const title = [...groups.flatMap((g) => g.pages), ...side].find(([to]) => to === current)?.[1] ?? '首页';
  return (
    <div className={`shell${open ? ' nav-open' : ''}`}>
      <aside className="sb">
        <a className="brand" href="#/"><i aria-hidden="true"><Mark /></i><span><b>正则</b><span>CLAIN 中台</span></span></a>
        <nav aria-label="导航">
          {groups.map((g, gi) => (
            <div className={`sg${g.top ? ' in' : ''}${g.home === current || g.pages.some(([to]) => to === current) ? ' cur' : ''}`} key={g.label}>
              {g.top && groups[gi - 1]?.top !== g.top && <div className="sg-top">{g.top}</div>}
              {g.label && (g.home ? <a className={`sg-h${g.home === current ? ' on' : ''}`} href={`#${g.home}`} aria-current={g.home === current ? 'page' : undefined}><b>{g.label}</b><i>汇总</i></a> : <div className="sg-h"><b>{g.label}</b></div>)}
              {g.note && <div className="sg-n">{g.note}</div>}
              {g.pages.map(link)}
            </div>
          ))}
        </nav>
        <div className="who">
          <span><b>{me.name}</b><span>{owns && ROLE[me.role] === '成员' ? '负责人' : ROLE[me.role]}</span></span>
          <button className="ghost sm" onClick={() => setScholar(true)} title={me.scholar_url ?? '填写本人的谷歌学术主页'}>学术主页</button>
          <button className="ghost sm" onClick={() => logout().finally(() => location.reload())}>退出</button>
        </div>
        <div className="ver">正则 v{__APP_VERSION__}</div>
        {scholar && <ActionDialog title="谷歌学术主页" submitLabel="保存"
          hint="填写本人谷歌学术个人主页的链接，课题列表和成员名单里随姓名显示。参与双选的博士须填写。留空即清除。"
          fields={[{ name: 'url', label: '链接，形如 https://scholar.google.com/citations?user=…', value: me.scholar_url ?? '', required: false }]}
          onSubmit={(v) => rpc('set_scholar_url', { url: v.url }).then(() => setMe({ ...me, scholar_url: v.url.trim() || null }))}
          onClose={() => setScholar(false)} />}
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="body">
        <header className="tb">
          <button className="ghost sm menu" aria-expanded={open} onClick={() => setOpen(!open)}>菜单</button>
          <div className="bc">{group?.top && <>{group.top}<i>/</i></>}{group?.label && <>{group.label}<i>/</i></>}<b>{title}</b></div>
          <span>{today()}</span>
        </header>
        <main key={route}><PageGuard key={route}>{page}</PageGuard></main>
        <footer className="ft"><span>项目 · 经费卡 · 课题 · 研究单元</span><span>决算数以学校正式入账为准</span></footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
