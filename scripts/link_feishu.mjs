// 用登录应用的身份按邮箱查出迁移用户的 open_id 并预先绑定，这样登录时不依赖用户授权邮箱。
//   FEISHU_APP_ID=… FEISHU_APP_SECRET=… node --env-file=.env scripts/link_feishu.mjs
// open_id 因应用而异，必须用登录所用的同一个应用来查。只打印人数。
import postgres from 'postgres';
const B = 'https://open.feishu.cn/open-apis';
const post = async (p, body, tok) => (await fetch(B + p, { method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: JSON.stringify(body) })).json();
const t = await post('/auth/v3/tenant_access_token/internal', { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET });
if (t.code !== 0) { console.error('取令牌失败', t.code); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const users = await sql`select id, email from app_user where feishu_open_id is null and email is not null`;
let linked = 0, missing = 0, taken = 0;
for (let i = 0; i < users.length; i += 50) {
  const part = users.slice(i, i + 50);
  const r = await post('/contact/v3/users/batch_get_id?user_id_type=open_id', { emails: part.map((u) => u.email) }, t.tenant_access_token);
  if (r.code !== 0) { console.error('按邮箱查用户失败', r.code, r.msg); await sql.end(); process.exit(1); }
  const byEmail = new Map((r.data.user_list ?? []).filter((x) => x.user_id).map((x) => [x.email.toLowerCase(), x.user_id]));
  for (const u of part) {
    const oid = byEmail.get(u.email.toLowerCase());
    if (!oid) { missing++; continue; }
    // 已有人用这个 open_id 登录过（登录时没拿到邮箱而新建的空账号）：没有业务记录就并入旧账号
    const [dup] = await sql`select id from app_user where feishu_open_id = ${oid}`;
    if (dup) {
      const ok = await sql.begin(async (tx) => {
        try { await tx`savepoint s`; await tx`delete from app_user where id = ${dup.id} and legacy_serial is null`; }
        catch { await tx`rollback to savepoint s`; return false; }
        await tx`update app_user set feishu_open_id = ${oid}, updated_at = now() where id = ${u.id}`;
        return true;
      });
      ok ? linked++ : taken++;
    } else { await sql`update app_user set feishu_open_id = ${oid}, updated_at = now() where id = ${u.id}`; linked++; }
  }
}
console.log(`待绑定 ${users.length} 人：绑定 ${linked}，飞书里查不到 ${missing}，open_id 已被有记录的账号占用 ${taken}`);
await sql.end();
