import { useState } from 'react';
import { rpc, useViews, type Me } from '../api';
import { can, Loading } from '../ui';

// 系统 › 反馈分工（0184）：「遇到问题？」提交的反馈按页面分给岗位负责人，转成议题时在协助群 @ 他。
// 中心负责人可以改；分到的人停用或已不在协助群的，改 @ 兜底人。不在表里的页面由济民（中台程序）处理。
interface Route { page: string; label: string; owner_id: string | null; owner_name: string | null; sort: number; updated_by_name: string | null; updated_at: string }
interface U { id: string; name: string; active: boolean; role: string }

export function FeedbackRoutePage({ me }: { me: Me }) {
  const edit = can(me, 'budget.approve');
  const { data, error, reload } = useViews<{ routes: Route[]; users: U[] }>(edit ? { routes: ['feedback_route'], users: ['users'] } : { routes: ['feedback_route'], users: ['feedback_route'] });
  const [err, setErr] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;
  const people = edit ? data.users.filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name, 'zh')) : [];
  const rows = [...data.routes].sort((a, b) => a.sort - b.sort);
  const byOwner = new Map<string, number>();
  for (const r of rows) if (r.page !== '*') byOwner.set(r.owner_name ?? '济民（中台程序）', (byOwner.get(r.owner_name ?? '济民（中台程序）') ?? 0) + 1);
  const set = async (page: string, owner: string) => { setErr(null); try { await rpc('set_feedback_route', { page, owner: owner || null }); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="wb">
      <h2>反馈分工</h2>
      <p className="hint">每个页面右下角「遇到问题？」提交的反馈，按提交时所在的页面分给岗位负责人：转成 GitHub 议题时写明负责人，并在协助群 @ 他认领。分到的人账号停用、或已不在协助群的，改 @ 兜底人。表里没有的页面（我的事项、使用指南、智能体接入等）由济民（中台程序）处理，不 @ 人。{edit ? '中心负责人可以在下表直接改，改完即生效。' : '由中心负责人调整。'}</p>
      <p className="hint">现在的分工：{[...byOwner].map(([k, n]) => `${k} ${n} 个页面`).join('，')}。</p>
      {err && <p className="err">{err}</p>}
      <div className="scroll"><table>
        <thead><tr><th>页面</th><th>地址</th><th>负责人</th><th>最近调整</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.page} style={r.page === '*' ? { background: 'var(--brand-soft, #fbefeb)' } : undefined}>
            <td>{r.label}</td><td className="sub2">{r.page === '*' ? '—' : `#/${r.page}`}</td>
            <td>{edit ? <select value={r.owner_id ?? ''} onChange={(e) => set(r.page, e.target.value)} aria-label={`${r.label}的负责人`}>
                <option value="">{r.page === '*' ? '（不设兜底）' : '济民（中台程序，不 @ 人）'}</option>
                {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select> : (r.owner_name ?? (r.page === '*' ? '不设兜底' : '济民（中台程序）'))}</td>
            <td className="sub2">{r.updated_by_name ? `${r.updated_by_name} ${r.updated_at.slice(5, 16).replace('T', ' ')}` : '—'}</td>
          </tr>))}</tbody>
      </table></div>
    </div>
  );
}
