import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReqStatus } from './api';

export const num = (v: string | number | null | undefined) => Number(v ?? 0);
export const money = (v: string | number | null | undefined) =>
  num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : '—');
export const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
export const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 北京时间

export const ROLE: Record<string, string> = { finance: '财务岗', director: '中心负责人', leader: '课题/研究单元负责人', member: '成员' };
// 人员身份只管一件事：公共设备给博士后、博士、硕士和研究助理个人申领
export const PERSON: Record<string, string> = { postdoc: '博士后', phd: '博士', master: '硕士', ra: '研究助理', ri: '研究实习生', visitor: '访问学生' };
// 页面上的按钮和入口跟着权限点走；真正的检查在数据库里
export const can = (me: { perms?: string[] }, ...codes: string[]) => codes.some((c) => me.perms?.includes(c));
export const canPublic = (k?: string | null) => k === 'postdoc' || k === 'phd' || k === 'master' || k === 'ra';
export const FUND_KIND: Record<string, string> = { vertical: '纵向', fiscal: '财政', horizontal: '横向' };
// 一张经费卡当年可用的总数（下达数连同上年结转）和其中已分到科目的部分。填了下达数的取所填的数，没填的取明细合计
export const cardTotal = (c: { granted: string | null; carried_in: string; cur: string; orig: string }) => (c.granted != null ? Number(c.granted) + Number(c.carried_in) + (Number(c.cur) - Number(c.orig)) : Number(c.cur));
export const cardGranted = (c: { granted: string | null; carried_in: string; orig: string }) => (c.granted != null ? Number(c.granted) : Number(c.orig) - Number(c.carried_in));
export const FUND_SOURCE: Record<string, string> = { school: '学校', national: '国家', provincial: '省部', enterprise: '企业', other: '其他' };
export const END_RULE: Record<string, string> = { recall: '到期回收', carry: '结转', return: '结余上缴' };
export const REQ: Record<ReqStatus, [string, string]> = {
  pending: ['待确认', 'warn'], committed: ['待提交学校', 'pri'], at_school: ['学校审核中', 'pri'], posted: ['已入账', 'ok'],
  returned: ['已退回', 'bad'], released: ['已释放', ''], rejected: ['已驳回', ''],
};
// 待批的申请停在哪一步
export const STEP: Record<string, [string, string]> = { confirm: ['待研究单元负责人确认', 'warn'], director: ['待中心负责人审批', 'warn'], check: ['待财务岗核对', 'warn'] };
export const reqBadge = (r: { status: ReqStatus; step?: string | null; over_amount?: string | null }): [string, string] =>
  r.status !== 'pending' || !r.step ? REQ[r.status] : r.step === 'director' && Number(r.over_amount ?? 0) > 0 ? ['超预算，待中心负责人审批', 'bad'] : STEP[r.step];
export const VERDICT: Record<string, [string, string]> = {
  yes: ['可报销', 'ok'], conditional: ['有条件报销', 'warn'], no: ['不可报销', 'bad'], disputed: ['有争议', 'warn'],
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

// 指标卡；给了 meter 就在数字下面画一条占比
export const Tile = ({ k, v, f, tone, color, meter }: { k: string; v: ReactNode; f?: ReactNode; tone?: string; color?: string; meter?: number }) => (
  <div className="tile"><div className="k">{color && <i style={{ background: color }} />}{k}</div><div className={`v ${tone ?? ''}`}>{v}</div>
    {meter != null && <div className="mt"><i style={{ width: `${Math.min(100, Math.max(0, meter * 100))}%`, background: color ?? 'var(--ink)' }} /></div>}
    {f && <div className="f">{f}</div>}</div>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function Loading({ error }: { error?: Error }) {
  return error ? <div className="msg bad" role="alert">{error.message}</div> : <p className="empty">加载中…</p>;
}

// 一个带若干输入项的确认框，用于批准以外需要补充信息的操作
export interface Field { name: string; label: string; type?: 'text' | 'date' | 'number' | 'month' | 'check' | 'multi' | 'area'; value?: string; required?: boolean; options?: [string, string][] }
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
            ) : f.type === 'area' ? (
              <textarea rows={8} required={f.required ?? true} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
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

// 一笔申请走到哪一步：申请 → 确认 → 交学校 → 入账。已驳回、已释放的不画
export const FLOW = ['申请', '确认', '提交学校', '入账'];
export function Flow({ status }: { status: ReqStatus }) {
  const at = ({ pending: 1, committed: 2, returned: 2, at_school: 3, posted: 4, released: -1, rejected: -1 } as Record<ReqStatus, number>)[status];
  if (at < 0) return null;
  return (
    <ol className="flow" aria-label={at >= FLOW.length ? '四个环节均已完成' : `已完成 ${at} 个环节，当前等待${FLOW[at]}`}>
      {FLOW.map((s, i) => <li key={s} title={s} className={i < at ? 'done' : i === at ? (status === 'returned' ? 'now bad' : 'now') : ''} />)}
    </ol>
  );
}
