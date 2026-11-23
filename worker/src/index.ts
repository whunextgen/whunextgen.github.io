// API 层：飞书登录、会话、只读视图、业务函数。
// 所有校验都在数据库函数里；这里只负责认出是谁，并把身份带进事务。
import postgres from 'postgres';

export interface Env {
  HYPERDRIVE: { connectionString: string };   // 以 app_api 角色连接 Supabase Postgres
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  // 发通知用的应用（机器人）。不设时沿用登录应用
  FEISHU_BOT_APP_ID?: string;
  FEISHU_BOT_APP_SECRET?: string;
  FEISHU_TENANT_KEY?: string;                 // 设了就只允许本租户
  SESSION_SECRET: string;
  APP_ORIGIN?: string;                        // 前端地址；不设时前端与接口同源（页面由本 Worker 的静态资源提供）
  VAULT_KEY?: string;                         // 加密密钥与账号用的口令；丢了，库里存的密钥就解不开
  FEISHU_NOTIFY?: string;                     // 设为 on 才真正发飞书通知；不设时消息只在数据库里排队，过 24 小时作废
}

export const VIEWS = new Set(['name_option', 'name_poll', 'me', 'users', 'card_pick', 'fund_project', 'card_school_subject', 'card_subject_map', 'card_income', 'subject', 'expense_type', 'card', 'cell', 'node', 'cap', 'rule', 'ruling',
  'request', 'request_event', 'procurement_event', 'budget_change', 'fund_event', 'person', 'pay_type', 'staff',
  'payroll_sheet', 'settlement', 'emergency', 'year_actual', 'settle_check',
  'template', 'template_cap', 'user_admin', 'outbox', 'project_tag', 'resource', 'allocation',
  'legacy_ms_submission', 'legacy_ms_item', 'legacy_budget_adjust', 'legacy_resource_request', 'legacy_quota_ledger', 'legacy_source', 'legacy_record', 'legacy_recon',
  'project', 'budget_category', 'budget_year', 'project_budget', 'budget_line',
  'budget_plan', 'budget_source', 'budget_module', 'budget_tier', 'tier_pick', 'module_topic', 'unit_apply', 'unit_exec',
  'token_param', 'tier_token', 'token_me', 'time_log', 'unit_pool', 'unit_share', 'outcome',
  'biweekly_report', 'biweekly_status',
  'category_subject', 'budget_alloc', 'line_exec', 'line_pick', 'budget_revision', 'budget_review',
  'resource_pick', 'resource_plan', 'resource_request', 'resource_stock', 'secret_access', 'petty_cash',
  'perm', 'role', 'role_grant', 'rbac_log',
  'api_token', 'api_call',
  'project_member', 'people_pick', 'project_cap', 'cap_request', 'budget_shift', 'project_asset', 'project_allocation', 'year_check', 'rule_lookup', 'task', 'task_step']);

// 函数名 → 参数名与类型（按位置传给数据库函数）
export const RPC: Record<string, [string, string][]> = {
  submit_request: [['card_id', 'uuid'], ['subject_id', 'uuid'], ['expense_type_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['eta_date', 'date'], ['emergency', 'boolean'], ['path', 'text']],
  approve_request: [['id', 'uuid']],
  reject_request: [['id', 'uuid'], ['note', 'text']],
  send_to_school: [['id', 'uuid']],
  post_voucher: [['id', 'uuid'], ['posted_on', 'date'], ['amount', 'numeric'], ['voucher_no', 'text']],
  school_return: [['id', 'uuid'], ['reason', 'text']],
  move_request: [['id', 'uuid'], ['card_id', 'uuid'], ['subject_id', 'uuid']],
  release_request: [['id', 'uuid']],
  procurement_advance: [['id', 'uuid']],
  procurement_fail: [['id', 'uuid'], ['kind', 'text'], ['reason', 'text'], ['delay_days', 'int']],
  create_change: [['card_id', 'uuid'], ['reason', 'text'], ['lines', 'jsonb']],
  confirm_change: [['id', 'uuid']],
  reject_change: [['id', 'uuid']],
  approve_change: [['id', 'uuid'], ['approved_on', 'date']],
  reassign_staff: [['person_id', 'uuid'], ['pay_type_id', 'uuid'], ['from_month', 'date'], ['to_month', 'date'], ['card_id', 'uuid']],
  build_payroll: [['month', 'date']],
  post_payroll: [['id', 'uuid'], ['posted_on', 'date']],
  settle_card: [['card_id', 'uuid']],
  reopen_card: [['card_id', 'uuid'], ['note', 'text']],
  add_ruling: [['card_id', 'uuid'], ['expense_type_id', 'uuid'], ['ruled_on', 'date'], ['ruled_by', 'text'], ['verdict', 'text'], ['note', 'text'], ['source', 'text']],
  finish_fund_event: [['id', 'uuid']],
  add_fund_event: [['card_id', 'uuid'], ['kind', 'text'], ['event_date', 'date'], ['amount', 'numeric'], ['todo', 'text']],
  save_expense_type: [['id', 'uuid'], ['name', 'text'], ['required_path', 'text']],
  save_person: [['id', 'uuid'], ['name', 'text']],
  save_pay_type: [['id', 'uuid'], ['name', 'text'], ['subject_code', 'text'], ['monthly_cap', 'numeric']],
  set_staff: [['person_id', 'uuid'], ['pay_type_id', 'uuid'], ['from_month', 'date'], ['to_month', 'date'], ['card_id', 'uuid'], ['amount', 'numeric']],
  set_user_role: [['user_id', 'uuid'], ['role', 'text'], ['active', 'boolean']],
  set_user_kind: [['user_id', 'uuid'], ['kind', 'text']],
  save_role: [['id', 'uuid'], ['name', 'text'], ['note', 'text'], ['perms', 'jsonb']],
  delete_role: [['id', 'uuid']],
  grant_role: [['user_id', 'uuid'], ['role_id', 'uuid'], ['project_id', 'uuid'], ['card_id', 'uuid'], ['from_date', 'date'], ['to_date', 'date'], ['note', 'text']],
  revoke_grant: [['id', 'uuid'], ['note', 'text']],
  save_template: [['id', 'uuid'], ['code', 'text'], ['name', 'text'], ['locked', 'boolean']],
  save_subject: [['id', 'uuid'], ['template_id', 'uuid'], ['code', 'text'], ['name', 'text'], ['school_name', 'text'], ['sort', 'int']],
  delete_subject: [['id', 'uuid']],
  save_cap: [['id', 'uuid'], ['template_id', 'uuid'], ['name', 'text'], ['max_ratio', 'numeric'], ['subject_ids', 'jsonb']],
  delete_cap: [['id', 'uuid']],
  save_card: [['id', 'uuid'], ['card_no', 'text'], ['name', 'text'], ['template_id', 'uuid'], ['owner_id', 'uuid'], ['start_date', 'date'],
    ['cutoff_date', 'date'], ['settle_date', 'date'], ['end_rule', 'text'], ['rule_note', 'text']],
  set_node: [['card_id', 'uuid'], ['node_date', 'date'], ['ratio', 'numeric'], ['consequence', 'text']],
  delete_node: [['id', 'uuid']],
  set_budget: [['card_id', 'uuid'], ['lines', 'jsonb']],
  save_card_subject: [['id', 'uuid'], ['card_id', 'uuid'], ['name', 'text']],
  delete_card_subject: [['id', 'uuid']],
  map_school_subject: [['card_id', 'uuid'], ['ledger', 'uuid'], ['subject', 'uuid']],
  set_emergency_limit: [['year', 'int'], ['per_request', 'numeric'], ['per_year', 'numeric']],
  save_user: [['id', 'uuid'], ['name', 'text'], ['email', 'text'], ['role', 'text'], ['active', 'boolean']],
  merge_user: [['from_id', 'uuid'], ['into_id', 'uuid']],
  set_school_balance: [['card_id', 'uuid'], ['balance', 'numeric'], ['frozen', 'numeric'], ['available', 'numeric']],
  post_vouchers: [['rows', 'jsonb']],
  save_budget_source: [['year', 'int'], ['fund_project', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  save_budget_module: [['id', 'uuid'], ['year', 'int'], ['project', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  save_budget_tier: [['id', 'uuid'], ['year', 'int'], ['name', 'text'], ['amount', 'numeric'], ['slots', 'int'], ['labor_ratio', 'numeric'], ['limits', 'jsonb']],
  publish_budget_plan: [['year', 'int'], ['on', 'boolean']],
  pick_tier: [['year', 'int'], ['project', 'uuid'], ['tier', 'uuid'], ['reason', 'text']],
  decide_tier: [['year', 'int'], ['project', 'uuid'], ['tier', 'uuid'], ['note', 'text'], ['on', 'date']],
  propose_project: [['year', 'int'], ['name', 'text'], ['tier', 'uuid'], ['reason', 'text'], ['units', 'text']],
  withdraw_proposal: [['year', 'int'], ['project', 'uuid']],
  propose_unit: [['id', 'uuid'], ['parent', 'uuid'], ['name', 'text'], ['meeting_on', 'date'], ['minutes_on', 'date'], ['note', 'text'], ['members', 'text']],
  propose_name: [['name', 'text'], ['note', 'text']],
  vote_name: [['option', 'uuid']],
  set_scholar_url: [['url', 'text']],
  approve_unit: [['unit', 'uuid']],
  confirm_unit: [['unit', 'uuid']],
  return_unit: [['unit', 'uuid'], ['note', 'text']],
  withdraw_unit: [['unit', 'uuid']],
  save_time_log: [['period', 'date'], ['items', 'jsonb']],
  confirm_time_logs: [['project', 'uuid'], ['period', 'date']],
  save_biweekly_report: [['project', 'uuid'], ['period', 'date'], ['stage', 'text'], ['question', 'text'], ['done', 'text'], ['changed', 'text'], ['issues', 'text'], ['division', 'text'], ['next', 'text']],
  set_pool_cap: [['project', 'uuid'], ['cap', 'numeric']],
  submit_outcome: [['project', 'uuid'], ['level', 'int'], ['link', 'text'], ['venue', 'text'], ['note', 'text']],
  check_outcome: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  set_token_param: [['key', 'text'], ['value', 'jsonb']],
  set_tier_token: [['tier', 'uuid'], ['amount', 'numeric']],
  reject_tier: [['year', 'int'], ['project', 'uuid'], ['note', 'text'], ['on', 'date']],
  settle_tiers: [['year', 'int']],
  unsettle_tiers: [['year', 'int']],
  set_project_morningstar: [['id', 'uuid'], ['on', 'boolean']],
  save_project: [['id', 'uuid'], ['code', 'text'], ['name', 'text'], ['kind', 'text'], ['owner_id', 'uuid'], ['active', 'boolean'], ['parent_id', 'uuid']],
  save_budget_category: [['id', 'uuid'], ['code', 'text'], ['name', 'text'], ['labor', 'boolean'], ['sort', 'int'], ['active', 'boolean']],
  open_budget_year: [['year', 'int'], ['due_date', 'date']],
  save_budget_line: [['id', 'uuid'], ['year', 'int'], ['project_id', 'uuid'], ['category_id', 'uuid'], ['purpose', 'text'], ['q1', 'numeric'], ['q2', 'numeric'], ['q3', 'numeric'], ['q4', 'numeric']],
  delete_budget_line: [['id', 'uuid']],
  set_project_budget: [['year', 'int'], ['project_id', 'uuid'], ['action', 'text'], ['note', 'text']],
  advance_budget_year: [['year', 'int'], ['action', 'text'], ['amount', 'numeric'], ['on_date', 'date']],
  adjust_budget_line: [['id', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  set_category_subjects: [['category_id', 'uuid'], ['subjects', 'jsonb']],
  allocate_line: [['id', 'uuid'], ['parts', 'jsonb']],
  auto_allocate: [['year', 'int']],
  submit_project_request: [['line_id', 'uuid'], ['expense_type_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['eta_date', 'date'], ['emergency', 'boolean'], ['path', 'text'], ['unit_id', 'uuid']],
  set_request_line: [['id', 'uuid'], ['line_id', 'uuid']],
  review_project: [['year', 'int'], ['quarter', 'int'], ['project_id', 'uuid'], ['note', 'text']],
  revise_fixed: [['id', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  submit_split: [['expense_type_id', 'uuid'], ['title', 'text'], ['eta_date', 'date'], ['path', 'text'], ['parts', 'jsonb']],
  save_resource: [['id', 'uuid'], ['kind', 'text'], ['name', 'text'], ['ref', 'text'], ['total', 'numeric'], ['unit', 'text'], ['note', 'text'], ['active', 'boolean']],
  allocate_resource: [['resource_id', 'uuid'], ['user_id', 'uuid'], ['quota', 'numeric'], ['from_date', 'date'], ['to_date', 'date'], ['note', 'text']],
  return_allocation: [['id', 'uuid'], ['returned_on', 'date']],
  set_resource_info: [['id', 'uuid'], ['info', 'jsonb']],
  stock_in: [['resource_id', 'uuid'], ['qty', 'numeric'], ['unit_price', 'numeric'], ['received_on', 'date'], ['supplier', 'text'], ['note', 'text'], ['request_id', 'uuid']],
  set_allocation_info: [['id', 'uuid'], ['used', 'numeric'], ['used_on', 'date'], ['asset_no', 'text'], ['location', 'text']],
  save_resource_request: [['id', 'uuid'], ['kind', 'text'], ['resource_id', 'uuid'], ['line_id', 'uuid'], ['amount', 'numeric'], ['period', 'date'],
    ['purpose', 'text'], ['usage_note', 'text'], ['urgent', 'boolean'], ['unit_id', 'uuid']],
  decide_resource_request: [['id', 'uuid'], ['action', 'text'], ['amount', 'numeric'], ['note', 'text']],
  fulfil_resource_request: [['id', 'uuid'], ['resource_id', 'uuid'], ['to_date', 'date'], ['note', 'text']],
  save_petty_cash: [['id', 'uuid'], ['amount', 'numeric'], ['purpose', 'text'], ['line_id', 'uuid'], ['unit_id', 'uuid']],
  set_line_resource: [['line_id', 'uuid'], ['resource_id', 'uuid'], ['qty', 'numeric']],
  decide_petty_cash: [['id', 'uuid'], ['action', 'text'], ['note', 'text']],
  settle_petty_cash: [['id', 'uuid'], ['spent', 'numeric'], ['settled_on', 'date'], ['note', 'text'], ['request_id', 'uuid']],
  set_card_info: [['card_id', 'uuid'], ['fund_kind', 'text'], ['received', 'numeric'], ['priority', 'int']],
  record_expense: [['card_id', 'uuid'], ['subject_id', 'uuid'], ['expense_type_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['posted_on', 'date'], ['voucher_no', 'text'], ['line_id', 'uuid']],
  record_expenses: [['rows', 'jsonb']],
  set_card_total: [['card_id', 'uuid'], ['total', 'numeric'], ['period_start', 'date'], ['period_end', 'date']],
  save_fund_project: [['id', 'uuid'], ['name', 'text'], ['source', 'text'], ['fund_kind', 'text'], ['owner_id', 'uuid'], ['quota', 'numeric'], ['period_start', 'date'], ['period_end', 'date'], ['template_id', 'uuid'], ['end_rule', 'text'], ['note', 'text']],
  open_card: [['project_id', 'uuid'], ['year', 'int'], ['card_no', 'text'], ['applied', 'numeric'], ['start_date', 'date'], ['cutoff_date', 'date'], ['settle_date', 'date'], ['name', 'text']],
  set_card_applied: [['card_id', 'uuid'], ['applied', 'numeric']],
  set_card_granted: [['card_id', 'uuid'], ['granted', 'numeric']],
  import_ledger: [['card_id', 'uuid'], ['rows', 'jsonb'], ['incomes', 'jsonb'], ['opening', 'numeric'], ['balance', 'numeric'], ['pooled', 'boolean']],
  register_inflight: [['card_id', 'uuid'], ['title', 'text'], ['amount', 'numeric'], ['spent_on', 'date'], ['state', 'text'], ['subject_id', 'uuid'], ['user_id', 'uuid'], ['note', 'text']],
  void_stray_posted: [['card_id', 'uuid']],
  set_card_pooled: [['card_id', 'uuid'], ['pooled', 'boolean']],
  close_fund_project: [['id', 'uuid']],
  set_project_close_rule: [['id', 'uuid'], ['rule', 'text']],
  move_card: [['card_id', 'uuid'], ['project_id', 'uuid']],
  delete_card: [['card_id', 'uuid']],
  delete_fund_project: [['id', 'uuid']],
  add_project_member: [['project_id', 'uuid'], ['user_id', 'uuid']],
  remove_project_member: [['project_id', 'uuid'], ['user_id', 'uuid']],
  recall_project_allocation: [['id', 'uuid']],
  set_project_cap: [['year', 'int'], ['project_id', 'uuid'], ['amount', 'numeric']],
  request_cap: [['year', 'int'], ['project_id', 'uuid'], ['amount', 'numeric'], ['reason', 'text']],
  decide_cap_request: [['id', 'uuid'], ['ok', 'boolean'], ['amount', 'numeric'], ['note', 'text']],
  confirm_request: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  check_request: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  shift_budget: [['from_line', 'uuid'], ['to_line', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  decide_budget_shift: [['id', 'uuid'], ['ok', 'boolean'], ['note', 'text']],
  move_budget: [['from_line', 'uuid'], ['to_line', 'uuid'], ['amount', 'numeric'], ['note', 'text']],
  create_task: [['title', 'text'], ['assignee', 'uuid'], ['due', 'date'], ['card_id', 'uuid'], ['detail', 'text'], ['steps', 'text']],
  edit_task: [['id', 'uuid'], ['title', 'text'], ['assignee', 'uuid'], ['due', 'date'], ['detail', 'text']],
  add_task_steps: [['id', 'uuid'], ['steps', 'text']],
  tick_task_step: [['step', 'uuid'], ['done', 'boolean'], ['note', 'text']],
  finish_task: [['id', 'uuid'], ['note', 'text']],
  revoke_api_token: [['id', 'uuid']],
  cancel_task: [['id', 'uuid'], ['note', 'text']],
  reopen_task: [['id', 'uuid'], ['note', 'text']],
  save_year_check: [['year', 'int'], ['resource_id', 'uuid'], ['actual', 'numeric'], ['note', 'text']],
};

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function sign(secret: string, kind: string, value: string, ttlSeconds: number, now = Date.now()) {
  const body = `${kind}.${value}.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${body}.${await hmac(secret, body)}`;
}
export async function verify(secret: string, kind: string, token: string | undefined, now = Date.now()) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== kind) return null;
  const body = parts.slice(0, 3).join('.');
  if (!same(parts[3], await hmac(secret, body))) return null;
  if (Number(parts[2]) < now / 1000) return null;
  return parts[1];
}

// ---------- 密钥与账号：明文只在这一层出现，进数据库之前加密 ----------
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function vaultKey(secret: string) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret: string, owner: string, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(owner) }, await vaultKey(secret), enc.encode(plain));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function unseal(secret: string, owner: string, cipher: string) {
  const [v, iv, ct] = cipher.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('bad cipher');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv), additionalData: enc.encode(owner) }, await vaultKey(secret), unb64u(ct));
  return new TextDecoder().decode(pt);
}
export const mask = (s: string) => (s.length >= 12 ? `${s.slice(0, 3)}…${s.slice(-4)}` : '已保存');

const cookies = (req: Request) =>
  Object.fromEntries((req.headers.get('cookie') ?? '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), c.slice(i + 1)];
  }));
const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

async function feishu(path: string, init: RequestInit) {
  const r = await fetch('https://open.feishu.cn/open-apis' + path, init);
  return (await r.json()) as any;
}

// 连接不取类型表，数组列回来是 {a,b} 这样的字符串，这里还原成数组
const ARRAY_OIDS = new Set([1000, 1005, 1007, 1009, 1015, 1016, 1182, 1231, 2951]);
export function pgArray(v: unknown): unknown {
  if (typeof v !== 'string' || v[0] !== '{' || v[v.length - 1] !== '}') return v;
  const out: (string | null)[] = [];
  let i = 1;
  while (i < v.length - 1) {
    if (v[i] === ',') { i++; continue; }
    if (v[i] === '"') {
      let s = '';
      for (i++; i < v.length && v[i] !== '"'; i++) s += v[i] === '\\' ? v[++i] : v[i];
      out.push(s); i++;
    } else {
      let j = i;
      while (j < v.length - 1 && v[j] !== ',') j++;
      const s = v.slice(i, j);
      out.push(s === 'NULL' ? null : s); i = j;
    }
  }
  return out;
}
function fixArrays<R extends Record<string, unknown>>(rows: R[] & { columns?: { name: string; type: number }[] }): R[] {
  const cols = (rows.columns ?? []).filter((c) => ARRAY_OIDS.has(c.type)).map((c) => c.name);
  if (cols.length === 0) return rows;
  return rows.map((r) => { const o: Record<string, unknown> = { ...r }; for (const c of cols) o[c] = pgArray(o[c]); return o as R; });
}

async function withUser<T>(env: Env, uid: string | null, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false, prepare: false });
  try {
    return (await sql.begin(async (tx) => {
      await tx`select set_config('app.uid', ${uid ?? ''}, true)`;
      return fn(tx);
    })) as T;
  } finally {
    await sql.end({ timeout: 1 });
  }
}


// ---------- 读视图、调函数：页面接口和 MCP 接口共用 ----------
// run：以某人的身份执行一条带参数的语句。线上走 Hyperdrive；测试里换成内存数据库。
export type Run = (uid: string | null, text: string, params: unknown[]) => Promise<any[]>;
const pgRun = (env: Env): Run => (uid, text, params) => withUser(env, uid, (sql) => sql.unsafe(text, params as any)).then((r) => fixArrays(r as any));
async function readView(run: Run, uid: string, view: string, filters: [string, string][], limit = 2000) {
  const where = filters.map(([k], i) => `${k}::text = $${i + 1}`).join(' and ');
  return run(uid, `select * from api.${view}${where ? ' where ' + where : ''} limit ${Math.max(1, Math.min(2000, Math.floor(limit) || 2000))}`, filters.map(([, v]) => v));
}
async function callRpc(run: Run, uid: string, fn: string, body: Record<string, unknown>) {
  const spec = RPC[fn];
  const args = spec.map(([name, type]) => {
    const v = body[name];
    return v === undefined || v === null || v === '' ? null : type === 'jsonb' ? JSON.stringify(v) : String(v);
  });
  // 所有参数一律先按文本收、再转成目标类型。直接写 ::jsonb 或 ::boolean 时，驱动会按目标类型把已是文本的值再编码一次：
  // JSON 字符串被再编码成一个字符串；文本 'true' 被布尔编码器当成“不是 true”而写成 false
  const call = `select public.${fn}(${spec.map(([, type], i) => `$${i + 1}::text::${type}`).join(', ')}) as result`;
  const [row] = await run(uid, call, args);
  return row?.result ?? null;
}

// ---------- 访问令牌 ----------
export async function sha256hex(s: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const TOKEN_RE = /^clain_[A-Za-z0-9_-]{43}$/;
export const newToken = () => 'clain_' + b64u(crypto.getRandomValues(new Uint8Array(32)));

// ---------- MCP：后台的全部视图和函数，以令牌持有人的身份开放给智能体 ----------
// 无状态的 Streamable HTTP：每个 POST 一条 JSON-RPC 消息，直接回 JSON，不开 SSE。
// 工具只有五个，视图和函数的名字作为参数传：九十多个视图、一百三十多个函数逐个列成工具，客户端装不下。
// 密钥的保存和取用（/api/secret）不经 MCP 开放。
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const str = { type: 'string' } as const;
export const MCP_TOOLS = [
  { name: 'whoami', description: '当前令牌持有人的姓名、角色和权限。先调这个确认身份。', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_views', description: '列出可读的全部视图及其列。视图是只读的查询，例如 project（课题和研究单元）、budget_line（预算行）、request（支出申请）、card（经费卡）。可用 keyword 按名称筛选。',
    inputSchema: { type: 'object', properties: { keyword: { ...str, description: '视图名里包含的字样，可省略' } } } },
  { name: 'read_view', description: '读一个视图的行。只能看到令牌持有人本人有权看到的数据。filters 按列做等值筛选，最多返回 2000 行。',
    inputSchema: { type: 'object', required: ['view'], properties: { view: { ...str, description: '视图名，见 list_views' },
      filters: { type: 'object', description: '列名 → 值，等值筛选', additionalProperties: { type: 'string' } }, limit: { type: 'number', description: '最多返回的行数，默认 200，上限 2000' } } } },
  { name: 'list_actions', description: '列出可调用的全部操作（数据库函数）及其参数名和类型。操作会改动数据，例如提交支出申请、登记两周时间去向。可用 keyword 按名称筛选。',
    inputSchema: { type: 'object', properties: { keyword: { ...str, description: '操作名里包含的字样，可省略' } } } },
  { name: 'call_action', description: '调用一个操作，会改动生产数据，以令牌持有人的身份执行，各项权限和业务检查照常生效。需要可写的令牌。调用前先向使用者确认。',
    inputSchema: { type: 'object', required: ['action', 'args'], properties: { action: { ...str, description: '操作名，见 list_actions' }, args: { type: 'object', description: '参数名 → 值' } } } },
];
const MCP_HINT = 'CLAIN 中台的后台接口。先用 whoami 确认身份；list_views / read_view 查数据；list_actions / call_action 办理业务。四个基本对象：项目（学校一侧的经费）、经费卡、课题、研究单元。支出一律先申请。call_action 会改动生产数据，调用前先向使用者确认。';
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const bizError = (e: any) => (e?.code === '42501' || e?.code === 'P0001' ? String(e.message) : typeof e?.code === 'string' && /^(22|23)/.test(e.code) ? '数据不合法' : null);

async function mcpTool(run: Run, who: { token_id: string; user_id: string; can_write: boolean }, name: string, a: Record<string, any>) {
  const uid = who.user_id, kw = typeof a.keyword === 'string' ? a.keyword.toLowerCase() : '';
  if (name === 'whoami') { const [me] = await readView(run, uid, 'me', []); return { ...me, token_can_write: who.can_write }; }
  if (name === 'list_views') {
    const names = [...VIEWS].filter((v) => !kw || v.includes(kw)).sort();
    const cols = await run(uid, `select table_name as v, column_name as c, data_type as t from information_schema.columns where table_schema = 'api' order by table_name, ordinal_position`, []);
    return names.map((v) => ({ view: v, columns: (cols as any[]).filter((x) => x.v === v).map((x) => `${x.c}:${x.t}`) }));
  }
  if (name === 'read_view') {
    if (typeof a.view !== 'string' || !VIEWS.has(a.view)) throw new Error('没有这个视图，请先用 list_views 查看');
    const filters = Object.entries(a.filters ?? {}).filter(([k]) => /^[a-z_]+$/.test(k)).map(([k, v]): [string, string] => [k, String(v)]);
    const rows = await readView(run, uid, a.view, filters, typeof a.limit === 'number' ? a.limit : 200);
    return { rows, count: rows.length };
  }
  if (name === 'list_actions') return Object.entries(RPC).filter(([k]) => !kw || k.includes(kw)).sort(([x], [y]) => x.localeCompare(y)).map(([k, spec]) => ({ action: k, params: spec.map(([n, t]) => `${n}:${t}`) }));
  if (name === 'call_action') {
    if (typeof a.action !== 'string' || !RPC[a.action]) throw new Error('没有这个操作，请先用 list_actions 查看');
    if (!who.can_write) throw new Error('这个令牌是只读的，不能调用操作。需要办理业务请在中台另建一个可写的令牌');
    const log = (ok: boolean, error: string | null) => run(uid, `select public.log_api_call($1::text::uuid, $2::text, $3::text::boolean, $4::text)`, [who.token_id, a.action, String(ok), error]).catch(() => null);
    try { const result = await callRpc(run, uid, a.action, (a.args ?? {}) as Record<string, unknown>); await log(true, null); return { result }; }
    catch (e: any) { await log(false, bizError(e) ?? '服务器错误'); throw e; }
  }
  throw new Error('没有这个工具');
}

export async function mcp(req: Request, run: Run): Promise<Response> {
  if (req.method !== 'POST') return json({ error: '只接受 POST' }, 405, { allow: 'POST' });
  const bearer = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const deny = () => json(rpcErr(null, -32001, '令牌无效、已停用或已过期'), 401, { 'www-authenticate': 'Bearer' });
  if (!TOKEN_RE.test(bearer)) return deny();
  const hash = await sha256hex(bearer);
  const [who] = await run(null, `select token_id, user_id, can_write from public.api_token_login($1::text)`, [hash]);
  if (!who) return deny();
  const msg = (await req.json().catch(() => null)) as any;
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return json(rpcErr(msg?.id, -32600, '请求格式有误'), 400);
  if (msg.id === undefined) return new Response(null, { status: 202 });   // 通知，不需要回
  const done = (result: unknown) => json({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return done({ protocolVersion: MCP_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : MCP_VERSIONS[0],
    capabilities: { tools: {} }, serverInfo: { name: 'clain-portal', version: '1.0.0' }, instructions: MCP_HINT });
  if (msg.method === 'ping') return done({});
  if (msg.method === 'tools/list') return done({ tools: MCP_TOOLS });
  if (msg.method === 'tools/call') {
    const text = (v: unknown, isError = false) => done({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }], isError });
    try { return text(await mcpTool(run, who, String(msg.params?.name ?? ''), (msg.params?.arguments ?? {}) as Record<string, any>)); }
    catch (e: any) { const b = bizError(e); if (!b && e?.code) console.error(e); return text(b ?? (e?.code ? '服务器错误' : String(e?.message ?? e)), true); }
  }
  return json(rpcErr(msg.id, -32601, '不支持的方法'));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') return mcp(req, pgRun(env)).catch((e) => { console.error(e); return json(rpcErr(null, -32603, '服务器错误'), 500); });
    const appOrigin = env.APP_ORIGIN || url.origin;
    const cors = {
      'access-control-allow-origin': appOrigin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      vary: 'origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const redirectUri = `${url.origin}/auth/feishu/callback`;
    const jar = cookies(req);

    try {
      // ---------- 飞书登录 ----------
      if (url.pathname === '/auth/feishu/login') {
        const state = b64u(crypto.getRandomValues(new Uint8Array(16)));
        const to = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
        to.searchParams.set('client_id', env.FEISHU_APP_ID);
        to.searchParams.set('redirect_uri', redirectUri);
        to.searchParams.set('response_type', 'code');
        to.searchParams.set('state', state);
        return new Response(null, { status: 302, headers: {
          location: to.toString(),
          'set-cookie': setCookie('fp_state', await sign(env.SESSION_SECRET, 'state', state, 600), 600) } });
      }

      if (url.pathname === '/auth/feishu/callback') {
        const state = await verify(env.SESSION_SECRET, 'state', jar.fp_state);
        const code = url.searchParams.get('code');
        if (!state || !code || state !== url.searchParams.get('state')) return json({ error: '登录状态无效，请重新登录' }, 400);
        const tok = await feishu('/authen/v2/oauth/token', {
          method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: env.FEISHU_APP_ID,
            client_secret: env.FEISHU_APP_SECRET, code, redirect_uri: redirectUri }) });
        if (!tok.access_token) return json({ error: '飞书授权失败' }, 401);
        const info = await feishu('/authen/v1/user_info', { headers: { authorization: `Bearer ${tok.access_token}` } });
        const u = info?.data;
        if (info?.code !== 0 || !u?.open_id) return json({ error: '读取飞书身份失败' }, 401);
        if (env.FEISHU_TENANT_KEY && u.tenant_key !== env.FEISHU_TENANT_KEY) return json({ error: '仅限本单位飞书账号登录' }, 403);
        const [row] = await withUser(env, null, (sql) =>
          sql`select (login_feishu(${u.open_id}, ${u.name ?? ''}, ${u.enterprise_email || u.email || null}, ${u.union_id ?? null})).id as id`);
        const headers = new Headers({ location: appOrigin });
        headers.append('set-cookie', setCookie('fp_session', await sign(env.SESSION_SECRET, 'uid', row.id, 7 * 86400), 7 * 86400));
        headers.append('set-cookie', setCookie('fp_state', '', 0));
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === '/auth/logout' && req.method === 'POST')
        return json({ ok: true }, 200, { ...cors, 'set-cookie': setCookie('fp_session', '', 0) });

      // 连通性检查：只确认接口层连得上数据库，不返回任何数据
      if (url.pathname === '/health') {
        const [r] = await withUser(env, null, (sql) => sql`select current_user as role, (select count(*) from api.me)::int as me`);
        return json({ ok: r.role === 'app_api' && r.me === 0 });
      }

      // ---------- API ----------
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      const uid = await verify(env.SESSION_SECRET, 'uid', jar.fp_session);
      if (!uid) return json({ error: '未登录' }, 401, cors);

      const view = url.pathname.match(/^\/api\/v\/([a-z_]+)$/)?.[1];
      if (view && req.method === 'GET') {
        if (!VIEWS.has(view)) return json({ error: 'not found' }, 404, cors);
        const filters = [...url.searchParams].filter(([k]) => /^[a-z_]+$/.test(k));
        return json(await readView(pgRun(env), uid, view, filters), 200, cors);
      }

      const fn = url.pathname.match(/^\/api\/rpc\/([a-z_]+)$/)?.[1];
      if (fn && req.method === 'POST') {
        const spec = RPC[fn];
        if (!spec) return json({ error: 'not found' }, 404, cors);
        // 写操作只接受来自前端页面的请求
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        return json({ result: await callRpc(pgRun(env), uid, fn, body) }, 200, cors);
      }
      // 接口目录：全部视图及其列、全部操作及其参数，供「智能体接入」页的接口文档使用。只有名称和类型，不含数据
      if (url.pathname === '/api/meta' && req.method === 'GET') {
        const cols = await pgRun(env)(uid, `select table_name as v, column_name as c, data_type as t from information_schema.columns where table_schema = 'api' order by table_name, ordinal_position`, []);
        return json({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
          views: [...VIEWS].sort().map((v) => ({ view: v, columns: cols.filter((x) => x.v === v).map((x) => `${x.c}:${x.t}`) })),
          actions: Object.entries(RPC).sort(([x], [y]) => x.localeCompare(y)).map(([k, spec]) => ({ action: k, params: spec.map(([n, t]) => `${n}:${t}`) })) }, 200, cors);
      }
      // 访问令牌：明文在这里生成，只在这一次返回；数据库里只存哈希和末四位
      if (url.pathname === '/api/token/create' && req.method === 'POST') {
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const token = newToken();
        await withUser(env, uid, async (sql) => sql`select public.create_api_token(${String(body.name ?? '')}::text, ${await sha256hex(token)}::text, ${token.slice(-4)}::text, ${String(body.write === true || body.write === 'true')}::text::boolean, ${String(Math.round(Number(body.days)) || 0)}::text::int)`);
        return json({ result: token }, 200, { ...cors, 'cache-control': 'no-store' });
      }
      // 密钥与账号：保存时加密，取用时解密；数据库里只有密文，每次取用都留记录
      const sec = url.pathname.match(/^\/api\/secret\/(set|get)$/)?.[1];
      if (sec && req.method === 'POST') {
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        if (!env.VAULT_KEY) return json({ error: '尚未配置加密口令，暂不可保存或查看密钥' }, 503, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const kind = String(body.kind ?? ''), id = String(body.id ?? '');
        if (!['resource', 'allocation'].includes(kind) || !/^[0-9a-f-]{36}$/.test(id)) return json({ error: '参数有误' }, 400, cors);
        const noStore = { ...cors, 'cache-control': 'no-store' };
        if (sec === 'set') {
          const plain = typeof body.secret === 'string' ? body.secret.trim() : '';
          if (plain.length > 2000) return json({ error: '内容过长' }, 400, cors);
          const cipher = plain ? await seal(env.VAULT_KEY, `${kind}:${id}`, plain) : null;
          await withUser(env, uid, (sql) => sql`select public.set_secret(${kind}::text, ${id}::uuid, ${cipher}::text, ${plain ? mask(plain) : null}::text)`);
          return json({ result: plain ? mask(plain) : null }, 200, noStore);
        }
        const [row] = await withUser(env, uid, (sql) => sql`select public.get_secret(${kind}::text, ${id}::uuid) as c`);
        return json({ result: await unseal(env.VAULT_KEY, `${kind}:${id}`, row.c) }, 200, noStore);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e: any) {
      // 数据库函数抛出的业务错误（拦截原因、角色不符）原样返回给前端
      if (e?.code === '42501') return json({ error: e.message }, 403, cors);
      if (e?.code === 'P0001') return json({ error: e.message }, 400, cors);
      if (typeof e?.code === 'string' && /^(22|23)/.test(e.code)) return json({ error: '数据不合法' }, 400, cors);
      console.error(e);
      return json({ error: '服务器错误' }, 500, cors);
    }
  },

  // 定时把通知队列里的消息以应用身份发给本人。开关 FEISHU_NOTIFY 不是 on 时什么都不做，也不连数据库。
  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (env.FEISHU_NOTIFY !== 'on') return;
    const batch = await withUser(env, null, (sql) => sql`select msg_id, target_id, body from public.outbox_take(20)`);
    if (!batch.length) return;
    const tok = await feishu('/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: env.FEISHU_BOT_APP_ID || env.FEISHU_APP_ID, app_secret: env.FEISHU_BOT_APP_SECRET || env.FEISHU_APP_SECRET }) }).catch(() => null);
    const results: [string, boolean, string | null][] = [];
    for (const m of batch) {
      if (!tok?.tenant_access_token) { results.push([String(m.msg_id), false, '无法获取应用凭证']); continue; }
      const body = typeof m.body === 'string' ? JSON.parse(m.body) : m.body;
      const r = await feishu(`/im/v1/messages?receive_id_type=${String(m.target_id).startsWith('on_') ? 'union_id' : 'open_id'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${tok.tenant_access_token}` },
        body: JSON.stringify({ receive_id: m.target_id, msg_type: 'text', content: JSON.stringify({ text: `【科研财务中台】${body.text}` }) }),
      }).catch((e) => ({ code: -1, msg: String(e?.message ?? e) }));
      results.push([String(m.msg_id), r?.code === 0, r?.code === 0 ? null : `飞书返回 ${r?.code}：${String(r?.msg ?? '').slice(0, 200)}`]);
    }
    await withUser(env, null, async (sql) => {
      for (const [id, ok, err] of results) await sql`select public.outbox_done(${id}::bigint, ${ok}::boolean, ${err}::text)`;
    });
  },
};
