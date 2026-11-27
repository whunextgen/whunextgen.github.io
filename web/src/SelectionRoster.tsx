import { useState } from 'react';
import { rpc, useViews, type Me } from './api';
import { ActionDialog, Badge, Empty, Loading, can, day } from './ui';

type Status = 'joined' | 'interested' | 'unselected' | 'unlinked' | 'inactive';
interface Project { id: string; code: string; name: string; layer: string; parent_name: string | null; owner_name: string | null; joined_on?: string }
interface Row { id: string; user_id: string | null; name: string; kind: string; rank: string; rank_label: string; selection_status: Status; projects: Project[]; interests: Project[] }
interface Recipient { user_id: string | null; name: string; audience: 'apply' | 'contact' | 'owner'; message: string; blocked: string | null }
const AUDIENCE = { apply: '未申请的 Intern', contact: '已表达意向的 Intern', owner: '待联系的负责人' };
const LABEL: Record<Status, string> = { joined: '已加入', interested: '仅表达意向', unselected: '尚未加入', unlinked: '待关联账号', inactive: '账号已停用' };

export function SelectionRoster({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ roster: Row[] }>({ roster: ['selection_roster'] });
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [preview, setPreview] = useState<Recipient[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState('');
  const previewReminders = async () => {
    setBusy(true); setNoticeError(''); setNotice('');
    try { const result = await rpc('preview_selection_reminders', {}) as { recipients: Recipient[] }; setPreview(result.recipients); }
    catch (e) { setNoticeError(e instanceof Error ? e.message : '预览失败，请重试'); }
    finally { setBusy(false); }
  };
  const all = can(me, 'read.people', 'people.manage');
  const rows = data?.roster ?? [];
  const shown = rows.filter((r) => (!status || (status === 'not_joined' ? r.selection_status !== 'joined' : r.selection_status === status))
    && (!kind || (kind === 'master' ? r.kind === 'master' : r.rank === kind)) && [r.name, ...r.projects.flatMap((p) => [p.code, p.name, p.parent_name ?? '', p.owner_name ?? '']), ...r.interests.map((p) => p.name)]
      .join(' ').toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return <details className="wb-sec selection-roster" aria-labelledby="selection-roster-title">
    <summary><h3 id="selection-roster-title">{all ? '人员双选情况' : '我的双选情况'}</h3><span className="selection-expand">展开查看</span><span className="selection-collapse">收起</span></summary>
    <div className="ir-acts"><button className="sm ghost" onClick={reload}>刷新双选情况</button>{can(me, 'selection.remind') && <button className="sm" disabled={busy} onClick={previewReminders}>{busy ? '正在核对收件人…' : '一键提醒双选'}</button>}</div>
    {notice && <p role="status" className="msg">{notice}</p>}{noticeError && <p role="alert" className="msg bad">{noticeError}</p>}
    <p className="hint">范围：在岗及非编的 Intern、Assistant 或硕士研究生（身份以人员档案为准）。以当前有效课题或研究单元成员名单为准；意向不算已加入，历史退出、已停用及待立项课题不计入。这里展示当前归属，不代表本轮新增。</p>
    {!data ? <Loading error={error} /> : <>
      <div className="selection-counts" aria-label="双选统计">
        <span>名单人数 <b>{rows.length}</b></span><span>已加入 <b>{rows.filter((r) => r.selection_status === 'joined').length}</b></span>
        <span>尚未加入（含待核对） <b>{rows.filter((r) => r.selection_status !== 'joined').length}</b></span>
        <span>其中仅表达意向 <b>{rows.filter((r) => r.selection_status === 'interested').length}</b></span>
        <span>待关联 / 停用账号 <b>{rows.filter((r) => ['unlinked', 'inactive'].includes(r.selection_status)).length}</b></span>
      </div>
      <div className="selection-filters">
        <label>搜索人员或课题<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="姓名、课题、负责人" /></label>
        <label>双选状态<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">全部状态</option><option value="not_joined">全部尚未加入（含待核对）</option>{Object.entries(LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <label>身份 / 硕士<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">全部身份 / 硕士</option><option value="intern">Intern</option><option value="assistant">Assistant</option><option value="master">硕士研究生（不限身份）</option></select></label>
      </div>
      <p role="status">显示 {shown.length} / {rows.length} 人</p>
      {shown.length === 0 ? <Empty>{rows.length ? '没有符合筛选条件的人员。' : all ? '当前名单中没有需要双选的在岗 Intern、Assistant 或硕士研究生。' : '本人不在当前双选统计范围内。'}</Empty> :
        <ul className="selection-people">{shown.map((r) => <li key={r.id}>
          <div className="selection-person-title"><strong>{r.name}</strong><span>{r.rank_label}{r.kind === 'master' && ' · 硕士研究生'}</span><Badge tone={r.selection_status === 'joined' ? 'ok' : 'warn'}>{LABEL[r.selection_status]}</Badge></div>
          {r.projects.length > 0 && <ul>{r.projects.map((p) => <li key={p.id}><b>{p.code} · {p.name}</b> · {p.layer === 'paper' ? '研究单元' : '课题'}{p.parent_name && `（所属课题：${p.parent_name}）`}<div className="hint">负责人：{p.owner_name ?? '待明确'} · 加入日期：{day(p.joined_on ?? '')}</div></li>)}</ul>}
          {r.selection_status === 'interested' && <p>已表达意向：{r.interests.map((p) => `${p.code} · ${p.name}`).join('；')}。待双方谈妥后由负责人加入名单。</p>}
          {r.selection_status === 'unselected' && <p className="hint">暂无有效成员关系或系统意向；线下已谈妥的，请负责人在课题管理中添加成员。</p>}
          {r.selection_status === 'unlinked' && <p className="hint">人员档案尚未关联登录账号，暂无法核对成员关系，请有权限的经办核对档案。</p>}
          {r.selection_status === 'inactive' && <p className="hint">关联账号已停用，请有权限的经办核对人员状态；已有归属仅供核对，不计为完成。</p>}
        </li>)}</ul>}
    </>}
    {preview && <ActionDialog title="双选私信提醒预览" submitLabel="确认加入私信队列" fields={[]} hint={<>
      <p>按全员当前状态核对，不受页面筛选影响。仅提醒尚未加入的 Intern 及有其未处理意向的负责人；同人同类每天最多一次。未关联账号不会按姓名猜测收件人。</p>
      <p>可入队 {preview.filter((r) => !r.blocked).length} 条，需核对或已提醒 {preview.filter((r) => r.blocked).length} 条。</p>
      {preview.length === 0 ? <p>当前没有符合条件的提醒对象。</p> : <ul className="selection-reminder-preview">{preview.map((r, i) => <li key={`${r.user_id}-${r.audience}-${i}`}><b>{r.name} · {AUDIENCE[r.audience]}</b>{r.blocked ? <p>不发送：{r.blocked}</p> : <p>{r.message}</p>}</li>)}</ul>}
      <p>发送时重新核对状态，实际条数可能变化。入队不等于送达，实际飞书私信由系统现有通知服务发送。</p>
    </>} onClose={() => setPreview(null)} onSubmit={async () => {
      const r = await rpc('send_selection_reminders', {}) as { queued: number; skipped: number };
      setNotice(`已加入正则私信队列 ${r.queued} 条，跳过 ${r.skipped} 条。实际送达以通知队列为准。`); reload();
    }} />}
  </details>;
}
