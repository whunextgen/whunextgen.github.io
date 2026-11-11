// 给还没绑定飞书的迁移用户按姓名对应：飞书里同名的恰好一人、且该人尚未绑定时才绑，其余列出来人工处理。
//   FEISHU_APP_ID=… FEISHU_APP_SECRET=… node --env-file=.env scripts/link_by_name.mjs [--apply]
// 不加 --apply 只报告不写库。须用登录所用的同一个飞书应用。
import postgres from 'postgres';
const apply = process.argv.includes('--apply');
const B = 'https://open.feishu.cn/open-apis';
const call = async (p, tok, body) => (await fetch(B + p, { method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json; charset=utf-8', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: body ? JSON.stringify(body) : undefined })).json();
const t = await call('/auth/v3/tenant_access_token/internal', null, { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
if (t.code !== 0) { console.error('取令牌失败', t.code); process.exit(1); }
const tok = t.tenant_access_token;
const pages = async (path) => {
  const out = []; let pt = '';
  do {
    const r = await call(`${path}${path.includes('?') ? '&' : '?'}page_size=50${pt ? '&page_token=' + encodeURIComponent(pt) : ''}`, tok);
    if (r.code !== 0) throw new Error(`${path.split('?')[0]} code ${r.code} ${r.msg}`);
    out.push(...(r.data?.items ?? [])); pt = r.data?.has_more ? r.data.page_token : '';
  } while (pt);
  return out;
};
// 通讯录：根部门起逐层取人
const people = new Map();   // open_id -> name
let source = '通讯录';
try {
  const depts = ['0', ...(await pages('/contact/v3/departments/0/children?fetch_child=true&department_id_type=open_department_id')).map((d) => d.open_department_id)];
  for (const d of depts)
    for (const u of await pages(`/contact/v3/users/find_by_department?department_id=${d}&department_id_type=open_department_id&user_id_type=open_id`))
      if (u.open_id && u.name) people.set(u.open_id, u.name);
} catch (e) { console.log('读通讯录失败：', e.message); }
if (people.size < 5) {   // 没有通讯录权限时退到机器人所在群的成员
  source = '机器人所在群的成员';
  for (const c of await pages('/im/v1/chats'))
    for (const m of await pages(`/im/v1/chats/${c.chat_id}/members?member_id_type=open_id`).catch(() => []))
      if (m.member_id && m.name) people.set(m.member_id, m.name);
}
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const byName = new Map();
for (const [oid, name] of people) byName.set(norm(name), [...(byName.get(norm(name)) ?? []), oid]);

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const todo = await sql`select id, name, role from app_user where feishu_open_id is null and legacy_serial is not null order by role, name`;
const bound = new Set((await sql`select feishu_open_id from app_user where feishu_open_id is not null`).map((r) => r.feishu_open_id));
const dupLocal = new Set((await sql`select name from app_user group by name having count(*) > 1`).map((r) => norm(r.name)));
const res = { 绑定: [], 飞书里没有同名: [], 飞书里同名多人: [], 库里同名多人: [], 同名者已绑定别的账号: [] };
for (const u of todo) {
  const hit = byName.get(norm(u.name)) ?? [];
  const tag = `${u.name}（${u.role}）`;
  if (dupLocal.has(norm(u.name))) res.库里同名多人.push(tag);
  else if (hit.length === 0) res.飞书里没有同名.push(tag);
  else if (hit.length > 1) res.飞书里同名多人.push(tag);
  else if (bound.has(hit[0])) res.同名者已绑定别的账号.push(tag);
  else {
    if (apply) await sql`update app_user set feishu_open_id = ${hit[0]}, updated_at = now() where id = ${u.id} and feishu_open_id is null`;
    bound.add(hit[0]); res.绑定.push(tag);
  }
}
console.log(`名单来源：${source}，共 ${people.size} 人；待对应 ${todo.length} 人${apply ? '' : '（演练，未写库）'}`);
for (const [k, v] of Object.entries(res)) console.log(`${k} ${v.length}${v.length ? '：' + v.join('、') : ''}`);
await sql.end();
