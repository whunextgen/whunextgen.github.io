// 工作台上逐级展开的层级：项目 › 经费卡 › 明细，课题 › 研究单元 › 预算行。每一级带一张自己的图。
import { useState, type ReactNode } from 'react';
import { Badge, money, pct } from './ui';

export interface Seg { cls: string; value: number; text?: string; tip: string }

// 一条分段的图：各段宽度按金额；cap 是图上方的小标题，scale 给出时整条的长度按金额占 scale 的比例
export function Track({ cap, segs, scale, total, mark }: { cap?: string; segs: Seg[]; scale?: number; total?: number; mark?: number }) {
  const shown = segs.filter((s) => s.value > 0);
  const sum = total ?? shown.reduce((t, s) => t + s.value, 0);
  return (
    <div className="wb-bar">
      {cap && <div className="wb-cap">{cap}</div>}
      <div className="wb-rel" style={scale && scale > 0 ? { width: `${Math.max((100 * sum) / scale, 4)}%` } : undefined}>
        <div className="wb-track" role="img" aria-label={shown.map((s) => s.tip).join('；')}>
          {shown.map((s, i) => <i key={i} className={s.cls} style={{ flex: `${s.value} ${s.value} 0` }} title={s.tip}>{s.text}</i>)}
        </div>
        {mark != null && <div className="wb-mark" style={{ left: `${Math.min(100, Math.max(0, mark * 100))}%` }}><span>时间进度 {(mark * 100).toFixed(0)}%</span></div>}
      </div>
    </div>
  );
}

// 执行图：已入账、已承诺、可用
export function execSegs(total: number, actual: number, commit: number, what: string): Seg[] {
  const rest = Math.max(total - actual - commit, 0);
  return [
    { cls: 'sa', value: actual, tip: `已入账 ${money(actual)}，占${what} ${pct(actual, total)}` },
    { cls: 'sc', value: commit, tip: `已承诺 ${money(commit)}，占${what} ${pct(commit, total)}` },
    { cls: 'sr', value: rest, tip: `可用 ${money(total - actual - commit)}，占${what} ${pct(rest, total)}` },
  ];
}

// 一个层级节点。有下一级的可点击展开；href 给出时标题旁有进入详情页的链接
export function TreeNode({ level, lv, title, meta, href, chart, num, sub, status, open = false, children }: {
  level: 1 | 2 | 3; lv: string; title: string; meta?: string; href?: string; chart: ReactNode; num: ReactNode; sub?: ReactNode;
  status?: [string, string] | null; open?: boolean; children?: ReactNode;
}) {
  const [on, setOn] = useState(open);
  const leaf = !children || (Array.isArray(children) && children.filter(Boolean).length === 0);
  const toggle = () => { if (!leaf) setOn(!on); };
  return (
    <div className={`wb-node l${level}${on && !leaf ? ' open' : ''}`}>
      <div className={`wb-head${leaf ? ' leaf' : ''}`} role={leaf ? undefined : 'button'} tabIndex={leaf ? undefined : 0} aria-expanded={leaf ? undefined : on}
        onClick={toggle} onKeyDown={(e) => { if (!leaf && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } }}>
        <span className="wb-tw" aria-hidden="true">▸</span>
        <div className="wb-name"><span className="wb-lv">{lv}</span><span className="wb-t">{title}</span>
          {href && <a className="wb-go" href={href} onClick={(e) => e.stopPropagation()}>详情 →</a>}
          {meta && <span className="wb-meta">{meta}</span>}</div>
        {chart}
        <div className="wb-num">{num}{sub && <small>{sub}</small>}</div>
        <div className="wb-st">{status && <Badge tone={status[0]}>{status[1]}</Badge>}</div>
      </div>
      {!leaf && on && <div className="wb-kids">{children}</div>}
    </div>
  );
}

// 各级详情页的页头：左边是本级名称和一个大数，右边是一张图和几个数
export function ObjHead({ crumb, eyebrow, title, badge, actions, label, value, unit = '元', neg, chart, facts }: {
  crumb: ReactNode; eyebrow: string; title: string; badge?: ReactNode; actions?: ReactNode; label: string; value: number | string; unit?: string; neg?: boolean;
  chart: ReactNode; facts: [string, ReactNode, boolean?][];
}) {
  const big = typeof value === 'number' ? (() => { const [a, d] = money(value).split('.'); return <>{a}<small>.{d}</small></>; })() : value;
  return (
    <>
      <p className="hint" style={{ margin: 0 }}>{crumb}</p>
      <div className="wb-hero">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h2 style={{ margin: '6px 0 0' }}>{title} {badge}</h2>
          <h1><small>{label}</small><em className={neg ? 'neg' : ''}>{big}</em>{typeof value === 'number' ? ` ${unit}` : ''}</h1>
          {actions && <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 14 }}>{actions}</div>}
        </div>
        <div>
          {chart}
          <div className="wb-facts">{facts.map(([k, v, warn]) => <span key={k} className={warn ? 'w' : undefined}>{k}<b>{v}</b></span>)}</div>
        </div>
      </div>
    </>
  );
}

// 本级的流程：五个环节各带一个数，当前所在环节加重显示
export interface Stage { nm: string; ds: string; v: ReactNode; f?: ReactNode }
export function Stages({ path, items, at }: { path: string; items: Stage[]; at: number }) {
  return (
    <section className="wb-sec">
      <div className="wb-sh"><span className="no">01</span><h2>流程</h2><span className="path">{path}</span></div>
      <div className="flowline" aria-label="流程">
        {items.map((g, i) => (
          <div key={g.nm} className={`stage still${i + 1 === at ? ' on' : i + 1 < at ? ' done' : ''}`} aria-current={i + 1 === at ? 'step' : undefined}>
            <span className="no">0{i + 1}</span><span className="nm">{g.nm}</span><span className="ds">{g.ds}</span><span className="v">{g.v}</span><span className="f">{g.f}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
