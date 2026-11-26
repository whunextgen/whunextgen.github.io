// 看演示库里的年度预算和可选预算行。用法：node scripts/demo/inspect.mjs <db.tgz>
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const db = new PGlite({ loadDataDir: new Blob([readFileSync(process.argv[2])]) });
const q = async (s) => (await db.query(s)).rows;
console.log(await q(`select year, stage from budget_year order by year`));
console.log(await q(`select b.year, p.code, b.status, count(l.*)::int n, sum(l.fixed) fixed from project_budget b join project p on p.id = b.project_id left join project_budget_line l on l.budget_id = b.id group by 1,2,3 order by 1,2`));
await db.close(); process.exit(0);
