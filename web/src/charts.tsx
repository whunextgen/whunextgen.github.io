import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { money, pct } from './ui';

// 图表用色：已入账、承诺、计划各一个固定颜色，剩余额度用中性的底色
export const C = { actual: '#bc442b', commit: '#d99a2b', plan: '#3b6fd4', rest: '#e4e4df' };

const short = (v: number) => (Math.abs(v) >= 1e4 ? `${+(v / 1e4).toFixed(v >= 1e5 ? 0 : 1)} 万` : `${Math.round(v)}`);

// 鼠标停在图上时跟着走的说明框
function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; t: ReactNode } | null>(null);
  const on = (t: ReactNode) => ({
    onMouseMove: (e: MouseEvent) => { const r = ref.current!.getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top, t }); },
    onMouseLeave: () => setTip(null),
  });
  return { ref, on, el: tip && <div className="tip" role="status" style={{ left: tip.x, top: tip.y }}>{tip.t}</div> };
}

export const Legend = ({ items }: { items: { name: string; color?: string; mark?: boolean }[] }) => (
  <div className="lg">{items.map((s) => <span key={s.name}><i className={s.mark ? 'mk' : ''} style={s.color ? { background: s.color } : undefined} />{s.name}</span>)}</div>
);

// 环形图：一笔总额分成几部分
export function Donut({ parts, value, label }: { parts: { name: string; value: number; color: string }[]; value: string; label: string }) {
  const { ref, on, el } = useTip();
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const r = 62, len = 2 * Math.PI * r;
  let at = 0;
  return (
    <div className="donut" ref={ref}>
      <svg viewBox="0 0 160 160" role="img" aria-label={parts.map((p) => `${p.name} ${pct(p.value, total)}`).join('，')}>
        <circle cx="80" cy="80" r={r} fill="none" stroke={C.rest} strokeWidth="15" opacity=".5" />
        {total > 0 && parts.map((p) => {
          const l = (Math.max(0, p.value) / total) * len, from = at; at += l;
          if (l < 0.5) return null;
          return <circle key={p.name} cx="80" cy="80" r={r} fill="none" stroke={p.color} strokeWidth="15" strokeDasharray={`${Math.max(0.5, l - 2)} ${len}`} strokeDashoffset={-from}
            transform="rotate(-90 80 80)" {...on(<><b>{p.name}</b>{money(p.value)} 元 · {pct(p.value, total)}</>)} />;
        })}
        <text x="80" y="78" textAnchor="middle" className="donut-v">{value}</text>
        <text x="80" y="98" textAnchor="middle" className="donut-l">{label}</text>
      </svg>
      <ul>{parts.map((p) => (
        <li key={p.name}><i style={{ background: p.color }} /><span>{p.name}</span><b>{money(p.value)}</b><em>{pct(p.value, total)}</em></li>
      ))}</ul>
      {el}
    </div>
  );
}

// 柱状图：一组或几组数按同一把尺子比
export function Columns({ labels, series, mark }: { labels: string[]; series: { name: string; color: string; values: number[] }[]; mark?: number }) {
  const { ref, on, el } = useTip();
  const top = Math.max(1, ...series.flatMap((s) => s.values));
  const raw = top / 3, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw)!;
  const max = step * Math.ceil(top / step);
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  return (
    <div className="cols" ref={ref}>
      {series.length > 1 && <Legend items={series} />}
      <div className="cols-in" role="img" aria-label={series.map((s) => `${s.name}：${labels.map((l, i) => `${l} ${money(s.values[i])}`).join('，')}`).join('；')}>
        <div className="cols-y">{ticks.map((t) => <span key={t} style={{ bottom: `${(t / max) * 100}%` }}>{short(t)}</span>)}</div>
        <div className="cols-plot">
          {ticks.map((t) => <i key={t} className="gl" style={{ bottom: `${(t / max) * 100}%` }} />)}
          {labels.map((l, i) => (
            <div key={l} className={`cols-g${mark === i ? ' now' : ''}`} {...on(<><b>{l}</b>{series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{series.length > 1 ? `${s.name} ` : ''}{money(s.values[i])} 元</span>)}</>)}>
              <div className="cols-bars">{series.map((s) => <i key={s.name} style={{ height: `${(Math.max(0, s.values[i]) / max) * 100}%`, background: s.color }} />)}</div>
              <span className="cols-x">{l}</span>
            </div>
          ))}
        </div>
      </div>
      {el}
    </div>
  );
}

// 进度条列表：每行一条，实心是已入账，浅色是承诺，竖线是时间走到哪
export interface BulletRow { key: string; name: string; sub?: string; href?: string; cur: number; actual: number; commit: number; time?: number; v: ReactNode; f?: ReactNode; tone?: string }
export function Bullets({ rows, legend }: { rows: BulletRow[]; legend: { name: string; color?: string; mark?: boolean }[] }) {
  const { ref, on, el } = useTip();
  const w = (x: number, cur: number) => `${cur > 0 ? Math.min(100, Math.max(0, (x / cur) * 100)) : 0}%`;
  return (
    <div className="bls" ref={ref}>
      {rows.map((r) => (
        <a key={r.key} className="bl" href={r.href}>
          <span className="bl-n">{r.name}{r.sub && <small>{r.sub}</small>}</span>
          <span className="bl-t" {...on(<><b>{r.name}</b>
            <span><i style={{ background: C.actual }} />已入账 {money(r.actual)} 元 · {pct(r.actual, r.cur)}</span>
            <span><i style={{ background: C.commit }} />承诺或在途 {money(r.commit)} 元 · {pct(r.commit, r.cur)}</span>
            <span><i style={{ background: C.rest }} />未使用 {money(r.cur - r.actual - r.commit)} 元</span>
            {r.time != null && <span><i className="mk" />时间进度 {(r.time * 100).toFixed(0)}%</span>}</>)}>
            <span className="bl-bar"><i style={{ width: w(r.actual, r.cur), background: C.actual }} /><i style={{ width: w(r.commit, r.cur), background: C.commit }} /></span>
            {r.time != null && <b className="bl-mk" style={{ left: `${Math.min(100, Math.max(0, r.time * 100))}%` }} />}
          </span>
          <span className={`bl-v ${r.tone ?? ''}`}>{r.v}{r.f && <small>{r.f}</small>}</span>
        </a>
      ))}
      <Legend items={legend} />
      {el}
    </div>
  );
}
