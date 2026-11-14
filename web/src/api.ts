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

const LISTS: Record<string, string[]> = { me: ['perms', 'scoped'], role: ['perms'] };
export const view = <T,>(name: string, filter: Record<string, string> = {}): Promise<T[]> =>
  send(`/api/v/${name}${Object.keys(filter).length ? '?' + new URLSearchParams(filter) : ''}`)
    .then((rows) => LISTS[name] && Array.isArray(rows) ? rows.map((r: Record<string, unknown>) => ({ ...r, ...Object.fromEntries(LISTS[name].map((k) => [k, list(r[k])])) })) : rows);

export const rpc = (fn: string, args: Record<string, unknown>) =>
  send(`/api/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    .then((b) => b.result);

// 密钥单独走这两个接口：保存时由服务端加密，取用时记一条取用记录；页面不缓存明文
const post = (path: string, body: unknown) => send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((b) => b.result);
export const secretSet = (kind: 'resource' | 'allocation', id: string, secret: string): Promise<string | null> => post('/api/secret/set', { kind, id, secret });
export const secretGet = (kind: 'resource' | 'allocation', id: string): Promise<string> => post('/api/secret/get', { kind, id });

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
export type Kind = 'postdoc' | 'phd' | 'master' | 'ra' | 'ri' | 'visitor';
// 数组列万一回来是 {a,b} 这样的字符串，也还原成数组
export const list = (v: unknown): string[] => Array.isArray(v) ? v : typeof v === 'string' && v.length > 2 && v[0] === '{' ? v.slice(1, -1).split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
export interface Me { id: string; name: string; role: Role; kind?: Kind | null; perms: string[]; scoped: string[] }
export interface Perm { code: string; name: string; grp: string; scope: 'global' | 'project' | 'card'; sort: number }
export interface RoleDef { id: string; code: string | null; name: string; note: string | null; builtin: boolean; locked: boolean; implicit: boolean; sort: number; perms: string[]; holders: number }
export interface RoleGrant { id: string; user_id: string; user_name: string; role_id: string; role_name: string; project_id: string | null; project_name: string | null;
  card_id: string | null; card_name: string | null; from_date: string; to_date: string | null; note: string | null; granted_by_name: string | null; granted_at: string;
  revoked_at: string | null; revoked_by_name: string | null; state: 'active' | 'upcoming' | 'expired' | 'revoked' }
export interface RbacLog { id: number; at: string; actor_name: string | null; action: string; user_name: string | null; summary: string }
export interface Card {
  card_id: string; card_no: string; name: string; status: 'active' | 'settled';
  start_date: string; cutoff_date: string; settle_date: string | null; end_rule: 'recall' | 'carry' | 'return';
  orig: string; adj: string; cur: string; commit: string; actual: string; avail: string;
  template_id: string; template_name: string; locked: boolean; owner_id: string | null; rule_note: string | null;
  school_balance: string | null; school_frozen: string | null; school_available: string | null; school_synced_at: string | null;
  fund_kind: 'vertical' | 'fiscal' | 'horizontal' | null; received: string | null; priority: number | null;
  total_amount: string | null; period_start: string | null; period_end: string | null;
  project_id: string; year: number; applied: string | null; carried_in: string; recalled: string | null; carried_out: string | null;
}
// 经费项目：额度和期限在这里；每年下来的经费是它下面当年的一张经费卡
export interface FundProject { id: string; name: string; source: 'school' | 'national' | 'provincial' | 'enterprise' | 'other' | null; fund_kind: 'vertical' | 'fiscal' | 'horizontal' | null;
  owner_id: string | null; owner_name: string | null; quota: string | null; period_start: string | null; period_end: string | null; template_id: string; template_name: string;
  end_rule: 'recall' | 'carry' | 'return'; note: string | null; status: 'active' | 'closed'; granted: string; recalled: string; cards: number }
export interface Cell { card_id: string; subject_id: string; subject_code: string; subject_name: string; sort: number;
  orig: string; adj: string; cur: string; commit: string; actual: string; avail: string }
export interface Node { node_id: string; card_id: string; node_date: string; ratio: string; consequence: string; need: string; forecast: string }
export interface Cap { card_id: string; cap_id: string; name: string; max_ratio: string; used: string; max_amount: string }
export interface CardPick { id: string; card_no: string; name: string; template_id: string; start_date: string; cutoff_date: string; status: string; year: number }
export interface Subject { id: string; template_id: string; code: string; name: string; school_name: string | null; sort: number }
export interface ExpenseType { id: string; name: string; required_path: string | null }
export type ReqStatus = 'pending' | 'committed' | 'at_school' | 'posted' | 'returned' | 'released' | 'rejected';
export interface Req {
  id: string; code: string | null; card_id: string | null; subject_id: string; expense_type_id: string; title: string; amount: string;
  eta_date: string; emergency: boolean; status: ReqStatus; requested_by: string | null; created_at: string;
  path: string | null; stage: number | null; stages: number | null; posted_on: string | null; posted_amount: string | null; voucher_no: string | null;
  morningstar_quota_id: string | null; split_group: string | null; project_id: string | null; budget_line_id: string | null;
  // 待批的申请停在哪一步；空的是老路（公共开支、按卡直接提的），由中心负责人直接批准
  step: 'confirm' | 'director' | 'check' | null; over_amount: string | null; self_confirmed: boolean | null; return_note: string | null;
  project_name: string | null; line_purpose: string | null; requester_name: string | null; confirmed_by_name: string | null; checked_by_name: string | null; can_confirm: boolean;
}
export interface Change { id: string; card_id: string; reason: string; status: 'pending' | 'filed' | 'approved' | 'rejected';
  approved_on: string | null; created_at: string; lines: { subject_id: string; delta: number }[] | null }
export interface Rule { card_id: string; expense_type_id: string; ruled_on: string; ruled_by: string | null; note: string | null; verdict: string }
export interface Ruling extends Rule { id: string; source: string | null }
export interface FundEvent { id: string; card_id: string; kind: string; event_date: string; amount: string; todo: string | null; done: boolean; created_at: string }
export interface ReqEvent { id: string; request_id: string; at: string; kind: string; note: string | null }
export interface Person { id: string; name: string }
export interface PayType { id: string; name: string; subject_code: string; monthly_cap: string | null }
export interface Staff { id: string; person_id: string; pay_type_id: string; month: string; card_id: string; amount: string; sheet_id: string | null; gap: string | null }
export interface Sheet { id: string; month: string; pay_type_id: string; card_id: string; status: 'draft' | 'submitted' | 'posted'; posted_on: string | null; total: string }
export interface YearActual { card_id: string; year: number; actual: string }
export interface SettleCheck { card_id: string; open_requests: number; open_changes: number; open_staff: number }
export interface SettleLine { id: string; card_id: string; settled_on: string; subject_id: string; budget: string; actual: string; balance: string }
export interface User { id: string; name: string; role: Role; active: boolean; kind?: Kind | null }
export interface Template { id: string; code: string; name: string; locked: boolean; cards: number }
export interface TemplateCap { id: string; template_id: string; name: string; max_ratio: string; subject_ids: string[] }
export interface UserAdmin { id: string; name: string; email: string | null; role: Role; active: boolean; linked: boolean; migrated: boolean; created_at: string; cards: number; requests: number }
export interface Outbox { id: number; created_at: string; user_id: string | null; user_name: string | null; text: string; status: 'queued' | 'sent' | 'failed' | 'expired'; attempts: number; last_error: string | null; sent_at: string | null }
export interface Quota { id: string; leader_id: string; leader_name: string; year: number; amount: string; labor_cap_ratio: string; used: string; actual: string; labor_used: string;
  requests: number; labor_cap: string; quarter: number; due: string; behind: boolean; project_id: string | null }
export interface QuotaPick { id: string; leader_name: string; year: number }
export interface Resource { id: string; kind: 'api' | 'asset'; name: string; ref: string | null; total: string | null; unit: string | null; note: string | null; active: boolean; allocated: string; holders: number;
  provider: string | null; model: string | null; currency: string | null; balance: string | null; balance_on: string | null; category: string | null; spec: string | null;
  unit_price: string | null; bundle: string | null; location: string | null; used: string; asked: string; has_secret: boolean; secret_hint: string | null }
export interface Allocation { id: string; resource_id: string; kind: 'api' | 'asset'; resource_name: string; ref: string | null; unit: string | null; user_id: string; user_name: string;
  quota: string | null; from_date: string; to_date: string | null; note: string | null; returned_on: string | null; current: boolean;
  used: string | null; used_on: string | null; asset_no: string | null; location: string | null; request_id: string | null; spec: string | null; model: string | null; provider: string | null;
  has_secret: boolean; secret_hint: string | null }
export interface ResourcePick { id: string; kind: 'api' | 'asset'; name: string; unit: string | null; category: string | null; spec: string | null; bundle: string | null; provider: string | null; model: string | null;
  unit_price: string | null; left_: string | null; single: boolean }
export type ResReqStatus = 'pending' | 'reviewed' | 'approved' | 'fulfilled' | 'rejected' | 'withdrawn';
export interface ResourceRequest { id: string; kind: 'api' | 'asset'; resource_id: string | null; resource_name: string | null; unit: string | null; project_id: string | null; project_code: string | null; project_name: string | null;
  requested_by: string; requester_name: string; amount: string; period: string | null; purpose: string; usage_note: string | null; urgent: boolean; status: ResReqStatus;
  reviewed_at: string | null; reviewed_by_name: string | null; approved_amount: string | null; decided_at: string | null; decided_by_name: string | null; decide_note: string | null; fulfilled_at: string | null; created_at: string; my_project: boolean;
  budget_line_id: string; line_purpose: string | null; plan_qty: string | null; priority: boolean }
export interface ResourceStock { id: string; resource_id: string; kind: 'api' | 'asset'; resource_name: string; unit: string | null; qty: string; unit_price: string | null; supplier: string | null; note: string | null;
  received_on: string; expense_request_id: string | null; created_by_name: string | null; project_id: string | null; project_name: string | null; line_purpose: string | null }
export interface SecretAccess { id: string; owner_kind: 'resource' | 'allocation'; owner_id: string; at: string; user_name: string; resource_name: string; holder_name: string | null }
export interface PettyCash { id: string; requested_by: string; requester_name: string; amount: string; purpose: string; status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'settled';
  decided_at: string | null; decided_by_name: string | null; decide_note: string | null; spent: string | null; settled_on: string | null; settle_note: string | null; expense_request_id: string | null; created_at: string;
  project_id: string; project_code: string | null; project_name: string | null; budget_line_id: string; line_purpose: string | null }
export interface LegacyMsSub { id: string; leader_name: string; file_name: string | null; submitted_at: string | null; total: string | null; approved: string | null; pending: string | null; rejected: string | null; status: string; comment: string | null }
export interface LegacyMsItem { id: string; submission_id: string; leader_name: string; serial: string | null; expense_type: string | null; parent_category: string | null; quantity: string | null; unit_amount: string | null;
  requested: string | null; approved: string | null; note: string | null; comment: string | null; status: string; card_name: string | null; subject_name: string | null; row_no: string }
export interface LegacyAdjust { id: string; card_id: string; subject_name: string; previous: string | null; amount: string | null; reason: string | null; version: string | null; adjusted_at: string | null }
export interface LegacyResReq { id: string; applicant: string; kind: string | null; resource: string | null; project: string | null; purpose: string | null; usage: string | null; amount: string | null; period: string | null; status: string | null; applied_at: string | null; comment: string | null }
export interface LegacyLedger { id: string; user_name: string; resource: string | null; project: string | null; period: string | null; total: string | null; used: string | null; remaining: string | null; valid_to: string | null }
export interface LegacySource { source: string; name: string; n: number }
export interface LegacyRecon { step: number; sort: number; key: string; source: string | null; label: string; old_n: number; old_amt: string | null; in_n: number | null; in_amt: string | null;
  new_n: number | null; new_amt: string | null; place: string | null; note: string | null; ok: boolean | null; all_n: number }
export interface LegacyRecord { source: string; record_id: string; status: string | null; data: Record<string, unknown> | null }
export interface Emergency { year: number; per_request: string; per_year: string; used: string }

// ---------- 年度预算 ----------
export type BudgetStage = 'declare' | 'summary' | 'approved' | 'applied' | 'granted' | 'fixed' | 'issued' | 'closed';
export interface Project { id: string; code: string; name: string; kind: 'project' | 'line' | 'public'; owner_id: string | null; owner_name: string | null; active: boolean; mine: boolean; labor_cap_ratio: string | null;
  layer: 'big' | 'paper'; parent_id: string | null; parent_code: string | null; parent_name: string | null; parent_owner_id: string | null; seen: boolean;
  member: boolean; can_roster: boolean; members: number }
export interface ProjectMember { id: string; project_id: string; user_id: string; user_name: string; joined_on: string; left_on: string | null; added_by_name: string | null; holding: number }
export interface PeoplePick { id: string; name: string }
export interface Task { id: string; title: string; detail: string | null; assignee_id: string; assignee_name: string | null; due_date: string | null; card_id: string | null; card_name: string | null;
  status: 'open' | 'done' | 'cancelled'; created_by: string; creator_name: string | null; created_at: string; closed_by_name: string | null; closed_at: string | null; close_note: string | null;
  steps: number; steps_done: number; mine: boolean; can_manage: boolean }
export interface TaskStep { id: string; task_id: string; sort: number; text: string; done: boolean; done_by_name: string | null; done_at: string | null; note: string | null }
export interface ProjectCap { year: number; project_id: string; amount: string; used: string }
export interface CapRequest { id: string; year: number; project_id: string; project_name: string; amount: string; reason: string; status: 'pending' | 'approved' | 'rejected';
  requester_name: string | null; decide_note: string | null; created_at: string; decided_at: string | null; cap: string | null; used: string }
export interface BudgetShift { id: string; year: number; project_id: string; project_name: string; from_line: string; from_purpose: string; to_line: string; to_purpose: string;
  amount: string; note: string; status: 'applied' | 'pending' | 'rejected'; requester_name: string | null; decided_by_name: string | null; decide_note: string | null; created_at: string; decided_at: string | null; to_project_id: string | null; to_project_name: string | null }
export interface ProjectAsset { id: string; project_id: string; resource_id: string; resource_name: string; unit: string | null; qty: string; unit_price: string | null; received_on: string; line_purpose: string | null; holders: string | null }
export interface ProjectAllocation { id: string; project_id: string; resource_id: string; resource_name: string; unit: string | null; user_id: string; user_name: string;
  quota: string | null; used: string | null; used_on: string | null; from_date: string; to_date: string | null; returned_on: string | null; current: boolean }
export interface YearCheck { year: number; resource_id: string; kind: 'api' | 'asset'; resource_name: string; unit: string | null; book_now: string; book: string | null; actual: string | null; diff: string | null;
  note: string | null; checked_by_name: string | null; checked_at: string | null }
export interface RuleLookup { expense_type_id: string; name: string; required_path: string | null; can_yes: boolean; has_cond: boolean; has_no: boolean; disputed: boolean; notes: string | null; ruled_on: string | null }
export interface BudgetCategory { id: string; code: string; name: string; labor: boolean; sort: number; active: boolean }
export interface BudgetYear { year: number; due_date: string; stage: BudgetStage; applied_on: string | null; granted_on: string | null; approved_at: string | null; approved_by_name: string | null;
  granted_amount: string | null; fixed_total: string | null; issued_at: string | null; closed_at: string | null }
export interface ProjectBudget { id: string; year: number; project_id: string; status: 'draft' | 'submitted' | 'returned'; return_note: string | null; submitted_at: string | null; submitted_by_name: string | null }
export interface BudgetLine { id: string; budget_id: string; year: number; project_id: string; category_id: string; purpose: string; q1: string; q2: string; q3: string; q4: string;
  declared: string; applied: string | null; adjust_note: string | null; fixed: string | null;
  resource_id: string | null; resource_name: string | null; resource_kind: 'api' | 'asset' | null; resource_unit: string | null; plan_qty: string | null }
export interface ResourcePlan { id: string; year: number; project_id: string; project_code: string; project_name: string; category_name: string; purpose: string;
  resource_id: string; resource_name: string; kind: 'api' | 'asset'; unit: string | null; plan_qty: string; asked: string; granted: string; open: boolean; project_kind: 'project' | 'line' | 'public' }
export interface CategorySubject { category_id: string; subject_id: string }
export interface BudgetAlloc { id: string; line_id: string; year: number; project_id: string; card_id: string | null; card_no: string | null; card_name: string | null; end_rule: 'recall' | 'carry' | 'return'; card_end: string;
  subject_id: string; subject_name: string; amount: string; used: string; actual: string }
export interface LineExec { id: string; year: number; project_id: string; category_id: string; purpose: string; q1: string; q2: string; q3: string; q4: string;
  fixed: string | null; allocated: string; used: string; actual: string; pending: string; a1: string; a2: string; a3: string; a4: string }
export interface LinePick { id: string; project_id: string; project_code: string; project_name: string; category_id: string; category_name: string; purpose: string }
export interface BudgetRevision { id: string; line_id: string; year: number; project_id: string; purpose: string; old_amount: string; new_amount: string; note: string | null; revised_by_name: string | null; revised_at: string }
export interface BudgetReview { id: string; year: number; quarter: number; project_id: string; note: string | null; reviewed_by_name: string | null; reviewed_at: string }
