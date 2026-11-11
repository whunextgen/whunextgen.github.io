// 在内存 Postgres（PGlite）里应用全部迁移，灌入原型的虚构数据，核对口径和拦截规则。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const mig = path.join(root, 'supabase/migrations');
for (const f of readdirSync(mig).sort()) await db.exec(readFileSync(path.join(mig, f), 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : (fail++, console.log('FAIL', name, extra)); };
const eq = (a, b, name) => ok(Number(a) === Number(b), name, `got ${a}, want ${b}`);
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0];
const raises = async (name, re, sql, p = []) => {
  try { await db.query(sql, p); ok(false, name, 'no error'); }
  catch (e) { ok(re.test(e.message), name, e.message); }
};
const as = async (uid, today) => {
  await db.query(`select set_config('app.uid', $1, false), set_config('app.today', $2, false)`, [uid ?? '', today ?? '']);
};

// ---------- 虚构数据，与 docs 原型一致 ----------
const SUBJ = { equip: '设备购置', mat: '专用材料', labor: '劳务费', wage: '工资福利（编外）', travel: '国内差旅', conf: '会议费', net: '网络运行与维护', abroad: '因公出国', print: '印刷费', consult: '专家咨询费', biz: '业务费' };
const TPL = {
  S: { n: '财政专项模板', subs: ['equip', 'mat', 'labor', 'wage', 'travel', 'conf', 'net', 'abroad', 'print', 'consult'], caps: [[['labor', 'wage'], .3, '工资福利与劳务费合计不超过经费总额 30%'], [['print'], .3, '印刷费不超过 30%']] },
  S2: { n: '基本科研业务费模板', subs: ['mat', 'labor', 'travel', 'net', 'print'], caps: [[['labor'], .3, '劳务费不超过经费总额 30%']] },
  P: { n: '人才项目模板', subs: ['equip', 'mat', 'labor', 'wage', 'travel', 'conf', 'net', 'abroad', 'print', 'consult'], caps: [] },
  N: { n: '基金项目模板', subs: ['equip', 'biz', 'labor'], caps: [] },
  H: { n: '横向项目模板', subs: ['equip', 'biz', 'labor', 'travel', 'net'], caps: [] },
  W: { n: '外专项目模板', subs: ['wage', 'consult'], caps: [], locked: true } };
const CARDS = [
  ['A', '4131-A', '人才启动经费', 'S', '2026-04-25', '2026-11-04', '2026-12-10', 'recall', [['2026-06-20', .5, '通报'], ['2026-09-20', .75, '回收'], ['2026-12-10', 1, '清零']]],
  ['B', '4130-B', '基本科研业务费小项目', 'S2', '2026-03-01', '2026-11-30', '2026-11-30', 'recall', [['2026-06-30', .5, '通报'], ['2026-09-30', .75, '回收'], ['2026-11-30', 1, '用完']]],
  ['C', '2121-C', '海外人才项目', 'P', '2026-01-01', '2028-12-31', null, 'carry', []],
  ['D', '2301-D', '市自然科学基金', 'N', '2026-01-01', '2028-06-30', null, 'carry', []],
  ['E', '2500-E', '企业横向', 'H', '2026-01-01', '2026-12-31', '2026-12-31', 'carry', [['2026-12-31', 1, '结题']]],
  ['F', '6004-F', '外专项目', 'W', '2026-06-01', '2027-12-31', null, 'return', []]];
const BUD0 = {
  A: { equip: 560000, mat: 50000, labor: 120000, wage: 80000, travel: 60000, conf: 60000, net: 30000, abroad: 30000, print: 5000, consult: 5000 },
  B: { mat: 20000, labor: 10000, travel: 15000, net: 10000, print: 5000 },
  C: { equip: 200000, mat: 50000, labor: 250000, wage: 150000, travel: 100000, conf: 50000, net: 120000, abroad: 50000, print: 10000, consult: 20000 },
  D: { equip: 10000, biz: 60000, labor: 30000 }, E: { equip: 30000, biz: 40000, labor: 40000, travel: 20000, net: 20000 }, F: { wage: 240000, consult: 60000 } };
const TYPES = ['API 充值', '服务器与 GPU', '电脑', '会员订阅', '专利费', '国际差旅', '国内差旅', '会议注册费', '耗材', '聚餐'];
const V = { 可: 'yes', 不可: 'no', 条件: 'conditional' };
const RULINGS = [
  ['A', '服务器与 GPU', '2026-06-03', '设备处', '可'], ['A', '电脑', '2026-06-03', '采购办', '条件'], ['A', '会员订阅', '2026-07-15', '财务甲', '不可'],
  ['A', '国际差旅', '2026-05-20', '财务乙', '可'], ['A', '国内差旅', '2026-05-20', '财务乙', '可'], ['A', '会议注册费', '2026-05-20', '财务乙', '可'],
  ['A', '耗材', '2026-05-12', '财务甲', '可'], ['A', '聚餐', '2026-05-12', '财务甲', '不可'], ['A', 'API 充值', '2026-05-12', '财务乙', '可'],
  ['B', 'API 充值', '2026-08-10', '财务乙', '可'], ['B', '服务器与 GPU', '2026-06-18', '财务甲', '不可'], ['B', '耗材', '2026-06-18', '财务甲', '可'], ['B', '国内差旅', '2026-06-18', '财务甲', '可'],
  ['C', 'API 充值', '2026-07-01', '财务乙', '可'], ['C', '电脑', '2026-06-03', '采购办', '条件'], ['C', '国际差旅', '2026-05-20', '财务乙', '可'], ['C', '国内差旅', '2026-05-20', '财务乙', '可'], ['C', '服务器与 GPU', '2026-06-03', '设备处', '可'], ['C', '耗材', '2026-05-12', '财务甲', '可'],
  ['D', '专利费', '2026-08-02', '科发院', '可'], ['D', 'API 充值', '2026-08-02', '财务乙', '可'],
  ['E', '会员订阅', '2026-07-15', '财务甲', '可'], ['E', 'API 充值', '2026-07-15', '财务甲', '可'], ['E', '专利费', '2026-07-15', '财务甲', '可'],
  ['E', '会议注册费', '2026-05-25', '财务甲', '可'], ['E', '聚餐', '2026-05-25', '财务甲', '不可'], ['E', '国内差旅', '2026-05-25', '财务甲', '可']];
const ST = { 已承诺: 'committed', 已入账: 'posted', 被退回: 'returned', 学校审核中: 'at_school', 待审批: 'pending' };
const REQ = [
  ['R01', 'A', 'equip', '服务器与 GPU', 'GPU 服务器', 315000, '已承诺', '2026-09-28', '分散采购', 2],
  ['R02', 'A', 'equip', '服务器与 GPU', '机器人实验平台', 240000, '已承诺', '2026-09-15', '分散采购', 3],
  ['R03', 'A', 'equip', '服务器与 GPU', '内存与硬盘', 48000, '已入账', '2026-06-12', '直采', 4],
  ['R04', 'A', 'net', 'API 充值', 'API 充值 8 月', 10000, '学校审核中', '2026-09-18'],
  ['R05', 'A', 'abroad', '国际差旅', '国际会议出访', 28000, '已入账', '2026-08-30'],
  ['R06', 'A', 'travel', '国内差旅', '国内会议差旅', 12000, '学校审核中', '2026-09-12'],
  ['R07', 'B', 'net', 'API 充值', 'API 充值 7 月', 10000, '已入账', '2026-08-15'],
  ['R08', 'B', 'mat', '耗材', '实验耗材', 8000, '已入账', '2026-06-20'],
  ['R09', 'C', 'net', 'API 充值', 'API 集中充值 三季度', 30000, '已入账', '2026-07-20'],
  ['R10', 'C', 'equip', '电脑', '笔记本 4 台', 28000, '已承诺', '2026-11-15', '集采', 1],
  ['R11', 'E', 'biz', '会员订阅', '文献工具年费', 3200, '待审批', '2026-09-25'],
  ['R12', 'E', 'travel', '会议注册费', '会议注册费', 6000, '已入账', '2026-05-30'],
  ['R13', 'D', 'biz', '专利费', '专利申请费', 4500, '学校审核中', '2026-09-10']];
const PEOPLE = [['P1', '校外 RA-01', '外聘人员劳务费', 3500], ['P2', '校外 RA-02', '外聘人员劳务费', 3500], ['P3', '校外 RA-03', '外聘人员劳务费', 4000],
  ['P4', '学生-01', '学生三兼费', 2500], ['P5', '学生-02', '学生三兼费', 3000], ['P6', '科研助理-01', '编外人员工资', 6500]];
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'];

const id = async (sql, p) => (await one(sql + ' returning id', p)).id;
const U = {};
for (const [k, n, r] of [['fin', '财务岗', 'finance'], ['dir', '负责人', 'director'], ['lead', '项目负责人', 'leader'], ['mem', '成员甲', 'member'], ['mem2', '成员乙', 'member']])
  U[k] = await id(`insert into app_user (name, role, feishu_open_id) values ($1, $2, $3)`, [n, r, 'ou_' + k]);
const T = {}, SUB = {};
for (const [code, t] of Object.entries(TPL)) {
  T[code] = await id(`insert into card_template (code, name, locked) values ($1, $2, $3)`, [code, t.n, !!t.locked]);
  SUB[code] = {};
  for (const [i, s] of t.subs.entries())
    SUB[code][s] = await id(`insert into template_subject (template_id, code, name, sort) values ($1, $2, $3, $4)`, [T[code], s, SUBJ[s], i]);
  for (const [subs, max, n] of t.caps) {
    const cap = await id(`insert into template_cap (template_id, name, max_ratio) values ($1, $2, $3)`, [T[code], n, max]);
    for (const s of subs) await q(`insert into template_cap_subject values ($1, $2)`, [cap, SUB[code][s]]);
  }
}
const C = {}, CT = {};
for (const [k, no, n, tpl, start, cutoff, settle, end, nodes] of CARDS) {
  C[k] = await id(`insert into fund_card (card_no, name, template_id, start_date, cutoff_date, settle_date, end_rule, owner_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [no, n, T[tpl], start, cutoff, settle, end, k === 'E' ? U.lead : null]);
  CT[k] = tpl;
  for (const [d, r, c] of nodes) await q(`insert into card_node (card_id, node_date, ratio, consequence) values ($1,$2,$3,$4)`, [C[k], d, r, c]);
  for (const [s, amt] of Object.entries(BUD0[k])) await q(`insert into budget_line (card_id, subject_id, amount) values ($1,$2,$3)`, [C[k], SUB[tpl][s], amt]);
}
const sub = (k, s) => SUB[CT[k]][s];
const TY = {};
for (const t of TYPES) TY[t] = await id(`insert into expense_type (name, required_path) values ($1, $2)`, [t, t === '电脑' ? '集采' : null]);
for (const [k, t, d, by, v] of RULINGS)
  await q(`insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict) values ($1,$2,$3,$4,$5)`, [C[k], TY[t], d, by, V[v]]);
const R = {};
for (const [rid, k, s, t, title, amt, st, date, pathName, stage] of REQ) {
  const posted = st === '已入账';
  R[rid] = await id(`insert into expense_request (code, card_id, subject_id, expense_type_id, title, amount, eta_date, status, requested_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [rid, C[k], sub(k, s), TY[t], title, amt, date, ST[st], rid === 'R11' ? U.mem : U.lead]);
  if (posted) await q(`insert into voucher (request_id, posted_on, amount) values ($1,$2,$3)`, [R[rid], date, amt]);
  if (pathName) await q(`insert into procurement (request_id, path, stage, stages) values ($1,$2,$3,$4)`, [R[rid], pathName, stage, pathName === '分散采购' ? 6 : 4]);
}
const J = await id(`insert into budget_change (card_id, reason, status, approved_on) values ($1, '会议改线上，设备需求增加', 'approved', '2026-07-20')`, [C.A]);
await q(`insert into budget_change_line values ($1,$2,-50000), ($1,$3,50000)`, [J, sub('A', 'conf'), sub('A', 'equip')]);
const PT = {}, P = {};
for (const [n, s] of [['外聘人员劳务费', 'labor'], ['学生三兼费', 'labor'], ['编外人员工资', 'wage']])
  PT[n] = await id(`insert into pay_type (name, subject_code) values ($1, $2)`, [n, s]);
for (const [pid, n, k, m] of PEOPLE) {
  P[pid] = await id(`insert into person (name) values ($1)`, [n]);
  for (const mo of MONTHS)
    await q(`insert into staff_assignment (person_id, pay_type_id, month, card_id, amount) values ($1,$2,$3,$4,$5)`,
      [P[pid], PT[k], mo + '-01', pid === 'P4' || pid === 'P5' ? C.C : C.A, m]);
}
await q(`insert into emergency_limit values (2026, 5000, 20000)`);

// ---------- 1. 5 到 8 月人员费走发放表入账 ----------
await as(U.fin, '2026-09-05');
for (const mo of MONTHS.slice(0, 4)) {
  await q(`select build_payroll($1)`, [mo + '-01']);
  for (const s of await q(`select id from payroll_sheet where month = $1`, [mo + '-01']))
    await q(`select post_payroll($1, $2)`, [s.id, mo + '-20']);
}

// ---------- 2. 口径（9 月 5 日）----------
let a = await one(`select * from v_card where card_no = '4131-A'`);
eq(a.cur, 1000000, 'A 现行预算'); eq(a.actual, 146000, 'A 决算数'); eq(a.commit, 612000, 'A 承诺'); eq(a.avail, 242000, 'A 可用');
let n = await one(`select * from v_node where card_id = $1 and node_date = '2026-09-20'`, [C.A]);
eq(n.need, 750000, 'A 9-20 节点要求'); eq(n.forecast, 425500, 'A 9-20 节点预测');
eq((await one(`select count(*) c from v_staff_gap`)).c, 24, '人员费空档 24 个人月');
eq((await one(`select cur from v_cell where card_id = $1 and subject_code = 'equip'`, [C.A])).cur, 610000, 'A 设备现行预算含已批复变更');
ok((await q(`select 1 from v_cell where avail < 0`)).length === 0, '没有负的可用额度');

// ---------- 3. 提交时的拦截 ----------
await as(U.mem, '2026-09-05');
const submit = `select submit_request($1,$2,$3,$4,$5,$6,$7,$8) as id`;
await raises('规则不可', /不能列支/, submit, [C.A, sub('A', 'net'), TY['会员订阅'], 'x', 100, '2026-09-20', false, null]);
await raises('规则未知', /还没有答复/, submit, [C.B, sub('B', 'mat'), TY['电脑'], 'x', 100, '2026-09-20', false, null]);
await raises('超可用额度', /可用/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 50001, '2026-09-20', false, null]);
await raises('晚于单据截止', /单据截止/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 100, '2026-11-10', false, null]);
await raises('电脑必须集采', /必须走集采/, submit, [C.A, sub('A', 'equip'), TY['电脑'], 'x', 7000, '2026-10-20', false, '直采']);
await raises('直采上限', /直采单件上限/, submit, [C.C, sub('C', 'equip'), TY['服务器与 GPU'], 'x', 60000, '2026-10-20', false, '直采']);
await raises('紧急通道单笔上限', /紧急通道单笔上限/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 6000, '2026-09-20', true, null]);
await raises('科目不属于该卡', /没有这个科目/, submit, [C.B, sub('A', 'equip'), TY['耗材'], 'x', 100, '2026-09-20', false, null]);
await as(U.mem, '2026-05-20');
await raises('卡未下达', /尚未下达/, submit, [C.F, sub('F', 'wage'), TY['耗材'], 'x', 100, '2026-06-20', false, null]);
await as(U.mem, '2026-09-05');
const r1 = (await one(submit, [C.A, sub('A', 'mat'), TY['耗材'], '试剂', 20000, '2026-09-18', false, null])).id;
eq((await one(`select avail from v_cell where card_id=$1 and subject_code='mat'`, [C.A])).avail, 50000, '待审批不占用额度');
const em = (await one(submit, [C.A, sub('A', 'mat'), TY['耗材'], '急用耗材', 4000, '2026-09-18', true, null])).id;
ok((await one(`select status from expense_request where id=$1`, [em])).status === 'committed', '紧急通道直接承诺');

// ---------- 4. 审批、提交学校、退回、改卡、入账 ----------
await raises('成员不能审批', /当前角色/, `select approve_request($1)`, [r1]);
await as(U.dir, '2026-09-05');
await q(`select approve_request($1)`, [r1]);
eq((await one(`select avail from v_cell where card_id=$1 and subject_code='mat'`, [C.A])).avail, 26000, '批准后占用额度');
await raises('负责人不能提交学校', /当前角色/, `select send_to_school($1)`, [r1]);
await as(U.fin, '2026-09-07');
await raises('采购未验收不能提交学校', /未验收/, `select send_to_school($1)`, [R.R02]);
await q(`select school_return($1, '该卡不能列支 API')`, [R.R04]);
ok((await one(`select verdict from v_reimb_rule where card_id=$1 and expense_type_id=$2`, [C.A, TY['API 充值']])).verdict === 'disputed', '退单写入规则表并标为争议');
await as(U.mem, '2026-09-08');
ok((await one(submit, [C.A, sub('A', 'net'), TY['API 充值'], '争议仍可提交', 100, '2026-09-20', false, null])).id, '争议规则可提交');
await as(U.fin, '2026-09-08');
await raises('改到规则不允许的卡', /规则不允许/, `select move_request($1,$2,$3)`, [R.R04, C.F, sub('F', 'consult')]);
await q(`select move_request($1,$2,$3)`, [R.R04, C.C, sub('C', 'net')]);
ok((await one(`select card_id from expense_request where id=$1`, [R.R04])).card_id === C.C, '改卡成功');
await q(`select send_to_school($1)`, [R.R04]);
await q(`select post_voucher($1, '2026-09-18', 9800, 'PZ-001')`, [R.R04]);
eq((await one(`select actual from v_cell where card_id=$1 and subject_code='net'`, [C.C])).actual, 39800, '入账按实际金额计决算数');
await raises('重复入账', /不在学校审核中/, `select post_voucher($1, '2026-09-18', 9800, null)`, [R.R04]);

// ---------- 5. 采购 ----------
eq((await one(`select procurement_advance($1) s`, [R.R02])).s, 4, '采购推进');
const eta = (await one(`select procurement_fail($1, '流标', '只有一家报价', 30) d`, [R.R01])).d;
ok(new Date(eta).toISOString().slice(0, 10) >= '2026-10-27', '流标后预计入账顺延', String(eta));
ok((await one(`select stage from procurement where request_id=$1`, [R.R01])).stage === 2, '流标后退回挂网');

// ---------- 6. 预算变更 ----------
const lines = (x) => JSON.stringify(x.map(([s, d]) => ({ subject_id: s, delta: d })));
await raises('调剂不平', /不相等/, `select create_change($1, 'x', $2::jsonb)`, [C.A, lines([[sub('A', 'conf'), -1000], [sub('A', 'mat'), 900]])]);
await raises('违反比例上限', /违反模板规则/, `select create_change($1, 'x', $2::jsonb)`, [C.A, lines([[sub('A', 'travel'), -48000], [sub('A', 'conf'), -10000], [sub('A', 'net'), -30000], [sub('A', 'consult'), -5000], [sub('A', 'print'), -5000], [sub('A', 'mat'), -10000], [sub('A', 'labor'), 108000]])]);
await raises('调出超可用', /可用额度不足/, `select create_change($1, 'x', $2::jsonb)`, [C.A, lines([[sub('A', 'abroad'), -5000], [sub('A', 'mat'), 5000]])]);
await raises('锁定科目的卡不能变更', /科目锁定/, `select create_change($1, 'x', $2::jsonb)`, [C.F, lines([[sub('F', 'wage'), -1000], [sub('F', 'consult'), 1000]])]);
const ch = (await one(`select create_change($1, '差旅转材料', $2::jsonb) id`, [C.A, lines([[sub('A', 'travel'), -10000], [sub('A', 'mat'), 10000]])])).id;
await raises('未确认不能批复', /尚未报发规办/, `select approve_change($1)`, [ch]);
await as(U.dir, '2026-09-09'); await q(`select confirm_change($1)`, [ch]);
await as(U.fin, '2026-09-12'); await q(`select approve_change($1)`, [ch]);
eq((await one(`select cur from v_cell where card_id=$1 and subject_code='mat'`, [C.A])).cur, 60000, '批复后现行预算更新');
eq((await one(`select cur from v_card where card_id=$1`, [C.A])).cur, 1000000, '变更不改变总额');

// ---------- 7. 人员改挂 ----------
await raises('财务岗不能改挂', /当前角色/, `select reassign_staff($1,$2,'2026-11-01','2027-04-01',$3)`, [P.P1, PT['外聘人员劳务费'], C.C]);
await as(U.dir, '2026-10-20');
await raises('目标卡没有科目', /没有对应科目/, `select reassign_staff($1,$2,'2026-11-01','2027-04-01',$3)`, [P.P6, PT['编外人员工资'], C.B]);
for (const [p, k] of [['P1', '外聘人员劳务费'], ['P2', '外聘人员劳务费'], ['P3', '外聘人员劳务费'], ['P6', '编外人员工资']])
  eq((await one(`select reassign_staff($1,$2,'2026-11-01','2027-04-01',$3) n`, [P[p], PT[k], C.C])).n, 6, `改挂 ${p}`);
eq((await one(`select count(*) c from v_staff_gap`)).c, 0, '改挂后空档清零');

// ---------- 8. 结清 ----------
await as(U.dir, '2026-11-15');
await raises('未到结清日', /未到结清日/, `select settle_card($1)`, [C.B]);
await as(U.dir, '2026-12-15');
await raises('有未结支出不能结清', /未结/, `select settle_card($1)`, [C.A]);
await raises('跨年卡不结清', /跨年卡/, `select settle_card($1)`, [C.C]);
await q(`select settle_card($1)`, [C.B]);
const sb = await one(`select sum(budget) b, sum(actual) a, sum(balance) x from settlement_line l join card_settlement s on s.id = l.settlement_id where s.card_id = $1`, [C.B]);
eq(sb.b, 60000, 'B 结清：现行预算'); eq(sb.a, 18000, 'B 结清：决算数'); eq(sb.x, 42000, 'B 结清：结余');
await raises('已结清的卡不能再提交', /已结清/, submit, [C.B, sub('B', 'mat'), TY['耗材'], 'x', 100, '2026-11-20', false, null]);
await raises('已结清的卡不能直接改数据', /已结清/, `update budget_line set amount = amount + 1 where card_id = $1`, [C.B]);

// ---------- 9. 访问控制 ----------
await db.exec(`set role app_api`);
await raises('API 角色读不到基础表', /permission denied/, `select * from fund_card`);
await raises('API 角色读不到内部视图', /permission denied/, `select * from v_card`);
await raises('API 角色读不到旧数据', /permission denied/, `select * from legacy.record`);
await raises('API 角色不能直接写', /permission denied/, `insert into api.ruling (card_id) values (null)`);
await as(null, null);
eq((await q(`select * from api.card_pick`)).length, 0, '未登录看不到任何卡');
eq((await q(`select * from api.rule`)).length, 0, '未登录看不到规则');
await raises('未登录不能提交', /当前角色/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 100, '2026-09-20', false, null]);
await as(U.mem, '2026-09-05');
eq((await q(`select * from api.card_pick`)).length, 6, '成员能选卡');
eq((await q(`select * from api.card`)).length, 0, '成员看不到卡的金额');
eq((await q(`select * from api.staff`)).length, 0, '成员看不到人员费');
ok((await q(`select * from api.request`)).every(r => r.requested_by === U.mem), '成员只看到自己的申请');
ok((await q(`select * from api.request`)).length >= 3, '成员能看到自己的申请');
await as(U.mem2, '2026-09-05');
eq((await q(`select * from api.request`)).length, 0, '其他成员看不到别人的申请');
await as(U.lead, '2026-09-05');
eq((await q(`select * from api.card`)).length, 1, '项目负责人只看到自己负责的卡');
await as(U.dir, '2026-09-05');
eq((await q(`select * from api.card`)).length, 6, '中心负责人看到全部卡');
eq((await q(`select * from api.staff`)).length, 72, '中心负责人看到人员费');
ok((await one(`select (login_feishu('ou_new', '新人')).role as role`)).role === 'member', '新用户登录建为普通成员');
ok((await one(`select (login_feishu('ou_new', '新人')).id as id`)).id === (await one(`select (login_feishu('ou_new', '新人')).id as id`)).id, '重复登录是同一个人');
await db.exec(`reset role`);
await q(`insert into app_user (name, role, email) values ('旧账号', 'leader', 'old@example.com')`);
await db.exec(`set role app_api`);
ok((await one(`select (login_feishu('ou_old', '旧账号', 'Old@Example.com')).role as role`)).role === 'leader', '按邮箱认领旧账号并保留角色');
ok((await one(`select (login_feishu('ou_other', '冒名', 'old@example.com')).role as role`)).role === 'member', '已认领的邮箱不能被第二个 open_id 认领');
await as(U.mem, '2026-09-05');
await raises('成员不能维护支出类型', /当前角色/, `select save_expense_type(null, '测试类型')`);
await as(U.fin, '2026-09-05');
const et = (await one(`select save_expense_type(null, ' 测试类型 ') as id`)).id;
ok((await one(`select name from api.expense_type where id = $1`, [et])).name === '测试类型', '财务岗新增支出类型，名称去掉首尾空格');
await raises('支出类型不能重名', /已经有叫/, `select save_expense_type(null, '测试类型')`);
await raises('采购路径只能取三种', /采购路径只能是/, `select save_expense_type(null, '测试类型二', '网购')`);
await q(`select save_expense_type($1, '测试类型改名', '集采')`, [et]);
ok((await one(`select required_path p from api.expense_type where id = $1`, [et])).p === '集采', '支出类型可以改名和改采购路径');
await as(U.dir, '2026-09-05');
await raises('中心负责人不能登记学校侧记录', /当前角色/, `select add_fund_event($1, '到账', '2026-08-28', 50000, '科研系统到账认领')`, [C.A]);
await as(U.fin, '2026-09-05');
await raises('学校侧记录的类型受限', /类型只能是/, `select add_fund_event($1, '拨款', '2026-08-28', 50000)`, [C.A]);
await raises('学校侧记录金额必须为正', /金额必须大于/, `select add_fund_event($1, '到账', '2026-08-28', 0)`, [C.A]);
const fe = (await one(`select add_fund_event($1, '到账', '2026-08-28', 50000, ' 科研系统到账认领 ') as id`, [C.A])).id;
const fe2 = (await one(`select add_fund_event($1, '下达', '2026-04-25', 1000000) as id`, [C.A])).id;
ok((await one(`select done from api.fund_event where id = $1`, [fe])).done === false, '带待办的学校侧记录是未办');
ok((await one(`select done from api.fund_event where id = $1`, [fe2])).done === true, '没有待办的学校侧记录直接算已办');
await q(`select finish_fund_event($1)`, [fe]);
ok((await one(`select done from api.fund_event where id = $1`, [fe])).done === true, '财务岗标记待办已办');
await raises('已办的记录不能重复办结', /已经办结/, `select finish_fund_event($1)`, [fe]);
await as(U.mem, '2026-09-05');
eq((await q(`select * from api.fund_event`)).length, 0, '成员看不到学校侧记录');
await as(U.lead, '2026-09-05');
await raises('项目负责人不能维护人员', /当前角色/, `select save_person(null, '新人甲')`);
await as(U.fin, '2026-09-05');
const np = (await one(`select save_person(null, ' 新人甲 ') as id`)).id;
await raises('人员不能重名', /已经有叫/, `select save_person(null, '新人甲')`);
await raises('发放类型要对应已有科目', /对应的科目/, `select save_pay_type(null, '专家咨询费', 'nope')`);
const npt = (await one(`select save_pay_type(null, '专家咨询费', 'consult', 3000) as id`)).id;
await raises('排布不能超过每月上限', /每月上限/, `select set_staff($1,$2,'2026-09-01','2026-10-01',$3,3500)`, [np, npt, C.A]);
await db.exec(`reset role`);
const noSub = await one(`select c.id from fund_card c where c.status = 'active' and not exists (select 1 from template_subject s where s.template_id = c.template_id and s.code = 'consult') limit 1`);
await db.exec(`set role app_api`);
if (noSub) await raises('排布的卡要有对应科目', /没有对应科目/, `select set_staff($1,$2,'2026-09-01','2026-10-01',$3,1000)`, [np, npt, noSub.id]);
else ok(false, '测试数据里应有一张没有咨询费科目的在用卡');
await raises('排布不能超出现行预算', /超出现行预算/, `select set_staff($1,$2,'2026-09-15','2026-10-01',$3,3000)`, [np, npt, C.A]);
eq((await one(`select set_staff($1,$2,'2026-09-15','2026-12-01',$3,1000) n`, [np, npt, C.A])).n, 4, '排布四个月，日期归到月初');
eq((await q(`select * from api.staff where person_id = $1 and gap is not null`, [np])).length, 2, '发放日过了单据截止的月份标为空档');
eq((await one(`select set_staff($1,$2,'2026-11-01','2026-12-01',null,null) n`, [np, npt])).n, 2, '金额不填是撤掉排布');
await q(`select build_payroll('2026-09-01')`);
await raises('进了发放表的月份不能再改', /已进发放表/, `select set_staff($1,$2,'2026-09-01','2026-10-01',$3,500)`, [np, npt, C.A]);
await raises('有排布的发放类型不能改科目', /不能再改科目/, `select save_pay_type($1, '专家咨询费', 'labor', 3000)`, [npt]);
await as(U.dir, '2026-12-15');
const ya = await q(`select * from api.year_actual`);
const ca = await q(`select card_id, actual from api.card`);
ok(ca.every(c => Math.abs(Number(c.actual) - ya.filter(y => y.card_id === c.card_id).reduce((s, y) => s + Number(y.actual), 0)) < 0.005), '分年度决算数加起来等于各卡决算数');
const sc = await q(`select * from api.settle_check`);
eq(sc.length, (await q(`select * from api.card where status = 'active'`)).length, '每张在用卡都有结清检查');
ok(sc.some(x => x.card_id === C.A && x.open_requests > 0), '有未结支出的卡在结清检查里标出');
await as(U.lead, '2026-12-15');
ok((await q(`select * from api.settle_check`)).every(x => x.card_id === C.E) && (await q(`select * from api.year_actual`)).every(x => x.card_id === C.E), '项目负责人的汇总只含自己的卡');
await as(U.mem, '2026-12-15');
eq((await q(`select * from api.year_actual`)).length + (await q(`select * from api.settle_check`)).length, 0, '成员看不到汇总');

// ---------- 主数据维护 ----------
const val = async (sql, p = []) => (await one(sql, p)).v;
const D = '2026-12-15';
await as(U.mem, D);
await raises('成员不能建模板', /当前角色/, `select save_template(null, 'X1', '测试模板', false)`);
await as(U.fin, D);
const nt = await val(`select save_template(null, 'X1', '测试模板', false) v`);
await raises('模板代码不能重复', /已经有代码/, `select save_template(null, 'X1', '另一个', false)`);
const s1 = await val(`select save_subject(null, $1, 'equip', '设备费') v`, [nt]);
const s2 = await val(`select save_subject(null, $1, 'labor', '劳务费') v`, [nt]);
const s3 = await val(`select save_subject(null, $1, 'tmp', '临时科目') v`, [nt]);
await raises('同一模板科目代码不能重复', /已经有代码/, `select save_subject(null, $1, 'equip', '设备二') v`, [nt]);
await q(`select delete_subject($1)`, [s3]);
eq((await q(`select * from api.subject where template_id = $1`, [nt])).length, 2, '没用过的科目可以删');
await raises('上限里的科目要属于本模板', /不属于这个模板/, `select save_cap(null, $1, '错的', 0.3, $2)`, [nt, JSON.stringify([sub('A', 'equip')])]);
await q(`select save_cap(null, $1, '劳务费不超过 30%', 0.3, $2)`, [nt, JSON.stringify([s2])]);
eq((await q(`select * from api.template_cap where template_id = $1`, [nt]))[0].subject_ids.length, 1, '比例上限带出科目');
const nc = await val(`select save_card(null, '9999-Z', '测试卡', $1, $2, '2026-01-01', '2027-06-30', null, 'carry') v`, [nt, U.lead]);
await raises('卡号不能重复', /已经有卡号/, `select save_card(null, '9999-Z', '重复', $1, null, '2026-01-01', '2027-06-30', null, 'carry')`, [nt]);
await raises('截止日不能早于下达日', /不能早于下达日/, `select save_card(null, '9999-Y', '反了', $1, null, '2026-06-01', '2026-01-01', null, 'carry')`, [nt]);
eq((await q(`select * from api.card where card_id = $1 and cur = 0`, [nc])).length, 1, '新建的卡没录预算也出现在总览里');
await q(`select set_node($1, '2026-12-31', 0.5, '通报')`, [nc]);
await q(`select set_node($1, '2026-12-31', 0.6, '回收')`, [nc]);
const nodes = await q(`select * from api.node where card_id = $1`, [nc]);
ok(nodes.length === 1 && Number(nodes[0].ratio) === 0.6, '同一天的节点是修改不是新增');
const bl = (a, b) => JSON.stringify([{ subject_id: s1, amount: a }, { subject_id: s2, amount: b }]);
await raises('年初预算也受比例上限约束', /违反模板规则/, `select set_budget($1, $2)`, [nc, bl(60000, 40000)]);
eq(await val(`select set_budget($1, $2) v`, [nc, bl(80000, 20000)]), 2, '财务岗录入年初预算');
await raises('录入后财务岗不能再改年初预算', /中心负责人/, `select set_budget($1, $2)`, [nc, bl(90000, 20000)]);
await raises('财务岗不能设紧急通道限额', /当前角色/, `select set_emergency_limit(2027, 3000, 10000)`);
await as(U.dir, D);
await q(`select set_budget($1, $2)`, [nc, JSON.stringify([{ subject_id: s1, amount: 90000 }])]);
eq((await one(`select cur from api.card where card_id = $1`, [nc])).cur, 110000, '中心负责人更正后预算合计正确');
await q(`select set_emergency_limit(2027, 3000, 10000)`);
await raises('全年额度不能小于单笔上限', /不能小于单笔/, `select set_emergency_limit(2027, 3000, 1000)`);
await raises('有预算的卡不能换模板', /不能换科目模板/, `select save_card($1, '9999-Z', '测试卡', $2, $3, '2026-01-01', '2027-06-30', null, 'carry')`, [nc, T.S, U.lead]);
await q(`select save_card($1, '9999-Z', '测试卡改名', $2, $3, '2026-01-01', '2027-09-30', null, 'carry', '备注')`, [nc, nt, U.lead]);
eq((await q(`select * from api.card where card_id = $1 and name = '测试卡改名'`, [nc])).length, 1, '可以改卡信息');
await q(`select delete_node($1)`, [nodes[0].node_id]);
eq((await q(`select * from api.node where card_id = $1`, [nc])).length, 0, '可以删节点');

// ---------- 用户管理 ----------
await raises('不能停用自己', /不能停用自己/, `select set_user_role($1, 'director', false)`, [U.dir]);
await raises('不能改掉自己的角色', /不能停用自己/, `select save_user($1, '主任', null, 'member', true)`, [U.dir]);
await raises('角色要合法', /角色只能是/, `select set_user_role($1, 'boss', true)`, [U.mem]);
const nu = await val(`select save_user(null, '新同事', 'New@Example.com', 'member', true) v`);
eq((await q(`select * from api.user_admin where id = $1 and email = 'new@example.com' and not linked`, [nu])).length, 1, '预先登记的人按小写邮箱等认领');
await raises('邮箱不能重复登记', /已经登记/, `select save_user(null, '又一个', 'new@example.com', 'member', true)`);
await as(U.fin, D);
eq((await q(`select * from api.user_admin`)).length, 0, '财务岗看不到用户管理');

// ---------- 学校余额、通知、批量入账 ----------
await q(`select set_school_balance($1, 500000, 20000)`, [C.C]);
eq((await one(`select school_available from api.card where card_id = $1`, [C.C])).school_available, 480000, '学校可用 = 余额 - 冻结');
await db.exec(`reset role`);
for (const t of ['耗材', 'API 充值']) await q(`insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict) values ($1, $2, '2026-12-01', '财务甲', 'yes')`, [nc, TY[t]]);
await db.exec(`set role app_api`);
await as(U.mem, D);
const nreq = (t, a) => val(`select submit_request_quota($1, $2, $3, $4, $5, '2027-03-01', false, null, null) v`, [nc, s1, TY['耗材'], t, a]);
const b1 = await nreq('批量一', 5000), b2 = await nreq('批量二', 6000);
await raises('登录用户取不到发送队列', /当前角色/, `select * from outbox_take(10)`);
await as(U.dir, D);
await q(`select approve_request($1)`, [b1]); await q(`select approve_request($1)`, [b2]);
const ob = await q(`select * from api.outbox`);
ok(ob.some(o => o.user_id === U.dir && /^待审批/.test(o.text) && /批量一/.test(o.text)), '提交后通知中心负责人');
ok(ob.some(o => o.user_id === U.mem && /^已批准/.test(o.text)), '批准后通知申请人');
ok(!ob.some(o => o.user_id === U.dir && /^已批准/.test(o.text)), '不通知操作者本人');
await as(U.fin, D);
await q(`select send_to_school($1)`, [b1]); await q(`select send_to_school($1)`, [b2]);
const rows = (x) => JSON.stringify(x.map(([id, amount]) => ({ id, amount, posted_on: '2027-01-10', voucher_no: 'PZ-9' })));
await raises('批量入账指出出错的行', /第 2 行（批量一）/, `select post_vouchers($1)`, [rows([[b1, 5000], [b1, 5000]])]);
eq((await q(`select * from api.request where id = $1 and status = 'at_school'`, [b1])).length, 1, '批量入账有一行出错就全部不入');
eq(await val(`select post_vouchers($1) v`, [rows([[b1, 5000], [b2, 5800]])]), 2, '批量入账两笔');
eq((await one(`select posted_amount from api.request where id = $1`, [b2])).posted_amount, 5800, '批量入账金额按实际入账');
await as(U.dir, D);
await raises('中心负责人不能回写学校余额', /当前角色/, `select set_school_balance($1, 1, 0)`, [C.C]);
await as('', D);
const took = await q(`select * from outbox_take(50)`);
ok(took.length > 0 && took.every(t => /^ou_/.test(t.target_id) && t.body.text), '定时任务能取到待发消息');
await q(`select outbox_done($1, true)`, [took[0].msg_id]);
await q(`select outbox_done($1, false, '网络错误')`, [took[1].msg_id]);
await as(U.fin, D);
const ob2 = await q(`select * from api.outbox`);
ok(ob2.find(o => String(o.id) === String(took[0].msg_id)).status === 'sent' && ob2.find(o => String(o.id) === String(took[1].msg_id)).status === 'queued', '发送成功标记已发，失败留在队列重试');

// ---------- 晨星额度 ----------
await raises('财务岗不能设晨星额度', /当前角色/, `select save_quota(null, $1, 2026, 10000, 0.3)`, [U.lead]);
await as(U.dir, D);
const qd = await val(`select save_quota(null, $1, 2026, 10000, 0.3) v`, [U.lead]);
await raises('同一人同一年只有一个额度', /已经有额度/, `select save_quota(null, $1, 2026, 5000, 0.3)`, [U.lead]);
await as(U.mem, D);
const subq = `select submit_request_quota($1, $2, $3, $4, $5, '2027-03-01', false, null, $6) v`;
const rq = await val(subq, [nc, s1, TY['耗材'], '挂额度', 4000, qd]);
await raises('超出晨星额度拦截', /晨星额度不足/, subq, [nc, s1, TY['耗材'], '超额度', 7000, qd]);
await raises('晨星额度里劳务不超过 30%', /劳务类支出超过上限/, subq, [nc, s2, TY['耗材'], '超劳务', 3500, qd]);
eq((await q(`select * from api.request where title in ('超额度', '超劳务')`)).length, 0, '额度拦截时申请整笔不提交');
eq((await q(`select * from api.quota`)).length, 0, '成员看不到额度金额');
eq((await q(`select * from api.quota_pick where id = $1`, [qd])).length, 1, '成员提交时能选到当年额度');
await as(U.lead, D);
const myq = await q(`select * from api.quota`);
ok(myq.length === 1 && Number(myq[0].used) === 4000 && Number(myq[0].actual) === 0 && myq[0].quarter === 4 && myq[0].behind, '负责人看到自己的额度、占用和季度执行');
await as(U.dir, D);
await raises('额度不能调到低于已占用', /晨星额度不足/, `select save_quota($1, null, null, 3000, 0.3)`, [qd]);
await as(U.fin, D);
await q(`select set_request_quota($1, null)`, [rq]);
eq((await one(`select used from api.quota where id = $1`, [qd])).used, 0, '取消挂接后额度释放');

// ---------- 资源使用权 ----------
const rs = await val(`select save_resource(null, 'api', '大模型接口', 'sk-…a3f9', 1000, '美元') v`);
await raises('编号一栏拒绝密钥', /不要填密钥/, `select save_resource(null, 'api', '另一个接口', 'sk-abcdefghijklmnopqrstuvwxyz012345')`);
await q(`select allocate_resource($1, $2, 600)`, [rs, U.mem]);
await raises('接口配额不能超分', /剩余配额/, `select allocate_resource($1, $2, 500)`, [rs, U.mem2]);
const asset = await val(`select save_resource(null, 'asset', '笔记本-01', 'ZC-001') v`);
const al = await val(`select allocate_resource($1, $2) v`, [asset, U.mem]);
await raises('资产同时只在一人名下', /还在别人名下/, `select allocate_resource($1, $2)`, [asset, U.mem2]);
await as(U.mem, D);
const mine = await q(`select * from api.allocation`);
ok(mine.length === 2 && mine.every(a => a.user_id === U.mem && a.current), '成员只看到分给自己的资源');
eq((await q(`select * from api.resource`)).length, 0, '成员看不到资源总表');
await raises('成员不能分配资源', /当前角色/, `select allocate_resource($1, $2)`, [asset, U.mem]);
await as(U.fin, D);
await q(`select return_allocation($1)`, [al]);
await q(`select allocate_resource($1, $2)`, [asset, U.mem2]);
eq((await one(`select holders from api.resource where id = $1`, [asset])).holders, 1, '归还后可以再领用');

// 有库存的一类资产可以按件发给多人
const stock = await val(`select save_resource(null, 'asset', '显示器', null, 3, '台') v`);
await q(`select allocate_resource($1, $2, 2)`, [stock, U.mem]);
await raises('一类资产发放不超过库存', /库存/, `select allocate_resource($1, $2, 2)`, [stock, U.mem2]);
await q(`select allocate_resource($1, $2)`, [stock, U.mem2]);
eq((await one(`select allocated from api.resource where id = $1`, [stock])).allocated, 3, '一类资产按件数累计');

// ---------- 旧门户数据 ----------
await db.exec(`reset role`);
const ent = (type, eid, status, data) => q(`insert into legacy.record (table_id, table_name, record_id, fields) values ('entity', '实体', $1, $2)`,
  [eid, JSON.stringify({ type, id: eid, name: eid, status, data: { id: eid, ...data } })]);
const lname = async (uid) => (await one(`select name from app_user where id = $1`, [uid])).name;
const cardNo = (await one(`select card_no from fund_card where id = $1`, [nc])).card_no;
await ent('funding_project', 'p1', '启用', { project_number: cardNo, total_amount: '1,000,000' });
await ent('milestone', 'm1', '启用', { project_id: 'p1', target_date: '2031-09-20', target_amount: '750000' });
await ent('milestone', 'm2', '启用', { project_id: 'p1', target_date: '2031-08-31', target_amount: '6500000' });
await ent('asset_catalog_item', 'a1', '启用', { name: '旧显示器', spec: '27 寸', unit: '台', stock_quantity: '1', category: '办公设备' });
await ent('asset_ledger', 'l1', '有效', { catalog_id: 'a1', leader_name: await lname(U.mem), quantity: '2', action: '财务直接发放', created_at: '2026-03-01T08:00:00.0000000+08:00' });
await ent('asset_ledger', 'l2', '已作废', { catalog_id: 'a1', leader_name: await lname(U.mem2), quantity: '1', action: '领用预留', created_at: '2026-03-02T08:00:00.0000000+08:00', voided_at: '2026-03-05T08:00:00.0000000+08:00' });
await ent('api_resource_pool', 'k1', '启用', { name: '充值在用', provider: '某服务商', model: '某模型', currency: '元', purchased_amount: '45000', balance_amount: '100' });
await ent('morningstar_budget_submission', 's1', '待审核', { leader_name: await lname(U.mem), file_name: '预算.xlsx', submitted_at: '2026-04-01T08:00:00.0000000+08:00', total_amount: '300' });
await ent('morningstar_budget_item', 'i1', '已通过', { submission_id: 's1', leader_name: await lname(U.mem), expense_type: '耗材', requested_amount: '300', approved_amount: '200' });
await ent('budget_adjustment', 'b1', '启用', { project_id: 'p1', category_name: '材料费', previous_amount: '100', amount: '200', version: '2', adjusted_at: '2026-05-01T08:00:00.0000000+08:00' });
await q(`insert into legacy.record (table_id, table_name, record_id, fields) values ('t1', '资源申请表', 'r1', $1), ('t2', '额度台账表', 'r2', $2)`,
  [JSON.stringify({ 申请人姓名: await lname(U.mem), 资源类型: '接口', 申请状态: '已通过', 预算金额: '500', 申请时间: '1767225600000' }),
   JSON.stringify({ 用户姓名: await lname(U.mem2), 资源类型: '接口', 总额度: '100', 已用额度: '40' })]);
await q(`select legacy_import()`); await q(`select legacy_import()`);
const lnodes = await q(`select * from card_node where card_id = $1 and consequence like '旧门户%'`, [nc]);
ok(lnodes.length === 1 && Number(lnodes[0].ratio) === 0.75, '旧考核节点换算成比例，超过总经费的不导入');
const la = await one(`select * from resource where legacy_id = 'a1'`);
eq(la.total, 2, '旧资产库存不小于已发数量');
const lal = await q(`select * from resource_allocation where legacy_id in ('l1', 'l2') order by legacy_id`);
ok(lal.length === 2 && Number(lal[0].quota) === 2 && lal[0].returned_on === null && lal[1].returned_on !== null, '旧发放台账导入，作废的记为已收回，重复执行不重复导入');
eq((await one(`select total from resource where legacy_id = 'k1'`)).total, 45000, '旧接口资源池导入');
await db.exec(`set role app_api`);
await as(U.mem, D);
eq((await q(`select * from api.legacy_ms_submission`)).length, 1, '负责人看得到自己的旧晨星预算');
eq((await one(`select approved from api.legacy_ms_item`)).approved, 200, '旧晨星明细金额');
ok((await one(`select status from api.legacy_ms_submission`)).status === '已通过', '旧晨星提交的状态按明细推出');
eq((await q(`select * from api.legacy_resource_request`)).length, 1, '看得到自己的旧资源申请');
eq((await q(`select * from api.legacy_quota_ledger`)).length, 0, '看不到别人的旧额度台账');
eq((await q(`select * from api.legacy_record`)).length, 0, '成员看不到旧数据原始记录');
await as(U.mem2, D);
eq((await q(`select * from api.legacy_ms_submission`)).length, 0, '看不到别人的旧晨星预算');
await as(U.fin, D);
eq((await q(`select * from api.legacy_budget_adjust where card_id = $1`, [nc])).length, 1, '旧预算调整挂到对应的卡');
ok((await q(`select * from api.legacy_source`)).length >= 8, '财务岗看得到旧数据目录');

// ---------- 多卡分摊 ----------
await as(U.mem, D);
const parts = (a, b) => JSON.stringify([{ card_id: nc, subject_id: s1, amount: a }, { card_id: C.C, subject_id: sub('C', 'net'), amount: b }]);
await raises('分摊有一处超预算就整笔不提交', /可用/, `select submit_split($1, '分摊失败', '2027-03-01', null, $2)`, [TY['API 充值'], parts(1000, 9999999)]);
eq((await q(`select * from api.request where title like '分摊失败%'`)).length, 0, '分摊失败不留半笔');
await raises('分摊的直采按合计算上限', /直采单件上限/, `select submit_split($1, '分摊直采', '2027-03-01', '直采', $2)`, [TY['API 充值'], parts(30000, 30000)]);
const g = await val(`select submit_split($1, '分摊充值', '2027-03-01', '直采', $2) v`, [TY['API 充值'], parts(1000, 2000)]);
const gp = await q(`select * from api.request where split_group = $1 order by title`, [g]);
ok(gp.length === 2 && /分摊 1\/2/.test(gp[0].title) && gp[0].path === '直采' && gp[1].path === null, '分摊拆成两笔，采购只记在第一笔');
await as(U.dir, D);
for (const x of gp) await q(`select approve_request($1)`, [x.id]);
await as(U.fin, D);
await raises('分摊的任何一笔都要等采购验收', /采购未验收/, `select send_to_school($1)`, [gp[1].id]);
await q(`select procurement_fail($1, '流标', '无人报价', 10)`, [gp[0].id]);
eq((await q(`select * from api.request where split_group = $1 and eta_date = '2027-03-11'`, [g])).length, 2, '流标后分摊的几笔一起顺延');

// ---------- 账号合并 ----------
await as(U.dir, D);
const dup = await val(`select save_user(null, '重复账号', 'dup@example.com', 'member', true) v`);
await raises('不能合并自己正在用的账号', /自己正在用/, `select merge_user($1, $2)`, [U.dir, dup]);
await raises('两个都绑定飞书的账号不能合并', /两个飞书身份/, `select merge_user($1, $2)`, [U.mem, U.mem2]);
await q(`select merge_user($1, $2)`, [dup, U.mem2]);
const ua = await q(`select * from api.user_admin where id in ($1, $2)`, [dup, U.mem2]);
ok(ua.find(u => u.id === dup).active === false && ua.find(u => u.id === U.mem2).email === 'dup@example.com' && ua.find(u => u.id === U.mem2).linked, '合并后旧账号停用，邮箱并到保留的账号');
await db.exec(`reset role`);
ok((await one(`select count(*) c from audit_log`)).c > 0, '审计日志有记录');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
