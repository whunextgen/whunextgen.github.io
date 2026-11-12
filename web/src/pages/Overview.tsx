import { useViews, type Card, type Me, type Node } from '../api';
import { Bullets, C, Donut } from '../charts';
import { Badge, Bar, Empty, END_RULE, FUND_KIND, Loading, can, Tile, day, money, num, pct, today, useCount } from '../ui';

// 节点状态：预测 = 已入账 + 预计在节点日前入账的承诺
export function nodeState(n: Node, now = today()) {
  const gap = num(n.need) - num(n.forecast);
  if (gap <= 0) return { tone: 'ok', text: day(n.node_date) < now ? '已达标' : '预计达标', gap: 0 };
  return { tone: day(n.node_date) < now ? 'bad' : 'warn', text: day(n.node_date) < now ? '未达标' : '预计不达标', gap };
}

// 执行预警：拿时间进度和执行进度比，按现在的入账速度推到单据截止日，看会剩多少
export function cardRisk(c: Card, now = today()) {
  const cur = num(c.cur), actual = num(c.actual), commit = num(c.commit);
  const t0 = Date.parse(day(c.start_date)), t1 = Date.parse(day(c.cutoff_date)), t = Date.parse(now);
  const time = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
  const exec = cur > 0 ? actual / cur : 0;
  const daysLeft = Math.max(0, Math.round((t1 - t) / 864e5));
  // 到截止日预计入账：在途承诺都入账，和按现在速度推算，取大的那个，不超过预算
  const forecast = Math.min(cur, Math.max(actual + commit, time > 0 ? actual / time : actual));
  const left = Math.max(0, cur - forecast);
  const gap = time - exec;                                    // 执行落后时间进度多少
  const loses = c.end_rule !== 'carry';                       // 到期回收、结余上缴的卡，剩下的钱留不住
  const level = cur <= 0 || left < 1 ? 'ok' : loses && (gap > 0.2 || (daysLeft <= 60 && left / cur > 0.1)) ? 'bad' : gap > 0.1 ? 'warn' : 'ok';
  const perMonth = daysLeft > 0 ? (cur - actual) / Math.max(1, daysLeft / 30) : cur - actual;
  const advice = cur <= 0 ? '还没有下达预算' : left < 1 ? '按现在的进度能用完'
    : daysLeft === 0 ? `已过单据截止，结余 ${money(cur - actual - commit)} ${loses ? '留不住' : '可结转'}`
    : `到截止日每月要入账 ${money(perMonth)}${cur - actual - commit > 0 ? `；还有 ${money(cur - actual - commit)} 没有安排支出` : ''}`;
  return { time, exec, gap, forecast, left, daysLeft, level, advice, loses, timePct: `${(time * 100).toFixed(0)}%`, execPct: `${(exec * 100).toFixed(0)}%` };
}
const RISK: Record<string, [string, string]> = { bad: ['滞后，会剩钱', 'bad'], warn: ['偏慢', 'warn'], ok: ['正常', 'ok'] };

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

  const risks = active.map((c) => ({ c, k: cardRisk(c, now) })).sort((a, b) => 'bad warn ok'.indexOf(a.k.level) - 'bad warn ok'.indexOf(b.k.level) || b.k.left - a.k.left);
  const atRisk = risks.filter((r) => r.k.level !== 'ok');
  const received = active.filter((c) => c.received != null);

  return (
    <>
      <div className="top"><h2>经费卡与节点</h2></div>
      <div className="tiles">
        <Tile k="现行预算" v={money(sum('cur'))} f={`${active.length} 张在用的卡`} />
        <Tile k="决算数 · 学校已入账" color={C.actual} v={money(sum('actual'))} meter={sum('cur') > 0 ? sum('actual') / sum('cur') : 0} f={`执行率 ${pct(sum('actual'), sum('cur'))}`} />
        <Tile k="承诺 · 已批准未入账" color={C.commit} v={money(sum('commit'))} meter={sum('cur') > 0 ? sum('commit') / sum('cur') : 0} f={`占预算 ${pct(sum('commit'), sum('cur'))}`} />
        <Tile k="可用" v={money(sum('avail'))} tone={sum('avail') < 0 ? 'bad' : ''} f="预算 − 承诺 − 决算" />
      </div>
      {active.length > 0 && (
        <div className="g2">
          <section className="card">
            <h3>额度构成 <span className="h3sub">{active.length} 张在用的卡合计</span></h3>
            <Donut value={pct(sum('actual'), sum('cur'))} label="执行率" parts={[{ name: '已入账', value: sum('actual'), color: C.actual }, { name: '承诺', value: sum('commit'), color: C.commit }, { name: '可用', value: Math.max(0, sum('avail')), color: C.rest }]} />
          </section>
          <section className="card">
            <h3>执行进度对时间进度 <span className="h3sub">竖线左边没填满的，是落后于时间的部分</span></h3>
            <Bullets legend={[{ name: '已入账', color: C.actual }, { name: '承诺', color: C.commit }, { name: '时间进度', mark: true }]} rows={risks.map(({ c, k }) => ({
              key: c.card_id, name: c.name, sub: `${END_RULE[c.end_rule]} · 还有 ${k.daysLeft} 天`, href: `#/card/${c.card_id}`,
              cur: num(c.cur), actual: num(c.actual), commit: num(c.commit), time: k.time, tone: k.level === 'bad' ? 'bad' : '',
              v: money(k.left), f: '预计到期结余' }))} />
          </section>
        </div>
      )}
      {active.length > 0 && (
        <section className="card">
          <h3>执行预警 <span className="h3sub">{atRisk.length ? `${atRisk.length} 张卡进度落后，按现在的速度到截止日合计会剩 ${money(atRisk.reduce((s, r) => s + r.k.left, 0))}` : '各卡进度都跟得上'}</span></h3>
          <p className="hint">时间进度从下达日算到单据截止日，执行进度只认学校已入账。预计入账按「在途承诺全部入账」和「保持现在的入账速度」两种算法取大的。到期回收和结余上缴的卡，剩下的钱留不住，排在前面。{received.length > 0 && ` 已到账合计 ${money(received.reduce((s, c) => s + num(c.received), 0))}。`}</p>
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>到期处理</th><th className="r">剩余天数</th><th className="r">时间进度</th><th className="r">执行进度</th><th className="r">预计到期入账</th><th className="r">预计到期结余</th><th>判断</th><th>建议</th></tr></thead>
            <tbody>{risks.map(({ c, k }) => (
              <tr key={c.card_id}><td><a href={`#/card/${c.card_id}`}>{c.name}</a>{c.fund_kind && <div className="sub2" style={{ marginLeft: 0 }}>{FUND_KIND[c.fund_kind]}{c.received != null ? ` · 已到账 ${money(c.received)}` : ''}</div>}</td>
                <td>{END_RULE[c.end_rule]}</td><td className="r">{k.daysLeft}</td><td className="r">{k.timePct}</td><td className={`r ${k.gap > 0.1 ? 'neg' : ''}`}>{k.execPct}</td>
                <td className="r">{money(k.forecast)}</td><td className={`r ${k.level === 'bad' ? 'neg' : ''}`}>{money(k.left)}</td>
                <td><Badge tone={RISK[k.level][1]}>{RISK[k.level][0]}</Badge></td><td className="wrap">{k.advice}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      <section className="card">
        <h3>经费卡</h3>
        {cards.length === 0 ? <Empty>{!can(me, 'read.finance') ? '还没有归到你名下的经费卡。' : '还没有经费卡。'}</Empty> : (
          <>
            <div className="funds">
              {cards.map((c) => (
                <a key={c.card_id} href={`#/card/${c.card_id}`} className={`fund ${c.status === 'settled' ? 'off' : ''}`}>
                  <div className="fund-top"><span className="mono">{c.card_no}</span>
                    {c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone={day(c.cutoff_date) < now ? 'bad' : ''}>{END_RULE[c.end_rule]}</Badge>}</div>
                  <div className="fund-name">{c.name}</div>
                  <div className="fund-sub">{c.fund_kind ? `${FUND_KIND[c.fund_kind]} · ` : ''}{c.template_name}{c.priority != null ? ` · 下达优先级 ${c.priority}` : ''}</div>
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
