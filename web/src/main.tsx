import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, logout, view, type Me } from './api';
import { ROLE } from './ui';
import { Overview } from './pages/Overview';
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
        <p>按项目编年度预算，按经费卡执行，按学校入账决算。用中心的飞书账号登录。</p>
        {reason && <div className="msg bad" role="alert">{reason}</div>}
        <a className="btn" href="/auth/feishu/login">飞书登录 →</a>
      </div>
      <div className="login-word" aria-hidden="true">预算<i>与</i><br />决算</div>
    </div>
  );
}

function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null | undefined>(undefined);   // undefined 加载中，null 未登录
  const [error, setError] = useState('');
  useEffect(() => {
    view<Me>('me').then((rows) => setMe(rows[0] ?? null))
      .catch((e: ApiError) => { if (e.status !== 401) setError(e.message); setMe(null); });
  }, []);
  if (me === undefined) return <p className="empty">加载中…</p>;
  if (me === null) return <Login reason={error} />;

  const seesCards = me.role !== 'member';
  const seesStaff = me.role === 'finance' || me.role === 'director';
  // 导航按一个预算年度走的三段七步排：预算（01 申报、02 汇总报批、03 核定下达）、执行（04 申请、05 承诺、06 入账）、决算（07 复盘结清）
  type Page = [string, string];
  const keep = (...p: (Page | false)[]) => p.filter(Boolean) as Page[];
  const groups = [
    { label: '预算', no: '01–03', pages: keep(['/budget', '年度预算'], ['/projects', '项目'], ['/rules', '可报销规则']) },
    { label: '执行', no: '04–06', pages: keep(['/requests', '04 支出申请'], seesStaff && ['/staff', '人员费'], seesCards && ['/procure', '05 采购跟踪'], seesCards && ['/school', '06 学校侧进度'], ['/petty', '备用金'], ['/track', '审批跟踪']) },
    { label: '决算', no: '07', pages: keep(['/review', '复盘与决算'], seesCards && ['/settle', '经费卡结清']) },
    { label: '资源', no: '', pages: keep(['/resource', '申请与名下'], seesStaff && ['/pool', '需求池与分发'], seesStaff && ['/stock', '资源池与库存']) },
    { label: seesStaff ? '财务工作台' : '经费卡', no: '', pages: keep(seesStaff && ['/desk', '预算设置'], seesCards && ['/cards', '经费卡与节点'], seesCards && ['/quota', '晨星额度'], seesStaff && ['/admin', '用户与规则']) },
  ].filter((g) => g.pages.length > 0);
  const main = groups.filter((g) => g.no), desk = groups.filter((g) => !g.no);
  const side = keep(['/history', '旧门户记录']);

  const cardId = seesCards ? route.match(/^\/card\/([0-9a-f-]{36})$/)?.[1] : undefined;
  const [, seg = '', arg = ''] = route.split('/');
  const allowed = new Set([...groups.flatMap((g) => g.pages), ...side].map(([to]) => to));
  const current = cardId ? '/cards' : allowed.has(`/${seg}`) ? `/${seg}` : '/';
  const group = groups.find((g) => g.pages.some(([to]) => to === current));
  const page = cardId ? <CardPage me={me} id={cardId} />
    : current === '/budget' ? <BudgetPage me={me} start={arg} />
    : current === '/projects' ? <Projects me={me} />
    : current === '/desk' ? <Desk me={me} />
    : current === '/cards' ? <Overview me={me} />
    : current === '/quota' ? <QuotaPage me={me} />
    : current === '/rules' ? <Rules me={me} />
    : current === '/requests' ? <Requests me={me} start={arg} />
    : current === '/staff' ? <StaffPage me={me} />
    : current === '/procure' ? <Procure me={me} />
    : current === '/school' ? <School me={me} />
    : current === '/review' ? <Review me={me} start={arg} />
    : current === '/settle' ? <Settle me={me} />
    : current === '/resource' ? <ResourcePage me={me} />
    : current === '/pool' ? <PoolPage me={me} />
    : current === '/stock' ? <StockPage />
    : current === '/petty' ? <PettyPage me={me} />
    : current === '/track' ? <TrackPage me={me} />
    : current === '/history' ? <History staff={seesStaff} />
    : current === '/admin' ? <Admin me={me} />
    : <Home me={me} />;
  return (
    <div className="shell">
      <header className="hd">
        <a className="brand" href="#/"><b>科研财务中台</b><span>CLAIN 中心</span></a>
        <nav aria-label="流程">
          {main.map((g) => <a key={g.label} href={`#${g.pages[0][0]}`} className={group === g ? 'on' : ''} aria-current={group === g ? 'true' : undefined}><i>{g.no}</i>{g.label}</a>)}
        </nav>
        <nav className="side" aria-label="其他">
          {desk.map((g) => <a key={g.label} href={`#${g.pages[0][0]}`} className={group === g ? 'on' : ''} aria-current={group === g ? 'true' : undefined}>{g.label}</a>)}
          {side.map(([to, label]) => <a key={to} href={`#${to}`} className={current === to ? 'on' : ''} aria-current={current === to ? 'page' : undefined}>{label}</a>)}
        </nav>
        <div className="who">
          <span><b>{me.name}</b><span>{ROLE[me.role]}</span></span>
          <button className="ghost sm" onClick={() => logout().finally(() => location.reload())}>退出</button>
        </div>
      </header>
      {group && group.pages.length > 1 && (
        <nav className="subnav" aria-label={`${group.label}的页面`}>
          <span className="eyebrow">{group.no} {group.label}</span>
          {group.pages.map(([to, label]) => <a key={to} href={`#${to}`} className={current === to ? 'on' : ''} aria-current={current === to ? 'page' : undefined}>{label}</a>)}
        </nav>
      )}
      <main key={route}>{page}</main>
      <footer className="ft"><span>预算 · 执行 · 决算</span><span>决算数只认学校正式入账</span></footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
