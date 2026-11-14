import { useState } from 'react';
import { rpc, useViews, type Card, type FundProject, type Me, type Template, type User } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, FUND_KIND, FUND_SOURCE, Loading, ROLE, Tile, can, day, money, num, today, type Field } from '../ui';

interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 经费项目：学校、国家等渠道批下来的项目，记额度和期限。每年申请下来的经费是项目下当年的一张经费卡，当年能用多少只看当年的卡。
export function Funds({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ projects: FundProject[]; cards: Card[]; templates: Template[]; users: User[] }>({
    projects: ['fund_project'], cards: ['card'], templates: ['template'], users: ['users'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  if (!data) return <Loading error={error} />;
  const staff = can(me, 'card.manage');
  const thisYear = Number(today().slice(0, 4));
  const tplOpts = data.templates.map((t): [string, string] => [t.id, t.name]);
  const owners = data.users.filter((u) => u.active).map((u): [string, string] => [u.id, `${u.name}（${ROLE[u.role]}）`]);
  const cardsOf = (p: FundProject) => data.cards.filter((c) => c.project_id === p.id).sort((a, b) => b.year - a.year);
  const left = (p: FundProject) => (p.quota != null ? num(p.quota) - num(p.granted) : null);
  const projects = [...data.projects].sort((a, b) => a.status.localeCompare(b.status) || (a.period_end ?? '9').localeCompare(b.period_end ?? '9') || a.name.localeCompare(b.name, 'zh'));
  const active = projects.filter((p) => p.status === 'active');
  const shown = showClosed ? projects : active;
  const withQuota = active.filter((p) => p.quota != null);
  const sum = (f: (p: FundProject) => number, ps = active) => ps.reduce((s, p) => s + f(p), 0);
  const nowCards = data.cards.filter((c) => c.year === thisYear && c.status === 'active');

  const projectAct = (p?: FundProject): Act => ({
    title: p ? `修改经费项目：${p.name}` : '新建经费项目', label: p ? '保存' : '新建',
    hint: '额度为该项目批复的总数，期限为项目起止日期，均按任务书或合同填写。每年实际申请下来的经费另在项目下开当年的经费卡。',
    fields: [
      { name: 'name', label: '项目名称', value: p?.name },
      { name: 'source', label: '来源渠道（选填）', options: Object.entries(FUND_SOURCE), required: false, value: p?.source ?? '' },
      { name: 'fund_kind', label: '经费性质（选填）', options: Object.entries(FUND_KIND), required: false, value: p?.fund_kind ?? '' },
      { name: 'owner_id', label: '负责人（选填）', options: owners, required: false, value: p?.owner_id ?? '' },
      { name: 'quota', label: '额度（元，选填；未填时不校验下达合计）', type: 'number', required: false, value: p?.quota != null ? String(num(p.quota)) : '' },
      { name: 'period_start', label: '期限开始（选填）', type: 'date', required: false, value: p?.period_start ? day(p.period_start) : '' },
      { name: 'period_end', label: '期限结束（选填）', type: 'date', required: false, value: p?.period_end ? day(p.period_end) : '' },
      { name: 'template_id', label: '科目模板', options: tplOpts, value: p?.template_id },
      { name: 'end_rule', label: '年底规则（各年经费卡的默认到期处理）', options: Object.entries(END_RULE), value: p?.end_rule ?? 'recall' },
      { name: 'note', label: '备注（选填）', required: false, value: p?.note ?? '' },
    ],
    run: (v) => rpc('save_fund_project', { id: p?.id ?? null, ...v }),
  });
  const openAct = (p: FundProject): Act => {
    const cs = cardsOf(p);
    const year = cs.length > 0 ? Math.max(cs[0].year + 1, thisYear) : thisYear;
    const prev = cs.find((c) => c.year === year - 1);
    return {
      title: `开经费卡：${p.name}`, label: '开卡',
      hint: `一个经费项目每年一张经费卡，记当年申请下来的经费。卡号按学校财务系统填写，各年可以相同。${p.end_rule === 'carry' ? '上一年的卡结清后，结余按科目自动带入本卡。' : ''}开卡后在经费卡页面按科目录入当年下达数。`,
      fields: [
        { name: 'year', label: '年度', type: 'number', value: String(year) },
        { name: 'card_no', label: '经费卡号', value: cs[0]?.card_no ?? '' },
        { name: 'applied', label: '当年申请数（元，选填）', type: 'number', required: false },
        { name: 'start_date', label: '下达日', type: 'date', value: `${year}-01-01` },
        { name: 'cutoff_date', label: '单据截止日', type: 'date', value: prev ? `${year}${day(prev.cutoff_date).slice(4)}` : `${year}-12-31` },
        { name: 'settle_date', label: '结清日（选填，结清前须填写）', type: 'date', required: false, value: prev?.settle_date ? `${year}${day(prev.settle_date).slice(4)}` : '' },
      ],
      run: (v) => rpc('open_card', { project_id: p.id, ...v }),
    };
  };
  const closeAct = (p: FundProject): Act => ({
    title: `结题：${p.name}`, label: '确认结题', danger: true, fields: [],
    hint: '结题后该经费项目不得再修改或开经费卡。各年的经费卡须已全部结清。',
    run: () => rpc('close_fund_project', { id: p.id }),
  });
  // 单据截止日晚于次年 6 月底的在用卡，是按整个项目期限填的
  const spans = (c: Card) => c.status === 'active' && day(c.cutoff_date) > `${c.year + 1}-06-30`;
  const fate = (c: Card) => c.status !== 'settled' ? <Badge tone="ok">在用</Badge>
    : num(c.carried_out) > 0 ? <Badge>已结清，结转 {money(c.carried_out)}</Badge>
    : num(c.recalled) > 0 ? <Badge tone="warn">已结清，回收 {money(c.recalled)}</Badge> : <Badge>已结清</Badge>;

  return (
    <>
      <div className="top"><h2>经费项目</h2>{staff && <button onClick={() => setAct(projectAct())}>新建经费项目</button>}</div>
      <p className="lede">经费项目是学校、国家等渠道批复的项目，记额度和期限。额度不是当年可用的钱：每年申请下来的经费记在项目下当年的经费卡上，支出只与当年的经费卡核对，年底按规则回收或结转。</p>
      <div className="tiles">
        <Tile k="在执行的经费项目" v={String(active.length)} f={`${nowCards.length} 张 ${thisYear} 年的在用经费卡`} />
        <Tile k="额度合计" v={money(sum((p) => num(p.quota), withQuota))} f={withQuota.length < active.length ? `${active.length - withQuota.length} 个项目尚未填写额度` : '各项目批复总数'} />
        <Tile k="历年下达合计" v={money(sum((p) => num(p.granted)))} f={`历年回收 ${money(sum((p) => num(p.recalled)))}`} />
        <Tile k={`${thisYear} 年可用`} v={money(nowCards.reduce((s, c) => s + num(c.avail), 0))} tone={nowCards.reduce((s, c) => s + num(c.avail), 0) < 0 ? 'bad' : ''} f="当年经费卡的下达数 − 承诺 − 决算" />
      </div>

      {shown.length === 0 ? <section className="card"><Empty>暂无经费项目。{staff && '先新建经费项目，再在项目下开当年的经费卡。'}</Empty></section> : shown.map((p) => {
        const cs = cardsOf(p); const rest = left(p); const cur = cs.find((c) => c.year === thisYear);
        const facts = [p.source && FUND_SOURCE[p.source], p.fund_kind && FUND_KIND[p.fund_kind], p.owner_name && `负责人 ${p.owner_name}`, p.template_name, `年底${END_RULE[p.end_rule]}`].filter(Boolean).join(' · ');
        return (
          <section className="card" key={p.id}>
            <h3>{p.name} {p.status === 'closed' ? <Badge>已结题</Badge> : p.period_end && day(p.period_end) < today() ? <Badge tone="warn">已过期限</Badge> : null}
              <span className="h3sub">{facts}</span></h3>
            <table><tbody>
              <tr><th scope="row">额度</th><td>{p.quota != null ? money(p.quota) : <span className="sub2">尚未填写</span>}</td>
                <th scope="row">期限</th><td>{p.period_start || p.period_end ? `${day(p.period_start)} 至 ${day(p.period_end)}` : <span className="sub2">尚未填写</span>}</td></tr>
              <tr><th scope="row">历年下达合计</th><td>{money(p.granted)}{num(p.recalled) > 0 && <span className="sub2"> 其中已回收 {money(p.recalled)}</span>}</td>
                <th scope="row">尚未申请</th><td>{rest == null ? '—' : <span className={rest < 0 ? 'neg' : ''}>{money(rest)}</span>}</td></tr>
              {p.note && <tr><th scope="row">备注</th><td colSpan={3} className="wrap">{p.note}</td></tr>}
            </tbody></table>
            {cs.length === 0 ? <Empty>尚未开出经费卡。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>年度</th><th>经费卡号</th><th className="r">申请数</th><th className="r">下达数</th><th className="r">上年结转</th><th className="r">已用</th><th className="r">可用</th><th>单据截止</th><th>状态</th></tr></thead>
                <tbody>{cs.map((c) => (
                  <tr key={c.card_id}><td>{c.year}</td><td><a className="mono" href={`#/card/${c.card_id}`}>{c.card_no}</a></td>
                    <td className="r">{c.applied != null ? money(c.applied) : '—'}</td><td className="r">{money(num(c.orig) - num(c.carried_in))}</td>
                    <td className="r">{num(c.carried_in) > 0 ? money(c.carried_in) : '—'}</td><td className="r">{money(num(c.actual) + num(c.commit))}</td>
                    <td className={`r ${num(c.avail) < 0 ? 'neg' : ''}`}>{c.status === 'settled' ? '—' : money(c.avail)}</td>
                    <td>{day(c.cutoff_date)}{spans(c) && <> <Badge tone="warn">跨年</Badge></>}</td><td>{fate(c)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
            {cs.some(spans) && <p className="hint">标有「跨年」的经费卡，单据截止日晚于其年度的次年 6 月底，是按整个项目期限填写的。经费卡只记当年的经费：请将单据截止日和结清日改到当年，下达数改为当年实际下来的数，以后各年另开经费卡。</p>}
            {p.status === 'active' && !cur && cs.length > 0 && <p className="hint">{thisYear} 年的经费卡尚未开出，当年无可用经费。</p>}
            {staff && p.status === 'active' && (
              <div className="actions" style={{ justifyContent: 'flex-start' }}>
                <button className="sm" onClick={() => setAct(openAct(p))}>开经费卡</button>
                <button className="sm ghost" onClick={() => setAct(projectAct(p))}>修改</button>
                {cs.length > 0 && cs.every((c) => c.status === 'settled') && <button className="sm ghost" onClick={() => setAct(closeAct(p))}>结题</button>}
              </div>
            )}
          </section>
        );
      })}
      {projects.length > active.length && <p className="hint"><button className="sm ghost" onClick={() => setShowClosed(!showClosed)}>{showClosed ? '只看在执行的' : `显示已结题的 ${projects.length - active.length} 个`}</button></p>}

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
