import { useState } from 'react';
import { Track, execSegs, type Seg } from '../tree';
import { rpc, useViews, type Card, type FundProject, type Me, type Template, type User } from '../api';
import { ActionDialog, Badge, CLOSE_RULE, Empty, END_RULE, FUND_KIND, FUND_SOURCE, Loading, ROLE, Tile, can, cardGap, cardGranted, day, money, num, pct, today, type Field } from '../ui';

interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 项目：学校、国家等渠道批下来的，记额度和期限。每次下达的经费是项目下的一张经费卡，经费卡可以跨年度使用，到期后按到期处理回收或结转；结余上缴按项目办，在项目结束时处理。
// only 给出时是单个项目的详情页（#/fund/<id>），否则是项目管理的列表
export function Funds({ me, only }: { me: Me; only?: string }) {
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
  const one = only ? data.projects.find((p) => p.id === only && !p.auto) : undefined;
  const shown = only ? (one ? [one] : []) : showClosed ? projects : active;
  const withQuota = active.filter((p) => p.quota != null);
  const sum = (f: (p: FundProject) => number, ps = active) => ps.reduce((s, p) => s + f(p), 0);
  const realIds = new Set(projects.map((p) => p.id));
  // 有效期内的经费卡：在用，且今天不晚于单据截止日
  const live = (c: Card) => c.status === 'active' && day(c.cutoff_date) >= today();
  const nowCards = data.cards.filter((c) => live(c) && realIds.has(c.project_id));

  const projectAct = (p?: FundProject): Act => ({
    title: !p ? '新建项目' : p.auto ? `据经费卡新建项目：${p.name}` : `修改项目：${p.name}`, label: p && !p.auto ? '保存' : '新建',
    hint: '经费卡到期处理两种：到期回收，结余由学校收回，回到项目的额度剩余，可重新申请；结转，结余带入下一张经费卡。项目结束处理选结余上缴的（如财政项目），结题时额度剩余记为上缴数。额度为该项目批复的总数，期限为项目起止日期，均按任务书或合同填写；经费卡的下达年度可以在期限之外，页面会给出提示。每次实际下达的经费另在项目下开经费卡。',
    fields: [
      { name: 'name', label: '项目名称', value: p?.name },
      { name: 'source', label: '来源渠道（选填）', options: Object.entries(FUND_SOURCE), required: false, value: p?.source ?? '' },
      { name: 'fund_kind', label: '经费性质（选填）', options: Object.entries(FUND_KIND), required: false, value: p?.fund_kind ?? '' },
      { name: 'owner_id', label: '负责人（选填）', options: owners, required: false, value: p?.owner_id ?? '' },
      { name: 'quota', label: '额度（元，选填；未填时不校验下达合计）', type: 'number', required: false, value: p?.quota != null ? String(num(p.quota)) : '' },
      { name: 'period_start', label: '期限开始（选填）', type: 'date', required: false, value: p?.period_start ? day(p.period_start) : '' },
      { name: 'period_end', label: '期限结束（选填）', type: 'date', required: false, value: p?.period_end ? day(p.period_end) : '' },
      { name: 'template_id', label: '科目模板', options: tplOpts, value: p?.template_id },
      { name: 'end_rule', label: '经费卡到期处理（经费卡到期后结余的去向，各经费卡默认按此）', options: Object.entries(END_RULE), value: p?.end_rule ?? 'recall' },
      { name: 'close_rule', label: '项目结束处理（项目结束时结余的处理）', options: Object.entries(CLOSE_RULE), value: p?.close_rule ?? 'none' },
      { name: 'note', label: '备注（选填）', required: false, value: p?.note ?? '' },
    ],
    run: async ({ close_rule, ...v }) => {
      const id = await rpc('save_fund_project', { id: p?.id ?? null, ...v }) as string;
      await rpc('set_project_close_rule', { id: p?.id ?? id, rule: close_rule });
    },
  });
  const openAct = (p: FundProject): Act => {
    const cs = cardsOf(p);
    const year = cs.length > 0 && !cs.some((c) => c.year === thisYear) ? Math.max(cs[0].year + 1, thisYear) : thisYear;
    const prev = cs.find((c) => c.year === year - 1);
    return {
      title: `开经费卡：${p.name}`, label: '开卡',
      hint: `经费卡记项目某次下达的经费，可以跨年度使用，到单据截止日为止。同一年度可开多张（如直接费、间接费各一张），各自填写名称；卡号按学校财务系统填写，同一下达年度内不得重复。${p.end_rule === 'carry' ? '前一张卡结清后，结余自动带入下达年度更晚的同卡号经费卡。' : ''}下达数可在导入学校明细账时按收入明细自动得出，也可按下达通知填写。`,
      fields: [
        { name: 'year', label: '下达年度', type: 'number', value: String(year) },
        { name: 'card_no', label: '经费卡号', value: '' },
        { name: 'name', label: '经费卡名称（选填，留空则与项目同名）', required: false, value: '' },
        { name: 'applied', label: '申请数（元，选填）', type: 'number', required: false },
        { name: 'granted', label: '下达数（元，选填；按下达通知填写）', type: 'number', required: false },
        { name: 'start_date', label: '下达日', type: 'date', value: `${year}-01-01` },
        { name: 'cutoff_date', label: '单据截止日（经费卡有效期至此，可跨年度）', type: 'date', value: prev ? `${year}${day(prev.cutoff_date).slice(4)}` : `${year}-12-31` },
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
  // 年度在项目期限之外的经费卡：不拦截，只作提示
  const outOf = (p: FundProject, c: Card) => (p.period_start != null && c.year < Number(day(p.period_start).slice(0, 4))) || (p.period_end != null && c.year > Number(day(p.period_end).slice(0, 4)));
  const fate = (c: Card) => c.status !== 'settled' ? <Badge tone="ok">在用</Badge>
    : num(c.carried_out) > 0 ? <Badge>已结清，结转 {money(c.carried_out)}</Badge>
    : num(c.recalled) > 0 ? <Badge tone="warn">已结清，回收 {money(c.recalled)}</Badge> : <Badge>已结清</Badge>;

  // ---------- 单个项目的详情页 ----------
  if (only) {
    const dialog = act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
      onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />;
    const p = one;
    if (!p) return <><p className="hint"><a href="#/funds">项目管理</a> › 项目</p><section className="card"><Empty>未找到该项目，或无权查看。</Empty></section></>;
    const now = today();
    const cs = data.cards.filter((c) => c.project_id === p.id).sort((a, b) => b.year - a.year || a.card_no.localeCompare(b.card_no));
    const quota = p.quota != null ? num(p.quota) : null; const granted = num(p.granted); const rest = left(p);
    const liveCs = cs.filter(live); const due = cs.filter((c) => c.status === 'active' && day(c.cutoff_date) < now); const settled = cs.filter((c) => c.status === 'settled');
    const avail = liveCs.reduce((t, c) => t + num(c.avail), 0);
    const actual = cs.reduce((t, c) => t + num(c.actual), 0); const commit = cs.filter((c) => c.status === 'active').reduce((t, c) => t + num(c.commit), 0);
    const issued = cs.reduce((t, c) => t + cardGranted(c), 0);
    const back = settled.filter((c) => c.end_rule === 'recall').reduce((t, c) => t + num(c.recalled ?? 0), 0);
    const carried = settled.reduce((t, c) => t + num(c.carried_out ?? 0), 0);
    const big = (x: number) => { const [a, d] = money(x).split('.'); return <>{a}<small>.{d}</small></>; };
    // 额度构成：各经费卡占用（到期回收的结余已扣除）与额度剩余
    const segs: Seg[] = [...cs].reverse().map((c, i) => { const g = cardGranted(c) - (c.status === 'settled' && c.end_rule === 'recall' ? num(c.recalled ?? 0) : 0);
      return { cls: `${i % 2 ? 'sy1' : 'sy0'} big`, value: g, text: `${c.year} 年 ${c.card_no}`, tip: `${c.year} 年下达的经费卡 ${c.card_no}${c.name === p.name ? '' : `（${c.name}）`}占用额度 ${money(g)}${quota ? `，占额度 ${pct(g, quota)}` : ''}` }; });
    if (quota != null && quota > granted) segs.push({ cls: 'hatch big', value: quota - granted, text: `额度剩余 ${pct(quota - granted, quota)}`, tip: `额度剩余 ${money(quota - granted)}，占额度 ${pct(quota - granted, quota)}；尚未下达，不是可用经费` });
    // 流程：立项 → 下达 → 执行 → 到期处理 → 结题。当前所在环节加重显示
    const at = p.status === 'closed' ? 5 : cs.length === 0 ? 2 : liveCs.length > 0 ? 3 : due.length > 0 ? 4 : 5;
    const stages = [
      { nm: '立项', ds: '批复额度和期限', v: quota != null ? money(quota) : '尚未填写', f: p.period_start || p.period_end ? `${day(p.period_start)} 至 ${day(p.period_end)}` : '期限尚未填写' },
      { nm: '下达', ds: '每次下达开一张经费卡', v: `${cs.length} 张`, f: cs.length > 0 ? `历年下达 ${money(issued)}` : '尚未开出经费卡' },
      { nm: '执行', ds: '以学校明细账的入账为准', v: money(actual), f: `已入账；有效期内 ${liveCs.length} 张，可用 ${money(avail)}` },
      { nm: '到期处理', ds: `经费卡到期后${END_RULE[p.end_rule]}`, v: `${settled.length} 张已结清`, f: [due.length > 0 && `${due.length} 张已到期待结清`, back > 0 && `回收 ${money(back)}，回到额度剩余`, carried > 0 && `结转 ${money(carried)}`].filter(Boolean).join('；') || '暂无到期的经费卡' },
      { nm: '结题', ds: p.close_rule === 'return' ? '项目结束时结余上缴' : '项目结束时无须上缴', v: p.status === 'closed' ? '已结题' : '未结题', f: p.returned != null ? `上缴 ${money(p.returned)}` : p.status === 'closed' ? '' : '经费卡全部结清后可结题' },
    ];
    const timeOf = (c: Card) => { const a = Date.parse(day(c.start_date)), b = Date.parse(day(c.cutoff_date)); return b > a ? Math.min(1, Math.max(0, (Date.parse(now) - a) / (b - a))) : undefined; };
    return (
      <div className="wb">
        <p className="hint" style={{ margin: 0 }}><a href="#/funds">项目管理</a> › {p.name}</p>
        <div className="wb-hero">
          <div>
            <div className="eyebrow">项目{p.source ? ` · ${FUND_SOURCE[p.source]}` : ''}{p.fund_kind ? ` · ${FUND_KIND[p.fund_kind]}` : ''}{p.owner_name ? ` · 负责人 ${p.owner_name}` : ''}</div>
            <h2 style={{ margin: '6px 0 0' }}>{p.name} {p.status === 'closed' ? <Badge>已结题</Badge> : p.period_end && day(p.period_end) < now ? <Badge tone="warn">已过期限</Badge> : null}</h2>
            {rest != null
              ? <h1><small>额度剩余</small><em className={rest < 0 ? 'neg' : ''}>{big(rest)}</em> 元</h1>
              : <h1><small>有效期内可用</small><em className={avail < 0 ? 'neg' : ''}>{big(avail)}</em> 元</h1>}
          </div>
          <div>
            {segs.length > 0 ? <Track cap={quota != null ? '额度构成 · 各经费卡占用与额度剩余（到期回收的结余已扣除）' : '各经费卡已下达 · 额度尚未填写'} segs={segs} /> : <Empty>尚未开出经费卡。</Empty>}
            <div className="wb-facts">
              <span>额度<b>{quota != null ? money(quota) : '尚未填写'}</b></span><span>占用额度<b>{money(granted)}</b></span>
              <span>有效期内可用<b>{money(avail)}</b></span><span>历年已入账<b>{money(actual)}</b></span>{commit > 0 && <span>已承诺<b>{money(commit)}</b></span>}
              {back > 0 && <span>到期回收<b>{money(back)}</b></span>}
            </div>
          </div>
        </div>

        <section className="wb-sec">
          <div className="wb-sh"><span className="no">01</span><h2>流程</h2><span className="path">立项 › 下达 › 执行 › 到期处理 › 结题</span></div>
          <div className="flowline" aria-label="项目流程">
            {stages.map((g, i) => (
              <div key={g.nm} className={`stage still${i + 1 === at ? ' on' : i + 1 < at ? ' done' : ''}`} aria-current={i + 1 === at ? 'step' : undefined}>
                <span className="no">0{i + 1}</span><span className="nm">{g.nm}</span><span className="ds">{g.ds}</span><span className="v">{g.v}</span><span className="f">{g.f}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="wb-sec">
          <div className="wb-sh"><span className="no">02</span><h2>经费卡</h2>{staff && p.status === 'active' ? <button onClick={() => setAct(openAct(p))} style={{ marginLeft: 'auto' }}>开经费卡</button> : <span className="path">{cs.length} 张</span>}</div>
          <div className="wb-key"><span><i className="sa" />已入账</span><span><i className="sc" />已承诺</span><span><i className="sr" />可用</span></div>
          {cs.length === 0 ? <Empty>尚未开出经费卡。</Empty> : (
            <div className="scroll"><table className="wb-table">
              <thead><tr><th>下达年度</th><th>经费卡号</th><th>名称</th><th className="r">下达数</th><th className="r">结转转入</th><th style={{ minWidth: 220 }}>执行</th><th className="r">可用</th><th>有效期</th><th>状态</th>{staff && <th />}</tr></thead>
              <tbody>{cs.map((c) => { const total = num(c.cur); return (
                <tr key={c.card_id}><td>{c.year}{outOf(p, c) && <> <Badge tone="warn">期限外</Badge></>}</td><td><a className="mono" href={`#/card/${c.card_id}`}>{c.card_no}</a></td><td>{c.name === p.name ? <span className="sub2">同项目</span> : c.name}</td>
                  <td className="r">{money(cardGranted(c))}{c.applied != null && <div className="sub2" style={{ marginLeft: 0 }}>申请 {money(c.applied)}</div>}</td>
                  <td className="r">{num(c.carried_in) > 0 ? money(c.carried_in) : '—'}</td>
                  <td>{total > 0 ? <Track segs={execSegs(total, num(c.actual), num(c.commit), '下达数')} mark={c.status === 'active' ? timeOf(c) : undefined} /> : <span className="sub2">尚未下达</span>}</td>
                  <td className={`r ${num(c.avail) < 0 ? 'neg' : ''}`}>{c.status === 'settled' ? '—' : money(c.avail)}</td>
                  <td>{day(c.start_date)} 至 {day(c.cutoff_date)}{c.status === 'active' && day(c.cutoff_date) < now && <> <Badge tone="warn">已到期</Badge></>}</td><td>{fate(c)}</td>
                  {staff && <td><div className="acts">{c.status === 'active' && p.status === 'active' && <button className="sm ghost" onClick={() => setAct(moveAct(c))}>改归属</button>}
                    {blank(c) && <button className="sm ghost" onClick={() => setAct(delCardAct(c))}>删除</button>}</div></td>}</tr>); })}</tbody>
            </table></div>
          )}
          {cs.some((c) => outOf(p, c)) && <p className="hint">标有「期限外」的经费卡，其下达年度不在项目期限之内。项目如已延期，请修改项目期限；否则请核对该经费卡的下达年度。</p>}
          {p.status === 'active' && liveCs.length === 0 && cs.length > 0 && <p className="hint">该项目当前没有在有效期内的经费卡，无可用经费。</p>}
        </section>

        <section className="wb-sec">
          <div className="wb-sh"><span className="no">03</span><h2>项目信息</h2></div>
          <table><tbody>
            <tr><th scope="row">来源渠道</th><td>{p.source ? FUND_SOURCE[p.source] : <span className="sub2">尚未填写</span>}</td>
              <th scope="row">经费性质</th><td>{p.fund_kind ? FUND_KIND[p.fund_kind] : <span className="sub2">尚未填写</span>}</td></tr>
            <tr><th scope="row">负责人</th><td>{p.owner_name ?? <span className="sub2">尚未填写</span>}</td>
              <th scope="row">科目模板</th><td>{p.template_name}</td></tr>
            <tr><th scope="row">额度</th><td>{quota != null ? money(quota) : <span className="sub2">尚未填写</span>}</td>
              <th scope="row">期限</th><td>{p.period_start || p.period_end ? `${day(p.period_start)} 至 ${day(p.period_end)}` : <span className="sub2">尚未填写</span>}</td></tr>
            <tr><th scope="row">经费卡到期处理</th><td>{END_RULE[p.end_rule]}<span className="sub2"> {p.end_rule === 'carry' ? '结余带入更晚的同卡号经费卡' : '结余回到额度剩余，可重新申请'}</span></td>
              <th scope="row">项目结束处理</th><td>{CLOSE_RULE[p.close_rule] ?? CLOSE_RULE.none}</td></tr>
            {p.note && <tr><th scope="row">备注</th><td colSpan={3} className="wrap">{p.note}</td></tr>}
          </tbody></table>
          {staff && p.status === 'active' && (
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button className="sm ghost" onClick={() => setAct(projectAct(p))}>修改</button>
              {cs.length === 0 && <button className="sm ghost" onClick={() => setAct({ ...delProjectAct(p), run: () => delProjectAct(p).run({}).then(() => { location.hash = '#/funds'; }) })}>删除</button>}
              {cs.length > 0 && cs.every((c) => c.status === 'settled') && <button className="sm ghost" onClick={() => setAct(closeAct(p))}>结题</button>}
            </div>
          )}
        </section>
        {dialog}
      </div>
    );
  }

  return (
    <>
      <div className="top"><h2>项目管理</h2>{staff && <button onClick={() => setAct(projectAct())}>新建项目</button>}</div>
      <p className="lede">项目指学校、国家等渠道批复下来的经费来源，记额度和期限。额度不是可直接使用的钱：每次下达的经费记在项目下的经费卡上，经费卡可以跨年度使用，支出只与有效期内的经费卡核对；经费卡到期后，结余按到期处理回收、上缴或结转。</p>
      <div className="tiles">
        <Tile k="在执行的项目" v={String(active.length)} f={loose.length > 0 ? `另有 ${loose.length} 张经费卡尚未归入项目` : `${nowCards.length} 张有效期内的经费卡`} tone={loose.length > 0 ? 'warn' : ''} />
        <Tile k="额度合计" v={money(sum((p) => num(p.quota), withQuota))} f={withQuota.length < active.length ? `${active.length - withQuota.length} 个项目尚未填写额度` : '各项目批复总数'} />
        <Tile k="占用额度合计" v={money(sum((p) => num(p.granted)))} f="各经费卡下达数合计，已扣除到期回收的结余" />
        <Tile k="有效期内可用" v={money(nowCards.reduce((s, c) => s + num(c.avail), 0))} tone={nowCards.reduce((s, c) => s + num(c.avail), 0) < 0 ? 'bad' : ''} f="有效期内经费卡的下达数 − 承诺 − 决算" />
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
                <td>{day(c.cutoff_date)}</td>
                <td><div className="acts">{staff && c.status === 'active' && <>
                  <button className="sm" onClick={() => setAct(moveAct(c))}>归入项目</button>
                  <button className="sm ghost" onClick={() => setAct(projectAct(p))}>据此新建项目</button>
                  {blank(c) && <button className="sm ghost" onClick={() => setAct(delCardAct(c))}>删除</button>}</>}</div></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      {shown.length === 0 ? <section className="card"><Empty>暂无项目。{staff && (loose.length > 0 ? '请先新建项目，再把上面的经费卡归入。' : '先新建项目，再在项目下开经费卡。')}</Empty></section> : shown.map((p) => {
        const cs = cardsOf(p); const rest = left(p); const cur = cs.find(live);
        // 已结清的卡：到期回收的结余回到额度剩余
        const back = cs.filter((c) => c.status === 'settled' && c.end_rule === 'recall').reduce((t, c) => t + num(c.recalled ?? 0), 0);
        const facts = [p.source && FUND_SOURCE[p.source], p.fund_kind && FUND_KIND[p.fund_kind], p.owner_name && `负责人 ${p.owner_name}`, p.template_name, `经费卡到期处理：${END_RULE[p.end_rule]}`, p.close_rule === 'return' && '项目结束时结余上缴'].filter(Boolean).join(' · ');
        return (
          <section className="card" key={p.id}>
            <h3><a href={`#/fund/${p.id}`}>{p.name}</a> {p.status === 'closed' ? <Badge>已结题</Badge> : p.period_end && day(p.period_end) < today() ? <Badge tone="warn">已过期限</Badge> : null}
              <span className="h3sub">{facts}</span></h3>
            <table><tbody>
              <tr><th scope="row">额度</th><td>{p.quota != null ? money(p.quota) : <span className="sub2">尚未填写</span>}</td>
                <th scope="row">期限</th><td>{p.period_start || p.period_end ? `${day(p.period_start)} 至 ${day(p.period_end)}` : <span className="sub2">尚未填写</span>}</td></tr>
              <tr><th scope="row">占用额度</th><td>{money(p.granted)}{back > 0 && <span className="sub2"> 历年下达 {money(num(p.granted) + back)}；到期回收 {money(back)}，回到额度剩余</span>}</td>
                <th scope="row">额度剩余</th><td>{rest == null ? '—' : <span className={rest < 0 ? 'neg' : ''}>{money(rest)}</span>}{p.returned != null ? <span className="sub2"> 结题时上缴 {money(p.returned)}</span> : p.close_rule === 'return' && rest != null && <span className="sub2"> 项目结束时结余上缴</span>}</td></tr>
              {p.note && <tr><th scope="row">备注</th><td colSpan={3} className="wrap">{p.note}</td></tr>}
            </tbody></table>
            {cs.length === 0 ? <Empty>尚未开出经费卡。</Empty> : (
              <div className="scroll"><table>
                <thead><tr><th>下达年度</th><th>经费卡号</th><th>名称</th><th className="r">申请数</th><th className="r">下达数</th><th className="r">上年结转</th><th className="r">已用</th><th className="r">可用</th><th>单据截止</th><th>状态</th>{staff && <th />}</tr></thead>
                <tbody>{cs.map((c) => (
                  <tr key={c.card_id}><td>{c.year}{outOf(p, c) && <> <Badge tone="warn">期限外</Badge></>}</td><td><a className="mono" href={`#/card/${c.card_id}`}>{c.card_no}</a></td><td>{c.name === p.name ? <span className="sub2">同项目</span> : c.name}</td>
                    <td className="r">{c.applied != null ? money(c.applied) : '—'}</td><td className="r">{money(cardGranted(c))}{cardGap(c) >= 0.005 && <div className="sub2" style={{ marginLeft: 0 }}>未分到科目 {money(cardGap(c))}</div>}</td>
                    <td className="r">{num(c.carried_in) > 0 ? money(c.carried_in) : '—'}</td><td className="r">{money(num(c.actual) + num(c.commit))}</td>
                    <td className={`r ${num(c.avail) < 0 ? 'neg' : ''}`}>{c.status === 'settled' ? '—' : money(c.avail)}</td>
                    <td>{day(c.cutoff_date)}{c.status === 'active' && day(c.cutoff_date) < today() && <> <Badge tone="warn">已到期</Badge></>}</td><td>{fate(c)}</td>
                    {staff && <td><div className="acts">{c.status === 'active' && p.status === 'active' && <button className="sm ghost" onClick={() => setAct(moveAct(c))}>改归属</button>}
                      {blank(c) && <button className="sm ghost" onClick={() => setAct(delCardAct(c))}>删除</button>}</div></td>}</tr>
                ))}</tbody>
              </table></div>
            )}
            {cs.some((c) => outOf(p, c)) && <p className="hint">标有「期限外」的经费卡，其年度不在项目期限之内。项目如已延期，请修改项目期限；否则请核对该经费卡的年度。</p>}
            {p.status === 'active' && !cur && cs.length > 0 && <p className="hint">该项目当前没有在有效期内的经费卡，无可用经费。</p>}
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
