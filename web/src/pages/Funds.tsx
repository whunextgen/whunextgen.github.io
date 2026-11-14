import { useState } from 'react';
import { rpc, useViews, type Card, type FundProject, type Me, type Template, type User } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, FUND_KIND, FUND_SOURCE, Loading, ROLE, Tile, can, cardGranted, cardTotal, day, money, num, today, type Field } from '../ui';

interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 项目：学校、国家等渠道批下来的，记额度和期限。每年申请下来的经费是项目下当年的一张经费卡，当年能用多少只看当年的卡。
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
  // 由经费卡自动生成的占位不算项目：它名下的卡列在「尚未归入项目的经费卡」里
  const pending = data.projects.filter((p) => p.auto);
  const loose = pending.flatMap((p) => cardsOf(p).map((c) => ({ p, c }))).sort((a, b) => a.c.card_no.localeCompare(b.c.card_no));
  const projects = data.projects.filter((p) => !p.auto).sort((a, b) => a.status.localeCompare(b.status) || (a.period_end ?? '9').localeCompare(b.period_end ?? '9') || a.name.localeCompare(b.name, 'zh'));
  const active = projects.filter((p) => p.status === 'active');
  const shown = showClosed ? projects : active;
  const withQuota = active.filter((p) => p.quota != null);
  const sum = (f: (p: FundProject) => number, ps = active) => ps.reduce((s, p) => s + f(p), 0);
  const realIds = new Set(projects.map((p) => p.id));
  const nowCards = data.cards.filter((c) => c.year === thisYear && c.status === 'active' && realIds.has(c.project_id));

  const projectAct = (p?: FundProject): Act => ({
    title: !p ? '新建项目' : p.auto ? `据经费卡新建项目：${p.name}` : `修改项目：${p.name}`, label: p && !p.auto ? '保存' : '新建',
    hint: '额度为该项目批复的总数，期限为项目起止日期，均按任务书或合同填写；经费卡的年度可以在期限之外，页面会给出提示。每年实际申请下来的经费另在项目下开当年的经费卡。',
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
    const year = cs.length > 0 && !cs.some((c) => c.year === thisYear) ? Math.max(cs[0].year + 1, thisYear) : thisYear;
    const prev = cs.find((c) => c.year === year - 1);
    return {
      title: `开经费卡：${p.name}`, label: '开卡',
      hint: `经费卡记项目某一年度申请下来的经费。同一年度可开多张（如直接费、间接费各一张），各自填写名称；卡号按学校财务系统填写，同一年度内不得重复，各年可以相同。${p.end_rule === 'carry' ? '上一年的卡结清后，结余按科目自动带入下一年同卡号的卡。' : ''}当年下达数按下达通知填写；开卡后在经费卡页面把下达数按学校科目分到明细。`,
      fields: [
        { name: 'year', label: '年度', type: 'number', value: String(year) },
        { name: 'card_no', label: '经费卡号', value: '' },
        { name: 'name', label: '经费卡名称（选填，留空则与项目同名）', required: false, value: '' },
        { name: 'applied', label: '当年申请数（元，选填）', type: 'number', required: false },
        { name: 'granted', label: '当年下达数（元，选填；按下达通知填写）', type: 'number', required: false },
        { name: 'start_date', label: '下达日', type: 'date', value: `${year}-01-01` },
        { name: 'cutoff_date', label: '单据截止日', type: 'date', value: prev ? `${year}${day(prev.cutoff_date).slice(4)}` : `${year}-12-31` },
        { name: 'settle_date', label: '结清日（选填，结清前须填写）', type: 'date', required: false, value: prev?.settle_date ? `${year}${day(prev.settle_date).slice(4)}` : '' },
      ],
      run: async ({ granted, ...v }) => { const id = await rpc('open_card', { project_id: p.id, ...v }); if (granted) await rpc('set_card_granted', { card_id: id, granted }); },
    };
  };
  // 把一张卡归到已有的项目下：科目模板相同的项目才可选
  const moveAct = (c: Card): Act => {
    const targets = active.filter((t) => t.id !== c.project_id && t.template_id === c.template_id);
    return {
      title: `归入项目：${c.card_no} · ${c.year} 年`, label: '归入',
      hint: targets.length === 0 ? '暂无可归入的项目：须先新建项目，且其科目模板与该经费卡相同。'
        : '归入后该经费卡成为所选项目该年度的经费卡之一，负责人和经费性质随项目，名称保留。卡上的预算、支出和入账记录不变。',
      fields: targets.length === 0 ? [] : [{ name: 'project_id', label: '项目', options: targets.map((t): [string, string] => [t.id, t.name]) }],
      run: (v) => (targets.length === 0 ? Promise.resolve() : rpc('move_card', { card_id: c.card_id, project_id: v.project_id })),
    };
  };
  // 开错的卡、建错的项目可以删：只限还没有预算、支出和记录的，由后台把关
  const blank = (c: Card) => c.status === 'active' && num(c.orig) === 0 && num(c.actual) === 0 && num(c.commit) === 0;
  const delCardAct = (c: Card): Act => ({
    title: `删除经费卡：${c.card_no} · ${c.year} 年`, label: '删除', danger: true, fields: [],
    hint: `${c.name}。仅尚未录入预算、没有支出和其他记录的经费卡可以删除，删除后不可恢复。`,
    run: () => rpc('delete_card', { card_id: c.card_id }),
  });
  const delProjectAct = (p: FundProject): Act => ({
    title: `删除项目：${p.name}`, label: '删除', danger: true, fields: [],
    hint: '该项目下没有经费卡，可以删除。删除后不可恢复。',
    run: () => rpc('delete_fund_project', { id: p.id }),
  });
  const closeAct = (p: FundProject): Act => ({
    title: `结题：${p.name}`, label: '确认结题', danger: true, fields: [],
    hint: '结题后该项目不得再修改或开经费卡。各年的经费卡须已全部结清。',
    run: () => rpc('close_fund_project', { id: p.id }),
  });
  // 单据截止日晚于次年 6 月底的在用卡，是按整个项目期限填的
  const spans = (c: Card) => c.status === 'active' && day(c.cutoff_date) > `${c.year + 1}-06-30`;
  // 年度在项目期限之外的经费卡：不拦截，只作提示
  const outOf = (p: FundProject, c: Card) => (p.period_start != null && c.year < Number(day(p.period_start).slice(0, 4))) || (p.period_end != null && c.year > Number(day(p.period_end).slice(0, 4)));
  const fate = (c: Card) => c.status !== 'settled' ? <Badge tone="ok">在用</Badge>
    : num(c.carried_out) > 0 ? <Badge>已结清，结转 {money(c.carried_out)}</Badge>
    : num(c.recalled) > 0 ? <Badge tone="warn">已结清，回收 {money(c.recalled)}</Badge> : <Badge>已结清</Badge>;

  return (
    <>
      <div className="top"><h2>项目管理</h2>{staff && <button onClick={() => setAct(projectAct())}>新建项目</button>}</div>
      <p className="lede">项目指学校、国家等渠道批复下来的经费来源，记额度和期限。额度不是当年可用的钱：每年申请下来的经费记在项目下当年的经费卡上，支出只与当年的经费卡核对，年底按规则回收或结转。</p>
      <div className="tiles">
        <Tile k="在执行的项目" v={String(active.length)} f={loose.length > 0 ? `另有 ${loose.length} 张经费卡尚未归入项目` : `${nowCards.length} 张 ${thisYear} 年的在用经费卡`} tone={loose.length > 0 ? 'warn' : ''} />
        <Tile k="额度合计" v={money(sum((p) => num(p.quota), withQuota))} f={withQuota.length < active.length ? `${active.length - withQuota.length} 个项目尚未填写额度` : '各项目批复总数'} />
        <Tile k="历年下达合计" v={money(sum((p) => num(p.granted)))} f={`历年回收 ${money(sum((p) => num(p.recalled)))}`} />
        <Tile k={`${thisYear} 年可用`} v={money(nowCards.reduce((s, c) => s + num(c.avail), 0))} tone={nowCards.reduce((s, c) => s + num(c.avail), 0) < 0 ? 'bad' : ''} f="当年经费卡的下达数 − 承诺 − 决算" />
      </div>

      {loose.length > 0 && (
        <section className="card">
          <h3>尚未归入项目的经费卡 <Badge tone="warn">{loose.length} 张</Badge></h3>
          <p className="hint">这些是此前直接登记的经费卡，还没有对应的项目。先确定它属于哪个项目：属于已建项目的，归入该项目；项目尚未建立的，据此新建项目并补全来源渠道、额度和期限。几张卡属于同一个项目的，先据其中一张新建项目，再把其余的归入。</p>
          <div className="scroll"><table>
            <thead><tr><th>经费卡号</th><th>名称</th><th>年度</th><th className="r">现行预算</th><th className="r">已用</th><th>下达日</th><th>单据截止</th><th /></tr></thead>
            <tbody>{loose.map(({ p, c }) => (
              <tr key={c.card_id}><td><a className="mono" href={`#/card/${c.card_id}`}>{c.card_no}</a></td><td>{c.name}</td><td>{c.year}</td>
                <td className="r">{money(c.cur)}</td><td className="r">{money(num(c.actual) + num(c.commit))}</td><td>{day(c.start_date)}</td>
                <td>{day(c.cutoff_date)}{spans(c) && <> <Badge tone="warn">跨年</Badge></>}</td>
                <td><div className="acts">{staff && c.status === 'active' && <>
                  <button className="sm" onClick={() => setAct(moveAct(c))}>归入项目</button>
                  <button className="sm ghost" onClick={() => setAct(projectAct(p))}>据此新建项目</button>
                  {blank(c) && <button className="sm ghost" onClick={() => setAct(delCardAct(c))}>删除</button>}</>}</div></td></tr>
            ))}</tbody>
          </table></div>
          {loose.some(({ c }) => spans(c)) && <p className="hint">标有「跨年」的经费卡，单据截止日是按整个项目期限填写的。归入项目后，请将单据截止日和结清日改到当年，下达数改为当年实际下来的数。</p>}
        </section>
      )}
      {shown.length === 0 ? <section className="card"><Empty>暂无项目。{staff && (loose.length > 0 ? '请先新建项目，再把上面的经费卡归入。' : '先新建项目，再在项目下开当年的经费卡。')}</Empty></section> : shown.map((p) => {
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
                <thead><tr><th>年度</th><th>经费卡号</th><th>名称</th><th className="r">申请数</th><th className="r">下达数</th><th className="r">上年结转</th><th className="r">已用</th><th className="r">可用</th><th>单据截止</th><th>状态</th>{staff && <th />}</tr></thead>
                <tbody>{cs.map((c) => (
                  <tr key={c.card_id}><td>{c.year}{outOf(p, c) && <> <Badge tone="warn">期限外</Badge></>}</td><td><a className="mono" href={`#/card/${c.card_id}`}>{c.card_no}</a></td><td>{c.name === p.name ? <span className="sub2">同项目</span> : c.name}</td>
                    <td className="r">{c.applied != null ? money(c.applied) : '—'}</td><td className="r">{money(cardGranted(c))}{cardTotal(c) - num(c.cur) >= 0.005 && <div className="sub2" style={{ marginLeft: 0 }}>未分到科目 {money(cardTotal(c) - num(c.cur))}</div>}</td>
                    <td className="r">{num(c.carried_in) > 0 ? money(c.carried_in) : '—'}</td><td className="r">{money(num(c.actual) + num(c.commit))}</td>
                    <td className={`r ${num(c.avail) < 0 ? 'neg' : ''}`}>{c.status === 'settled' ? '—' : money(c.avail)}</td>
                    <td>{day(c.cutoff_date)}{spans(c) && <> <Badge tone="warn">跨年</Badge></>}</td><td>{fate(c)}</td>
                    {staff && <td><div className="acts">{c.status === 'active' && p.status === 'active' && <button className="sm ghost" onClick={() => setAct(moveAct(c))}>改归属</button>}
                      {blank(c) && <button className="sm ghost" onClick={() => setAct(delCardAct(c))}>删除</button>}</div></td>}</tr>
                ))}</tbody>
              </table></div>
            )}
            {cs.some(spans) && <p className="hint">标有「跨年」的经费卡，单据截止日晚于其年度的次年 6 月底，是按整个项目期限填写的。经费卡只记当年的经费：请将单据截止日和结清日改到当年，下达数改为当年实际下来的数，以后各年另开经费卡。</p>}
            {cs.some((c) => outOf(p, c)) && <p className="hint">标有「期限外」的经费卡，其年度不在项目期限之内。项目如已延期，请修改项目期限；否则请核对该经费卡的年度。</p>}
            {p.status === 'active' && !cur && cs.length > 0 && <p className="hint">{thisYear} 年的经费卡尚未开出，当年无可用经费。</p>}
            {staff && p.status === 'active' && (
              <div className="actions" style={{ justifyContent: 'flex-start' }}>
                <button className="sm" onClick={() => setAct(openAct(p))}>开经费卡</button>
                <button className="sm ghost" onClick={() => setAct(projectAct(p))}>修改</button>
                {cs.length === 0 && <button className="sm ghost" onClick={() => setAct(delProjectAct(p))}>删除</button>}
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
