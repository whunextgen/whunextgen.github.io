import { useMemo, useState, type FormEvent } from 'react';
import { rpc, useViews, type CardPick, type ExpenseType, type Me, type Rule, type Ruling } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, VERDICT, day, today } from '../ui';

const PATH_OPTS: [string, string][] = [['直采', '直采'], ['集采', '集采'], ['分散采购', '分散采购']];

function NewRuling({ cards, types, onDone }: { cards: CardPick[]; types: ExpenseType[]; onDone: () => void }) {
  const [v, setV] = useState({ card_id: '', expense_type_id: '', ruled_on: today(), ruled_by: '', verdict: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await rpc('add_ruling', { ...v, source: '人工记录' }); onDone(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h3>记录一条答复</h3>
      <p className="hint">每问一次财务处或发规办就记一条。同一张卡同一类支出，前后答复相反时标为有争议。</p>
      <div className="grid">
        <label className="field"><span>经费卡</span>
          <select required value={v.card_id} onChange={(e) => set({ card_id: e.target.value })}>
            <option value="">请选择</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className="field"><span>支出类型</span>
          <select required value={v.expense_type_id} onChange={(e) => set({ expense_type_id: e.target.value })}>
            <option value="">请选择</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
        <label className="field"><span>答复</span>
          <select required value={v.verdict} onChange={(e) => set({ verdict: e.target.value })}>
            <option value="">请选择</option><option value="yes">可以</option><option value="conditional">有条件</option><option value="no">不可以</option>
          </select></label>
        <label className="field"><span>答复日期</span><input required type="date" max={today()} value={v.ruled_on} onChange={(e) => set({ ruled_on: e.target.value })} /></label>
        <label className="field"><span>答复人或部门</span><input required maxLength={100} value={v.ruled_by} onChange={(e) => set({ ruled_by: e.target.value })} /></label>
        <label className="field"><span>条件或说明{v.verdict === 'yes' ? '（可不填）' : ''}</span>
          <input required={v.verdict !== 'yes'} maxLength={500} value={v.note} onChange={(e) => set({ note: e.target.value })} /></label>
      </div>
      {error && <div className="msg bad" role="alert">{error}</div>}
      <div className="actions"><button type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
    </form>
  );
}

export function Rules({ me }: { me: Me }) {
  const staff = can(me, 'rule.manage');
  const { data, error, reload } = useViews<{ rules: Rule[]; rulings: Ruling[]; cards: CardPick[]; types: ExpenseType[] }>({
    rules: ['rule'], rulings: ['ruling'], cards: ['card_pick'], types: ['expense_type'],
  });
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [edit, setEdit] = useState<ExpenseType | 'new' | null>(null);
  const by = useMemo(() => new Map((data?.rules ?? []).map((r) => [`${r.card_id}|${r.expense_type_id}`, r])), [data]);
  if (!data) return <Loading error={error} />;
  const cards = data.cards.filter((c) => c.status === 'active').sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const types = [...data.types].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const cardName = new Map(data.cards.map((c) => [c.id, c.name]));
  const typeName = new Map(data.types.map((t) => [t.id, t.name]));
  const history = data.rulings.filter((r) => !pick || r.card_id === pick).sort((a, b) => b.ruled_on.localeCompare(a.ruled_on));

  return (
    <>
      <div className="top"><h2>可报销规则</h2>
        {staff && <button onClick={() => setAdding(!adding)} className={adding ? 'ghost' : ''}>{adding ? '收起' : '记录一条答复'}</button>}</div>
      {adding && <NewRuling cards={cards} types={types} onDone={() => { setAdding(false); reload(); }} />}

      <section className="card">
        <h3>哪张卡能列支什么</h3>
        <p className="hint">没有答复的组合不能提交支出申请，要先问清楚并记录。学校退单的原因会自动记成不可以。</p>
        {cards.length === 0 || types.length === 0 ? <Empty>还没有在用的经费卡或支出类型。</Empty> : (
          <div className="scroll"><table className="matrix">
            <thead><tr><th>支出类型</th>{cards.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
            <tbody>{types.map((t) => (
              <tr key={t.id}><th scope="row">{t.name}{t.required_path && <div className="sub2">必须走{t.required_path}</div>}</th>
                {cards.map((c) => { const r = by.get(`${c.id}|${t.id}`); const v = r && VERDICT[r.verdict]; return (
                  <td key={c.id} title={r?.note ?? undefined}>{v ? <Badge tone={v[1]}>{v[0]}</Badge> : <span className="none">未答复</span>}
                    {r?.note && <div className="sub2 wrap">{r.note}</div>}</td>); })}</tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {staff && (
        <section className="card">
          <h3>支出类型</h3>
          <p className="hint">提交支出申请时要选类型，规则按类型记录。类型只能新增和修改，不能删除。</p>
          <div className="tabs">
            {types.map((t) => <button key={t.id} className="sm" onClick={() => setEdit(t)} title="修改">{t.name}{t.required_path ? ` · ${t.required_path}` : ''}</button>)}
            <button className="sm" aria-pressed="true" onClick={() => setEdit('new')}>新增类型</button>
          </div>
        </section>
      )}
      {edit && <ActionDialog title={edit === 'new' ? '新增支出类型' : '修改支出类型'} submitLabel="保存"
        hint={edit === 'new' ? '例如：电脑、差旅、会议、劳务、云服务。' : '改名会同时改变已有答复和申请里显示的名称。'}
        fields={[{ name: 'name', label: '名称', value: edit === 'new' ? '' : edit.name },
          { name: 'required_path', label: '必须走的采购路径（没有就不选）', required: false, options: PATH_OPTS, value: edit === 'new' ? '' : edit.required_path ?? '' }]}
        onSubmit={async (v) => { await rpc('save_expense_type', { id: edit === 'new' ? null : edit.id, name: v.name, required_path: v.required_path || null }); reload(); }}
        onClose={() => setEdit(null)} />}

      <section className="card">
        <h3>答复记录</h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className="sm" aria-pressed={pick === ''} onClick={() => setPick('')}>全部 {data.rulings.length}</button>
          {cards.map((c) => <button key={c.id} className="sm" aria-pressed={pick === c.id} onClick={() => setPick(c.id)}>
            {c.name} {data.rulings.filter((r) => r.card_id === c.id).length}</button>)}
        </div>
        {history.length === 0 ? <Empty>还没有答复记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>日期</th><th>经费卡</th><th>支出类型</th><th>答复</th><th>答复人</th><th>说明</th></tr></thead>
            <tbody>{history.map((r) => { const v = VERDICT[r.verdict] ?? [r.verdict, '']; return (
              <tr key={r.id}><td>{day(r.ruled_on)}</td><td>{cardName.get(r.card_id) ?? '—'}</td><td>{typeName.get(r.expense_type_id) ?? '—'}</td>
                <td><Badge tone={v[1]}>{v[0]}</Badge></td><td>{r.ruled_by ?? '—'}</td>
                <td className="wrap">{r.note}{r.source?.startsWith('request:') && <div className="sub2">来自学校退单</div>}</td></tr>); })}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
