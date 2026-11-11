import { useViews, type Card, type Me, type Node, type Req } from '../api';
import { Badge, Bar, Empty, END_RULE, Loading, day, money, num, pct, today, useCount } from '../ui';

// 节点状态：预测 = 已入账 + 预计在节点日前入账的承诺
export function nodeState(n: Node, now = today()) {
  const gap = num(n.need) - num(n.forecast);
  if (gap <= 0) return { tone: 'ok', text: day(n.node_date) < now ? '已达标' : '预计达标', gap: 0 };
  return { tone: day(n.node_date) < now ? 'bad' : 'warn', text: day(n.node_date) < now ? '未达标' : '预计不达标', gap };
}

function Hero({ cur, actual, commit, avail, cards, now }: { cur: number; actual: number; commit: number; avail: number; cards: number; now: string }) {
  const [int, dec] = money(useCount(avail)).split('.');
  const w = (x: number) => `${cur > 0 ? Math.min(100, Math.max(0, (x / cur) * 100)) : 0}%`;
  return (
    <section className="hero" aria-label="在用经费卡合计">
      <div className="hero-top"><span className="eyebrow">可用额度 · Available</span><span className="eyebrow">{now} · {cards} 张在用的卡</span></div>
      <div className={`hero-num ${avail < 0 ? 'bad' : ''}`} aria-label={`可用 ${money(avail)} 元`}>{int}<small>.{dec}</small><em>元</em></div>
      <div className="hero-bar" role="img" aria-label={`决算 ${pct(actual, cur)}，承诺 ${pct(commit, cur)}`}>
        <i className="a" style={{ width: w(actual) }} /><i className="c" style={{ width: w(commit) }} />
      </div>
      <dl className="hero-stats">
        <div><dt><i className="key r" />现行预算</dt><dd>{money(cur)}</dd></div>
        <div><dt><i className="key a" />决算数 · 学校已入账</dt><dd>{money(actual)}<span>{pct(actual, cur)}</span></dd></div>
        <div><dt><i className="key c" />承诺 · 已批准未入账</dt><dd>{money(commit)}<span>{pct(commit, cur)}</span></dd></div>
      </dl>
    </section>
  );
}

export function Overview({ me }: { me: Me }) {
  const { data, error } = useViews<{ cards: Card[]; nodes: Node[]; reqs: Req[] }>({
    cards: ['card'], nodes: ['node'], reqs: ['request', { status: 'pending' }],
  });
  if (!data) return <Loading error={error} />;
  const now = today();
  const cards = [...data.cards].sort((a, b) => a.cutoff_date.localeCompare(b.cutoff_date));
  const active = cards.filter((c) => c.status === 'active');
  const sum = (k: 'cur' | 'actual' | 'commit' | 'avail') => active.reduce((s, c) => s + num(c[k]), 0);
  const byId = new Map(cards.map((c) => [c.card_id, c]));
  const nodes = data.nodes.filter((n) => byId.get(n.card_id)?.status === 'active')
    .sort((a, b) => a.node_date.localeCompare(b.node_date));
  const behind = nodes.filter((n) => nodeState(n, now).gap > 0);
  const over = active.filter((c) => num(c.avail) < 0);
  const soon = active.filter((c) => day(c.cutoff_date) >= now && (Date.parse(day(c.cutoff_date)) - Date.parse(now)) / 864e5 <= 30);

  return (
    <>
      <div className="top"><h2>经费卡与节点</h2></div>
      <Hero cur={sum('cur')} actual={sum('actual')} commit={sum('commit')} avail={sum('avail')} cards={active.length} now={now} />

      {(over.length > 0 || behind.length > 0 || soon.length > 0 || data.reqs.length > 0) && (
        <section className="card">
          <h3>需要处理</h3>
          <ul className="todo">
            {data.reqs.length > 0 && <li><a href="#/requests"><Badge tone="warn">待审批</Badge>
              <span>{data.reqs.length} 笔支出申请等待批准，合计 {money(data.reqs.reduce((s, r) => s + num(r.amount), 0))}</span>
              <span className="go">去处理 →</span></a></li>}
            {over.map((c) => <li key={c.card_id}><a href={`#/card/${c.card_id}`}><Badge tone="bad">超支</Badge>
              <span>{c.name} 可用为 {money(c.avail)}</span><span className="go">看这张卡 →</span></a></li>)}
            {behind.map((n) => { const c = byId.get(n.card_id)!; const s = nodeState(n, now); return (
              <li key={n.node_id}><a href={`#/card/${c.card_id}`}><Badge tone={s.tone}>{s.text}</Badge>
                <span>{c.name}：{day(n.node_date)} 节点要求 {money(n.need)}，预测 {money(n.forecast)}，差 {money(s.gap)}（{n.consequence}）</span>
                <span className="go">看这张卡 →</span></a></li>); })}
            {soon.map((c) => <li key={c.card_id}><a href={`#/card/${c.card_id}`}><Badge tone="warn">临近截止</Badge>
              <span>{c.name} 单据截止 {day(c.cutoff_date)}，还有可用 {money(c.avail)}</span><span className="go">看这张卡 →</span></a></li>)}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>经费卡</h3>
        {cards.length === 0 ? <Empty>{me.role === 'leader' ? '还没有归到你名下的经费卡。' : '还没有经费卡。'}</Empty> : (
          <>
            <div className="funds">
              {cards.map((c) => (
                <a key={c.card_id} href={`#/card/${c.card_id}`} className={`fund ${c.status === 'settled' ? 'off' : ''}`}>
                  <div className="fund-top"><span className="mono">{c.card_no}</span>
                    {c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone={day(c.cutoff_date) < now ? 'bad' : ''}>{END_RULE[c.end_rule]}</Badge>}</div>
                  <div className="fund-name">{c.name}</div>
                  <div className="fund-sub">{c.template_name}</div>
                  <div className="fund-num"><span>可用</span><b className={num(c.avail) < 0 ? 'neg' : ''}>{money(c.avail)}</b></div>
                  <Bar cur={num(c.cur)} actual={num(c.actual)} commit={num(c.commit)} />
                  <div className="fund-foot"><span>执行 {pct(num(c.actual), num(c.cur))}</span><span>预算 {money(c.cur)}</span><span>截止 {day(c.cutoff_date)}</span></div>
                </a>
              ))}
            </div>
            <div className="legend"><span><i className="a" />决算数</span><span><i className="c" />承诺</span></div>
          </>
        )}
      </section>

      <section className="card">
        <h3>考核节点</h3>
        {nodes.length === 0 ? <Empty>各卡的考核节点还没有录入。节点的日期、比例和后果由财务岗录入后，这里按已入账和预计入账给出预测。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>节点日</th><th>经费卡</th><th className="r">要求比例</th><th className="r">要求金额</th><th className="r">预测</th><th>状态</th><th>后果</th></tr></thead>
            <tbody>{nodes.map((n) => { const s = nodeState(n, now); return (
              <tr key={n.node_id}><td>{day(n.node_date)}</td><td><a href={`#/card/${n.card_id}`}>{byId.get(n.card_id)?.name}</a></td>
                <td className="r">{(num(n.ratio) * 100).toFixed(0)}%</td><td className="r">{money(n.need)}</td><td className="r">{money(n.forecast)}</td>
                <td><Badge tone={s.tone}>{s.text}{s.gap > 0 ? `，差 ${money(s.gap)}` : ''}</Badge></td><td>{n.consequence}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
