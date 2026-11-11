// 把 export_feishu.py 的导出装进 legacy.record，再转成新表，最后对账。
//
//   node --env-file=.env scripts/import_legacy.mjs <导出目录> [--director <姓名>]
//
// 没有 DATABASE_URL 时在内存 Postgres 里演练（应用全部迁移后导入），不碰任何真实数据库。
// 设了 DATABASE_URL 时写入该库（需要先应用迁移，用表的所有者连接）。
// 密钥和访问码在装入前剔除；人事表和备份表不导入。只打印行数和合计，不打印内容。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = args[0];
if (!dir) { console.error('用法：node scripts/import_legacy.mjs <导出目录> [--director <姓名>]'); process.exit(2); }
const director = args.includes('--director') ? args[args.indexOf('--director') + 1] : null;

// 旧表的 ID 从环境变量读（写在 .env 里，不进仓库）；暂存时用户表和实体表改用固定的逻辑名
const USERS = process.env.LEGACY_USERS_TABLE, ENTITY = process.env.LEGACY_ENTITY_TABLE;
if (!USERS || !ENTITY) { console.error('请设置 LEGACY_USERS_TABLE 和 LEGACY_ENTITY_TABLE'); process.exit(2); }
const SKIP = new Set((process.env.LEGACY_SKIP_TABLES ?? '').split(',').filter(Boolean));   // 人事表、备份
const LOGICAL = { [USERS]: 'users', [ENTITY]: 'entity' };
const SECRET_FIELD = /访问码|API Key|密码|password|secret|token/i;
const SECRET_KEY = /secret|password|token|access_code/i;

const text = (v) => Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.text ?? '' : String(x))).join('') : v;
const KEY_SHAPED = /\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_.-]+/g;   // 混在说明文字里的密钥
const scrub = (o) => Array.isArray(o) ? o.map(scrub)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, scrub(v)]))
  : typeof o === 'string' ? o.replace(KEY_SHAPED, '[已剔除密钥]') : o;

function rows() {
  const out = [];
  for (const f of readdirSync(dir).filter((f) => /^tbl.*\.json$/.test(f))) {
    const t = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    if (SKIP.has(t.table_id)) continue;
    for (const r of t.records) {
      const F = r.fields;
      let fields;
      if (t.table_id === USERS) {
        const acct = Array.isArray(F['飞书账号']) ? F['飞书账号'][0] : null;
        fields = { serial: text(F['序号']), name: text(F['姓名']) ?? acct?.name ?? null,
                   email: acct?.email || text(F['登录邮箱']) || null,
                   role: text(F['财务系统角色']) ?? null, status: text(F['财务系统状态']) ?? null,
                   scope: text(F['数据查看范围']) ?? null };
      } else if (t.table_id === ENTITY) {
        let data = {};
        try { data = JSON.parse(text(F['数据JSON']) || '{}'); } catch { data = { _unparsed: true }; }
        fields = { type: text(F['记录类型']), id: text(F['业务ID']), name: text(F['名称']), status: text(F['状态']), data: scrub(data) };
      } else {
        fields = scrub(Object.fromEntries(Object.entries(F).filter(([k]) => !SECRET_FIELD.test(k))));
      }
      out.push([LOGICAL[t.table_id] ?? t.table_id, t.name, r.record_id, JSON.stringify(fields)]);
    }
  }
  return out;
}

async function connect() {
  if (process.env.DATABASE_URL) {
    const { default: postgres } = await import('postgres');
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    return { live: true, q: async (s, p = []) => [...await sql.unsafe(s, p)], exec: (s) => sql.unsafe(s), end: () => sql.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const mig = path.join(root, 'supabase/migrations');
  for (const f of readdirSync(mig).sort()) await db.exec(readFileSync(path.join(mig, f), 'utf8'));
  return { live: false, q: async (s, p = []) => (await db.query(s, p)).rows, exec: (s) => db.exec(s), end: async () => {} };
}

const data = rows();
const db = await connect();
console.log(db.live ? '写入 DATABASE_URL 指向的库' : '演练：内存库，不写任何真实数据库');
for (const r of data)
  await db.q(`insert into legacy.record (table_id, table_name, record_id, fields) values ($1,$2,$3,$4::jsonb)
              on conflict (table_id, record_id) do update set fields = excluded.fields`, r);
await db.exec(readFileSync(path.join(root, 'supabase/legacy/transform.sql'), 'utf8'));
if (director) {
  const n = await db.q(`update app_user set role = 'director' where name = $1 returning id`, [director]);
  console.log(`中心负责人：匹配到 ${n.length} 人`);
}

// ---------- 对账：源数据合计 vs 新表合计 ----------
const ent = data.filter((r) => r[0] === 'entity').map((r) => JSON.parse(r[3]));
const of = (t, st) => ent.filter((e) => e.type === t && (!st || e.status === st));
const src = {
  users: data.filter((r) => r[0] === 'users' && JSON.parse(r[3]).name).length,
  cards: of('funding_project').length,
  budget: of('budget', '生效').reduce((s, e) => s + Number(e.data.amount || 0), 0),
  expense: of('expense', '已确认').reduce((s, e) => s + e.data.allocations.reduce((x, a) => x + Number(a.amount), 0), 0),
};
const [got] = await db.q(`select
  (select count(*) from app_user where legacy_serial is not null)::int as users,
  (select count(*) from fund_card)::int as cards,
  (select coalesce(sum(orig), 0) from v_card)::float as budget,
  (select coalesce(sum(actual), 0) from v_card)::float as expense,
  (select count(*) from v_cell where avail < 0)::int as negative,
  (select count(*) from legacy.record)::int as staged`);
let bad = 0;
for (const k of Object.keys(src)) {
  const same = Math.abs(src[k] - got[k]) < 0.005;
  if (!same) bad++;
  console.log(`${same ? '一致' : '不一致'}  ${k.padEnd(8)} 源 ${src[k]}  新表 ${got[k]}`);
}
console.log(`暂存 ${got.staged} 行；可用额度为负的卡 × 科目 ${got.negative} 个`);
const left = {};
for (const e of ent) if (!['category', 'funding_project', 'budget', 'expense'].includes(e.type)) left[e.type] = (left[e.type] || 0) + 1;
console.log('仍留在暂存区、等对应模块建好再转的实体：', JSON.stringify(left));
await db.end();
process.exit(bad ? 1 : 0);
