import { useEffect, useState } from 'react';
import { rpc, view, type Me } from './api';
import { ActionDialog } from './ui';

// 每个页面右下角的「反馈」按钮：写下问题或建议，自动记下提交人、时间和页面；中台转成 GitHub 议题，转好后通知本人
interface Mine { id: string; seq: number; body: string; created_at: string; issue_number: number | null; issue_url: string | null; mine: boolean }
export function FeedbackButton({ me, title }: { me: Me; title: string }) {
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const [done, setDone] = useState('');
  useEffect(() => { if (open) view('feedback').then((r) => setMine((r as Mine[]).filter((x) => x.mine).sort((a, b) => b.seq - a.seq).slice(0, 5))).catch(() => setMine([])); }, [open]);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(''), 6000); return () => clearTimeout(t); }, [done]);
  const page = location.hash || '#/';
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return <>
    <button className="feedback-fab" onClick={() => setOpen(true)} aria-label="遇到问题？点这里反馈" title="有问题点这里反馈">遇到问题？</button>
    {done && <div className="feedback-toast" role="status">{done}</div>}
    {open && <ActionDialog title="反馈问题或建议" submitLabel="提交"
      hint={<>自动记下：提交人 {me.name} · {now} · 页面「{title}」（{page}）。提交后转成 GitHub 议题，转好后正则通知你。
        {mine.length > 0 && <span style={{ display: 'block', marginTop: 8 }}>我最近的反馈：{mine.map((f) => <span key={f.id} style={{ display: 'block' }}>第 {f.seq} 号 · {f.body.slice(0, 30)}{f.body.length > 30 ? '…' : ''} · {f.issue_url ? <a href={f.issue_url} target="_blank" rel="noreferrer">议题 #{f.issue_number}</a> : '待转议题'}</span>)}</span>}</>}
      fields={[{ name: 'body', label: '遇到什么问题，或有什么建议（越具体越好：做了什么、看到什么、期望什么）', type: 'area' }]}
      onSubmit={(v) => rpc('submit_feedback', { body: v.body, page, title }).then((seq) => setDone(`已提交第 ${seq} 号反馈，转成 GitHub 议题后会通知你`))}
      onClose={() => setOpen(false)} />}
  </>;
}
