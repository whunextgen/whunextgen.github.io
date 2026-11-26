// 本地演示环境：用测试跑完导出的虚构数据库（PGlite）起一套正则，供使用手册截图。
// 只监听 127.0.0.1；不连任何线上数据库；登录入口只认演示库里的虚构账号（/demo 页面选人）。
// 用法：
//   DEMO_OUT=demo.tgz npm test          # 导出演示数据库
//   (cd web && npm run build)           # 构建页面
//   node scripts/demo/server.mjs demo.tgz [端口，默认 8788]
import { PGlite } from '@electric-sql/pglite';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RPC, VIEWS } from '../../worker/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [file, portArg] = process.argv.slice(2);
if (!file || !existsSync(file)) { console.log('用法：node scripts/demo/server.mjs <演示数据库.tgz> [端口]'); process.exit(1); }
const db = new PGlite({ loadDataDir: new Blob([readFileSync(file)]) });
await db.exec(readFileSync(path.join(root, 'scripts/demo/polish.sql'), 'utf8'));
// 演示环境里登记日、登记时段都按真实规则
const dist = path.join(root, 'web/dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.csv': 'text/csv' };

// 与 Worker 一致：每个请求在一个事务里，先记下当前用户，再以接口层的角色读写
async function asUser(uid, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('app.uid', $1, true)`, [uid ?? '']);
    await tx.exec('set local role app_api');
    return fn(tx);
  });
}
function rpcArgs(spec, body) {
  return spec.map(([, type], i) => {
    const v = body[spec[i][0]];
    if (v === undefined || v === null || v === '') return null;
    if (type === 'jsonb') return JSON.stringify(v);
    if (type.endsWith('[]')) return `{${(Array.isArray(v) ? v : String(v).split(',').filter(Boolean)).map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
    return String(v);
  });
}
const cookieUid = (req) => (req.headers.cookie ?? '').match(/(?:^|;\s*)demo_uid=([0-9a-f-]{36})/)?.[1] ?? null;
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    // 选人登录：只列演示库里的启用账号
    if (url.pathname === '/demo') {
      const rows = (await db.query(`select u.id, u.name, u.role, p.rank,
        (select string_agg(r.name, '、') from rbac_grant g join rbac_role r on r.id = g.role_id where g.user_id = u.id and g.revoked_at is null) grants
        from app_user u left join person p on p.user_id = u.id where u.active order by u.created_at`)).rows;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>演示账号</title><body style="font:14px system-ui;padding:24px"><h2>正则演示环境 · 选择账号</h2><p>全部为虚构数据。</p><ul>${rows.map((r) => `<li><a href="/demo/as/${r.id}">${r.name}</a> · ${r.role}${r.rank ? ' · ' + r.rank : ''}${r.grants ? ' · ' + r.grants : ''}</li>`).join('')}</ul></body>`);
      return;
    }
    const as = url.pathname.match(/^\/demo\/as\/([0-9a-f-]{36})$/)?.[1];
    if (as) { res.writeHead(302, { 'set-cookie': `demo_uid=${as}; Path=/; HttpOnly; SameSite=Lax`, location: '/#/' }); res.end(); return; }
    if (url.pathname === '/auth/logout') { send(res, 200, { ok: true }, { 'set-cookie': 'demo_uid=; Path=/; Max-Age=0' }); return; }
    if (url.pathname.startsWith('/auth/')) { res.writeHead(302, { location: '/demo' }); res.end(); return; }

    if (url.pathname.startsWith('/api/')) {
      const uid = cookieUid(req);
      if (!uid) return send(res, 401, { error: '未登录' });
      const view = url.pathname.match(/^\/api\/v\/([a-z_]+)$/)?.[1];
      if (view && req.method === 'GET') {
        if (!VIEWS.has(view)) return send(res, 404, { error: 'not found' });
        const f = [...url.searchParams].filter(([k]) => /^[a-z_]+$/.test(k));
        const where = f.map(([k], i) => `${k}::text = $${i + 1}`).join(' and ');
        const rows = await asUser(uid, (tx) => tx.query(`select * from api.${view}${where ? ' where ' + where : ''} limit 2000`, f.map(([, v]) => v)));
        return send(res, 200, rows.rows);
      }
      const fn = url.pathname.match(/^\/api\/rpc\/([a-z_]+)$/)?.[1];
      if (fn && req.method === 'POST') {
        const spec = RPC[fn];
        if (!spec) return send(res, 404, { error: 'not found' });
        const body = await readBody(req);
        const call = `select public.${fn}(${spec.map(([, t], i) => `$${i + 1}::text::${t}`).join(', ')}) as result`;
        const r = await asUser(uid, (tx) => tx.query(call, rpcArgs(spec, body)));
        return send(res, 200, { result: r.rows[0]?.result ?? null });
      }
      if (url.pathname === '/api/meta') return send(res, 200, { tools: [], views: [...VIEWS].sort().map((v) => ({ view: v, columns: [] })), actions: Object.keys(RPC).sort().map((k) => ({ action: k, params: RPC[k].map(([n, t]) => `${n}:${t}`) })) });
      return send(res, 404, { error: 'not found' });
    }

    // 页面
    let p = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!p.startsWith(dist) || !existsSync(p) || statSync(p).isDirectory()) p = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
    res.end(readFileSync(p));
  } catch (e) {
    send(res, 400, { error: String(e?.message ?? e).slice(0, 300) });
  }
});
const port = Number(portArg ?? 8788);
server.listen(port, '127.0.0.1', () => console.log(`演示环境：http://127.0.0.1:${port}/demo`));
