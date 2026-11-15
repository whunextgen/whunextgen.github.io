import { useViews, type Card, type FundProject } from '../api';
import { Badge, Empty, Loading, day, money, num, today } from '../ui';

// 明细账校准：各经费卡上次上传学校明细账的时间和按明细核对的结果。上传在经费卡页办理
export function SyncPage() {
  const { data, error } = useViews<{ cards: Card[]; funds: FundProject[] }>({ cards: ['card'], funds: ['fund_project'] });
  if (!data) return <Loading error={error} />;
  const now = Date.parse(today());
  const name = new Map(data.funds.map((p) => [p.id, p]));
  const rows = [...data.cards].sort((a, b) => a.status.localeCompare(b.status) || (a.school_synced_at ?? '').localeCompare(b.school_synced_at ?? '') || a.card_no.localeCompare(b.card_no));
  const age = (c: Card) => (c.school_synced_at ? Math.floor((now - Date.parse(day(c.school_synced_at))) / 864e5) : null);
  const stale = rows.filter((c) => c.status === 'active' && (age(c) == null || age(c)! > 30)).length;
  return (
    <>
      <div className="top"><h2>明细账校准</h2></div>
      <p className="lede">上传学校财务系统导出的明细账，即上传学校的入账记录，用来校准经费卡的下达数、已入账和学校余额。上传在各经费卡的页面办理；这里列出每张经费卡上次校准的时间。{stale > 0 ? `在用的经费卡中有 ${stale} 张超过 30 天未校准或从未校准。` : ''}</p>
      <section className="card">
        {rows.length === 0 ? <Empty>暂无经费卡。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>经费卡</th><th>所属项目</th><th className="r">明细账支出</th><th className="r">收入明细</th><th className="r">学校余额</th><th>上次校准</th><th /></tr></thead>
            <tbody>{rows.map((c) => { const a = age(c); const p = name.get(c.project_id); return (
              <tr key={c.card_id} style={c.status === 'settled' ? { opacity: .6 } : undefined}>
                <td><a className="mono" href={`#/card/${c.card_id}`}>{c.card_no}</a> {c.name}<span className="sub2">{c.year} 年下达{c.status === 'settled' ? ' · 已结清' : ''}</span></td>
                <td>{p && !p.auto ? <a href={`#/fund/${p.id}`}>{p.name}</a> : <span className="sub2">尚未归入项目</span>}</td>
                <td className="r">{num(c.ledger_actual) > 0 ? money(c.ledger_actual) : '—'}</td><td className="r">{num(c.income) > 0 ? money(c.income) : '—'}</td>
                <td className="r">{c.school_balance != null ? money(c.school_balance) : '—'}</td>
                <td>{a == null ? <Badge tone="warn">从未校准</Badge> : <>{day(c.school_synced_at!)} {c.status === 'active' && a > 30 ? <Badge tone="warn">{a} 天前</Badge> : <span className="sub2">{a} 天前</span>}</>}</td>
                <td className="r">{c.status === 'active' && <a className="btn sm ghost" href={`#/card/${c.card_id}`}>上传明细账</a>}</td>
              </tr>); })}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
