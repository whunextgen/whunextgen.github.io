import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, logout, view, type Me } from './api';
import { ROLE, can, today } from './ui';
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
  // 导航按谁来办分组：每个人都用的、按项目看的、财务岗办理的、经费卡、设置
  type Page = [string, string];
  const keep = (...p: (Page | false)[]) => p.filter(Boolean) as Page[];
  const groups = [
    { label: '我的', pages: keep(['/', '总览'], ['/requests', '支出申请'], ['/resource', '资源申领'], ['/petty', '备用金']) },
    { label: '项目', pages: keep(['/projects', '项目'], ['/budget', '年度预算'], ['/review', '复盘与决算']) },
    { label: '财务办理', pages: keep(seesCards && ['/procure', '采购跟踪'], seesCards && ['/school', '学校侧进度'], seesPeople && ['/staff', '人员费'], seesRes && ['/pool', '需求池与分发'], seesRes && ['/stock', '资源池与库存']) },
    { label: '经费卡', pages: keep(seesCards && ['/cards', '经费卡与节点'], seesCards && ['/settle', '经费卡结清'], seesCards && ['/rules', '可报销规则'], seesCards && ['/quota', '晨星额度']) },
    { label: '设置', pages: keep(seesDesk && ['/desk', '预算设置'], seesAdmin && ['/admin', '用户、权限与规则'], ['/history', '旧门户记录']) },
  ].filter((g) => g.pages.length > 0);
  // 不在导航里、从别的页面点进去的页面
  const side = keep(['/track', '在途事项']);

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
    : current === '/history' ? <History staff={can(me, 'read.legacy')} />
    : current === '/admin' ? <Admin me={me} />
    : <Home me={me} />;
  const link = ([to, label]: Page) => <a key={to} href={`#${to}`} className={current === to ? 'on' : ''} aria-current={current === to ? 'page' : undefined}>{label}</a>;
  const title = [...groups.flatMap((g) => g.pages), ...side].find(([to]) => to === current)?.[1] ?? '总览';
  return (
    <div className={`shell${open ? ' nav-open' : ''}`}>
      <aside className="sb">
        <a className="brand" href="#/"><i aria-hidden="true">财</i><span><b>科研财务中台</b><span>CLAIN 中心</span></span></a>
        <nav aria-label="导航">
          {groups.map((g) => (
            <div className="sg" key={g.label}>
              <div className="sg-h">{g.label}</div>
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
          <div className="bc">{group && current !== '/' && <>{group.label}<i>/</i></>}<b>{title}</b></div>
          <span>{today()}</span>
        </header>
        <main key={route}>{page}</main>
        <footer className="ft"><span>预算 · 执行 · 决算</span><span>决算数只认学校正式入账</span></footer>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
