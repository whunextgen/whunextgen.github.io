import { useState } from 'react';
import { rpc, useViews, type Me, type Project } from './api';
import { ActionDialog, Badge, Empty, Loading, can, day, type Field } from './ui';

// ARR 担保名额：担保资格和每轮名额记在人上，研究单元投 ARR 时由负责人请一位有余量的担保人。
// 不另设页面：研究单元页上办申请和答复，人员档案页上登记资格、开启轮次。
export interface ArrCycle { name: string; opened_at: string; current: boolean }
export interface ArrSponsor { user_id: string; user_name: string; user_active: boolean; qualified: boolean; quota: number; used: number; remaining: number; note: string | null; updated_at: string }
export interface ArrClaim { id: string; cycle: string; current: boolean; project_id: string; unit_code: string; unit_name: string; sponsor_id: string; sponsor_name: string;
  status: 'pending' | 'agreed' | 'declined' | 'withdrawn'; asked_by_name: string | null; asked_at: string; decided_at: string | null; note: string | null; can_answer: boolean; can_withdraw: boolean }
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }
const ST: Record<ArrClaim['status'], [string, string]> = { pending: ['warn', '待担保人答复'], agreed: ['ok', '已同意担保'], declined: ['bad', '未获同意'], withdrawn: ['', '已撤回'] };

// ---------- 研究单元页：本轮的担保 ----------
export function UnitArr({ me, unit }: { me: Me; unit: Project }) {
  const { data, error, reload } = useViews<{ cycles: ArrCycle[]; sponsors: ArrSponsor[]; claims: ArrClaim[] }>({
    cycles: ['arr_cycle'], sponsors: ['arr_sponsor'], claims: ['arr_claim'],
  }, unit.id);
  const [act, setAct] = useState<Act | null>(null);
  if (!data) return <Loading error={error} />;
  const cur = data.cycles.find((c) => c.current);
  const mine = data.claims.filter((c) => c.project_id === unit.id).sort((a, b) => b.asked_at.localeCompare(a.asked_at));
  const live = mine.find((c) => c.current && (c.status === 'pending' || c.status === 'agreed'));
  if (!cur && mine.length === 0) return null;
  const open = data.sponsors.filter((s) => s.qualified && s.user_active && s.remaining > 0);
  const askAct: Act = { title: `申请 ARR 担保：${unit.name}`, label: '提交申请',
    hint: `本轮为「${cur?.name ?? ''}」。一个研究单元一轮只请一位担保人，对方同意后占用其一个名额；撤回或对方不同意的，名额退回。请本人担保的直接生效。`,
    fields: [{ name: 'sponsor', label: '担保人', options: open.map((s) => [s.user_id, `${s.user_name}${s.user_id === me.id ? '（本人）' : ''} · 余 ${s.remaining} 个`]) }],
    run: (v) => rpc('ask_arr', { project: unit.id, sponsor: v.sponsor }) };
  const answerAct = (c: ArrClaim, ok: boolean): Act => ({ title: `${ok ? '同意' : '不同意'}担保：${c.unit_name}`, label: ok ? '同意' : '不同意', danger: !ok,
    hint: ok ? `同意后占用本人在「${c.cycle}」一轮的一个担保名额。研究单元撤回申请的，名额退回。` : '不同意的请写明原因，名额退回本人。',
    fields: [{ name: 'note', label: ok ? '说明（选填）' : '原因', type: 'area', required: !ok }],
    run: (v) => rpc('answer_arr', { id: c.id, ok, note: v.note || null }) });
  const withdrawAct = (c: ArrClaim): Act => ({ title: `撤回担保申请：${c.unit_name}`, label: '撤回', danger: true,
    hint: `撤回后 ${c.sponsor_name} 的名额退回，本研究单元可以另请他人。`, fields: [], run: () => rpc('withdraw_arr', { id: c.id }) });
  return (
    <section className="card" id="sec-arr">
      <h3>ARR 担保 <span className="h3sub">{cur ? `本轮：${cur.name}` : '尚未开启轮次'}</span></h3>
      <p className="hint">投 ARR 的稿件须由具备审稿资格的人担保，每人每轮能担保的篇数有限。研究单元准备投 ARR 时，由负责人在此请一位有余量的担保人，对方同意后生效。不投 ARR 的研究单元不必办理。</p>
      {mine.length === 0 ? <Empty>本研究单元尚未申请担保。</Empty> : (
        <div className="scroll"><table>
          <thead><tr><th>轮次</th><th>担保人</th><th>状态</th><th>申请</th><th>答复</th><th /></tr></thead>
          <tbody>{mine.map((c) => (
            <tr key={c.id}><td>{c.cycle}{!c.current && <span className="sub2">往轮</span>}</td><td>{c.sponsor_name}</td>
              <td><Badge tone={ST[c.status][0]}>{ST[c.status][1]}</Badge>{c.note && <span className="sub2">{c.note}</span>}</td>
              <td>{c.asked_by_name ?? '—'}<span className="sub2">{day(c.asked_at)}</span></td><td>{c.decided_at ? day(c.decided_at) : '—'}</td>
              <td className="r"><div className="acts">
                {c.can_answer && <><button className="sm" onClick={() => setAct(answerAct(c, true))}>同意</button><button className="ghost sm danger" onClick={() => setAct(answerAct(c, false))}>不同意</button></>}
                {c.can_withdraw && <button className="ghost sm danger" onClick={() => setAct(withdrawAct(c))}>撤回</button>}
              </div></td></tr>
          ))}</tbody>
        </table></div>
      )}
      {unit.mine && cur && !live && (
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {open.length > 0 ? <button className="sm" onClick={() => setAct(askAct)}>申请担保</button> : <span className="sub2">本轮暂无有余量的担保人，请联系人事岗。</span>}
        </div>
      )}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}

// ---------- 人员档案页：担保资格、每轮名额、轮次 ----------
export function ArrAdmin({ me, users }: { me: Me; users: { id: string; name: string; active: boolean }[] }) {
  const { data, error, reload } = useViews<{ cycles: ArrCycle[]; sponsors: ArrSponsor[]; claims: ArrClaim[] }>({
    cycles: ['arr_cycle'], sponsors: ['arr_sponsor'], claims: ['arr_claim'],
  });
  const [act, setAct] = useState<Act | null>(null);
  const edit = can(me, 'people.manage');
  if (!data) return <Loading error={error} />;
  if (!edit && data.sponsors.length === 0) return null;
  const cur = data.cycles.find((c) => c.current);
  const rows = [...data.sponsors].sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.user_name.localeCompare(b.user_name, 'zh'));
  const has = new Set(rows.map((s) => s.user_id));
  const saveAct = (s?: ArrSponsor): Act => ({ title: s ? `修改担保资格：${s.user_name}` : '登记担保人', label: '保存',
    hint: '每轮名额是此人一轮最多担保的篇数。修改名额不影响已同意的担保；取消资格后不能再被请，已同意的担保仍然有效。',
    fields: [...(s ? [] : [{ name: 'user', label: '人员', options: users.filter((u) => u.active && !has.has(u.id)).map((u) => [u.id, u.name] as [string, string]) } as Field]),
      { name: 'qualified', label: '担保资格', options: [['true', '合格'], ['false', '不合格']], value: s ? String(s.qualified) : 'true' },
      { name: 'quota', label: '每轮名额', type: 'number', value: s ? String(s.quota) : '1' },
      { name: 'note', label: '备注（选填）', required: false, value: s?.note ?? '' }],
    run: (v) => rpc('save_arr_sponsor', { user: s?.user_id ?? v.user, qualified: v.qualified === 'true', quota: v.quota, note: v.note || null }) });
  const cycleAct: Act = { title: '开启新一轮', label: '开启',
    hint: `${cur ? `当前为「${cur.name}」。` : ''}开启后各人的余量按每轮名额重新起算，往轮的担保记录保留。轮次名称按 ARR 的截稿月份填写。`,
    fields: [{ name: 'name', label: '轮次名称', value: '' }], run: (v) => rpc('open_arr_cycle', { name: v.name }) };
  const live = data.claims.filter((c) => c.current && (c.status === 'pending' || c.status === 'agreed'));
  return (
    <section className="card" id="sec-arr">
      <h3>ARR 担保名额 <span className="h3sub">{cur ? `本轮：${cur.name} · 已占用 ${live.length} 个` : '尚未开启轮次'}</span></h3>
      <p className="hint">具备 ARR 审稿资格的人可以为投稿担保，每人每轮名额有限。此处登记资格和每轮名额、开启轮次；研究单元负责人在研究单元页上请担保人，对方同意后占用名额。余量仅研究单元负责人、担保人本人和人事岗可见。</p>
      {rows.length === 0 ? <Empty>尚未登记担保人。</Empty> : (
        <div className="scroll"><table>
          <thead><tr><th>担保人</th><th>资格</th><th className="r">每轮名额</th><th className="r">本轮已占</th><th className="r">本轮余量</th><th>本轮担保的研究单元</th><th /></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.user_id}><td>{s.user_name}{!s.user_active && <span className="sub2">账号已停用</span>}{s.note && <span className="sub2">{s.note}</span>}</td>
              <td>{s.qualified ? <Badge tone="ok">合格</Badge> : <Badge>不合格</Badge>}</td>
              <td className="r">{s.quota}</td><td className="r">{s.used}</td><td className="r">{s.remaining}</td>
              <td>{live.filter((c) => c.sponsor_id === s.user_id).map((c) => <span key={c.id}><a href={`#/project/${c.project_id}`}>{c.unit_code} {c.unit_name}</a>{c.status === 'pending' && <span className="sub2">待答复</span>} </span>)}</td>
              <td className="r">{edit && <button className="ghost sm" onClick={() => setAct(saveAct(s))}>修改</button>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {edit && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="sm" onClick={() => setAct(saveAct())}>登记担保人</button><button className="ghost sm" onClick={() => setAct(cycleAct)}>开启新一轮</button></div>}
      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.label} danger={act.danger} onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </section>
  );
}
