import { useViews, type Card, type Me, type Node, type Req } from '../api';
import { Badge, Bar, Empty, END_RULE, Loading, Tile, day, money, num, pct, today } from '../ui';

// 节点状态：预测 = 已入账 + 预计在节点日前入账的承诺
export function nodeState(n: Node, now = today()) {
  const gap = num(n.need) - num(n.forecast);
  if (gap <= 0) return { tone: 'ok', text: day(n.node_date) < now ? '已达标' : '预计达标', gap: 0 };
  return { tone: day(n.node_date) < now ? 'bad' : 'warn', text: day(n.node_date) < now ? '未达标' : '预计不达标', gap };
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
      <div className="top"><h2>经费卡与节点</h2><span className="sub2">今天 {now}</span></div>
      <div className="tiles">
        <Tile k="现行预算" v={money(sum('cur'))} f={`${active.length} 张在用的卡`} />
        <Tile k="决算数（学校已入账）" v={money(sum('actual'))} f={`执行率 ${pct(sum('actual'), sum('cur'))}`} />
        <Tile k="承诺（已批准未入账）" v={money(sum('commit'))} />
        <Tile k="可用" v={money(sum('avail'))} tone={sum('avail') < 0 ? 'bad' : ''} />
      </div>

      {(over.length > 0 || behind.length > 0 || soon.length > 0 || data.reqs.length > 0) && (
        <section className="card">
          <h3>需要处理</h3>
          <table><tbody>
            {data.reqs.length > 0 && <tr><td><Badge tone="warn">待审批</Badge></td>
              <td className="wrap">{data.reqs.length} 笔支出申请等待批准，合计 {money(data.reqs.reduce((s, r) => s + num(r.amount), 0))}</td>
              <td className="r"><a href="#/requests">去处理</a></td></tr>}
            {over.map((c) => <tr key={c.card_id}><td><Badge tone="bad">超支</Badge></td>
              <td className="wrap">{c.name} 可用为 {money(c.avail)}</td><td className="r"><a href={`#/card/${c.card_id}`}>看这张卡</a></td></tr>)}
            {behind.map((n) => { const c = byId.get(n.card_id)!; const s = nodeState(n, now); return (
              <tr key={n.node_id}><td><Badge tone={s.tone}>{s.text}</Badge></td>
                <td className="wrap">{c.name}：{day(n.node_date)} 节点要求 {money(n.need)}，预测 {money(n.forecast)}，差 {money(s.gap)}（{n.consequence}）</td>
                <td className="r"><a href={`#/card/${c.card_id}`}>看这张卡</a></td></tr>); })}
            {soon.map((c) => <tr key={c.card_id}><td><Badge tone="warn">临近截止</Badge></td>
              <td className="wrap">{c.name} 单据截止 {day(c.cutoff_date)}，还有可用 {money(c.avail)}</td>
              <td className="r"><a href={`#/card/${c.card_id}`}>看这张卡</a></td></tr>)}
          </tbody></table>
        </section>
      )}

      <section className="card">
        <h3>经费卡</h3>
        {cards.length === 0 ? <Empty>{me.role === 'leader' ? '还没有归到你名下的经费卡。' : '还没有经费卡。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th className="r">现行预算</th><th className="r">决算数</th><th className="r">承诺</th><th className="r">可用</th>
              <th>执行</th><th>单据截止</th><th>到期</th></tr></thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.card_id}>
                  <td><a href={`#/card/${c.card_id}`}>{c.name}</a><div className="sub2">{c.card_no} · {c.template_name}</div></td>
                  <td className="r">{money(c.cur)}</td><td className="r">{money(c.actual)}</td><td className="r">{money(c.commit)}</td>
                  <td className={`r ${num(c.avail) < 0 ? 'neg' : ''}`}>{money(c.avail)}</td>
                  <td><Bar cur={num(c.cur)} actual={num(c.actual)} commit={num(c.commit)} /><div className="sub2">{pct(num(c.actual), num(c.cur))}</div></td>
                  <td>{day(c.cutoff_date)}</td>
                  <td>{c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone={day(c.cutoff_date) < now ? 'bad' : ''}>{END_RULE[c.end_rule]}</Badge>}</td>
                </tr>
              ))}
              <tr className="sum"><td>在用的卡合计</td><td className="r">{money(sum('cur'))}</td><td className="r">{money(sum('actual'))}</td>
                <td className="r">{money(sum('commit'))}</td><td className="r">{money(sum('avail'))}</td><td colSpan={3} /></tr>
            </tbody>
          </table></div>
        )}
        <div className="legend"><span><i style={{ background: 'var(--pri)' }} />决算数</span><span><i style={{ background: '#e0a100' }} />承诺</span></div>
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
