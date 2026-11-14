import { useMemo, useState } from 'react';
import { rpc, useViews, type CardPick, type Me, type Project, type Quota, type Req, type Subject, type User } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, REQ, Tile, day, money, num, pct, type Field } from '../ui';

interface Act { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 晨星额度：叠在经费卡之上的内部额度。钱仍从经费卡出，这里只看额度、劳务上限和季度执行。
export function QuotaPage({ me }: { me: Me }) {
  const staff = can(me, 'quota.manage');
  const director = can(me, 'quota.set');
  const { data, error, reload } = useViews<{ quotas: Quota[]; reqs: Req[]; cards: CardPick[]; subjects: Subject[]; users: User[]; projects: Project[] }>({
    quotas: ['quota'], reqs: ['request'], cards: ['card_pick'], subjects: ['subject'], users: ['users'], projects: ['project'],
  });
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [open, setOpen] = useState('');
  const [act, setAct] = useState<Act | null>(null);
  const maps = useMemo(() => ({
    card: new Map((data?.cards ?? []).map((c) => [c.id, c.name])),
    subject: new Map((data?.subjects ?? []).map((s) => [s.id, s.name])),
    project: new Map((data?.projects ?? []).map((p) => [p.id, p])),
  }), [data]);
  if (!data) return <Loading error={error} />;

  const years = [...new Set([thisYear, ...data.quotas.map((q) => q.year)])].sort((a, b) => b - a);
  const rows = data.quotas.filter((q) => q.year === year).sort((a, b) => a.leader_name.localeCompare(b.leader_name, 'zh'));
  const sum = (k: 'amount' | 'used' | 'actual') => rows.reduce((s, q) => s + num(q[k]), 0);
  const leaders = data.users.filter((u) => u.active && (u.role === 'leader' || u.role === 'director')).map((u): [string, string] => [u.id, u.name]);
  const quotaAct = (q?: Quota): Act => ({
    label: q ? '修改' : '下达额度', title: q ? `修改 ${q.leader_name} ${q.year} 年的额度` : '下达晨星额度',
    hint: q ? '负责人和年度不可修改。额度不得低于已关联支出。' : '每位负责人每年度一个额度。',
    fields: [...(q ? [] : [{ name: 'leader_id', label: '负责人', options: leaders } as Field, { name: 'year', label: '年度', type: 'number', value: String(year) } as Field]),
      { name: 'amount', label: '额度（元）', type: 'number', value: q ? String(num(q.amount)) : '' },
      { name: 'labor', label: '劳务类上限（%）', type: 'number', value: String(q ? num(q.labor_cap_ratio) * 100 : 30) }],
    run: (v) => rpc('save_quota', { id: q?.id ?? null, leader_id: q?.leader_id ?? v.leader_id, year: q?.year ?? Math.round(Number(v.year)), amount: v.amount, labor_ratio: Number(v.labor) / 100 }),
  });

  return (
    <>
      <div className="top"><h2>晨星额度管理</h2>
        {director && <button onClick={() => setAct(quotaAct())}>下达额度</button>}</div>
      <div className="tiles">
        <Tile k={`${year} 年额度`} v={money(sum('amount'))} f={`${rows.length} 位负责人`} />
        <Tile k="已关联支出" v={money(sum('used'))} f={`占额度 ${pct(sum('used'), sum('amount'))}`} />
        <Tile k="已入账" v={money(sum('actual'))} f={`执行率 ${pct(sum('actual'), sum('amount'))}`} />
        <Tile k="执行落后" v={rows.filter((q) => q.behind).length} f="入账不足应执行数的 70%" tone={rows.some((q) => q.behind) ? 'bad' : ''} />
      </div>
      <section className="card">
        <h3>额度与执行</h3>
        <p className="hint">晨星额度并入项目预算：每位负责人的额度对应一个独立研究线项目，额度为该项目当年预算的上限，申报、核定、下达和执行均按年度预算办理。尚未转为项目的额度维持原办法，提交支出申请时选择额度即计入。
          季度执行按至当季末应累计入账 额度 × 季度序号 ÷ 4 计算，实际入账不足应执行数的 70% 标为落后。</p>
        {years.length > 1 && <div className="tabs" style={{ marginBottom: 12 }}>
          {years.map((y) => <button key={y} className="sm" aria-pressed={y === year} onClick={() => setYear(y)}>{y}</button>)}</div>}
        {rows.length === 0 ? <Empty>{year} 年尚未下达额度。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>负责人</th><th>项目</th><th className="r">额度</th><th className="r">已关联支出</th><th className="r">剩余</th><th className="r">已入账</th>
              <th className="r">第 {rows[0].quarter} 季度末应执行</th><th>执行</th><th className="r">劳务类</th><th /></tr></thead>
            <tbody>{rows.map((q) => { const left = num(q.amount) - num(q.used); return (
              <tr key={q.id}><td>{q.leader_name}{q.leader_id === me.id && <span className="sub2"> 本人</span>}</td>
                <td>{q.project_id ? <a href={`#/project/${q.project_id}`}>{maps.project.get(q.project_id)?.name ?? '已转为项目'}<span className="sub2">{maps.project.get(q.project_id)?.code ?? ''}</span></a> : <Badge tone="warn">未转项目</Badge>}</td>
                <td className="r">{money(q.amount)}</td><td className="r">{money(q.used)}</td><td className={`r ${left < 0 ? 'neg' : ''}`}>{money(left)}</td>
                <td className="r">{money(q.actual)}</td><td className="r">{money(q.due)}</td>
                <td>{q.quarter === 0 ? '—' : q.behind ? <Badge tone="bad">落后，差 {money(num(q.due) - num(q.actual))}</Badge> : <Badge tone="ok">正常</Badge>}</td>
                <td className={`r ${num(q.labor_used) > num(q.labor_cap) ? 'neg' : ''}`}>{money(q.labor_used)}<div className="sub2">上限 {money(q.labor_cap)}</div></td>
                <td><div className="acts"><button className="sm ghost" aria-pressed={open === q.id} onClick={() => setOpen(open === q.id ? '' : q.id)}>{q.requests} 笔</button>
                  {staff && !q.project_id && <button className="sm ghost" onClick={() => setAct({ label: '转为项目', title: `将 ${q.leader_name} 的额度转为项目预算`, fields: [],
                    hint: `为 ${q.leader_name} 建立一个独立研究线项目（此前已转的沿用原项目），${q.year} 年的额度 ${money(q.amount)} 成为该项目当年预算的上限，劳务上限一并转入；额度下已有的 ${q.requests} 笔支出归入该项目。转入后不可撤回。`,
                    run: () => rpc('quota_to_project', { id: q.id }) })}>转为项目</button>}
                  {director && <button className="sm ghost" onClick={() => setAct(quotaAct(q))}>修改</button>}</div></td></tr>); })}</tbody>
          </table></div>
        )}
      </section>
      {rows.filter((q) => q.id === open).map((q) => { const list = data.reqs.filter((r) => r.morningstar_quota_id === q.id && !['rejected', 'released'].includes(r.status))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)); return (
        <section className="card" key={q.id}>
          <h3>{q.leader_name} 额度下的支出</h3>
          {list.length === 0 ? <Empty>该额度下暂无支出。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>事项</th><th>经费卡</th><th>科目</th><th className="r">金额</th><th>预计入账</th><th>状态</th><th /></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id}><td className="wrap">{r.title}</td><td>{maps.card.get(r.card_id ?? '') ?? '—'}</td><td>{maps.subject.get(r.subject_id) ?? '—'}</td>
                  <td className="r">{money(r.status === 'posted' ? r.posted_amount ?? r.amount : r.amount)}</td><td>{day(r.posted_on ?? r.eta_date)}</td>
                  <td><Badge tone={REQ[r.status][1]}>{REQ[r.status][0]}</Badge></td>
                  <td><div className="acts">{staff && <button className="sm ghost danger" onClick={() => setAct({ label: '移出额度', title: '将该笔支出移出额度', danger: true,
                    hint: `${r.title}，${money(r.amount)}。移出后不再计入 ${q.leader_name} 的额度，支出本身不受影响。`, fields: [], run: () => rpc('set_request_quota', { id: r.id, quota_id: null }) })}>移出</button>}</div></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>); })}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
