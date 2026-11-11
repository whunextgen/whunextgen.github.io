// 把 supabase/migrations 里尚未应用的文件按顺序应用到 DATABASE_URL，每个文件一个事务。
//   node --env-file=.env scripts/migrate.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('请设置 DATABASE_URL'); process.exit(2); }
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../supabase/migrations');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  await sql`create schema if not exists ops`;
  await sql`create table if not exists ops.migration (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from ops.migration`).map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) { console.log('已应用', f); continue; }
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(path.join(dir, f), 'utf8'));
      await tx`insert into ops.migration (name) values (${f})`;
    });
    console.log('应用  ', f);
  }
} catch (e) {
  console.error('失败：', e.code, e.message, e.where ? '\n' + e.where : '', e.position ? '位置 ' + e.position : '');
  process.exitCode = 1;
} finally { await sql.end(); }
