import { useViews, type Cap, type Card, type Cell, type Change, type Me, type Node, type Req } from '../api';
import { Badge, Bar, CHANGE, Empty, END_RULE, Loading, Tile, day, money, num, pct, today } from '../ui';
import { nodeState } from './Overview';
import { RequestTable } from './Requests';

export function CardPage({ me, id }: { me: Me; id: string }) {
  const f = { card_id: id };
  const { data, error, reload } = useViews<{ card: Card[]; cells: Cell[]; nodes: Node[]; caps: Cap[]; changes: Change[]; reqs: Req[] }>({
    card: ['card', f], cells: ['cell', f], nodes: ['node', f], caps: ['cap', f], changes: ['budget_change', f], reqs: ['request', f],
  }, id);
  if (!data) return <Loading error={error} />;
  const c = data.card[0];
  if (!c) return <><div className="top"><h2>经费卡</h2></div><Empty>没有这张卡，或者你看不到它。<a href="#/">回到总览</a></Empty></>;
  const now = today();
  const cells = [...data.cells].sort((a, b) => a.sort - b.sort || a.subject_code.localeCompare(b.subject_code));
  const used = cells.filter((x) => num(x.cur) || num(x.commit) || num(x.actual));
  const name = new Map(cells.map((x) => [x.subject_id, x.subject_name]));
  const open = data.reqs.filter((r) => !['posted', 'released', 'rejected'].includes(r.status));
  const diff = c.school_available != null ? num(c.avail) - num(c.school_available) : null;

  return (
    <>
      <div className="top">
        <div className="crumb"><a href="#/">经费卡与节点</a> / {c.card_no}</div>
        <h2>{c.name}</h2>
        {c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone={day(c.cutoff_date) < now ? 'bad' : 'ok'}>{day(c.cutoff_date) < now ? '已过单据截止' : '在用'}</Badge>}
      </div>
      <div className="tiles">
        <Tile k="现行预算" v={money(c.cur)} f={num(c.adj) ? `年初 ${money(c.orig)}，变更 ${money(c.adj)}` : '未做过预算变更'} />
        <Tile k="决算数" v={money(c.actual)} f={`执行率 ${pct(num(c.actual), num(c.cur))}`} />
        <Tile k="承诺" v={money(c.commit)} f={`${open.length} 笔在途`} />
        <Tile k="可用" v={money(c.avail)} tone={num(c.avail) < 0 ? 'bad' : ''} />
      </div>

      <section className="card">
        <h3>基本情况</h3>
        <table><tbody>
          <tr><th scope="row">科目模板</th><td>{c.template_name}{c.locked && '（科目锁定，不能变更预算）'}</td>
            <th scope="row">下达日</th><td>{day(c.start_date)}</td></tr>
          <tr><th scope="row">单据截止日</th><td>{day(c.cutoff_date)}</td>
            <th scope="row">到期处理</th><td>{END_RULE[c.end_rule]}{c.settle_date ? `，结清日 ${day(c.settle_date)}` : '，跨年不结清'}</td></tr>
          <tr><th scope="row">学校财务系统</th>
            <td colSpan={3}>{c.school_synced_at == null ? '还没有回写过学校侧的余额，无法对账。'
              : <>余额 {money(c.school_balance)}，冻结 {money(c.school_frozen)}，可用 {money(c.school_available)}（{day(c.school_synced_at)} 回写）
                {diff != null && Math.abs(diff) >= 0.005 && <> <Badge tone="bad">与本系统可用相差 {money(diff)}</Badge></>}</>}</td></tr>
          {c.rule_note && <tr><th scope="row">备注</th><td colSpan={3} className="wrap">{c.rule_note}</td></tr>}
        </tbody></table>
      </section>

      <section className="card">
        <h3>科目预算与执行</h3>
        {used.length === 0 ? <Empty>这张卡还没有预算。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>科目</th><th className="r">年初预算</th><th className="r">变更</th><th className="r">现行预算</th><th className="r">决算数</th>
              <th className="r">承诺</th><th className="r">可用</th><th>执行</th></tr></thead>
            <tbody>
              {used.map((x) => (
                <tr key={x.subject_id}><td>{x.subject_name}</td><td className="r">{money(x.orig)}</td><td className="r">{num(x.adj) ? money(x.adj) : '—'}</td>
                  <td className="r">{money(x.cur)}</td><td className="r">{money(x.actual)}</td><td className="r">{money(x.commit)}</td>
                  <td className={`r ${num(x.avail) < 0 ? 'neg' : ''}`}>{money(x.avail)}</td>
                  <td><Bar cur={num(x.cur)} actual={num(x.actual)} commit={num(x.commit)} /></td></tr>
              ))}
              <tr className="sum"><td>合计</td><td className="r">{money(c.orig)}</td><td className="r">{num(c.adj) ? money(c.adj) : '—'}</td><td className="r">{money(c.cur)}</td>
                <td className="r">{money(c.actual)}</td><td className="r">{money(c.commit)}</td><td className="r">{money(c.avail)}</td><td /></tr>
            </tbody>
          </table></div>
        )}
        {cells.length > used.length && <p className="sub2">另有 {cells.length - used.length} 个科目没有预算也没有支出，未列出。</p>}
      </section>

      <section className="card">
        <h3>比例上限</h3>
        {data.caps.length === 0 ? <Empty>这张卡的模板没有设置比例上限。</Empty> : (
          <table>
            <thead><tr><th>规则</th><th className="r">上限</th><th className="r">上限金额</th><th className="r">现行预算中</th><th>状态</th></tr></thead>
            <tbody>{data.caps.map((k) => (
              <tr key={k.cap_id}><td>{k.name}</td><td className="r">{(num(k.max_ratio) * 100).toFixed(0)}%</td><td className="r">{money(k.max_amount)}</td>
                <td className="r">{money(k.used)}</td><td>{num(k.used) > num(k.max_amount) ? <Badge tone="bad">超出</Badge> : <Badge tone="ok">未超</Badge>}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>考核节点</h3>
        {data.nodes.length === 0 ? <Empty>这张卡的考核节点还没有录入。</Empty> : (
          <table>
            <thead><tr><th>节点日</th><th className="r">要求比例</th><th className="r">要求金额</th><th className="r">预测</th><th>状态</th><th>后果</th></tr></thead>
            <tbody>{[...data.nodes].sort((a, b) => a.node_date.localeCompare(b.node_date)).map((n) => { const s = nodeState(n, now); return (
              <tr key={n.node_id}><td>{day(n.node_date)}</td><td className="r">{(num(n.ratio) * 100).toFixed(0)}%</td><td className="r">{money(n.need)}</td>
                <td className="r">{money(n.forecast)}</td><td><Badge tone={s.tone}>{s.text}{s.gap > 0 ? `，差 ${money(s.gap)}` : ''}</Badge></td><td>{n.consequence}</td></tr>); })}</tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>预算变更</h3>
        {data.changes.length === 0 ? <Empty>没有预算变更记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>发起日</th><th>原因</th><th>调整</th><th>状态</th><th>批复日</th></tr></thead>
            <tbody>{[...data.changes].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((ch) => (
              <tr key={ch.id}><td>{day(ch.created_at)}</td><td className="wrap">{ch.reason}</td>
                <td className="wrap">{(ch.lines ?? []).map((l) => `${name.get(l.subject_id) ?? '科目'} ${l.delta > 0 ? '+' : ''}${money(l.delta)}`).join('；')}</td>
                <td><Badge tone={CHANGE[ch.status][1]}>{CHANGE[ch.status][0]}</Badge></td><td>{day(ch.approved_on)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>在途的支出</h3>
        <p className="hint">已入账的历史支出在 <a href="#/requests">支出与承诺</a> 里按状态查看。</p>
        {open.length === 0 ? <Empty>这张卡没有在途的支出。</Empty>
          : <RequestTable me={me} rows={open} subjectName={name} onChange={reload} />}
      </section>
    </>
  );
}
