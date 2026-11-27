import { useEffect, useState, type CSSProperties } from 'react';
import { rpc, useViews } from '../api';
import { Badge, Loading } from '../ui';
import { PALETTES, tryPalette, triedPalette, type Palette } from '../palettes';

interface Opt { code: string; name: string; note: string; sort: number; votes: number; mine: boolean; closes_at: string; open: boolean; total_votes: number }

// 小样：用这套配色画一块「我的事项」卡片和几样常用控件，变量只作用在小样里
function Swatch({ p }: { p: Palette }) {
  const v = (k: string, d: string) => `var(${k}, ${d})`;
  const box: CSSProperties = { ...(p.root as CSSProperties), ...(p.card as CSSProperties), background: v('--bg', '#f3f3f0'), color: v('--ink', '#16171a'), borderRadius: 12, padding: 14, border: `1px solid ${v('--line', '#e6e6e2')}` };
  return (
    <div style={box} aria-hidden="true">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: v('--mute', '#6a6e75'), marginBottom: 10 }}><span>课题 / 课题管理</span><span>11-27</span></div>
      <div style={{ background: v('--i-bg', '#f1ece2'), color: v('--i-ink', '#17130f'), border: `1px solid ${v('--i-line', '#17130f')}`, padding: '12px 14px', marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: v('--i-mut', '#635b50') }}>我的事项 · Researcher</div>
        <div style={{ font: `700 28px/1.2 ${v('--i-serif', '"Songti SC", serif')}` }}>何静</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11 }}>
          {['Intern', 'Assistant', 'Researcher'].map((x, i) => <span key={x} style={{ color: i === 2 ? v('--i-red', '#c2351b') : v('--i-mut', '#635b50'), fontWeight: i === 2 ? 700 : 500 }}>{x}</span>)}
        </div>
      </div>
      <div style={{ background: v('--paper', '#fff'), border: `1px solid ${v('--line', '#e6e6e2')}`, borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>本年度可用 <span style={{ color: v('--brand', '#bc442b') }}>34,999.00</span></div>
        <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: v('--track', '#ebebe7'), marginBottom: 10 }}>
          <i style={{ flex: 3, background: v('--ink', '#16171a') }} /><i style={{ flex: 2, background: v('--brand', '#bc442b') }} /><i style={{ flex: 5 }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ background: v('--btn', v('--ink', '#16171a')), color: '#fff', borderRadius: 8, padding: '5px 12px', fontSize: 13 }}>提交申请</span>
          <span style={{ background: v('--paper', '#fff'), color: v('--ink', '#16171a'), border: `1px solid ${v('--line', '#e6e6e2')}`, borderRadius: 8, padding: '5px 12px', fontSize: 13 }}>取消</span>
          <span style={{ background: v('--brand-soft', '#fbefeb'), color: v('--brand', '#bc442b'), borderRadius: 999, padding: '2px 9px', fontSize: 12 }}>待审核</span>
          <span style={{ fontSize: 12, color: v('--mute', '#6a6e75') }}>辅助说明文字</span>
        </div>
      </div>
    </div>
  );
}

// 配色投票：几套候选配色，每人一票、截止前可改投，不显示谁投的；每套都可以先「试用」到整个中台看看效果
export function PalettePoll() {
  const { data, error, reload } = useViews<{ opts: Opt[] }>({ opts: ['palette_option'] });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tried, setTried] = useState(() => triedPalette()?.code ?? 'ochre');
  useEffect(() => { const f = () => setTried(triedPalette()?.code ?? 'ochre'); addEventListener('palette-try', f); return () => removeEventListener('palette-try', f); }, []);
  if (!data) return <Loading error={error} />;
  const opts = [...data.opts].sort((a, b) => a.sort - b.sort);
  const first = opts[0], open = !!first?.open, total = first?.total_votes ?? 0, top = Math.max(1, ...opts.map((o) => o.votes));
  const closes = first ? new Date(first.closes_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const vote = async (code: string | null) => {
    setBusy(true); setMsg('');
    try { await rpc('vote_palette', { code }); reload(); } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <div className="top"><h2>配色投票</h2></div>
      <p className="lede">中台换不换配色，由大家投票定。下面几套各画了一块小样；点「试用」可以把整个中台临时换成这套配色，到各页看看效果，只改你自己这台电脑的显示，随时可以恢复。每人一票，截止前可以改投；{open ? `北京时间 ${closes} 截止` : '投票已截止'}。</p>
      <section className="card">
        <h3>候选配色 <span className="h3sub">{opts.length} 套 · 已投 {total} 票 · {open ? <Badge tone="pri">进行中</Badge> : <Badge>已截止</Badge>}</span></h3>
        <p className="hint">匿名：页面上不显示票是谁投的。系统只为保证每人一票记下账号，不对外展示。</p>
        <div className="palette-grid">
          {opts.map((o) => { const p = PALETTES.find((x) => x.code === o.code); return (
            <div key={o.code} className="palette-opt">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}><b style={{ fontSize: 16 }}>{o.name}</b>{o.mine && <Badge tone="ok">已投</Badge>}</div>
              <p className="hint" style={{ margin: '4px 0 10px' }}>{o.note}</p>
              {p && <Swatch p={p} />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
                <div style={{ flex: 1, height: 8, background: 'var(--line)', borderRadius: 4 }}><div style={{ width: `${(o.votes / top) * 100}%`, height: 8, background: 'var(--brand)', borderRadius: 4 }} /></div>
                <span style={{ minWidth: 40, textAlign: 'right' }}>{o.votes} 票</span></div>
              <div className="acts" style={{ justifyContent: 'flex-start' }}>
                {tried === o.code ? <button className="sm ghost" onClick={() => tryPalette(null)}>{o.code === 'ochre' ? '正在用现行配色' : '恢复现行配色'}</button>
                  : <button className="sm ghost" onClick={() => tryPalette(o.code)}>{o.code === 'ochre' ? '恢复现行配色' : '试用到整个中台'}</button>}
                {open && (o.mine ? <button className="sm ghost" disabled={busy} onClick={() => vote(null)}>撤回</button>
                  : <button className="sm" disabled={busy} onClick={() => vote(o.code)}>投这套</button>)}
              </div>
            </div>); })}
        </div>
        {msg && <p className="hint" style={{ marginTop: 10 }}>{msg}</p>}
      </section>
    </>
  );
}

// 试用中的提示条：在每一页顶部提醒正在试用哪套配色，可以一键恢复
export function PaletteTrialBar() {
  const [p, setP] = useState(() => triedPalette());
  useEffect(() => { const f = () => setP(triedPalette()); addEventListener('palette-try', f); return () => removeEventListener('palette-try', f); }, []);
  if (!p) return null;
  return <div className="palette-bar" role="status">正在试用「{p.name}」配色，只改你自己的显示。<a href="#/palette">去投票</a><button className="sm ghost" onClick={() => tryPalette(null)}>恢复现行配色</button></div>;
}
