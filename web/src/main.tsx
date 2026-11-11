import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, logout, view, type Me } from './api';
import { ROLE } from './ui';
import { Overview } from './pages/Overview';
import { CardPage } from './pages/Card';
import { Requests } from './pages/Requests';
import { Rules } from './pages/Rules';
import { School } from './pages/School';
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
        <p>按经费卡管理预算、承诺和决算。用中心的飞书账号登录。</p>
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
  const nav = [
    ...(seesCards ? [['/', '经费卡与节点']] : []),
    ['/requests', '支出与承诺'],
    ...(seesCards ? [['/school', '学校侧进度']] : []),
    ['/rules', '可报销规则'],
  ];
  const cardId = route.match(/^\/card\/([0-9a-f-]{36})$/)?.[1];
  const rules = route.startsWith('/rules');
  const school = seesCards && route.startsWith('/school');
  const page = cardId ? <CardPage me={me} id={cardId} />
    : rules ? <Rules me={me} />
    : school ? <School me={me} />
    : route.startsWith('/requests') || !seesCards ? <Requests me={me} />
    : <Overview me={me} />;
  const current = cardId ? '/' : rules ? '/rules' : school ? '/school' : route.startsWith('/requests') || !seesCards ? '/requests' : '/';
  return (
    <div className="shell">
      <header className="hd">
        <a className="brand" href="#/"><b>科研财务中台</b><span>CLAIN 中心</span></a>
        <nav>{nav.map(([to, label]) => <a key={to} href={`#${to}`} className={current === to ? 'on' : ''} aria-current={current === to ? 'page' : undefined}>{label}</a>)}</nav>
        <div className="who">
          <span><b>{me.name}</b><span>{ROLE[me.role]}</span></span>
          <button className="ghost sm" onClick={() => logout().finally(() => location.reload())}>退出</button>
        </div>
      </header>
      <main key={cardId ?? current}>{page}</main>
      <footer className="ft"><span>经费卡 · 预算 · 决算</span><span>决算数只认学校正式入账</span></footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
