import { useState } from 'react';
import { rpc, useViews, type Me, type Person, type User } from '../api';
import { ArrAdmin } from '../arr';
import { ActionDialog, Badge, Empty, Loading, PERSON, Tile, can, day, type Field } from '../ui';

const KIND: Record<string, string> = { ...PERSON, external: '外部人员' };
const KINDS = Object.entries(KIND);
const STATUS: Record<Person['status'], [string, string]> = { active: ['在岗', 'ok'], offroll: ['非编', ''], left: ['已离开', ''], pending: ['待确认', 'warn'], ignored: ['已忽略', ''] };
const SETTABLE: [string, string][] = [['active', '在岗'], ['offroll', '非编'], ['left', '已离开']];
interface Act { title: string; hint?: string; label: string; fields: Field[]; run: (v: Record<string, string>) => Promise<unknown> }

// 人员档案：一人一条，独立于账号。类别和状态以档案为准，账号的身份和启停跟着档案走。
export function People({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ people: Person[]; users: User[] }>({ people: ['person'], users: ['users'] });
  const [act, setAct] = useState<Act | null>(null);
  const [show, setShow] = useState<'on' | 'left' | 'all'>('on');
  const [kind, setKind] = useState('');
  if (!data) return <Loading error={error} />;
  const edit = can(me, 'people.manage');
  const all = data.people;
  const linked = new Set(all.filter((p) => p.user_id).map((p) => p.user_id));
  const pending = all.filter((p) => p.status === 'pending');
  const ignored = all.filter((p) => p.status === 'ignored');
  const orphans = data.users.filter((u) => u.active && !linked.has(u.id));           // 启用的账号，没有档案
  const free = all.filter((p) => !p.user_id && p.status !== 'pending' && p.status !== 'ignored');   // 还没有对应账号的档案
  const unlogged = free.filter((p) => p.status === 'active' || p.status === 'offroll');
  const on = all.filter((p) => p.status === 'active' || p.status === 'offroll');
  const rows = all.filter((p) => p.status !== 'pending' && p.status !== 'ignored')
    .filter((p) => (show === 'all' ? true : show === 'left' ? p.status === 'left' : p.status !== 'left'))
    .filter((p) => !kind || (kind === 'none' ? !p.kind : p.kind === kind))
    .sort((a, b) => (a.no ? 0 : 1) - (b.no ? 0 : 1) || (a.no ?? '').localeCompare(b.no ?? '', 'en', { numeric: true }) || a.name.localeCompare(b.name, 'zh'));

  const body = (id: string | null, v: Record<string, string>) => ({ id, no: v.no || null, name: v.name, kind: v.kind || null, status: v.status || 'active',
    joined: v.joined || null, left: v.left || null, edu: v.edu || null, school: v.school || null, direction: v.direction || null, mentor: v.mentor || null, note: v.note || null });
  const fields = (p?: Partial<Person>, status = 'active'): Field[] => [
    { name: 'name', label: '姓名', value: p?.name ?? '' },
    { name: 'no', label: '编号（研究助理、研究实习生、硕士留空则自动顺延）', value: p?.no ?? '', required: false },
    { name: 'kind', label: '类别', options: KINDS, value: p?.kind ?? '', required: false },
    { name: 'status', label: '状态', options: SETTABLE, value: p?.status && p.status !== 'pending' ? p.status : status },
    { name: 'joined', label: '加入日期', type: 'date', value: p?.joined_on ? day(p.joined_on) : '', required: false },
    { name: 'left', label: '离开日期（登记为已离开时填，留空按当天）', type: 'date', value: p?.left_on ? day(p.left_on) : '', required: false },
    { name: 'edu', label: '学历', value: p?.edu ?? '', required: false }, { name: 'school', label: '学校', value: p?.school ?? '', required: false },
    { name: 'direction', label: '研究方向', value: p?.direction ?? '', required: false }, { name: 'mentor', label: '导师', value: p?.mentor ?? '', required: false },
    { name: 'note', label: '备注', type: 'area', value: p?.note ?? '', required: false }];
  const LEAVE = '登记为已离开后，对应的账号随即停用；改回在岗或非编，账号恢复启用。';
  const add: Act = { title: '登记人员', label: '保存', hint: `先建档案，本人可以还没有登录过中台。${LEAVE}`, fields: fields(), run: (v) => rpc('save_person_record', body(null, v)) };
  const editAct = (p: Person): Act => ({ title: `修改档案：${p.name}`, label: '保存', hint: LEAVE, fields: fields(p), run: (v) => rpc('save_person_record', body(p.id, v)) });
  const confirmAct = (p: Person): Act => ({ title: `确认在岗：${p.name}`, label: '确认',
    hint: '此人已用飞书登录，但没有对应的人员档案，账号尚未启用。核实是本中心人员后补全档案并确认，账号即可使用。姓名取自飞书，可以改为本名。',
    fields: fields(p), run: (v) => rpc('save_person_record', body(p.id, v)) });
  const mergeAct = (p: Person): Act => ({ title: `并入已有档案：${p.name}`, label: '并入',
    hint: '此人已有档案（比如名单里登记过，但飞书上的名字不同）时，选出那条档案，这个账号就对到它上面，待确认的这一条删掉。',
    fields: [{ name: 'person', label: '已有档案（尚未对应账号的）', options: free.map((x): [string, string] => [x.id, `${x.no ? x.no + ' ' : ''}${x.name}${x.kind ? '（' + KIND[x.kind] + '）' : ''}${x.status === 'left' ? ' · 已离开' : ''}`]) }],
    run: (v) => rpc('link_person', { person: v.person, user: p.user_id }) });
  const ignoreAct = (p: Person): Act => ({ title: `忽略：${p.name}`, label: '忽略',
    hint: '不是本中心人员、或不该开通账号的，可以忽略：账号保持停用，此人再登录也不会再提醒。忽略后列在本页「已忽略」里，可以恢复。',
    fields: [{ name: 'note', label: '理由（比如「不是本中心人员」「重复的飞书账号」）', type: 'area', value: '' }],
    run: (v) => rpc('ignore_person', { person: p.id, note: v.note }) });
  const unignore = (p: Person) => { if (confirm(`把 ${p.name} 恢复为待确认？恢复后在「待处理」里确认在岗或并入。`)) rpc('unignore_person', { person: p.id }).then(reload).catch((e) => alert(e?.message ?? String(e))); };
  const fillAct = (u: User): Act => ({ title: `补档案：${u.name}`, label: '保存',
    hint: '这个账号在用，但没有人员档案。可以新建一条，也可以在下面选一条已有的档案对上（选了已有档案，其余各项不用填）。',
    fields: [{ name: 'person', label: '对到已有档案（可不选）', options: free.map((x): [string, string] => [x.id, `${x.no ? x.no + ' ' : ''}${x.name}`]), required: false }, ...fields({ name: u.name, kind: u.kind ?? undefined })],
    run: async (v) => { const pid = v.person || (await rpc('save_person_record', body(null, v))) as string; await rpc('link_person', { person: pid, user: u.id }); } });
  const btn = (a: Act, cls = 'sm') => <button className={cls} onClick={() => setAct(a)}>{a.label === '保存' ? a.title.split('：')[0] : a.label}</button>;

  return (
    <>
      <div className="top"><h2>人员档案</h2>{edit && <div className="acts"><button onClick={() => setAct(add)}>登记人员</button></div>}</div>
      <p className="lede">每人一条档案，独立于账号：可以先登记、后登录。类别和状态以档案为准，账号上的身份跟着档案变；档案登记为已离开，账号随即停用。没有档案的人用飞书登录后不能直接进入，须在这里确认。</p>
      <div className="tiles">
        <Tile k="在岗" v={on.filter((p) => p.status === 'active').length} f={`另有非编 ${on.filter((p) => p.status === 'offroll').length} 人`} />
        <Tile k="待人事确认" v={pending.length} tone={pending.length ? 'warn' : undefined} f="已登录、没有档案" />
        <Tile k="账号没有档案" v={orphans.length} tone={orphans.length ? 'warn' : undefined} f="启用中的账号" />
        <Tile k="尚未登录" v={unlogged.length} f="在岗、还没有账号" />
        <Tile k="已离开" v={all.filter((p) => p.status === 'left').length} />
      </div>

      {(pending.length > 0 || orphans.length > 0) && (
        <section className="card">
          <h3>待处理 <span className="h3sub">{pending.length + orphans.length} 项</span></h3>
          <div className="scroll"><table>
            <thead><tr><th>姓名</th><th>情况</th><th /></tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}><td><b>{p.name}</b></td><td><Badge tone="warn">待确认</Badge><span className="sub2">已用飞书登录，没有对应的档案，账号未启用</span></td>
                  <td className="r">{edit && <div className="acts">{btn(confirmAct(p))}{free.length > 0 && btn(mergeAct(p), 'sm ghost')}{btn(ignoreAct(p), 'sm ghost')}</div>}</td></tr>))}
              {orphans.map((u) => (
                <tr key={u.id}><td><b>{u.name}</b></td><td><Badge>无档案</Badge><span className="sub2">账号在用，尚未建档{u.kind ? `；账号上登记的身份是${PERSON[u.kind] ?? u.kind}` : ''}</span></td>
                  <td className="r">{edit && <div className="acts">{btn(fillAct(u))}</div>}</td></tr>))}
            </tbody>
          </table></div>
        </section>
      )}

      <section className="card">
        <h3>全部档案 <span className="h3sub">{rows.length} 人</span></h3>
        <div className="tabs" style={{ marginBottom: 12 }}>
          {([['on', '在岗与非编'], ['left', '已离开'], ['all', '全部']] as const).map(([k, t]) => <button key={k} className={show === k ? 'on' : ''} onClick={() => setShow(k)}>{t}</button>)}
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ marginLeft: 12 }} aria-label="按类别筛选">
            <option value="">全部类别</option>{KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}<option value="none">未登记类别</option>
          </select>
        </div>
        {rows.length === 0 ? <Empty>没有符合条件的档案。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>编号</th><th>姓名</th><th>类别</th><th>状态</th><th>学历 · 学校</th><th>研究方向</th><th>账号</th><th /></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.no ?? '—'}</td>
                <td><b>{p.name}</b>{p.mentor && <div className="sub2" style={{ marginLeft: 0 }}>导师 {p.mentor}</div>}</td>
                <td>{p.kind ? KIND[p.kind] : <Badge tone="warn">未登记</Badge>}</td>
                <td><Badge tone={STATUS[p.status][1]}>{STATUS[p.status][0]}</Badge>{p.status === 'left' && p.left_on && <div className="sub2" style={{ marginLeft: 0 }}>{day(p.left_on)} 离开</div>}
                  {p.status !== 'left' && p.joined_on && <div className="sub2" style={{ marginLeft: 0 }}>{day(p.joined_on)} 加入</div>}</td>
                <td className="wrap">{[p.edu, p.school].filter(Boolean).join(' · ') || '—'}</td>
                <td className="wrap">{p.direction ?? '—'}{p.note && <div className="sub2" style={{ marginLeft: 0 }}>{p.note}</div>}</td>
                <td>{p.user_id ? (p.account_active ? <Badge tone="ok">已启用</Badge> : <Badge>已停用</Badge>) : p.has_feishu ? <span className="sub2" style={{ marginLeft: 0 }}>未登录，已记飞书身份</span> : <span className="sub2" style={{ marginLeft: 0 }}>未登录</span>}</td>
                <td className="r">{edit && <div className="acts">{btn(editAct(p), 'sm ghost')}</div>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </section>
      {ignored.length > 0 && (
        <details className="card">
          <summary><h3 style={{ display: 'inline' }}>已忽略 <span className="h3sub">{ignored.length} 人</span></h3></summary>
          <p className="sub2" style={{ marginLeft: 0 }}>用飞书登录过、经人事忽略的人，账号保持停用，再登录也不提醒。</p>
          <div className="scroll"><table>
            <thead><tr><th>姓名</th><th>理由</th><th>忽略</th><th /></tr></thead>
            <tbody>{ignored.map((p) => (
              <tr key={p.id}><td><b>{p.name}</b></td><td className="wrap">{p.ignore_note ?? '—'}</td>
                <td>{p.ignored_by_name ?? '—'}{p.ignored_at && <div className="sub2" style={{ marginLeft: 0 }}>{day(p.ignored_at)}</div>}</td>
                <td className="r">{edit && <button className="sm ghost" onClick={() => unignore(p)}>恢复</button>}</td></tr>))}</tbody>
          </table></div>
        </details>
      )}
      <ArrAdmin me={me} users={data.users} />
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
