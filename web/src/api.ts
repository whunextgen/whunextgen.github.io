// 所有请求都走这里。接口与页面同源，登录态在 HttpOnly Cookie 里，页面拿不到也不需要拿。
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function send(path: string, init?: RequestInit) {
  const r = await fetch(path, { credentials: 'same-origin', ...init });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, body?.error ?? `请求失败（${r.status}）`);
  return body;
}

export const view = <T,>(name: string, filter: Record<string, string> = {}): Promise<T[]> =>
  send(`/api/v/${name}${Object.keys(filter).length ? '?' + new URLSearchParams(filter) : ''}`);

export const rpc = (fn: string, args: Record<string, unknown>) =>
  send(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    .then((b) => b.result);

export const logout = () => send('/auth/logout', { method: 'POST' });

// 一次取多张视图；reload 用于写操作之后刷新
export function useViews<T extends Record<string, unknown[]>>(spec: { [K in keyof T]: [string, Record<string, string>?] }, key = '') {
  const [state, set] = useState<{ data?: T; error?: ApiError }>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const names = Object.keys(spec) as (keyof T)[];
    Promise.all(names.map((k) => view(spec[k][0], spec[k][1])))
      .then((rows) => live && set({ data: Object.fromEntries(names.map((k, i) => [k, rows[i]])) as T }))
      .catch((error) => live && set({ error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ---------- 视图的行 ----------
export type Role = 'finance' | 'director' | 'leader' | 'member';
export interface Me { id: string; name: string; role: Role }
export interface Card {
  card_id: string; card_no: string; name: string; status: 'active' | 'settled';
  start_date: string; cutoff_date: string; settle_date: string | null; end_rule: 'recall' | 'carry' | 'return';
  orig: string; adj: string; cur: string; commit: string; actual: string; avail: string;
  template_id: string; template_name: string; locked: boolean; owner_id: string | null; rule_note: string | null;
  school_balance: string | null; school_frozen: string | null; school_available: string | null; school_synced_at: string | null;
}
export interface Cell { card_id: string; subject_id: string; subject_code: string; subject_name: string; sort: number;
  orig: string; adj: string; cur: string; commit: string; actual: string; avail: string }
export interface Node { node_id: string; card_id: string; node_date: string; ratio: string; consequence: string; need: string; forecast: string }
export interface Cap { card_id: string; cap_id: string; name: string; max_ratio: string; used: string; max_amount: string }
export interface CardPick { id: string; card_no: string; name: string; template_id: string; start_date: string; cutoff_date: string; status: string }
export interface Subject { id: string; template_id: string; code: string; name: string; sort: number }
export interface ExpenseType { id: string; name: string; required_path: string | null }
export type ReqStatus = 'pending' | 'committed' | 'at_school' | 'posted' | 'returned' | 'released' | 'rejected';
export interface Req {
  id: string; code: string | null; card_id: string; subject_id: string; expense_type_id: string; title: string; amount: string;
  eta_date: string; emergency: boolean; status: ReqStatus; requested_by: string | null; created_at: string;
  path: string | null; stage: number | null; stages: number | null; posted_on: string | null; posted_amount: string | null; voucher_no: string | null;
}
export interface Change { id: string; card_id: string; reason: string; status: 'pending' | 'filed' | 'approved' | 'rejected';
  approved_on: string | null; created_at: string; lines: { subject_id: string; delta: number }[] | null }
export interface Rule { card_id: string; expense_type_id: string; ruled_on: string; ruled_by: string | null; note: string | null; verdict: string }
export interface Ruling extends Rule { id: string; source: string | null }
export interface SettleLine { id: string; card_id: string; settled_on: string; subject_id: string; budget: string; actual: string; balance: string }
export interface User { id: string; name: string; role: Role; active: boolean }
