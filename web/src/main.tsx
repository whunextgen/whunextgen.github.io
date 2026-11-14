import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, logout, view, type Me } from './api';
import { ROLE, can, today } from './ui';
import { Overview } from './pages/Overview';
import { Funds } from './pages/Funds';
import { Home } from './pages/Home';
import { History } from './pages/Legacy';
import { CardPage } from './pages/Card';
import { Requests } from './pages/Requests';
import { Rules } from './pages/Rules';
import { School } from './pages/School';
import { StaffPage } from './pages/Staff';
import { Settle } from './pages/Settle';
import { Admin } from './pages/Admin';
import { QuotaPage } from './pages/Quota';
import { Procure } from './pages/Procure';
import { PoolPage, ResourcePage, StockPage } from './pages/Resource';
import { PettyPage, TrackPage } from './pages/Petty';
import { BudgetPage } from './pages/Budget';
import { Projects } from './pages/Projects';
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

const useRoute = () => {
  const [hash, setHash] = useState(location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => { setHash(location.hash.slice(1) || '/'); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
};

function Login({ reason }: { reason?: string }) {
  return (
    <div className="login">
      <div className="login-in">
        <span className="eyebrow">CLAIN 中心</span>
        <h1>科研财务中台</h1>
        <p>按研究项目编制年度预算，按当年经费卡执行，按学校入账决算。请使用中心飞书账号登录。</p>
        {reason && <div className="msg bad" role="alert">{reason}</div>}
        <a className="btn" href="/auth/feishu/login">飞书登录 →</a>
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
  if (me === undefined) return <p className="empty">加载中…</p>;
  if (me === null) return <Login reason={error} />;

  // 经费卡只给中心负责人和财务岗看；单独授权了某张卡的人也看得到
  const seesCards = can(me, 'read.finance') || me.scoped?.includes('card.read');
  const seesStaff = can(me, 'read.finance');
  const seesPeople = can(me, 'read.people'), seesRes = can(me, 'read.resource');
  const seesDesk = can(me, 'budget.setup', 'ledger.post');
  const seesAdmin = can(me, 'read.admin', 'rbac.manage', 'user.manage', 'rule.manage', 'card.manage');
  const seesCaps = can(me, 'budget.approve', 'budget.setup'), seesReview = can(me, 'budget.review'), seesLegacy = can(me, 'read.legacy') || seesAdmin;
  // 导航按一笔钱走的顺序分组：先编预算，再执行，再落到经费卡和学校入账，最后决算。每组标题下一行说这一步办什么
  type Page = [string, string];
  const keep = (...p: (Page | false)[]) => p.filter(Boolean) as Page[];
  const groups = [
    { label: '', no: '', note: '', pages: keep(['/', '工作台'], ['/tasks', '任务管理']) },
    { label: '预算', no: '01', note: '编制、控制、下达', pages: keep(['/projects', '研究项目'], ['/budget', '预算编制'], seesCaps && ['/caps', '预算控制'], seesDesk && ['/desk', '预算参数']) },
    { label: '执行', no: '02', note: '申请、审批、发放', pages: keep(['/requests', '支出申请'], ['/petty', '备用金管理'], ['/resource', '资源申领'], seesRes && ['/pool', '资源调配'], seesPeople && ['/staff', '人员经费'], ['/ask', '报销咨询']) },
    { label: '入账', no: '03', note: '经费到卡、学校入账', pages: keep(seesCards && ['/funds', '经费项目'], seesCards && ['/cards', '经费卡管理'], seesCards && ['/school', '入账跟踪'], seesCards && ['/quota', '晨星额度管理']) },
    { label: '决算', no: '04', note: '结清、盘点、决算', pages: keep(seesCards && ['/settle', '经费结清'], seesRes && ['/stock', '资产盘点'], seesReview && ['/review', '年度决算']) },
    { label: '系统', no: '', note: '', pages: keep(seesAdmin && ['/admin', '权限管理'], seesLegacy && ['/history', '历史数据']) },
  ].filter((g) => g.pages.length > 0);
  // 不在导航里、从别的页面点进去的页面
  const side = keep(['/track', '在途事项'], seesCards && ['/rules', '报销答复记录'], !seesReview && ['/review', '年度决算'], !seesLegacy && ['/history', '历史数据']);

  const cardId = seesCards ? route.match(/^\/card\/([0-9a-f-]{36})$/)?.[1] : undefined;
  const proj = route.match(/^\/project\/([^/]+)(?:\/(\d{4}))?$/);
  const [, seg0 = '', arg = ''] = route.split('/');
  // 采购并进学校侧进度，旧的 #/procure 链接照样能用
  const procure = seg0 === 'procure' || (seg0 === 'school' && arg === 'procure');
  const seg = seg0 === 'procure' ? 'school' : seg0;
  const allowed = new Set([...groups.flatMap((g) => g.pages), ...side].map(([to]) => to));
  const current = cardId ? '/cards' : proj ? '/projects' : allowed.has(`/${seg}`) ? `/${seg}` : '/';
  const group = groups.find((g) => g.pages.some(([to]) => to === current));
  const page = cardId ? <CardPage me={me} id={cardId} />
    : proj ? <ProjectPage me={me} id={proj[1]} start={proj[2] ?? ''} />
    : current === '/budget' ? <BudgetPage me={me} start={arg} />
    : current === '/caps' ? <CapsPage me={me} start={arg} />
    : current === '/ask' ? <Ask me={me} />
    : current === '/tasks' ? <Tasks me={me} />
    : current === '/projects' ? <Projects me={me} />
    : current === '/desk' ? <Desk me={me} />
    : current === '/funds' ? <Funds me={me} />
    : current === '/cards' ? <Overview me={me} />
    : current === '/quota' ? <QuotaPage me={me} />
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
    : current === '/petty' ? <PettyPage me={me} />
    : current === '/track' ? <TrackPage me={me} />
    : current === '/history' ? <History staff={can(me, 'read.legacy')} />
    : current === '/admin' ? <Admin me={me} />
    : <Home me={me} />;
  const link = ([to, label]: Page) => <a key={to} href={`#${to}`} className={current === to ? 'on' : ''} aria-current={current === to ? 'page' : undefined}>{label}</a>;
  const title = [...groups.flatMap((g) => g.pages), ...side].find(([to]) => to === current)?.[1] ?? '工作台';
  return (
    <div className={`shell${open ? ' nav-open' : ''}`}>
      <aside className="sb">
        <a className="brand" href="#/"><i aria-hidden="true">财</i><span><b>科研财务中台</b><span>CLAIN 中心</span></span></a>
        <nav aria-label="导航">
          {groups.map((g) => (
            <div className={`sg${g.pages.some(([to]) => to === current) ? ' cur' : ''}`} key={g.label}>
              {g.label && <div className="sg-h"><b>{g.label}</b>{g.no && <i>{g.no}</i>}</div>}
              {g.note && <div className="sg-n">{g.note}</div>}
              {g.pages.map(link)}
            </div>
          ))}
        </nav>
        <div className="who">
          <span><b>{me.name}</b><span>{ROLE[me.role]}</span></span>
          <button className="ghost sm" onClick={() => logout().finally(() => location.reload())}>退出</button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="body">
        <header className="tb">
          <button className="ghost sm menu" aria-expanded={open} onClick={() => setOpen(!open)}>菜单</button>
          <div className="bc">{group?.label && <>{group.label}<i>/</i></>}<b>{title}</b></div>
          <span>{today()}</span>
        </header>
        <main key={route}><PageGuard key={route}>{page}</PageGuard></main>
        <footer className="ft"><span>预算 · 执行 · 决算</span><span>决算数以学校正式入账为准</span></footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
