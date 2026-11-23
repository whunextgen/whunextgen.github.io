import { useState } from 'react';
import { rpc, useViews } from '../api';
import { ActionDialog, Badge, Empty, Loading } from '../ui';

interface NameOption { id: string; name: string; note: string | null; created_at: string; votes: number; mine: boolean; closes_at: string; open: boolean; total_votes: number }

// 中台征名：可以给已有的名字投票，也可以提新的名字。每人一票，截止前可以改投。不显示谁提的、谁投的。
export function Naming() {
  const { data, error, reload } = useViews<{ names: NameOption[] }>({ names: ['name_option'] });
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <Loading error={error} />;
  const names = [...data.names].sort((a, b) => b.votes - a.votes || a.created_at.localeCompare(b.created_at));
  const first = names[0], open = !!first?.open, total = first?.total_votes ?? 0, top = Math.max(1, ...names.map((n) => n.votes));
  const closes = first ? new Date(first.closes_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const vote = async (id: string | null) => {
    setBusy(true); setMsg('');
    try { await rpc('vote_name', { option: id }); reload(); } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <div className="top"><h2>中台征名</h2>{open && <div className="acts"><button onClick={() => setAdding(true)}>提一个新名字</button></div>}</div>
      <p className="lede">给这个中台起个名字，从《楚辞》里取。可以给已有的名字投票，也可以提新的。每人一票，截止前可以改投；{open ? `北京时间 ${closes} 截止` : '征名已截止'}。</p>
      <section className="card">
        <h3>候选名字 <span className="h3sub">{names.length} 个 · 已投 {total} 票 · {open ? <Badge tone="pri">进行中</Badge> : <Badge>已截止</Badge>}</span></h3>
        <p className="hint">匿名：页面上不显示名字是谁提的、票是谁投的。系统只为保证每人一票记下账号，不对外展示。</p>
        {names.length === 0 ? <Empty>暂无候选名字。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th style={{ width: '14%' }}>名字</th><th>出处与寓意</th><th style={{ width: '24%' }}>票数</th><th /></tr></thead>
            <tbody>{names.map((n) => (
              <tr key={n.id}><td><b style={{ fontSize: 16 }}>{n.name}</b>{n.mine && <span className="sub2">已投</span>}</td>
                <td className="wrap" style={{ whiteSpace: 'pre-wrap' }}>{n.note ?? '—'}</td>
                <td><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 8, background: 'var(--line)', borderRadius: 4 }}><div style={{ width: `${(n.votes / top) * 100}%`, height: 8, background: 'var(--pri, #2f6fed)', borderRadius: 4 }} /></div>
                  <span style={{ minWidth: 34, textAlign: 'right' }}>{n.votes} 票</span></div></td>
                <td className="r">{open && (n.mine ? <button className="sm ghost" disabled={busy} onClick={() => vote(null)}>撤回</button>
                  : <button className="sm" disabled={busy} onClick={() => vote(n.id)}>投这个</button>)}</td></tr>))}</tbody>
          </table></div>
        )}
        {msg && <p className="hint" style={{ marginTop: 10 }}>{msg}</p>}
      </section>
      {adding && <ActionDialog title="提一个新名字" submitLabel="提交"
        hint="名字从《楚辞》里取，不超过 8 个字；请写明出处和寓意。提交后所有人都能看到并投票，不显示是谁提的。每人最多提 3 个。提名不等于投票，需要另点「投这个」。"
        fields={[{ name: 'name', label: '名字' }, { name: 'note', label: '出处与寓意', type: 'area' }]}
        onSubmit={(v) => rpc('propose_name', { name: v.name, note: v.note }).then(reload)} onClose={() => setAdding(false)} />}
    </>
  );
}
