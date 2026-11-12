import { useViews, type Card, type Me, type Node } from '../api';
import { Badge, Bar, Empty, END_RULE, Loading, Tile, day, money, num, pct, today, useCount } from '../ui';

// 节点状态：预测 = 已入账 + 预计在节点日前入账的承诺
export function nodeState(n: Node, now = today()) {
  const gap = num(n.need) - num(n.forecast);
  if (gap <= 0) return { tone: 'ok', text: day(n.node_date) < now ? '已达标' : '预计达标', gap: 0 };
  return { tone: day(n.node_date) < now ? 'bad' : 'warn', text: day(n.node_date) < now ? '未达标' : '预计不达标', gap };
}

export function Hero({ cur, actual, commit, avail, cards, now }: { cur: number; actual: number; commit: number; avail: number; cards: number; now: string }) {
  const [int, dec] = money(useCount(avail)).split('.');
  const w = (x: number) => `${cur > 0 ? Math.min(100, Math.max(0, (x / cur) * 100)) : 0}%`;
  return (
    <section className="hero slim" aria-label="在用经费卡合计">
      <div className="hero-top"><span className="eyebrow">可用额度</span><span className="eyebrow">{now} · {cards} 张在用的卡</span></div>
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
  const { data, error } = useViews<{ cards: Card[]; nodes: Node[] }>({ cards: ['card'], nodes: ['node'] });
  if (!data) return <Loading error={error} />;
  const now = today();
  const cards = [...data.cards].sort((a, b) => a.cutoff_date.localeCompare(b.cutoff_date));
  const active = cards.filter((c) => c.status === 'active');
  const sum = (k: 'cur' | 'actual' | 'commit' | 'avail') => active.reduce((s, c) => s + num(c[k]), 0);
  const byId = new Map(cards.map((c) => [c.card_id, c]));
  const nodes = data.nodes.filter((n) => byId.get(n.card_id)?.status === 'active')
    .sort((a, b) => a.node_date.localeCompare(b.node_date));

  return (
    <>
      <div className="top"><h2>经费卡与节点</h2></div>
      <div className="tiles">
        <Tile k="现行预算" v={money(sum('cur'))} f={`${active.length} 张在用的卡`} />
        <Tile k="承诺 · 已批准未入账" v={money(sum('commit'))} f={`占预算 ${pct(sum('commit'), sum('cur'))}`} />
        <Tile k="决算数 · 学校已入账" v={money(sum('actual'))} f={`执行率 ${pct(sum('actual'), sum('cur'))}`} />
        <Tile k="可用" v={money(sum('avail'))} tone={sum('avail') < 0 ? 'bad' : ''} f="预算 − 承诺 − 决算" />
      </div>
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
