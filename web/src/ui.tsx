import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReqStatus } from './api';

export const num = (v: string | number | null | undefined) => Number(v ?? 0);
export const money = (v: string | number | null | undefined) =>
  num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : '—');
export const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
export const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 北京时间

export const ROLE: Record<string, string> = { finance: '财务岗', director: '中心负责人', leader: '负责人', member: '成员' };
export const END_RULE: Record<string, string> = { recall: '到期回收', carry: '结转', return: '结余上缴' };
export const REQ: Record<ReqStatus, [string, string]> = {
  pending: ['待审批', 'warn'], committed: ['已批准', 'pri'], at_school: ['学校审核中', 'pri'], posted: ['已入账', 'ok'],
  returned: ['被退回', 'bad'], released: ['已释放', ''], rejected: ['已驳回', ''],
};
export const VERDICT: Record<string, [string, string]> = {
  yes: ['可以', 'ok'], conditional: ['有条件', 'warn'], no: ['不可以', 'bad'], disputed: ['有争议', 'warn'],
};
export const CHANGE: Record<string, [string, string]> = {
  pending: ['待负责人确认', 'warn'], filed: ['已报发规办', 'pri'], approved: ['已批复', 'ok'], rejected: ['已驳回', ''],
};

// 数字滚动到目标值；系统设置了减少动效时直接显示
export function useCount(target: number, ms = 1300) {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [v, setV] = useState(still ? target : 0);
  useEffect(() => {
    if (still) { setV(target); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => { const p = Math.min(1, (t - t0) / ms); setV(target * (1 - (1 - p) ** 4)); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const end = setTimeout(() => setV(target), ms + 300);   // 标签页在后台时动画帧不触发
    return () => { cancelAnimationFrame(raf); clearTimeout(end); };
  }, [target, ms, still]);
  return v;
}

export const Badge = ({ tone = '', children }: { tone?: string; children: ReactNode }) => <span className={`b ${tone}`}>{children}</span>;

// 预算执行条：决算数、承诺、可用
export function Bar({ cur, actual, commit }: { cur: number; actual: number; commit: number }) {
  const w = (x: number) => `${cur > 0 ? Math.min(100, Math.max(0, (x / cur) * 100)) : 0}%`;
  return (
    <div className="bar" role="img" aria-label={`决算 ${pct(actual, cur)}，承诺 ${pct(commit, cur)}`}>
      <i className="a" style={{ width: w(actual) }} /><i className="c" style={{ width: w(commit) }} />
    </div>
  );
}

export const Tile = ({ k, v, f, tone }: { k: string; v: ReactNode; f?: ReactNode; tone?: string }) => (
  <div className="tile"><div className="k">{k}</div><div className={`v ${tone ?? ''}`}>{v}</div>{f && <div className="f">{f}</div>}</div>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function Loading({ error }: { error?: Error }) {
  return error ? <div className="msg bad" role="alert">{error.message}</div> : <p className="empty">加载中…</p>;
}

// 一个带若干输入项的确认框，用于批准以外需要补充信息的操作
export interface Field { name: string; label: string; type?: 'text' | 'date' | 'number' | 'month' | 'check' | 'multi'; value?: string; required?: boolean; options?: [string, string][] }
export function ActionDialog({ title, hint, fields, submitLabel = '确认', danger, onSubmit, onClose }: {
  title: string; hint?: ReactNode; fields: Field[]; submitLabel?: string; danger?: boolean;
  onSubmit: (values: Record<string, string>) => Promise<unknown>; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError('');
        try { await onSubmit(values); onClose(); } catch (err) { setError((err as Error).message); setBusy(false); }
      }}>
        <h3>{title}</h3>
        {hint && <p className="hint">{hint}</p>}
        {fields.map((f) => f.type === 'check' ? (
          <label key={f.name} className="field check">
            <input type="checkbox" checked={values[f.name] === 'true'} onChange={(e) => setValues({ ...values, [f.name]: String(e.target.checked) })} /><span>{f.label}</span>
          </label>
        ) : f.type === 'multi' ? (
          <fieldset key={f.name} className="multi">
            <legend>{f.label}</legend>
            {(f.options ?? []).map(([v, label]) => { const on = values[f.name].split(',').filter(Boolean); return (
              <label key={v} className="field check"><input type="checkbox" checked={on.includes(v)}
                onChange={(e) => setValues({ ...values, [f.name]: (e.target.checked ? [...on, v] : on.filter((x) => x !== v)).join(',') })} /><span>{label}</span></label>); })}
          </fieldset>
        ) : (
          <label key={f.name} className="field">
            <span>{f.label}</span>
            {f.options ? (
              <select required={f.required ?? true} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                <option value="">请选择</option>{f.options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            ) : (
              <input type={f.type ?? 'text'} step={f.type === 'number' ? '0.01' : undefined} required={f.required ?? true}
                value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            )}
          </label>
        ))}
        {error && <div className="msg bad" role="alert">{error}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit" className={danger ? 'danger' : ''} disabled={busy}>{busy ? '处理中…' : submitLabel}</button>
        </div>
      </form>
    </dialog>
  );
}

// 一笔申请走到哪一步：申请 → 批准 → 交学校 → 入账。已驳回、已释放的不画
export const FLOW = ['申请', '批准', '交学校', '入账'];
export function Flow({ status }: { status: ReqStatus }) {
  const at = ({ pending: 1, committed: 2, returned: 2, at_school: 3, posted: 4, released: -1, rejected: -1 } as Record<ReqStatus, number>)[status];
  if (at < 0) return null;
  return (
    <ol className="flow" aria-label={at >= FLOW.length ? '四步都已完成' : `已完成 ${at} 步，现在等${FLOW[at]}`}>
      {FLOW.map((s, i) => <li key={s} title={s} className={i < at ? 'done' : i === at ? (status === 'returned' ? 'now bad' : 'now') : ''} />)}
    </ol>
  );
}
