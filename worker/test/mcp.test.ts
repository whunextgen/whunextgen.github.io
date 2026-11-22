// MCP 接口的端到端测试：内存数据库里应用全部迁移，真的走一遍 JSON-RPC。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { mcp, sha256hex, newToken, MCP_TOOLS, type Run } from '../src/index.ts';
let bad = 0, n = 0; const ok = (c: unknown, name: string, extra = '') => { n++; if (!c) { bad++; console.log('FAIL', name, extra); } };
const db = new PGlite(); const mig = new URL('../../supabase/migrations/', import.meta.url);
for (const f of readdirSync(mig).sort()) await db.exec(readFileSync(new URL(f, mig), 'utf8'));
const uid = ((await db.query(`insert into app_user (name, role, feishu_open_id) values ('测试成员', 'member', 'ou_mcp_test') returning id`)).rows[0] as any).id as string;
const ro = newToken(), rw = newToken();
ok(/^clain_[A-Za-z0-9_-]{43}$/.test(ro) && ro !== rw, '令牌格式');
ok((await sha256hex('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256');
await db.query(`select set_config('app.uid', $1, false)`, [uid]);
await db.query(`select create_api_token('只读', $1, $2, false, 30)`, [await sha256hex(ro), ro.slice(-4)]);
await db.query(`select create_api_token('可写', $1, $2, true, 30)`, [await sha256hex(rw), rw.slice(-4)]);
await db.exec(`set role app_api`);
const run: Run = async (u, text, params) => { await db.query(`select set_config('app.uid', $1, false)`, [u ?? '']); return (await db.query(text, params as any[])).rows as any[]; };
let id = 0;
const call = async (token: string | null, method: string, params?: unknown, note = false) => {
  const r = await mcp(new Request('https://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(note ? {} : { id: ++id }), method, params }) }), run);
  return { status: r.status, body: r.status === 202 ? null : (await r.json()) as any };
};
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await call(token, 'tools/call', { name, arguments: args }); const c = r.body?.result; const text = c?.content?.[0]?.text as string;
  let data: any = null; try { data = JSON.parse(text); } catch { /* 不是 JSON 就是错误说明 */ }
  return { isError: !!c?.isError, text, data };
};

ok((await call(null, 'initialize')).status === 401, '没有令牌被拒');
ok((await call('clain_' + 'x'.repeat(43), 'initialize')).status === 401, '不存在的令牌被拒');
ok((await mcp(new Request('https://x/mcp'), run)).status === 405, '只接受 POST');
const init = await call(ro, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
ok(init.status === 200 && init.body.result.protocolVersion === '2025-03-26' && init.body.result.capabilities.tools && init.body.result.serverInfo.name === 'clain-portal', '握手');
ok((await call(ro, 'notifications/initialized', undefined, true)).status === 202, '通知不回内容');
const tl = await call(ro, 'tools/list');
ok(tl.body.result.tools.length === MCP_TOOLS.length && tl.body.result.tools.every((t: any) => t.name && t.inputSchema?.type === 'object'), '工具清单');
const me = await tool(ro, 'whoami');
ok(!me.isError && me.data.id === uid && me.data.token_can_write === false, '身份是令牌持有人', me.text);
const lv = await tool(ro, 'list_views', { keyword: 'project' });
ok(!lv.isError && lv.data.some((v: any) => v.view === 'project' && v.columns.some((c: string) => c.startsWith('name:'))), '列出视图和列', lv.text?.slice(0, 200));
const all = await tool(ro, 'list_views');
ok(all.data.every((v: any) => v.columns.length > 0), '登记的视图在数据库里都存在', JSON.stringify(all.data?.filter((v: any) => !v.columns.length).map((v: any) => v.view)));
const rv = await tool(ro, 'read_view', { view: 'budget_category', limit: 3 });
ok(!rv.isError && Array.isArray(rv.data.rows) && rv.data.rows.length <= 3, '读视图', rv.text?.slice(0, 200));
ok((await tool(ro, 'read_view', { view: 'app_user' })).isError, '不在清单里的表读不到');
ok((await tool(ro, 'read_view', { view: 'project; drop table x' })).isError, '视图名只认清单');
const la = await tool(ro, 'list_actions', { keyword: 'time_log' });
ok(la.data.some((x: any) => x.action === 'save_time_log' && x.params.includes('items:jsonb')), '列出操作和参数', la.text);
const deniedW = await tool(ro, 'call_action', { action: 'save_time_log', args: { period: '2026-11-16', items: [] } });
ok(deniedW.isError && /只读/.test(deniedW.text), '只读令牌不能办理业务', deniedW.text);
const biz = await tool(rw, 'call_action', { action: 'save_time_log', args: { period: '2026-11-16', items: [] } });
ok(biz.isError && /身份尚未登记/.test(biz.text), '业务检查照常生效，原因原样返回', biz.text);
ok((await tool(rw, 'call_action', { action: 'no_such', args: {} })).isError, '不在清单里的操作调不了');
const okCall = await tool(rw, 'call_action', { action: 'revoke_api_token', args: { id: '00000000-0000-0000-0000-000000000000' } });
ok(okCall.isError && /令牌不存在/.test(okCall.text), '参数按类型传到函数', okCall.text);
const logs = await tool(rw, 'read_view', { view: 'api_call' });
ok(logs.data.rows.length === 2 && logs.data.rows.every((r: any) => r.ok === false && r.token_name === '可写'), '写操作留了记录', logs.text?.slice(0, 300));
const toks = await tool(rw, 'read_view', { view: 'api_token' });
const mine = toks.data.rows.find((r: any) => r.name === '可写');
const rev = await tool(rw, 'call_action', { action: 'revoke_api_token', args: { id: mine.id } });
ok(!rev.isError, '可写令牌办成一件事', rev.text);
ok((await call(rw, 'ping')).status === 401, '停用后立即失效');
ok((await call(ro, 'nope')).body.error?.code === -32601, '不认识的方法');
console.log(bad ? `${bad} failed of ${n}` : `ok ${n}`);
process.exit(bad ? 1 : 0);
