// API 层：飞书登录、会话、只读视图、业务函数。
// 所有校验都在数据库函数里；这里只负责认出是谁，并把身份带进事务。
import postgres from 'postgres';

export interface Env {
  HYPERDRIVE: { connectionString: string };   // 以 app_api 角色连接 Supabase Postgres
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  FEISHU_TENANT_KEY?: string;                 // 设了就只允许本租户
  SESSION_SECRET: string;
  APP_ORIGIN?: string;                        // 前端地址；不设时前端与接口同源（页面由本 Worker 的静态资源提供）
}

const VIEWS = new Set(['me', 'users', 'card_pick', 'subject', 'expense_type', 'card', 'cell', 'node', 'cap', 'rule', 'ruling',
  'request', 'request_event', 'procurement_event', 'budget_change', 'fund_event', 'person', 'pay_type', 'staff',
  'payroll_sheet', 'settlement', 'emergency']);

// 函数名 → 参数名与类型（按位置传给数据库函数）
const RPC: Record<string, [string, string][]> = {
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
  add_ruling: [['card_id', 'uuid'], ['expense_type_id', 'uuid'], ['ruled_on', 'date'], ['ruled_by', 'text'], ['verdict', 'text'], ['note', 'text'], ['source', 'text']],
  finish_fund_event: [['id', 'uuid']],
  set_user_role: [['user_id', 'uuid'], ['role', 'text'], ['active', 'boolean']],
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
        if (env.FEISHU_TENANT_KEY && u.tenant_key !== env.FEISHU_TENANT_KEY) return json({ error: '只允许本单位飞书账号登录' }, 403);
        const [row] = await withUser(env, null, (sql) =>
          sql`select (login_feishu(${u.open_id}, ${u.name ?? ''}, ${u.enterprise_email || u.email || null})).id as id`);
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
        const rows = await withUser(env, uid, (sql) => {
          const where = filters.map(([k], i) => `${k}::text = $${i + 1}`).join(' and ');
          return sql.unsafe(`select * from api.${view}${where ? ' where ' + where : ''} limit 2000`, filters.map(([, v]) => v));
        });
        return json(rows, 200, cors);
      }

      const fn = url.pathname.match(/^\/api\/rpc\/([a-z_]+)$/)?.[1];
      if (fn && req.method === 'POST') {
        const spec = RPC[fn];
        if (!spec) return json({ error: 'not found' }, 404, cors);
        // 写操作只接受来自前端页面的请求
        if (req.headers.get('origin') !== appOrigin) return json({ error: '来源不允许' }, 403, cors);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const args = spec.map(([name, type]) => {
          const v = body[name];
          return v === undefined || v === null || v === '' ? null : type === 'jsonb' ? JSON.stringify(v) : String(v);
        });
        const call = `select public.${fn}(${spec.map(([, type], i) => `$${i + 1}::${type}`).join(', ')}) as result`;
        const [row] = await withUser(env, uid, (sql) => sql.unsafe(call, args));
        return json({ result: row?.result ?? null }, 200, cors);
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
};
