// 换登录应用之前运行一次：用原应用的身份，把已绑定用户的 open_id 换算成 union_id 记下来。
//   FEISHU_APP_ID=… FEISHU_APP_SECRET=… node --env-file=.env scripts/backfill_union.mjs [--apply]
// 必须用原来登录所用的那个应用来查（open_id 因应用而异）。只打印人数。
import postgres from 'postgres';
const B = 'https://open.feishu.cn/open-apis';
const apply = process.argv.includes('--apply');
const t = await (await fetch(B + '/auth/v3/tenant_access_token/internal', { method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }) })).json();
if (t.code !== 0) { console.error('取令牌失败', t.code); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const users = await sql`select id, feishu_open_id as oid from app_user where feishu_open_id is not null and feishu_union_id is null`;
  let done = 0, missing = 0, taken = 0;
  for (let i = 0; i < users.length; i += 50) {
    const part = users.slice(i, i + 50);
    const qs = part.map((u) => 'user_ids=' + encodeURIComponent(u.oid)).join('&');
    const r = await (await fetch(`${B}/contact/v3/users/batch?user_id_type=open_id&${qs}`,
      { headers: { authorization: `Bearer ${t.tenant_access_token}` } })).json();
    if (r.code !== 0) { console.error('查用户失败', r.code, r.msg); process.exitCode = 1; break; }
    const by = new Map((r.data?.items ?? []).filter((x) => x.open_id && x.union_id).map((x) => [x.open_id, x.union_id]));
    for (const u of part) {
      const n = by.get(u.oid);
      if (!n) { missing++; continue; }
      const [dup] = await sql`select 1 from app_user where feishu_union_id = ${n}`;
      if (dup) { taken++; continue; }
      if (apply) await sql`update app_user set feishu_union_id = ${n}, updated_at = now() where id = ${u.id} and feishu_union_id is null`;
      done++;
    }
  }
  console.log(apply ? '已写入' : '可写入（未写，加 --apply 才写）', done, '查不到', missing, '已被占用', taken, '共', users.length);
} catch (e) { console.error('失败', e.code, String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '[已隐去]')); process.exitCode = 1; }
finally { await sql.end(); }
