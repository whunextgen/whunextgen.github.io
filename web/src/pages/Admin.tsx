import { useState } from 'react';
import { LegacyArchive } from './Legacy';
import { rpc, useViews, type Card, type Emergency, type Me, type Outbox, type Subject, type Template, type TemplateCap, type User, type UserAdmin } from '../api';
import { ActionDialog, Badge, Empty, END_RULE, Loading, ROLE, day, money, num, type Field } from '../ui';

interface Act { label: string; title: string; hint?: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
type Opt = [string, string];

// 经费卡基本信息的输入项；新建和修改共用
export function cardFields(templates: Opt[], owners: Opt[], c?: Card): Field[] {
  return [
    { name: 'card_no', label: '经费卡号', value: c?.card_no },
    { name: 'name', label: '名称', value: c?.name },
    { name: 'template_id', label: '科目模板', options: templates, value: c?.template_id },
    { name: 'owner_id', label: '负责人（可不选）', options: owners, required: false, value: c?.owner_id ?? '' },
    { name: 'start_date', label: '下达日', type: 'date', value: c ? day(c.start_date) : '' },
    { name: 'cutoff_date', label: '单据截止日', type: 'date', value: c ? day(c.cutoff_date) : '' },
    { name: 'settle_date', label: '结清日（跨年不结清的不填）', type: 'date', required: false, value: c?.settle_date ? day(c.settle_date) : '' },
    { name: 'end_rule', label: '到期处理', options: Object.entries(END_RULE), value: c?.end_rule ?? 'recall' },
    { name: 'rule_note', label: '备注（可不填）', required: false, value: c?.rule_note ?? '' },
  ];
}
export const saveCard = (id: string | null, v: Record<string, string>) => rpc('save_card', { id, ...v });

const OUT: Record<string, [string, string]> = { queued: ['排队中', 'warn'], sent: ['已发送', 'ok'], failed: ['未发出', 'bad'], expired: ['已过期', ''] };

export function Admin({ me }: { me: Me }) {
  const director = me.role === 'director';
  const [tab, setTab] = useState<'cards' | 'templates' | 'users' | 'limits' | 'outbox' | 'legacy'>('cards');
  const [tpl, setTpl] = useState('');
  const [act, setAct] = useState<Act | null>(null);
  const { data, error, reload } = useViews<{ cards: Card[]; templates: Template[]; subjects: Subject[]; caps: TemplateCap[]; users: User[];
    admin: UserAdmin[]; limits: Emergency[]; outbox: Outbox[] }>({
    cards: ['card'], templates: ['template'], subjects: ['subject'], caps: ['template_cap'], users: ['users'],
    admin: ['user_admin'], limits: ['emergency'], outbox: ['outbox'],
  });
  if (!data) return <Loading error={error} />;

  const tplOpts = data.templates.map((t): Opt => [t.id, t.name]);
  const owners = data.users.filter((u) => u.active).map((u): Opt => [u.id, `${u.name}（${ROLE[u.role]}）`]);
  const userName = new Map(data.users.map((u) => [u.id, u.name]));
  const cards = [...data.cards].sort((a, b) => a.status.localeCompare(b.status) || a.card_no.localeCompare(b.card_no));
  const t = data.templates.find((x) => x.id === tpl) ?? data.templates[0];
  const subs = data.subjects.filter((s) => s.template_id === t?.id).sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
  const subName = new Map(subs.map((s) => [s.id, s.name]));
  const caps = data.caps.filter((k) => k.template_id === t?.id);
  const year = new Date().getFullYear();
  const btn = (a: Act) => <button key={a.label} className={`sm ghost ${a.danger ? 'danger' : ''}`} onClick={() => setAct(a)}>{a.label}</button>;

  const subjectAct = (s?: Subject): Act => ({
    label: s ? '修改' : '加科目', title: s ? `修改科目：${s.name}` : `给「${t!.name}」加科目`,
    hint: s ? '科目代码定了就不能改，人员费和历史数据按代码对应。' : '代码只用字母、数字和下划线；加上后这个模板下所有卡都会多出这个科目，预算为零。',
    fields: [...(s ? [] : [{ name: 'code', label: '科目代码' } as Field]), { name: 'name', label: '科目名称', value: s?.name },
      { name: 'school_name', label: '学校财务系统里的科目名（可不填）', required: false, value: s?.school_name ?? '' },
      { name: 'sort', label: '排序号', type: 'number', required: false, value: s ? String(s.sort) : '' }],
    run: (v) => rpc('save_subject', { id: s?.id ?? null, template_id: t!.id, code: s?.code ?? v.code, name: v.name, school_name: v.school_name, sort: v.sort ? Math.round(Number(v.sort)) : null }),
  });
  const capAct = (k?: TemplateCap): Act => ({
    label: k ? '修改' : '加比例上限', title: k ? `修改比例上限：${k.name}` : `给「${t!.name}」加比例上限`,
    hint: '所选科目的现行预算合计不得超过卡总预算的这个比例；录预算和做预算变更时检查。',
    fields: [{ name: 'name', label: '规则名称', value: k?.name }, { name: 'ratio', label: '上限（%）', type: 'number', value: k ? String(num(k.max_ratio) * 100) : '' },
      { name: 'subjects', label: '计入的科目', type: 'multi', options: subs.map((s): Opt => [s.id, s.name]), value: (k?.subject_ids ?? []).join(',') }],
    run: (v) => rpc('save_cap', { id: k?.id ?? null, template_id: t!.id, name: v.name, max_ratio: Number(v.ratio) / 100, subject_ids: v.subjects.split(',').filter(Boolean) }),
  });
  const userAct = (u?: UserAdmin): Act => ({
    label: u ? '修改' : '登记用户', title: u ? `修改用户：${u.name}` : '预先登记用户',
    hint: u ? '停用后不能登录，历史记录保留。' : '按企业邮箱登记；本人第一次用飞书登录时，邮箱对得上就自动认领这个账号和角色。',
    fields: [{ name: 'name', label: '姓名', value: u?.name }, { name: 'email', label: u ? '企业邮箱（可不填）' : '企业邮箱', required: !u, value: u?.email ?? '' },
      { name: 'role', label: '角色', options: Object.entries(ROLE), value: u?.role ?? 'member' },
      ...(u ? [{ name: 'active', label: '在用（取消勾选即停用）', type: 'check', value: String(u.active) } as Field] : [])],
    run: (v) => rpc('save_user', { id: u?.id ?? null, name: v.name, email: v.email, role: v.role, active: u ? v.active === 'true' : true }),
  });
  const mergeAct = (u: UserAdmin): Act => ({
    label: '合并', title: `把「${u.name}」并入另一个账号`, danger: true,
    hint: `同一个人有两个账号时用。「${u.name}」名下的卡、申请、额度和记录全部转到保留的账号，然后「${u.name}」停用。两个账号都绑定了飞书的不能合并。合并不能撤销。`,
    fields: [{ name: 'into', label: '保留的账号', options: data.admin.filter((x) => x.id !== u.id && x.active).map((x): Opt => [x.id, `${x.name}${x.email ? ` ${x.email}` : ''}${x.linked ? '（已绑定飞书）' : ''}`]) }],
    run: (v) => rpc('merge_user', { from_id: u.id, into_id: v.into }),
  });
  const limitAct = (l?: Emergency): Act => ({
    label: l ? '修改' : '设置限额', title: '紧急通道限额', hint: '紧急通道的支出不等审批直接计入承诺，事后补批。单笔和全年累计都有上限。',
    fields: [{ name: 'year', label: '年度', type: 'number', value: String(l?.year ?? year) }, { name: 'per_request', label: '单笔上限（元）', type: 'number', value: l ? String(num(l.per_request)) : '' },
      { name: 'per_year', label: '全年额度（元）', type: 'number', value: l ? String(num(l.per_year)) : '' }],
    run: (v) => rpc('set_emergency_limit', { year: Math.round(Number(v.year)), per_request: v.per_request, per_year: v.per_year }),
  });

  const tabs: [typeof tab, string][] = [['cards', `经费卡 ${cards.length}`], ['templates', `科目模板 ${data.templates.length}`],
    ...(director ? [['users', `用户 ${data.admin.length}`] as [typeof tab, string]] : []), ['limits', '紧急通道限额'], ['outbox', '飞书通知'], ['legacy', '旧门户数据']];

  return (
    <>
      <div className="top"><h2>设置</h2></div>
      <div className="tabs" style={{ marginBottom: 18 }}>
        {tabs.map(([k, label]) => <button key={k} className="sm" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>)}
      </div>

      {tab === 'cards' && (
        <section className="card">
          <h3>经费卡</h3>
          <p className="hint">新建后在卡的页面里录年初预算和考核节点。已有预算、支出或人员费的卡不能换科目模板。</p>
          <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
            <button className="sm" onClick={() => setAct({ label: '新建', title: '新建经费卡', fields: cardFields(tplOpts, owners), run: (v) => saveCard(null, v) })}>新建经费卡</button></div>
          {cards.length === 0 ? <Empty>还没有经费卡。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>卡号</th><th>名称</th><th>模板</th><th>负责人</th><th>下达日</th><th>单据截止</th><th>结清日</th><th className="r">现行预算</th><th>状态</th><th /></tr></thead>
              <tbody>{cards.map((c) => (
                <tr key={c.card_id}><td className="code">{c.card_no}</td><td><a href={`#/card/${c.card_id}`}>{c.name}</a></td><td>{c.template_name}</td>
                  <td>{userName.get(c.owner_id ?? '') ?? '—'}</td><td>{day(c.start_date)}</td><td>{day(c.cutoff_date)}</td><td>{day(c.settle_date)}</td>
                  <td className="r">{money(c.cur)}</td><td>{c.status === 'settled' ? <Badge>已结清</Badge> : <Badge tone="ok">在用</Badge>}</td>
                  <td><div className="acts">{c.status === 'active' && btn({ label: '修改', title: `修改经费卡：${c.name}`, fields: cardFields(tplOpts, owners, c), run: (v) => saveCard(c.card_id, v) })}</div></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      {tab === 'templates' && (
        <>
          <section className="card">
            <h3>科目模板</h3>
            <p className="hint">每张卡按模板决定有哪些科目。科目锁定的模板（如人才经费）不能加减科目，卡也不能做预算变更。</p>
            <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}>
              <button className="sm" onClick={() => setAct({ label: '新建', title: '新建科目模板', fields: [{ name: 'code', label: '模板代码' }, { name: 'name', label: '模板名称' },
                { name: 'locked', label: '科目锁定（不能变更预算）', type: 'check', value: 'false' }],
                run: (v) => rpc('save_template', { id: null, code: v.code, name: v.name, locked: v.locked === 'true' }) })}>新建模板</button></div>
            <div className="scroll"><table>
              <thead><tr><th>代码</th><th>名称</th><th>科目锁定</th><th className="r">科目数</th><th className="r">在用的卡</th><th /></tr></thead>
              <tbody>{data.templates.map((x) => (
                <tr key={x.id}><td className="code">{x.code}</td><td>{x.name}</td><td>{x.locked ? <Badge tone="warn">锁定</Badge> : '—'}</td>
                  <td className="r">{data.subjects.filter((s) => s.template_id === x.id).length}</td><td className="r">{x.cards}</td>
                  <td><div className="acts"><button className="sm ghost" aria-pressed={t?.id === x.id} onClick={() => setTpl(x.id)}>看科目</button>
                    {btn({ label: '修改', title: `修改模板：${x.name}`, fields: [{ name: 'code', label: '模板代码', value: x.code }, { name: 'name', label: '模板名称', value: x.name },
                      { name: 'locked', label: '科目锁定（不能变更预算）', type: 'check', value: String(x.locked) }],
                      run: (v) => rpc('save_template', { id: x.id, code: v.code, name: v.name, locked: v.locked === 'true' }) })}</div></td></tr>
              ))}</tbody>
            </table></div>
          </section>
          {t && (
            <>
              <section className="card">
                <h3>{t.name} 的科目</h3>
                {!t.locked && <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(subjectAct())}>加科目</button></div>}
                {subs.length === 0 ? <Empty>这个模板还没有科目。</Empty> : (
                  <div className="scroll"><table>
                    <thead><tr><th className="r">排序</th><th>代码</th><th>名称</th><th>学校侧科目名</th><th /></tr></thead>
                    <tbody>{subs.map((s) => (
                      <tr key={s.id}><td className="r">{s.sort}</td><td className="code">{s.code}</td><td>{s.name}</td><td>{s.school_name ?? '—'}</td>
                        <td><div className="acts">{btn(subjectAct(s))}
                          {!t.locked && btn({ label: '删除', title: `删除科目：${s.name}`, hint: '只有从没有过预算、支出和人员费的科目能删。', danger: true, fields: [], run: () => rpc('delete_subject', { id: s.id }) })}</div></td></tr>
                    ))}</tbody>
                  </table></div>
                )}
              </section>
              <section className="card">
                <h3>{t.name} 的比例上限</h3>
                <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}><button className="sm" disabled={subs.length === 0} onClick={() => setAct(capAct())}>加比例上限</button></div>
                {caps.length === 0 ? <Empty>这个模板没有比例上限。</Empty> : (
                  <table>
                    <thead><tr><th>规则</th><th className="r">上限</th><th>计入的科目</th><th /></tr></thead>
                    <tbody>{caps.map((k) => (
                      <tr key={k.id}><td>{k.name}</td><td className="r">{(num(k.max_ratio) * 100).toFixed(0)}%</td>
                        <td className="wrap">{k.subject_ids.map((id) => subName.get(id) ?? '科目').join('、')}</td>
                        <td><div className="acts">{btn(capAct(k))}{btn({ label: '删除', title: `删除比例上限：${k.name}`, danger: true, fields: [], run: () => rpc('delete_cap', { id: k.id }) })}</div></td></tr>
                    ))}</tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </>
      )}

      {tab === 'users' && director && (
        <section className="card">
          <h3>用户</h3>
          <p className="hint">只用飞书登录。没登记过的人第一次登录自动成为成员；要给别的角色，先在这里按企业邮箱登记，或登录后在这里改。</p>
          <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(userAct())}>登记用户</button></div>
          <div className="scroll"><table>
            <thead><tr><th>姓名</th><th>企业邮箱</th><th>角色</th><th>飞书</th><th className="r">名下的卡</th><th className="r">申请</th><th>状态</th><th /></tr></thead>
            <tbody>{[...data.admin].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh')).map((u) => (
              <tr key={u.id}><td>{u.name}{u.id === me.id && <span className="sub2"> 我</span>}</td><td className="code">{u.email ?? '—'}</td><td>{ROLE[u.role]}</td>
                <td>{u.linked ? <Badge tone="ok">已绑定</Badge> : <Badge tone="warn">未登录过</Badge>}{u.migrated && <span className="sub2"> 旧系统迁入</span>}</td>
                <td className="r">{u.cards}</td><td className="r">{u.requests}</td><td>{u.active ? '在用' : <Badge>已停用</Badge>}</td>
                <td><div className="acts">{btn(userAct(u))}{u.active && u.id !== me.id && btn(mergeAct(u))}</div></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {tab === 'limits' && (
        <section className="card">
          <h3>紧急通道限额</h3>
          <p className="hint">紧急通道的支出不等审批直接计入承诺，事后补批。限额由中心负责人按年设置；当年没有设置时紧急通道不可用。</p>
          {director && <div className="actions" style={{ marginTop: 0, justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(limitAct())}>设置限额</button></div>}
          {data.limits.length === 0 ? <Empty>还没有设置过限额。</Empty> : (
            <table>
              <thead><tr><th>年度</th><th className="r">单笔上限</th><th className="r">全年额度</th><th className="r">已用</th><th /></tr></thead>
              <tbody>{[...data.limits].sort((a, b) => b.year - a.year).map((l) => (
                <tr key={l.year}><td>{l.year}</td><td className="r">{money(l.per_request)}</td><td className="r">{money(l.per_year)}</td>
                  <td className={`r ${num(l.used) > num(l.per_year) ? 'neg' : ''}`}>{money(l.used)}</td><td><div className="acts">{director && btn(limitAct(l))}</div></td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'outbox' && (
        <section className="card">
          <h3>飞书通知</h3>
          <p className="hint">申请提交、批准、驳回、学校退回、入账和预算变更的每一步，都会给相关的人排一条飞书消息。这里是近 30 天的队列。
            发送开关在接口层，默认关闭；关闭期间消息只排队，超过 24 小时作废，不会在打开时补发。</p>
          {data.outbox.length === 0 ? <Empty>近 30 天没有排过通知。</Empty> : (
            <div className="scroll"><table>
              <thead><tr><th>时间</th><th>发给</th><th>内容</th><th>状态</th></tr></thead>
              <tbody>{[...data.outbox].sort((a, b) => b.id - a.id).slice(0, 200).map((o) => (
                <tr key={o.id}><td>{o.created_at.slice(0, 16).replace('T', ' ')}</td><td>{o.user_name ?? '—'}</td><td className="wrap">{o.text}</td>
                  <td><Badge tone={OUT[o.status]?.[1]}>{OUT[o.status]?.[0] ?? o.status}</Badge>{o.last_error && <div className="sub2">{o.last_error}</div>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}

      {tab === 'legacy' && <LegacyArchive />}

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
