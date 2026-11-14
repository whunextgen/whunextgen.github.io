import { useState } from 'react';
import { rpc, useViews, type Card, type Me, type SettleCheck, type SettleLine, type YearActual } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, Loading, can, day, money, num, pct, today } from '../ui';

export function Settle({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ cards: Card[]; years: YearActual[]; checks: SettleCheck[]; lines: SettleLine[] }>({
    cards: ['card'], years: ['year_actual'], checks: ['settle_check'], lines: ['settlement'],
  });
  const now = today();
  const thisYear = Number(now.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [target, setTarget] = useState<Card | null>(null);
  if (!data) return <Loading error={error} />;

  const cards = [...data.cards].sort((a, b) => a.card_no.localeCompare(b.card_no));
  const years = [...new Set([thisYear, ...data.years.map((y) => y.year)])].sort((a, b) => b - a);
  const inYear = new Map(data.years.filter((y) => y.year === year).map((y) => [y.card_id, num(y.actual)]));
  // 年度表只列这一年内存续的卡
  const rows = cards.filter((c) => Number(day(c.start_date).slice(0, 4)) <= year && (inYear.has(c.card_id) || c.status === 'active' || Number(day(c.cutoff_date).slice(0, 4)) >= year));
  const total = (f: (c: Card) => number) => rows.reduce((s, c) => s + f(c), 0);

  const check = new Map(data.checks.map((k) => [k.card_id, k]));
  const active = cards.filter((c) => c.status === 'active');
  const due = active.filter((c) => c.settle_date).sort((a, b) => a.settle_date!.localeCompare(b.settle_date!));
  const open = active.filter((c) => !c.settle_date);
  const blockers = (c: Card) => {
    const k = check.get(c.card_id); const out: string[] = [];
    if (k?.open_requests) out.push(`${k.open_requests} 笔支出未结`);
    if (k?.open_changes) out.push(`${k.open_changes} 笔调整办理中`);
    if (k?.open_staff) out.push(`${k.open_staff} 条人员费未入账`);
    return out;
  };

  const settled = cards.filter((c) => c.status === 'settled').map((c) => {
    const ls = data.lines.filter((l) => l.card_id === c.card_id);
    const s = (k: 'budget' | 'actual' | 'balance') => ls.reduce((t, l) => t + num(l[k]), 0);
    return { c, on: ls[0]?.settled_on, budget: s('budget'), actual: s('actual'), balance: s('balance') };
  }).sort((a, b) => (b.on ?? '').localeCompare(a.on ?? ''));

  return (
    <>
      <div className="top"><h2>经费结清</h2></div>

      <section className="card">
        <h3>年度汇总</h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {years.map((y) => <button key={y} className="sm" aria-pressed={y === year} onClick={() => setYear(y)}>{y} 年</button>)}
        </div>
        {rows.length === 0 ? <Empty>该年度暂无经费卡。</Empty> : (
          <>
            <div className="scroll"><table>
              <thead><tr><th>经费卡</th><th>状态</th><th className="r">现行预算</th><th className="r">{year} 年决算</th><th className="r">累计决算</th>
                <th className="r">累计执行率</th><th className="r">承诺</th><th className="r">可用</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.card_id}><td><a href={`#/card/${c.card_id}`}>{c.name} {c.year}</a><br /><span className="mono">{c.card_no}</span></td>
                  <td>{c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone="ok">在用</Badge>}</td>
                  <td className="r">{money(c.cur)}</td><td className="r">{money(inYear.get(c.card_id) ?? 0)}</td><td className="r">{money(c.actual)}</td>
                  <td className="r">{pct(num(c.actual), num(c.cur))}</td><td className="r">{money(c.commit)}</td>
                  <td className="r">{c.status === 'settled' ? '—' : money(c.avail)}</td></tr>
              ))}</tbody>
              <tfoot><tr><th scope="row">合计</th><td /><td className="r">{money(total((c) => num(c.cur)))}</td>
                <td className="r">{money(total((c) => inYear.get(c.card_id) ?? 0))}</td><td className="r">{money(total((c) => num(c.actual)))}</td>
                <td className="r">{pct(total((c) => num(c.actual)), total((c) => num(c.cur)))}</td><td className="r">{money(total((c) => num(c.commit)))}</td>
                <td className="r">{money(total((c) => (c.status === 'settled' ? 0 : num(c.avail))))}</td></tr></tfoot>
            </table></div>
            <p className="hint">年度决算按学校入账日归属年度。预算、累计决算、承诺和可用为各经费卡截至当日的数据，不随年度切换。</p>
          </>
        )}
      </section>

      <section className="card">
        <h3>待结清经费卡</h3>
        {due.length === 0 ? <Empty>暂无已设结清日的在用经费卡。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>结清日</th><th>经费卡</th><th>到期处理</th><th className="r">可用</th><th>结清前待办</th><th /></tr></thead>
            <tbody>{due.map((c) => { const b = blockers(c); const reached = day(c.settle_date) <= now; return (
              <tr key={c.card_id}><td>{day(c.settle_date)}</td><td><a href={`#/card/${c.card_id}`}>{c.name} {c.year}</a></td><td>{END_RULE[c.end_rule]}</td>
                <td className="r">{money(c.avail)}</td>
                <td>{b.length > 0 ? <Badge tone={reached ? 'bad' : 'warn'}>{b.join('，')}</Badge>
                  : reached ? <Badge tone="ok">可结清</Badge> : <Badge>未到结清日</Badge>}</td>
                <td className="r">{can(me, 'card.settle') && reached && b.length === 0 && <button className="sm danger" onClick={() => setTarget(c)}>结清</button>}</td></tr>); })}</tbody>
          </table></div>
        )}
        {open.length > 0 && <p className="hint">尚未设结清日的经费卡：{open.map((c) => `${c.name} ${c.year}`).join('、')}。结清前须先在经费卡页面填写结清日。</p>}
      </section>

      <section className="card">
        <h3>已结清</h3>
        {settled.length === 0 ? <Empty>暂无已结清的经费卡。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>结清日期</th><th>经费卡</th><th className="r">预算</th><th className="r">决算</th><th className="r">结余</th><th>结余去向</th></tr></thead>
            <tbody>{settled.map(({ c, on, budget, actual, balance }) => (
              <tr key={c.card_id}><td>{day(on)}</td><td><a href={`#/card/${c.card_id}`}>{c.name} {c.year}</a></td>
                <td className="r">{money(budget)}</td><td className="r">{money(actual)}</td><td className="r">{money(balance)}</td>
                <td>{num(c.carried_out) > 0 ? `结转至下一年 ${money(c.carried_out)}` : num(c.recalled) > 0 ? `回收 ${money(c.recalled)}` : END_RULE[c.end_rule]}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {target && <ActionDialog title={`结清 ${target.name}`} danger submitLabel="确认结清" fields={[]}
        hint={`结清后各科目的预算、决算和结余即固定，该经费卡不得再提交支出和调整。结余 ${money(num(target.cur) - num(target.actual))} 按「${END_RULE[target.end_rule]}」处理${target.end_rule === 'carry' ? '，按科目带入该项目下一年的经费卡' : '，记为回收数'}。`}
        onSubmit={() => rpc('settle_card', { card_id: target.card_id }).then(reload)} onClose={() => setTarget(null)} />}
    </>
  );
}
