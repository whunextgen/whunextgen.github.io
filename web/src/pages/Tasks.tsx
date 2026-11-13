import { useState } from 'react';
import { rpc, useViews, type CardPick, type Me, type PeoplePick, type Task, type TaskStep } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, today } from '../ui';
import type { Act } from './Caps';

// 期限离今天多远：过期、七天内、其他
export const taskDue = (t: Task, now: string): [string, string] => {
  if (!t.due_date) return ['不限期', ''];
  const left = Math.round((Date.parse(day(t.due_date)) - Date.parse(now)) / 864e5);
  return left < 0 ? [`过期 ${-left} 天`, 'bad'] : left === 0 ? ['今天到期', 'warn'] : left <= 7 ? [`还有 ${left} 天`, 'warn'] : [`${day(t.due_date)} 前`, ''];
};
const STEPS_HINT = '一行一步，办的人办完一步勾一步。';

// 任务列表：派给我的、我派出去的；有派任务权限的人看得到全部
export function Tasks({ me }: { me: Me }) {
  const assign = can(me, 'task.assign');
  const seesCards = can(me, 'read.finance') || me.scoped?.includes('card.read');
  const { data, error, reload } = useViews<{ tasks: Task[]; steps: TaskStep[]; people: PeoplePick[]; cards: CardPick[] }>({
    tasks: ['task'], steps: ['task_step'], people: ['people_pick'], cards: ['card_pick'] });
  const [act, setAct] = useState<Act | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [showDone, setShowDone] = useState(false);
  if (!data) return <Loading error={error} />;
  const now = today();
  const people: [string, string][] = data.people.map((p) => [p.id, p.id === me.id ? `${p.name}（我自己）` : p.name]);
  const stepsOf = (id: string) => data.steps.filter((s) => s.task_id === id).sort((a, b) => a.sort - b.sort);
  const byDue = (a: Task, b: Task) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.created_at.localeCompare(b.created_at);
  const open = data.tasks.filter((t) => t.status === 'open').sort(byDue);
  const mine = open.filter((t) => t.mine), others = open.filter((t) => !t.mine);
  const closed = data.tasks.filter((t) => t.status !== 'open').sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));

  const tick = async (s: TaskStep) => {
    setBusy(s.id); setErr('');
    try { await rpc('tick_task_step', { step: s.id, done: !s.done, note: null }); reload(); } catch (e) { setErr((e as Error).message); }
    setBusy('');
  };
  const createAct = (): Act => ({ title: '新建任务', submitLabel: '建任务',
    hint: assign ? `选办理人就是派给这个人，对方在总览的「轮到你处理」里看到。${STEPS_HINT}` : `给自己建的任务只有你和中心负责人看得到。${STEPS_HINT}`,
    fields: [{ name: 'title', label: '任务名称' },
      ...(assign ? [{ name: 'assignee', label: '办理人', options: people, value: me.id }] : []),
      { name: 'due', label: '期限（可不填）', type: 'date' as const, required: false },
      ...(seesCards && data.cards.length > 0 ? [{ name: 'card', label: '关联的经费卡（可不选）', options: data.cards.map((c): [string, string] => [c.id, `${c.name} · ${c.card_no}`]), required: false }] : []),
      { name: 'detail', label: '说明（可不填）', type: 'area' as const, required: false },
      { name: 'steps', label: '步骤（一行一步，可不填）', type: 'area' as const, required: false }],
    run: (v) => rpc('create_task', { title: v.title, assignee: v.assignee || null, due: v.due || null, card_id: v.card || null, detail: v.detail || null, steps: v.steps || null }) });
  const editAct = (t: Task): Act => ({ title: `修改任务：${t.title}`, submitLabel: '保存', hint: '换办理人、改期限，对方会收到通知。步骤在任务上直接加。',
    fields: [{ name: 'title', label: '任务名称', value: t.title },
      { name: 'assignee', label: '办理人', options: assign ? people : people.filter(([id]) => id === me.id || id === t.assignee_id), value: t.assignee_id },
      { name: 'due', label: '期限（可不填）', type: 'date', required: false, value: t.due_date ? day(t.due_date) : '' },
      { name: 'detail', label: '说明（可不填）', type: 'area', required: false, value: t.detail ?? '' }],
    run: (v) => rpc('edit_task', { id: t.id, title: v.title, assignee: v.assignee, due: v.due || null, detail: v.detail || null }) });

  const card = (t: Task) => {
    const steps = stepsOf(t.id), [dueText, dueTone] = taskDue(t, now), live = t.status === 'open';
    const canDo = live && (t.mine || t.can_manage);
    return (
      <section className="card task" key={t.id}>
        <h3>{t.title}
          {live ? <Badge tone={dueTone}>{dueText}</Badge> : <Badge tone={t.status === 'done' ? 'ok' : ''}>{t.status === 'done' ? '已办结' : '已撤销'}</Badge>}
          {steps.length > 0 && <span className="h3sub">{t.steps_done} / {t.steps} 步</span>}
        </h3>
        <p className="hint">
          {t.mine ? '办理人：我' : `办理人：${t.assignee_name ?? '—'}`} · {t.created_by === me.id ? '我建的' : `${t.creator_name ?? '—'} 派的`} · {day(t.created_at)}
          {t.due_date && <> · 期限 {day(t.due_date)}</>}
          {t.card_id && <> · <a href={`#/card/${t.card_id}`}>{t.card_name}</a></>}
        </p>
        {t.detail && <p className="task-detail">{t.detail}</p>}
        {steps.length > 0 && (
          <ul className="tsteps">{steps.map((s) => (
            <li key={s.id} className={s.done ? 'done' : ''}>
              <label><input type="checkbox" checked={s.done} disabled={!canDo || busy === s.id} onChange={() => tick(s)} /><span>{s.text}</span></label>
              <span className="sub2">{[s.done && `${s.done_by_name ?? ''} ${day(s.done_at)}`, s.note].filter(Boolean).join(' · ')}</span>
              {canDo && <button className="ghost sm" onClick={() => setAct({ title: `备注：${s.text}`, submitLabel: '保存', hint: '写办到哪了、单号、交给了谁。',
                fields: [{ name: 'note', label: '备注', value: s.note ?? '' }], run: (v) => rpc('tick_task_step', { step: s.id, done: null, note: v.note }) })}>备注</button>}
            </li>
          ))}</ul>
        )}
        {!live && t.close_note && <p className="sub2">{t.status === 'done' ? '办结说明' : '撤销原因'}：{t.close_note}{t.closed_by_name ? `（${t.closed_by_name} ${day(t.closed_at)}）` : ''}</p>}
        <div className="acts">
          {canDo && <button className="sm" disabled={t.steps_done < t.steps} title={t.steps_done < t.steps ? '每一步都勾了才能办结' : undefined}
            onClick={() => setAct({ title: `办结：${t.title}`, submitLabel: '办结', hint: t.steps > 0 ? `${t.steps} 步都已勾完。` : '这个任务没有拆步骤，办完直接办结。',
              fields: [{ name: 'note', label: '办结说明（可不填）', required: false }], run: (v) => rpc('finish_task', { id: t.id, note: v.note || null }) })}>办结</button>}
          {canDo && <button className="sm ghost" onClick={() => setAct({ title: `加步骤：${t.title}`, submitLabel: '加上', hint: `加在现有步骤后面。${STEPS_HINT}`,
            fields: [{ name: 'steps', label: '要加的步骤', type: 'area' }], run: (v) => rpc('add_task_steps', { id: t.id, steps: v.steps }) })}>加步骤</button>}
          {live && t.can_manage && <button className="sm ghost" onClick={() => setAct(editAct(t))}>修改</button>}
          {live && t.can_manage && <button className="sm ghost danger" onClick={() => setAct({ title: `撤销：${t.title}`, submitLabel: '撤销', danger: true, hint: '撤销之后办理人不用再办，记录留着。',
            fields: [{ name: 'note', label: '为什么撤销' }], run: (v) => rpc('cancel_task', { id: t.id, note: v.note }) })}>撤销</button>}
          {!live && t.can_manage && <button className="sm ghost" onClick={() => setAct({ title: `退回重办：${t.title}`, submitLabel: '退回重办', hint: '任务重新打开，已勾的步骤不变，办理人会收到通知。',
            fields: [{ name: 'note', label: '哪里还要再办' }], run: (v) => rpc('reopen_task', { id: t.id, note: v.note }) })}>退回重办</button>}
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="top">
        <h2>任务</h2>
        <button onClick={() => setAct(createAct())}>新建任务</button>
      </div>
      <p className="lede">一件要办的事派给一个人，拆成几步，办一步勾一步，全部勾完后办结。{assign ? '你能派给任何人，也看得到全部任务。' : '你能给自己建任务；派给你的任务也在这里。'}</p>
      {err && <div className="msg bad" role="alert">{err}</div>}

      <h3 className="sec">派给我的 <span className="h3sub">{mine.length} 件</span></h3>
      {mine.length === 0 ? <section className="card"><Empty>现在没有派给你的任务。</Empty></section> : mine.map(card)}

      {(others.length > 0 || assign) && <>
        <h3 className="sec">{assign ? '别人在办的' : '我派出去的'} <span className="h3sub">{others.length} 件</span></h3>
        {others.length === 0 ? <section className="card"><Empty>没有别人在办的任务。</Empty></section> : others.map(card)}
      </>}

      {closed.length > 0 && <>
        <h3 className="sec">已办结和已撤销 <span className="h3sub">{closed.length} 件</span>
          <button className="ghost sm" style={{ marginLeft: 12 }} onClick={() => setShowDone(!showDone)}>{showDone ? '收起' : '展开'}</button></h3>
        {showDone && closed.map(card)}
      </>}

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} submitLabel={act.submitLabel} danger={act.danger}
        onSubmit={async (v) => { await act.run(v); reload(); }} onClose={() => setAct(null)} />}
    </>
  );
}
