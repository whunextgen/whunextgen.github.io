// 在内存 Postgres（PGlite）里应用全部迁移，灌入原型的虚构数据，核对口径和拦截规则。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
const mig = path.join(root, 'supabase/migrations');
for (const f of readdirSync(mig).sort()) await db.exec(readFileSync(path.join(mig, f), 'utf8'));
// 登记日（0089）：下面大部分测试是按「期内随时可办」写的，考的是权限、否决期、字段校验这些，与哪一天办无关。
// 这里先把两处判断换成替身（任何一天都算登记日、本期全程可登记），文件末尾换回真函数，专门测登记日。
const REAL_GATES = `create or replace function is_register_day() returns boolean language sql stable security definer set search_path = public as $$ select app_today() = token_period(app_today()) $$;
create or replace function register_window(p_day date) returns boolean language sql immutable as $$
  select p_day = token_period(p_day) or (token_period(p_day) = date '2026-11-23' and p_day <= date '2026-11-24') $$;`;
await db.exec(`create or replace function is_register_day() returns boolean language sql stable security definer set search_path = public as $$ select true $$;
create or replace function register_window(p_day date) returns boolean language sql immutable as $$ select true $$;`);

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
// 直接选卡提交只留给看得到卡的人（财务岗、中心负责人）；成员和项目负责人从预算行提
const submit = `select submit_request($1,$2,$3,$4,$5,$6,$7,$8) as id`;
await as(U.mem, '2026-09-05');
await raises('成员不能直接选卡提交', /拦截：支出须从研究单元预算行提交，不得直接选择经费卡/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 100, '2026-09-20', false, null]);
await as(U.lead, '2026-09-05');
await raises('卡上的负责人也不能直接选卡提交', /拦截：支出须从研究单元预算行提交，不得直接选择经费卡/, submit, [C.E, sub('E', 'biz'), TY['会员订阅'], 'x', 100, '2026-09-20', false, null]);
await as(U.fin, '2026-09-05');
await raises('规则不可', /不能列支/, submit, [C.A, sub('A', 'net'), TY['会员订阅'], 'x', 100, '2026-09-20', false, null]);
await raises('规则未知', /」尚无答复，请先咨询财务岗并记入报销答复记录/, submit, [C.B, sub('B', 'mat'), TY['电脑'], 'x', 100, '2026-09-20', false, null]);
await raises('超可用额度', /可用/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 50001, '2026-09-20', false, null]);
await raises('晚于单据截止', /单据截止/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 100, '2026-11-10', false, null]);
await raises('电脑必须集采', /须通过集采办理/, submit, [C.A, sub('A', 'equip'), TY['电脑'], 'x', 7000, '2026-10-20', false, '直采']);
await raises('直采上限', /直采单件上限/, submit, [C.C, sub('C', 'equip'), TY['服务器与 GPU'], 'x', 60000, '2026-10-20', false, '直采']);
await raises('紧急通道单笔上限', /紧急通道单笔上限/, submit, [C.A, sub('A', 'mat'), TY['耗材'], 'x', 6000, '2026-09-20', true, null]);
await raises('科目不属于该卡', /拦截：该经费卡无此科目/, submit, [C.B, sub('A', 'equip'), TY['耗材'], 'x', 100, '2026-09-20', false, null]);
await as(U.fin, '2026-05-20');
await raises('卡未下达', /尚未下达/, submit, [C.F, sub('F', 'wage'), TY['耗材'], 'x', 100, '2026-06-20', false, null]);
await as(U.fin, '2026-09-05');
const r1 = (await one(submit, [C.A, sub('A', 'mat'), TY['耗材'], '试剂', 20000, '2026-09-18', false, null])).id;
eq((await one(`select avail from v_cell where card_id=$1 and subject_code='mat'`, [C.A])).avail, 50000, '待审批不占用额度');
const em = (await one(submit, [C.A, sub('A', 'mat'), TY['耗材'], '急用耗材', 4000, '2026-09-18', true, null])).id;
ok((await one(`select status from expense_request where id=$1`, [em])).status === 'committed', '紧急通道直接承诺');

// ---------- 4. 审批、提交学校、退回、改卡、入账 ----------
await as(U.mem, '2026-09-05');
await raises('成员不能审批', /当前角色/, `select approve_request($1)`, [r1]);
await as(U.dir, '2026-09-05');
await q(`select approve_request($1)`, [r1]);
eq((await one(`select avail from v_cell where card_id=$1 and subject_code='mat'`, [C.A])).avail, 26000, '批准后占用额度');
await as(U.mem, '2026-09-05');
await raises('成员不能提交学校', /当前角色|需要权限/, `select send_to_school($1)`, [r1]);
await as(U.fin, '2026-09-07');
await raises('采购未验收不能提交学校', /未验收/, `select send_to_school($1)`, [R.R02]);
await q(`select school_return($1, '该卡不能列支 API')`, [R.R04]);
ok((await one(`select verdict from v_reimb_rule where card_id=$1 and expense_type_id=$2`, [C.A, TY['API 充值']])).verdict === 'disputed', '退单写入规则表并标为争议');
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
await raises('锁定科目的卡不能变更', /该经费卡科目已锁定，不得变更预算/, `select create_change($1, 'x', $2::jsonb)`, [C.F, lines([[sub('F', 'wage'), -1000], [sub('F', 'consult'), 1000]])]);
const ch = (await one(`select create_change($1, '差旅转材料', $2::jsonb) id`, [C.A, lines([[sub('A', 'travel'), -10000], [sub('A', 'mat'), 10000]])])).id;
await raises('未确认不能批复', /尚未报发规办/, `select approve_change($1)`, [ch]);
await as(U.dir, '2026-09-09'); await q(`select confirm_change($1)`, [ch]);
await as(U.fin, '2026-09-12'); await q(`select approve_change($1)`, [ch]);
eq((await one(`select cur from v_cell where card_id=$1 and subject_code='mat'`, [C.A])).cur, 60000, '批复后现行预算更新');
eq((await one(`select cur from v_card where card_id=$1`, [C.A])).cur, 1000000, '变更不改变总额');

// ---------- 7. 人员改挂 ----------
await raises('财务岗不能改挂', /当前角色/, `select reassign_staff($1,$2,'2026-11-01','2027-04-01',$3)`, [P.P1, PT['外聘人员劳务费'], C.C]);
await as(U.dir, '2026-10-20');
await raises('目标卡没有科目', /目标经费卡无对应科目/, `select reassign_staff($1,$2,'2026-11-01','2027-04-01',$3)`, [P.P6, PT['编外人员工资'], C.B]);
for (const [p, k] of [['P1', '外聘人员劳务费'], ['P2', '外聘人员劳务费'], ['P3', '外聘人员劳务费'], ['P6', '编外人员工资']])
  eq((await one(`select reassign_staff($1,$2,'2026-11-01','2027-04-01',$3) n`, [P[p], PT[k], C.C])).n, 6, `改挂 ${p}`);
eq((await one(`select count(*) c from v_staff_gap`)).c, 0, '改挂后空档清零');

// ---------- 8. 结清 ----------
await as(U.dir, '2026-11-15');
await raises('未到结清日', /未到结清日/, `select settle_card($1)`, [C.B]);
await as(U.dir, '2026-12-15');
await raises('有未结支出不能结清', /未结/, `select settle_card($1)`, [C.A]);
await raises('跨年卡不结清', /跨年度经费卡无结清日，本年度仅作小结/, `select settle_card($1)`, [C.C]);
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
eq((await q(`select * from api.card_pick`)).length, 0, '成员看不到经费卡，也选不了卡');
eq((await q(`select * from api.rule`)).length, 0, '成员看不到按卡的报销规则');
{ const lk = await q(`select * from api.rule_lookup`);
  ok(lk.length > 0 && lk.some((r) => r.can_yes || r.has_no || r.has_cond), '成员能查一类支出能不能报');
  ok(lk.every((r) => !('card_id' in r) && !('card_no' in r)), '能不能报的查询里不带经费卡'); }
eq((await q(`select * from api.card`)).length, 0, '成员看不到卡的金额');
eq((await q(`select * from api.staff`)).length, 0, '成员看不到人员费');
ok((await q(`select * from api.request`)).every(r => r.requested_by === U.mem), '成员只看到自己的申请');
ok((await q(`select * from api.request`)).length >= 1, '成员能看到自己的申请');
ok((await q(`select card_id from api.request`)).every(r => r.card_id === null), '成员看自己的申请时看不到落在哪张卡');
await as(U.mem2, '2026-09-05');
eq((await q(`select * from api.request`)).length, 0, '其他成员看不到别人的申请');
await as(U.lead, '2026-09-05');
eq((await q(`select * from api.card`)).length, 0, '卡上的负责人也看不到经费卡');
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
ok((await one(`select (login_feishu('ou_app2_old', '旧账号', null, 'on_old')).role as role`)).role === 'member', '换了应用且没有预先登记 union_id 时按新人处理');
await db.exec(`reset role`);
await q(`update app_user set feishu_union_id = 'on_real' where feishu_open_id = 'ou_old'`);
await db.exec(`set role app_api`);
ok((await one(`select (login_feishu('ou_app2_real', '旧账号', null, 'on_real')).role as role`)).role === 'leader', '换了应用后按 union_id 认回原账号');
ok((await one(`select feishu_open_id as o from login_feishu('ou_app2_real', '旧账号', null, 'on_real')`)).o === 'ou_old', '按 union_id 登录不改原来的 open_id');
ok((await one(`select feishu_union_id as n from login_feishu('ou_new', '新人', null, 'on_new')`)).n === 'on_new', '原应用登录时补记 union_id');
await as(U.mem, '2026-09-05');
await raises('成员不能维护支出类型', /当前角色/, `select save_expense_type(null, '测试类型')`);
await as(U.fin, '2026-09-05');
const et = (await one(`select save_expense_type(null, ' 测试类型 ') as id`)).id;
ok((await one(`select name from api.expense_type where id = $1`, [et])).name === '测试类型', '财务岗新增支出类型，名称去掉首尾空格');
await raises('支出类型不能重名', /已存在名称为「/, `select save_expense_type(null, '测试类型')`);
await raises('采购路径只能取三种', /采购路径仅限直采、集采或分散采购/, `select save_expense_type(null, '测试类型二', '网购')`);
await q(`select save_expense_type($1, '测试类型改名', '集采')`, [et]);
ok((await one(`select required_path p from api.expense_type where id = $1`, [et])).p === '集采', '支出类型可以改名和改采购路径');
await as(U.mem, '2026-09-05');
await raises('成员不能登记学校侧记录', /当前角色|需要权限/, `select add_fund_event($1, '到账', '2026-08-28', 50000, '科研系统到账认领')`, [C.A]);
await as(U.fin, '2026-09-05');
await raises('学校侧记录的类型受限', /类型仅限下达、到账、认领、预借票、核销、冻结或回收/, `select add_fund_event($1, '拨款', '2026-08-28', 50000)`, [C.A]);
await raises('学校侧记录金额必须为正', /金额须大于/, `select add_fund_event($1, '到账', '2026-08-28', 0)`, [C.A]);
const fe = (await one(`select add_fund_event($1, '到账', '2026-08-28', 50000, ' 科研系统到账认领 ') as id`, [C.A])).id;
const fe2 = (await one(`select add_fund_event($1, '下达', '2026-04-25', 1000000) as id`, [C.A])).id;
ok((await one(`select done from api.fund_event where id = $1`, [fe])).done === false, '带待办的学校侧记录是未办');
ok((await one(`select done from api.fund_event where id = $1`, [fe2])).done === true, '没有待办的学校侧记录直接算已办');
await q(`select finish_fund_event($1)`, [fe]);
ok((await one(`select done from api.fund_event where id = $1`, [fe])).done === true, '财务岗标记待办已办');
await raises('已办的记录不能重复办结', /该记录不存在或已办结/, `select finish_fund_event($1)`, [fe]);
await as(U.mem, '2026-09-05');
eq((await q(`select * from api.fund_event`)).length, 0, '成员看不到学校侧记录');
await as(U.lead, '2026-09-05');
await raises('项目负责人不能维护人员', /当前角色/, `select save_person(null, '新人甲')`);
await as(U.fin, '2026-09-05');
const np = (await one(`select save_person(null, ' 新人甲 ') as id`)).id;
await raises('人员不能重名', /」的人员，同名请加备注区分/, `select save_person(null, '新人甲')`);
await raises('发放类型要对应已有科目', /对应的科目/, `select save_pay_type(null, '专家咨询费', 'nope')`);
const npt = (await one(`select save_pay_type(null, '专家咨询费', 'consult', 3000) as id`)).id;
await raises('排布不能超过每月上限', /每月上限/, `select set_staff($1,$2,'2026-09-01','2026-10-01',$3,3500)`, [np, npt, C.A]);
await db.exec(`reset role`);
const noSub = await one(`select c.id from fund_card c where c.status = 'active' and not exists (select 1 from template_subject s where s.template_id = c.template_id and s.code = 'consult') limit 1`);
await db.exec(`set role app_api`);
if (noSub) await raises('排布的卡要有对应科目', /无对应科目/, `select set_staff($1,$2,'2026-09-01','2026-10-01',$3,1000)`, [np, npt, noSub.id]);
else ok(false, '测试数据里应有一张没有咨询费科目的在用卡');
await raises('排布不能超出现行预算', /超出现行预算/, `select set_staff($1,$2,'2026-09-15','2026-10-01',$3,3000)`, [np, npt, C.A]);
eq((await one(`select set_staff($1,$2,'2026-09-15','2026-12-01',$3,1000) n`, [np, npt, C.A])).n, 4, '排布四个月，日期归到月初');
eq((await q(`select * from api.staff where person_id = $1 and gap is not null`, [np])).length, 2, '发放日过了单据截止的月份标为空档');
eq((await one(`select set_staff($1,$2,'2026-11-01','2026-12-01',null,null) n`, [np, npt])).n, 2, '金额不填是撤掉排布');
await q(`select build_payroll('2026-09-01')`);
await raises('进了发放表的月份不能再改', /部分月份已进入发放表，不得修改/, `select set_staff($1,$2,'2026-09-01','2026-10-01',$3,500)`, [np, npt, C.A]);
await raises('有排布的发放类型不能改科目', /该发放类型已有排布，不得变更科目/, `select save_pay_type($1, '专家咨询费', 'labor', 3000)`, [npt]);
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
await raises('模板代码不能重复', /已存在代码为「/, `select save_template(null, 'X1', '另一个', false)`);
const s1 = await val(`select save_subject(null, $1, 'equip', '设备费') v`, [nt]);
const s2 = await val(`select save_subject(null, $1, 'labor', '劳务费') v`, [nt]);
const s3 = await val(`select save_subject(null, $1, 'tmp', '临时科目') v`, [nt]);
await raises('同一模板科目代码不能重复', /该模板已存在代码为「/, `select save_subject(null, $1, 'equip', '设备二') v`, [nt]);
await q(`select delete_subject($1)`, [s3]);
eq((await q(`select * from api.subject where template_id = $1`, [nt])).length, 2, '没用过的科目可以删');
await raises('上限里的科目要属于本模板', /所选科目不属于该模板/, `select save_cap(null, $1, '错的', 0.3, $2)`, [nt, JSON.stringify([sub('A', 'equip')])]);
await q(`select save_cap(null, $1, '劳务费不超过 30%', 0.3, $2)`, [nt, JSON.stringify([s2])]);
eq((await q(`select * from api.template_cap where template_id = $1`, [nt]))[0].subject_ids.length, 1, '比例上限带出科目');
const nc = await val(`select save_card(null, '9999-Z', '测试卡', $1, $2, '2026-01-01', '2027-06-30', null, 'carry') v`, [nt, U.lead]);
await raises('卡号不能重复', /已存在卡号为「/, `select save_card(null, '9999-Z', '重复', $1, null, '2026-01-01', '2027-06-30', null, 'carry')`, [nt]);
await raises('截止日不能早于下达日', /单据截止日不得早于下达日/, `select save_card(null, '9999-Y', '反了', $1, null, '2026-06-01', '2026-01-01', null, 'carry')`, [nt]);
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
await raises('全年额度不能小于单笔上限', /全年额度不得小于单笔上限/, `select set_emergency_limit(2027, 3000, 1000)`);
await raises('有预算的卡不能换模板', /该经费卡已有预算、支出或人员经费，不得更换科目模板/, `select save_card($1, '9999-Z', '测试卡', $2, $3, '2026-01-01', '2027-06-30', null, 'carry')`, [nc, T.S, U.lead]);
await q(`select save_card($1, '9999-Z', '测试卡改名', $2, $3, '2026-01-01', '2027-09-30', null, 'carry', '备注')`, [nc, nt, U.lead]);
eq((await q(`select * from api.card where card_id = $1 and name = '测试卡改名'`, [nc])).length, 1, '可以改卡信息');
await q(`select delete_node($1)`, [nodes[0].node_id]);
eq((await q(`select * from api.node where card_id = $1`, [nc])).length, 0, '可以删节点');

// ---------- 用户管理 ----------
await raises('不能停用自己', /不得停用本人账号或变更本人角色，请由另一位中心负责人操作/, `select set_user_role($1, 'director', false)`, [U.dir]);
await raises('不能改掉自己的角色', /不得停用本人账号或变更本人角色，请由另一位中心负责人操作/, `select save_user($1, '主任', null, 'member', true)`, [U.dir]);
await raises('角色要合法', /角色仅限财务岗、中心负责人、课题\/研究单元负责人或成员/, `select set_user_role($1, 'boss', true)`, [U.mem]);
const nu = await val(`select save_user(null, '新同事', 'New@Example.com', 'member', true) v`);
eq((await q(`select * from api.user_admin where id = $1 and email = 'new@example.com' and not linked`, [nu])).length, 1, '预先登记的人按小写邮箱等认领');
await raises('邮箱不能重复登记', /该邮箱已登记在其他用户名下/, `select save_user(null, '又一个', 'new@example.com', 'member', true)`);
await as(U.fin, D);
eq((await q(`select * from api.user_admin`)).length, 0, '财务岗看不到用户管理');

// ---------- 学校余额、通知、批量入账 ----------
await q(`select set_school_balance($1, 500000, 20000)`, [C.C]);
eq((await one(`select school_available from api.card where card_id = $1`, [C.C])).school_available, 480000, '学校可用 = 余额 - 冻结');
await db.exec(`reset role`);
for (const t of ['耗材', 'API 充值']) await q(`insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict) values ($1, $2, '2026-12-01', '财务甲', 'yes')`, [nc, TY[t]]);
await db.exec(`set role app_api`);
await as(U.fin, D);
const nreq = (t, a) => val(`select submit_request($1, $2, $3, $4, $5, '2027-03-01', false, null) v`, [nc, s1, TY['耗材'], t, a]);
const b1 = await nreq('批量一', 5000), b2 = await nreq('批量二', 6000);
await raises('登录用户取不到发送队列', /当前角色/, `select * from outbox_take(10)`);
await as(U.dir, D);
await q(`select approve_request($1)`, [b1]); await q(`select approve_request($1)`, [b2]);
const ob = await q(`select * from api.outbox`);
ok(ob.some(o => o.user_id === U.dir && /^待审批/.test(o.text) && /批量一/.test(o.text)), '提交后通知中心负责人');
ok(ob.some(o => o.user_id === U.fin && /^已批准/.test(o.text)), '批准后通知申请人');
ok(!ob.some(o => o.user_id === U.dir && /^已批准/.test(o.text)), '不通知操作者本人');
await as(U.fin, D);
await q(`select send_to_school($1)`, [b1]); await q(`select send_to_school($1)`, [b2]);
const rows = (x) => JSON.stringify(x.map(([id, amount]) => ({ id, amount, posted_on: '2027-01-10', voucher_no: 'PZ-9' })));
await raises('批量入账指出出错的行', /第 2 行（批量一）/, `select post_vouchers($1)`, [rows([[b1, 5000], [b1, 5000]])]);
eq((await q(`select * from api.request where id = $1 and status = 'at_school'`, [b1])).length, 1, '批量入账有一行出错就全部不入');
eq(await val(`select post_vouchers($1) v`, [rows([[b1, 5000], [b2, 5800]])]), 2, '批量入账两笔');
eq((await one(`select posted_amount from api.request where id = $1`, [b2])).posted_amount, 5800, '批量入账金额按实际入账');
await as(U.mem, D);
await raises('成员不能回写学校余额', /当前角色|需要权限/, `select set_school_balance($1, 1, 0)`, [C.C]);
await as('', D);
const took = await q(`select * from outbox_take(50)`);
ok(took.length > 0 && took.every(t => /^ou_/.test(t.target_id) && t.body.text), '定时任务能取到待发消息');
await q(`select outbox_done($1, true)`, [took[0].msg_id]);
await q(`select outbox_done($1, false, '网络错误')`, [took[1].msg_id]);
await as(U.fin, D);
const ob2 = await q(`select * from api.outbox`);
ok(ob2.find(o => String(o.id) === String(took[0].msg_id)).status === 'sent' && ob2.find(o => String(o.id) === String(took[1].msg_id)).status === 'queued', '发送成功标记已发，失败留在队列重试');

// ---------- 资源使用权 ----------
const rs = await val(`select save_resource(null, 'api', '大模型接口', 'sk-…a3f9', 1000, '美元') v`);
await raises('编号一栏拒绝密钥', /编号栏仅填写保管库编号或掩码（例如 sk-…a3f9），不得填写密钥本身/, `select save_resource(null, 'api', '另一个接口', 'sk-abcdefghijklmnopqrstuvwxyz012345')`);
await q(`select allocate_resource($1, $2, 600)`, [rs, U.mem]);
await raises('接口配额不能超分', /剩余配额/, `select allocate_resource($1, $2, 500)`, [rs, U.mem2]);
const asset = await val(`select save_resource(null, 'asset', '笔记本-01', 'ZC-001') v`);
const al = await val(`select allocate_resource($1, $2) v`, [asset, U.mem]);
await raises('资产同时只在一人名下', /」尚在他人名下，请先登记归还/, `select allocate_resource($1, $2)`, [asset, U.mem2]);
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
const recon = await q(`select * from api.legacy_recon`);
const rc = (k) => recon.find((x) => x.key === k);
ok(rc('node').old_n === 2 && rc('node').in_n === 1 && rc('node').new_n === 1 && rc('node').ok === true, '对账：考核节点旧 2 条、转入 1 条');
ok(rc('asset_ledger').new_n === 2 && rc('asset_ledger').ok === true && Number(rc('pool').new_amt) === 45000 && rc('pool').ok === true, '对账：资产台账和接口资源池对得上');
ok(Number(rc('ms_item:已通过').old_amt) === 300 && rc('ms_item:已通过').ok === null && rc('ms_item:已通过').step === 3, '对账：已通过的晨星明细归在承诺，只存档');
ok(recon.filter((x) => x.in_n != null).every((x) => x.ok === true), '对账：转入新系统的每一类都对得上');
eq(recon.reduce((s, x) => s + x.old_n, 0), recon[0].all_n, '对账：各类条数加起来等于旧数据总条数');
await db.exec(`reset role`); await q(`update resource set total = 44000 where legacy_id = 'k1'`); await db.exec(`set role app_api`); await as(U.fin, D);
ok((await one(`select ok from api.legacy_recon where key = 'pool'`)).ok === false, '对账：新系统的数被改动后显示对不上');
await db.exec(`reset role`); await q(`update resource set total = 45000 where legacy_id = 'k1'`); await db.exec(`set role app_api`);
await as(U.mem, D);
eq((await q(`select * from api.legacy_recon`)).length, 0, '成员看不到对账表');

// ---------- 多卡分摊 ----------
await as(U.fin, D);
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
await raises('不能合并自己正在用的账号', /不得合并本人正在使用的账号，请调换合并方向/, `select merge_user($1, $2)`, [U.dir, dup]);
await raises('两个都绑定飞书的账号不能合并', /两个飞书身份/, `select merge_user($1, $2)`, [U.mem, U.mem2]);
await q(`select merge_user($1, $2)`, [dup, U.mem2]);
const ua = await q(`select * from api.user_admin where id in ($1, $2)`, [dup, U.mem2]);
ok(ua.find(u => u.id === dup).active === false && ua.find(u => u.id === U.mem2).email === 'dup@example.com' && ua.find(u => u.id === U.mem2).linked, '合并后旧账号停用，邮箱并到保留的账号');
const xo = (await one(`select (login_feishu('ou_x_old', '跨应用')).id as id`)).id;
const xn = (await one(`select (login_feishu('ou_x_new', '跨应用（改过名）', null, 'on_x')).id as id`)).id;
ok(xo !== xn, '旧账号没记 union_id、飞书上又改了名的，新应用登录另建账号');
await q(`select merge_user($1, $2)`, [xn, xo]);
ok((await one(`select (login_feishu('ou_x_new', '跨应用（改过名）', null, 'on_x')).id as id`)).id === xo, '只有一边有 union_id 的两个账号可以合并，之后登录认回保留的账号');
const y1 = (await one(`select (login_feishu('ou_y1', '甲', null, 'on_y1')).id as id`)).id;
const y2 = (await one(`select (login_feishu('ou_y2', '乙', null, 'on_y2')).id as id`)).id;
await raises('两边都有 union_id 的账号不能合并', /两个飞书身份/, `select merge_user($1, $2)`, [y1, y2]);

// ---------- 年度预算：申报、汇总报批、核定 ----------
await as(U.mem, D);
await raises('成员不能建项目', /./, `select save_project(null, 'P-X', '越权项目', 'project', null, true)`);
await as(U.fin, D);
const P1 = await val(`select save_project(null, 'P-01', '具身智能评测', 'project', $1, true) v`, [U.lead]);
const P2 = await val(`select save_project(null, 'P-02', '金融大模型', 'project', $1, true) v`, [U.mem]);
const P0 = await val(`select save_project(null, 'PUB', '中心公共开支', 'public', null, true) v`);
await raises('项目编号不能重复', /已存在编号为「/, `select save_project(null, 'P-01', '重复', 'project', null, true)`);
// ---------- 项目分两层 ----------
const PA1 = await val(`select save_project(null, '', '论文甲', 'project', $1, true, $2) v`, [U.mem2, P1]);
const PA2 = await val(`select save_project(null, '', '论文乙', null, $1, true, $2) v`, [U.lead, P1]);
let pa = await q(`select id, code, layer, kind, parent_id, parent_code, parent_name from api.project where parent_id = $1 order by code`, [P1]);
ok(pa.length === 2 && pa[0].code === 'P-01-01' && pa[1].code === 'P-01-02' && pa.every(x => x.layer === 'paper' && x.kind === 'project' && x.parent_code === 'P-01'), '论文项目挂在大项目下，编号自动编', JSON.stringify(pa));
ok((await one(`select layer, parent_id from api.project where id = $1`, [P1])).layer === 'big', '原有项目都是大项目');
await raises('论文项目要有负责人', /指定负责人/, `select save_project(null, '', '没人管', 'project', null, true, $1)`, [P1]);
await raises('论文项目不能再往下套', /研究单元仅可设在课题之下/, `select save_project(null, '', '套娃', 'project', $1, true, $2)`, [U.lead, PA1]);
await raises('公共开支下面不挂论文项目', /中心公共开支之下不设研究单元/, `select save_project(null, '', '公共论文', 'project', $1, true, $2)`, [U.lead, P0]);
await raises('有论文项目的大项目不能改成论文项目', /该课题下尚有研究单元，不得改为研究单元/, `select save_project($1, 'P-01', '具身智能评测', 'project', $2, true, $3)`, [P1, U.lead, P2]);
await raises('下面有在用的论文项目时大项目不能停用', /下设研究单元尚在使用，请先停用/, `select save_project($1, 'P-01', '具身智能评测', 'project', $2, false)`, [P1, U.lead]);
await raises('不能挂在自己下面', /不得设在自身之下/, `select save_project($1, 'P-02', '金融大模型', 'project', $2, true, $1)`, [P2, U.mem]);
await q(`select save_project($1, 'P-01-02', '论文乙', null, $2, true, $3)`, [PA2, U.lead, P2]);
ok((await one(`select parent_code from api.project where id = $1`, [PA2])).parent_code === 'P-02', '论文项目可以改挂到别的大项目');
await q(`select save_project($1, 'P-01-02', '论文乙', null, $2, false, $3)`, [PA2, U.lead, P2]);
await as(U.lead, D);
let sv = await one(`select mine, seen from api.project where id = $1`, [PA1]);
ok(sv.mine === false && sv.seen === true, '大项目负责人看得到下面论文项目的预算，但不能替它填', JSON.stringify(sv));
ok((await q(`select 1 from api.project where id = $1`, [PA2])).length === 0, '停用的论文项目负责人看不到');
await as(U.mem2, D);
sv = await one(`select mine, seen from api.project where id = $1`, [PA1]);
ok(sv.mine === true && sv.seen === true, '论文项目负责人能填自己的论文项目');
ok((await one(`select seen from api.project where id = $1`, [P1])).seen === true, '课题全公开：研究单元负责人看得到所属课题的预算');
await as(U.mem, D);
ok((await one(`select seen from api.project where id = $1`, [PA1])).seen === true, '课题全公开：别的课题负责人看得到这个研究单元的预算');
await as(U.fin, D);
// ---------- 资源申请、库存、密钥、备用金、经费卡属性、补登 ----------
await q(`select set_resource_info($1, $2)`, [rs, JSON.stringify({ provider: '服务商甲', model: '通用模型', currency: '美元', balance: '820.5' })]);
let ri = await one(`select provider, balance, balance_on::text d from api.resource where id = $1`, [rs]);
ok(ri.provider === '服务商甲' && Number(ri.balance) === 820.5 && ri.d === D, '资源池属性可以改，余额带上更新日期');
await raises('属性里拒绝密钥', /属性中不得填写密钥，密钥须单独保存/, `select set_resource_info($1, $2)`, [rs, JSON.stringify({ location: 'sk-abcdefghijklmnopqrstuvwxyz012345' })]);
await raises('不认识的属性不收', /无效属性：/, `select set_resource_info($1, $2)`, [rs, JSON.stringify({ kind: 'asset' })]);
await raises('入库要对应支出申请', /对应一笔已批准的支出申请/, `select stock_in($1, 2, 1500, null, '供应商甲')`, [stock]);
const buy = await val(`select id v from api.request where status in ('committed','at_school','posted') limit 1`);
const pend = await val(`select id v from api.request where status = 'pending' limit 1`);
if (pend) await raises('没批准的支出不能入库', /尚未批准/, `select stock_in($1, 2, 1500, null, '供应商甲', null, $2)`, [stock, pend]);
await q(`select stock_in($1, 2, 1500, null, '供应商甲', null, $2)`, [stock, buy]);
ri = await one(`select total, unit_price from api.resource where id = $1`, [stock]);
ok(Number(ri.total) === 5 && Number(ri.unit_price) === 1500, '验收入库后库存增加，记下单价');
await raises('单件资产不记库存', /单件资产/, `select stock_in($1, 1)`, [asset]);
await q(`select stock_in($1, 500, null, null, null, null, $2)`, [rs, buy]);
ri = await one(`select total, balance from api.resource where id = $1`, [rs]);
ok(Number(ri.total) === 1500 && Number(ri.balance) === 1320.5, '接口充值后总配额和余额同时增加');
eq((await q(`select * from api.resource_stock`)).length, 2, '入库记录留痕');
const alq = await val(`select id v from api.allocation where resource_id = $1 and user_id = $2`, [rs, U.mem]);
await q(`select set_allocation_info($1, 250)`, [alq]);
eq((await one(`select used from api.resource where id = $1`, [rs])).used, 250, '已用量回写后汇总到资源池');
await raises('已用量不能超过额度', /超过已分配额度/, `select set_allocation_info($1, 700)`, [alq]);
await as(U.mem, D);
await raises('成员不能入库', /当前角色/, `select stock_in($1, 1)`, [stock]);
eq((await one(`select used from api.allocation where id = $1`, [alq])).used, 250, '使用人看得到自己的已用量');

await as(U.fin, D);
await q(`select set_card_info($1, 'vertical', 500000, 1)`, [C.C]);
const ci = await one(`select fund_kind, received, priority from api.card where card_id = $1`, [C.C]);
ok(ci.fund_kind === 'vertical' && Number(ci.received) === 500000 && ci.priority === 1, '经费卡可以记经费性质、到账和下达优先级');
await raises('经费性质只有三种', /纵向、财政或横向/, `select set_card_info($1, 'other', null, null)`, [C.C]);
await q(`select set_card_info($1, 'vertical', 500000, null)`, [C.C]);

const nReq = (await q(`select id from api.request`)).length;
const rec = `select record_expense($1, $2, $3, $4, $5, $6, $7) v`;
const re1 = await val(rec, [C.C, sub('C', 'net'), TY['API 充值'], '补登：云服务', 1200, '2026-12-01', 'PZ-9']);
const rr = await one(`select status, amount from api.request where id = $1`, [re1]);
ok(rr.status === 'posted' && Number(rr.amount) === 1200, '补登的支出直接是已入账');
await raises('补登日期不能晚于今天', /入账日期不得为空，且不得晚于当日/, rec, [C.C, sub('C', 'net'), TY['API 充值'], '未来', 100, '2027-01-01', null]);
await raises('补登也不能超过可用额', /不足/, rec, [C.C, sub('C', 'net'), TY['API 充值'], '超额', 99999999, '2026-12-01', null]);
await raises('批量补登有一行不对就整批不记', /第 2 行/, `select record_expenses($1)`, [JSON.stringify([
  { card_id: C.C, subject_id: sub('C', 'net'), expense_type_id: TY['API 充值'], title: '甲', amount: 10, posted_on: '2026-12-01' },
  { card_id: C.C, subject_id: sub('C', 'net'), expense_type_id: TY['API 充值'], title: '乙', amount: 0, posted_on: '2026-12-01' }])]);
eq((await q(`select id from api.request`)).length, nReq + 1, '整批回滚');
await as(U.mem, D);
await raises('成员不能补登', /当前角色/, rec, [C.C, sub('C', 'net'), TY['API 充值'], '越权', 100, '2026-12-01', null]);

await as(U.fin, D);
await raises('年度预算没开始不能申报', /年度预算尚未启动/, `select save_budget_line(null, 2027, $1, (select id from api.budget_category where code = 'EQUIP'), '服务器', 1, 0, 0, 0)`, [P1]);
await q(`select open_budget_year(2027, '2026-11-30')`);
await q(`select open_budget_year(2027, '2026-12-05')`);
ok(String((await one(`select due_date::text d from api.budget_year where year = 2027`)).d) === '2026-12-05', '申报阶段财务岗可以改截止日');
const cat = async (c) => await val(`select id v from api.budget_category where code = $1`, [c]);
const [cE, cL, cT] = [await cat('EQUIP'), await cat('LABOR'), await cat('TRAVEL')];
await as(U.lead, D);
const L1 = await val(`select save_budget_line(null, 2027, $1, $2, 'GPU 服务器', 300000, 0, 0, 0) v`, [P1, cE]);
const L2 = await val(`select save_budget_line(null, 2027, $1, $2, '学生劳务', 20000, 20000, 20000, 20000) v`, [P1, cL]);
await raises('不能替别的项目填预算', /仅课题负责人和财务岗可填报该课题预算/, `select save_budget_line(null, 2027, $1, $2, '越权', 1, 0, 0, 0)`, [P2, cE]);
await raises('四期都是零不能保存', /四个预算期至少填写一期金额/, `select save_budget_line(null, 2027, $1, $2, '空行', 0, 0, 0, 0)`, [P1, cE]);
await raises('用途必填', /请填写经费用途/, `select save_budget_line(null, 2027, $1, $2, ' ', 1, 0, 0, 0)`, [P1, cE]);
await q(`select save_budget_line($1, null, null, $2, '学生劳务', 20000, 20000, 20000, 30000)`, [L2, cL]);
eq((await one(`select declared from api.budget_line where id = $1`, [L2])).declared, 90000, '改一行后申报数是四期之和');
eq((await q(`select * from api.budget_line`)).length, 2, '项目负责人只看到自己项目的预算行');
ok((await one(`select granted_amount g, stage from api.budget_year where year = 2027`)).stage === 'declare', '项目负责人能看到年度在哪一步');
await q(`select set_project_budget(2027, $1, 'submit')`, [P1]);
await raises('提交后不能再改', /该课题预算已提交，修改前请先撤回/, `select save_budget_line($1, null, null, $2, '改', 1, 0, 0, 0)`, [L1, cE]);
await raises('提交后不能删行', /该课题预算已提交，修改前请先撤回/, `select delete_budget_line($1)`, [L1]);
await q(`select set_project_budget(2027, $1, 'withdraw')`, [P1]);
await q(`select set_project_budget(2027, $1, 'submit')`, [P1]);
await raises('项目负责人不能退回', /./, `select set_project_budget(2027, $1, 'return', '重填')`, [P1]);
await raises('项目负责人不能截止申报', /./, `select advance_budget_year(2027, 'close')`);
await as(U.mem, D);
const L3 = await val(`select save_budget_line(null, 2027, $1, $2, '调研差旅', 0, 15000, 15000, 0) v`, [P2, cT]);
eq((await q(`select * from api.budget_line`)).length, 3, '课题全公开：别的课题的预算行也看得到');
await as(U.fin, D);
const L0 = await val(`select save_budget_line(null, 2027, $1, $2, '公共服务器维保', 10000, 10000, 10000, 10000) v`, [P0, cE]);
await q(`select set_project_budget(2027, $1, 'submit')`, [P0]);
await raises('退回要写原因', /退回原因/, `select set_project_budget(2027, $1, 'return', '')`, [P1]);
await q(`select set_project_budget(2027, $1, 'return', '劳务偏高，请压缩')`, [P1]);
await as(U.lead, D);
ok((await one(`select status, return_note from api.project_budget where project_id = $1`, [P1])).return_note === '劳务偏高，请压缩', '退回原因项目负责人看得到');
await q(`select save_budget_line($1, null, null, $2, '学生劳务', 20000, 20000, 20000, 20000)`, [L2, cL]);
await q(`select set_project_budget(2027, $1, 'submit')`, [P1]);
await as(U.fin, D);
await raises('汇总前不能调申请数', /当前阶段不可调整金额/, `select adjust_budget_line($1, 1, '试')`, [L1]);
await raises('没批准不能报学校', /中心负责人批准后方可报送学校/, `select advance_budget_year(2027, 'apply')`);
await q(`select advance_budget_year(2027, 'close')`);
const sums = async () => await one(`select coalesce(sum(declared),0) d, coalesce(sum(applied),0) a, coalesce(sum(fixed),0) f from api.budget_line where year = 2027`);
eq((await sums()).a, 300000 + 80000 + 40000, '截止后申请数以已提交项目的申报数为起点');
ok((await one(`select applied from api.budget_line where id = $1`, [L3])).applied === null, '没提交的项目不进汇总');
await as(U.mem, D);
await raises('截止后不能再填', /年度预算申报已截止/, `select save_budget_line(null, 2027, $1, $2, '迟到', 1, 0, 0, 0)`, [P2, cE]);
await as(U.fin, D);
await raises('申请数和申报数不同要写原因', /申请数与申报数不一致时，请填写原因/, `select adjust_budget_line($1, 250000, null)`, [L1]);
await q(`select adjust_budget_line($1, 250000, '按询价结果下调')`, [L1]);
eq((await sums()).a, 370000, '调整后申请数合计');
eq((await sums()).d, 420000 + 30000, '申报数不随申请数变');
await raises('财务岗不能批准', /./, `select advance_budget_year(2027, 'approve')`);
await as(U.dir, D);
await q(`select advance_budget_year(2027, 'approve')`);
await as(U.fin, D);
await raises('批准后不能再调申请数', /当前阶段不可调整金额/, `select adjust_budget_line($1, 1, '试')`, [L1]);
await raises('财务岗不能把已批准的退回', /./, `select advance_budget_year(2027, 'reopen')`);
await raises('没报学校不能录批复', /报送学校后方可录入批复数/, `select advance_budget_year(2027, 'grant', 300000, '2027-04-10')`);
await q(`select advance_budget_year(2027, 'apply', null, '2026-12-20')`);
await q(`select advance_budget_year(2027, 'grant', 300000, '2027-04-10')`);
eq((await sums()).f, 370000, '批复后核定数以申请数为起点');
await as(U.dir, D);
await raises('核定数合计超过年度总预算不能确定', /超过年度总预算/, `select advance_budget_year(2027, 'fix', 300000)`);
await as(U.fin, D);
await q(`select adjust_budget_line($1, 200000)`, [L1]);
await q(`select adjust_budget_line($1, 60000)`, [L2]);
await as(U.dir, D);
await q(`select advance_budget_year(2027, 'fix', 300000)`);
const by = await one(`select * from api.budget_year where year = 2027`);
ok(by.stage === 'fixed' && Number(by.fixed_total) === 300000 && Number(by.granted_amount) === 300000, '核定后年度总预算和批复数都记下');
const l1 = await one(`select declared, applied, fixed from api.budget_line where id = $1`, [L1]);
ok(Number(l1.declared) === 300000 && Number(l1.applied) === 250000 && Number(l1.fixed) === 200000, '申报数、申请数、核定数三个数并存');
await as(U.fin, D);
await raises('核定后不能再调', /当前阶段不可调整金额/, `select adjust_budget_line($1, 1)`, [L1]);
await raises('过了申报阶段不能改截止日', /年度预算已过申报阶段，截止日不得修改/, `select open_budget_year(2027, '2026-12-31')`);
await as(U.lead, D);
ok((await one(`select granted_amount g, fixed_total f from api.budget_year where year = 2027`)).g === null, '学校批复数只有财务岗和中心负责人能看');
eq((await one(`select fixed from api.budget_line where id = $1`, [L1])).fixed, 200000, '项目负责人能看到自己项目的核定数');

// ---------- 年度预算：下达、按项目支出、复盘、决算 ----------
// 2027 年有一张到期回收的卡 G（设备 15 万、劳务 5 万）和可结转的卡 C
await db.exec(`reset role`);
// 预算只能下达到同年度的卡：这一段把卡 C 当作该经费项目 2027 年的卡
await q(`update fund_card set year = 2027 where id = $1`, [C.C]);
const G = await id(`insert into fund_card (card_no, name, template_id, start_date, cutoff_date, settle_date, end_rule) values ('4131-G', '人才启动经费 2027', $1, '2027-04-20', '2027-11-04', '2027-12-10', 'recall')`, [T.S]);
await q(`insert into budget_line (card_id, subject_id, amount) values ($1,$2,150000), ($1,$3,50000)`, [G, SUB.S.equip, SUB.S.labor]);
for (const t of ['服务器与 GPU', '耗材']) await q(`insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict) values ($1,$2,'2027-04-21','财务甲','yes')`, [G, TY[t]]);
await db.exec(`set role app_api`);
const D7 = '2027-05-10';
await as(U.fin, D7);
await raises('没设科目对应不能自动下达', /尚未设置预算科目对应的学校科目，请先在「预算参数」中设置/, `select auto_allocate(2027)`);
await raises('核定数没对到卡不能下达', /3 行核定数未分配至经费卡，合计 300000/, `select advance_budget_year(2027, 'issue')`);
await as(U.lead, D7);
await raises('项目负责人不能设科目对应', /./, `select set_category_subjects($1, $2)`, [cE, JSON.stringify([SUB.S.equip])]);
await as(U.fin, D7);
await q(`select set_category_subjects($1, $2)`, [cE, JSON.stringify([SUB.S.equip, SUB.P.equip, SUB.S.mat])]);
await q(`select set_category_subjects($1, $2)`, [cE, JSON.stringify([SUB.S.equip, SUB.P.equip])]);
await q(`select set_category_subjects($1, $2)`, [cL, JSON.stringify([SUB.S.labor, SUB.P.labor])]);
eq((await q(`select * from api.category_subject`)).length, 4, '科目对应整体替换');
const eqC = Number(await val(`select avail v from api.cell where card_id = $1 and subject_id = $2`, [C.C, SUB.P.equip]));
await raises('下达不能超过核定数', /超过该预算行核定数/, `select allocate_line($1, $2)`, [L0, JSON.stringify([{ card_id: C.C, subject_id: SUB.P.equip, amount: 50000 }])]);
await raises('下达不能超过这一格的可用额', /超出 50000/, `select allocate_line($1, $2)`, [L1, JSON.stringify([{ card_id: G, subject_id: SUB.S.equip, amount: 200000 }])]);
await raises('有效期不在这一年的卡不能下达', /有效期不在 2027 年内/, `select allocate_line($1, $2)`, [L1, JSON.stringify([{ card_id: C.A, subject_id: SUB.S.equip, amount: 1 }])]);
await raises('卡上没有的科目不能下达', /无此科目/, `select allocate_line($1, $2)`, [L1, JSON.stringify([{ card_id: G, subject_id: SUB.P.equip, amount: 1 }])]);
eq(await val(`select auto_allocate(2027) v`), 3, '自动下达：三行都放下了');
const alloc = async (line) => Object.fromEntries((await q(`select card_no, amount from api.budget_alloc where line_id = $1`, [line])).map(r => [r.card_no, Number(r.amount)]));
let al7 = await alloc(L1);
ok(al7['4131-G'] === 150000 && al7['2121-C'] === 50000, '自动下达先填满到期回收的卡，剩下的才去可结转的卡', JSON.stringify(al7));
al7 = await alloc(L2);
ok(al7['4131-G'] === 50000 && al7['2121-C'] === 10000, '劳务行同样先填回收卡', JSON.stringify(al7));
eq((await alloc(L0))['2121-C'], 40000, '回收卡填满后其余行去可结转的卡');
eq(await val(`select sum(amount) v from api.budget_alloc where card_no = '4131-G'`), 200000, '回收卡的预算全部下达出去');
ok(eqC >= 130000, '卡 C 设备费可用额够测试用', String(eqC));
await as(U.lead, D7);
eq((await q(`select * from api.budget_alloc`)).length, 4, '项目负责人只看到自己项目下达到哪些卡');
eq((await q(`select * from api.line_pick`)).length, 0, '没下达之前提交支出时选不到预算行');
await raises('没下达不能按项目支出', /年度预算尚未下达，下达后方可支出/, `select submit_project_request($1, $2, 'GPU 节点', 1000, '2027-06-30')`, [L1, TY['服务器与 GPU']]);
await raises('项目负责人不能下达', /./, `select advance_budget_year(2027, 'issue')`);
await as(U.dir, D7);
await raises('已经下达到卡的不能直接退回', /已有预算行下达至经费卡，请先撤销下达再退回/, `select advance_budget_year(2027, 'reopen')`);
await as(U.fin, D7);
await q(`select advance_budget_year(2027, 'issue')`);
ok((await one(`select stage, issued_at from api.budget_year where year = 2027`)).stage === 'issued', '全部对到卡之后财务岗下达');

// 04 申请：只选预算行，而且只能选自己在名单里的项目。研究单元都用课题的钱：课题下属研究单元的人也能选到课题的预算行
await as(U.mem2, D7);
eq((await q(`select * from api.line_pick where project_id = $1`, [P1])).length, 2, '研究单元负责人选得到所属课题的预算行');
await as(U.mem, D7);
eq((await q(`select * from api.line_pick where project_id = $1`, [P1])).length, 0, '不在名单里的项目选不到预算行');
await raises('不在名单里不能从这个项目提支出', /拦截：本人不在该课题及其研究单元的成员名单内，请研究单元负责人先将本人加入名单/, `select submit_project_request($1, $2, 'GPU 节点', 1000, '2027-06-30')`, [L1, TY['服务器与 GPU']]);
await raises('成员不能自己把自己加进名单', /仅研究单元负责人、副手和财务岗可修改成员名单/, `select add_project_member($1, $2)`, [P1, U.mem2]);
await as(U.lead, D7);
await q(`select add_project_member($1, $2)`, [P1, U.mem2]);
await raises('名单里不能重复加', /该用户已在名单内/, `select add_project_member($1, $2)`, [P1, U.mem2]);
await as(U.fin, D7);
await raises('公共开支不设名单', /不设成员名单/, `select add_project_member($1, $2)`, [P0, U.mem2]);
await as(U.mem2, D7);
ok((await one(`select member from api.project where id = $1`, [P1])).member === true, '负责人直接加，成员不用确认就在名单里');
const picks = await q(`select * from api.line_pick`);
ok(picks.length === 3 && !('fixed' in picks[0]), '成员提交时能选到当年已下达的预算行，看不到金额');
const sp = `select submit_project_request($1, $2, $3, $4, $5) v`;
const pr1 = await val(sp, [L1, TY['服务器与 GPU'], 'GPU 节点', 120000, '2027-06-30']);
await as(U.fin, D7);
let pr7 = await one(`select card_id, subject_id, project_id, budget_line_id, status from api.request where id = $1`, [pr1]);
ok(pr7.card_id === G && pr7.subject_id === SUB.S.equip && pr7.project_id === P1 && pr7.budget_line_id === L1 && pr7.status === 'pending', '按项目提交的支出落到回收卡上，带着项目和预算行');
await as(U.lead, D7);
eq((await q(`select * from api.request where id = $1`, [pr1])).length, 1, '项目负责人能看到自己项目下别人提交的支出');
await as(U.mem2, D7);
const pr2 = await val(sp, [L1, TY['服务器与 GPU'], '存储扩容', 50000, '2027-06-30']);
await as(U.fin, D7);
ok((await one(`select card_id from api.request where id = $1`, [pr2])).card_id === C.C, '回收卡上这一行剩的不够时自动落到下一张卡');
await as(U.mem2, D7);
await raises('超出预算的支出不能走紧急通道', /拦截：超出预算的支出不得使用紧急通道/, `select submit_project_request($1, $2, '超预算', 50000, '2027-06-30', true)`, [L1, TY['服务器与 GPU']]);
await raises('放不下时对成员不说经费卡的细节', /拦截：该预算行下达的经费卡余额不足以列支该笔支出，请联系财务岗/s, sp, [L1, TY['会员订阅'], '订阅', 100, '2027-06-30']);
await as(U.fin, D7);
await raises('卡上不能列支的类型拦截并说明', /4131-G 能否列支「会员订阅」尚无答复/, sp, [L1, TY['会员订阅'], '订阅', 100, '2027-06-30']);
await raises('下达到的卡都放不下时逐张说明原因', /4131-G 单据 2027-11-04 截止.*2121-C 下达的预算仅剩 0/s, sp, [L1, TY['服务器与 GPU'], '年底到货', 20000, '2027-12-01']);
await as(U.mem2, D);
await raises('只能在预算当年支出', /年度，仅可在当年支出/, sp, [L1, TY['服务器与 GPU'], '提前花', 100, '2027-06-30']);
await as(U.fin, D7);
let le7 = await one(`select fixed, allocated, used, actual, pending from api.line_exec where id = $1`, [L1]);
ok(Number(le7.used) === 170000 && Number(le7.pending) === 170000 && Number(le7.actual) === 0 && Number(le7.allocated) === 200000, '预算行的已用包含待批的支出');
await raises('有支出的下达不能撤', /已使用 120000/, `select allocate_line($1, $2)`, [L1, JSON.stringify([{ card_id: C.C, subject_id: SUB.P.equip, amount: 60000 }])]);
const other = await val(`select submit_request($1, $2, $3, '按卡提交的旧支出', 5000, '2027-06-30') v`, [C.C, SUB.P.equip, TY['服务器与 GPU']]);
await q(`select set_request_line($1, $2)`, [other, L0]);
eq((await one(`select used from api.line_exec where id = $1`, [L0])).used, 5000, '财务岗可以把按卡提交的支出挂到预算行');
await raises('挂上后超出核定数不行', /超出核定数/, `select set_request_line($1, $2)`, [pr1, L0]);
await q(`select set_request_line($1, null)`, [other]);
eq((await one(`select used from api.line_exec where id = $1`, [L0])).used, 0, '取消后预算行释放');
// 层层确认：项目负责人确认 → 财务岗核对
await as(U.mem2, D7);
let st7 = await one(`select step, over_amount, card_id, can_confirm from api.request where id = $1`, [pr1]);
ok(st7.step === 'confirm' && Number(st7.over_amount) === 0 && st7.card_id === null && st7.can_confirm === false, '成员提的支出先等项目负责人确认，成员看不到落在哪张卡', JSON.stringify(st7));
await raises('自己提的不能自己确认', /仅该研究单元的负责人或副手可确认/, `select confirm_request($1, true)`, [pr1]);
await as(U.dir, D7);
await raises('没到中心负责人这一步不能批', /待研究单元负责人确认/, `select approve_request($1)`, [pr1]);
await as(U.fin, D7);
await raises('没确认财务岗不能核对', /该申请不在待财务岗核对状态/, `select check_request($1, true)`, [pr1]);
await as(U.lead, D7);
ok((await one(`select can_confirm from api.request where id = $1`, [pr1])).can_confirm === true, '项目负责人看到等自己确认');
await raises('不同意要写原因', /不同意须填写原因/, `select confirm_request($1, false)`, [pr1]);
await q(`select confirm_request($1, true)`, [pr1]);
await raises('不能重复确认', /该申请不在待研究单元负责人确认状态/, `select confirm_request($1, true)`, [pr1]);
ok((await one(`select step from api.request where id = $1`, [pr1])).step === 'check', '没超预算的确认后直接到财务岗核对');
await as(U.dir, D7);
await raises('没超预算不经过中心负责人', /待财务岗核对/, `select approve_request($1)`, [pr1]);
await as(U.lead, D7);
await raises('项目负责人不能代财务岗核对', /需要权限/, `select check_request($1, true)`, [pr1]);
await as(U.fin, D7);
await raises('核对退回要写原因', /退回须填写原因/, `select check_request($1, false)`, [pr1]);
await q(`select check_request($1, true)`, [pr1]);
st7 = await one(`select status, step, checked_by_name, confirmed_by_name from api.request where id = $1`, [pr1]);
ok(st7.status === 'committed' && st7.checked_by_name === '财务岗' && st7.confirmed_by_name === '项目负责人', '财务岗核对通过后才承诺', JSON.stringify(st7));
await db.exec(`reset role`);
await q(`update expense_request set status = 'posted' where id = $1`, [pr1]);
await q(`insert into voucher (request_id, posted_on, amount) values ($1, '2027-06-15', 118000)`, [pr1]);
await db.exec(`set role app_api`);
await as(U.lead, '2027-07-05');
le7 = await one(`select used, actual, a1, a2, a3 from api.line_exec where id = $1`, [L1]);
ok(Number(le7.used) === 168000 && Number(le7.actual) === 118000 && Number(le7.a2) === 118000 && Number(le7.a1) === 0, '入账后按凭证金额计，决算数落在对应的预算期');

// ---------- 资源和备用金都从年度预算里出 ----------
const KEY = 'sk-abcdefghijklmnopqrstuvwxyz012345';
await as(U.lead, D7);
await raises('预算提交后项目负责人不能改资源计划', /由财务岗在复盘时调整/, `select set_line_resource($1, $2, 4)`, [L1, stock]);
await as(U.fin, D7);
await raises('资产计划数量要整数', /整数/, `select set_line_resource($1, $2, 1.5)`, [L1, stock]);
await q(`select set_line_resource($1, $2, 4)`, [L1, stock]);
await q(`select set_line_resource($1, $2, 500)`, [L2, rs]);   // 借用现有的预算行做接口额度计划
const blp = await one(`select resource_kind, plan_qty from api.budget_line where id = $1`, [L2]);
ok(blp.resource_kind === 'api' && Number(blp.plan_qty) === 500, '预算行带上资源计划');
const srq = `select save_resource_request(null, $1, $2, $3, $4, $5, $6, $7, $8) v`;
await as(U.mem2, D7);
const plans = await q(`select * from api.resource_plan where open`);
ok(plans.length === 2 && !('fixed' in plans[0]) && !('q1' in plans[0]), '成员能看到当年可以申请的资源计划，看不到金额');
await raises('资源申请必须选预算行', /请选择预算行/, srq, ['api', null, null, 50, '2027-06-01', '赶稿', null, false]);
await raises('没有资源计划的预算行不能挂资源申请', /拦截：该预算行未编制资源计划。请先在年度预算中填写所需资源及数量，再提交申请/, srq, ['api', null, L0, 50, '2027-06-01', '赶稿', null, false]);
await raises('类型和计划的资源对不上', /所选资源不存在，或类型不一致/, srq, ['asset', null, L2, 1, null, '办公', null, false]);
await raises('不能换成计划以外的资源', /所选资源与该预算行计划的资源不一致/, srq, ['asset', asset, L1, 1, null, '办公', null, false]);
await raises('超过计划的量拦截', /计划 500.*剩余 500.*不足 600/, srq, ['api', null, L2, 600, '2027-06-01', '评测', null, false]);
await raises('月份要在预算年度以内', /2027 年度以内/, srq, ['api', null, L2, 50, '2028-01-01', '评测', null, false]);
await raises('紧急申请要说明原因', /紧急申请须在用量说明中写明紧急原因/, srq, ['api', null, L2, 50, '2027-06-01', '赶稿', null, true]);
await raises('申请里拒绝密钥', /申请中不得填写密钥/, srq, ['api', null, L2, 50, '2027-06-01', KEY, null, false]);
const q1 = await val(srq, ['api', null, L2, 300, '2027-06-20', '评测实验调用', null, false]);
let rq1 = await one(`select status, period::text p, my_project, project_id, resource_id, budget_line_id from api.resource_request where id = $1`, [q1]);
ok(rq1.status === 'pending' && rq1.p === '2027-06-01' && rq1.my_project === false && rq1.project_id === P1 && rq1.resource_id === rs && rq1.budget_line_id === L2,
   '资源申请挂在预算行上，项目和资源跟着预算行走，先等项目负责人批示');
const pick = await q(`select * from api.resource_pick`);
ok(pick.length >= 3 && !('ref' in pick[0]) && !('balance' in pick[0]), '成员能看到资源目录，看不到编号和余额');
// 公共设备：中心公共开支只统一配设备，只给博士后、博士、硕士、研究助理本人申领
await raises('成员不能登记身份', /./, `select set_user_kind($1, 'phd')`, [U.mem2]);
await as(U.fin, D7);
await raises('中心公共开支不能计划接口额度', /拦截：中心公共开支仅统一配置设备。接口额度类资源请编入各研究单元预算/, `select set_line_resource($1, $2, 100)`, [L0, rs]);
await q(`select set_line_resource($1, $2, 2)`, [L0, stock]);
await raises('身份只能是规定的几种', /身份仅限教师、博士后、博士、硕士、研究助理、研究实习生或访问学生/, `select set_user_kind($1, 'boss')`, [U.mem2]);
await as(U.mem2, D7);
await raises('身份没登记的不能申领公共设备', /拦截：公共设备仅限博士后、博士、硕士和研究助理申领。身份尚未登记的，请先由财务岗登记/, srq, ['asset', null, L0, 1, null, '办公', null, false]);
await as(U.fin, D7);
await q(`select set_user_kind($1, 'ri')`, [U.mem2]);
await as(U.mem2, D7);
await raises('研究实习生不能申领公共设备', /拦截：公共设备仅限博士后、博士、硕士和研究助理申领。身份尚未登记的，请先由财务岗登记/, srq, ['asset', null, L0, 1, null, '办公', null, false]);
await as(U.fin, D7);
await q(`select set_user_kind($1, 'master')`, [U.mem2]);
await as(U.mem2, D7);
ok((await one(`select kind from api.me`)).kind === 'master', '自己能看到登记的身份');
const qp = await val(srq, ['asset', null, L0, 1, null, '办公', null, false]);
ok((await one(`select status from api.resource_request where id = $1`, [qp])).status === 'reviewed', '硕士申领公共设备，直接到财务岗');
await q(`select decide_resource_request($1, 'withdraw')`, [qp]);
await as(U.fin, D7);
await q(`select set_user_kind($1, 'postdoc')`, [U.mem2]);
await as(U.mem2, D7);
const qpd = await val(srq, ['asset', null, L0, 1, null, '办公', null, false]);
ok(!!qpd, '博士后也能申领公共设备');
await q(`select decide_resource_request($1, 'withdraw')`, [qpd]);
await as(U.fin, D7);
await raises('项目负责人没批示，财务岗不能直接批', /须待研究单元负责人批示/, `select decide_resource_request($1, 'approve')`, [q1]);
await as(U.mem, D7);
eq((await q(`select * from api.resource_request`)).length, 0, '别的项目负责人看不到这笔申请');
await raises('不是这个项目的负责人不能批示', /仅研究单元负责人可批示/, `select decide_resource_request($1, 'review')`, [q1]);
await as(U.lead, D7);
ok((await one(`select my_project from api.resource_request where id = $1`, [q1])).my_project, '项目负责人看得到挂在自己项目上的申请');
await q(`select decide_resource_request($1, 'review')`, [q1]);
await raises('项目负责人不能批准', /仅财务岗和中心负责人可批准/, `select decide_resource_request($1, 'approve')`, [q1]);
await as(U.fin, D7);
await raises('批准的数量不能超过申请的', /批准数量不得超过申请的/, `select decide_resource_request($1, 'approve', 400)`, [q1]);
await raises('少批要写原因', /批准数量少于申请数量，请填写原因/, `select decide_resource_request($1, 'approve', 200)`, [q1]);
await q(`select decide_resource_request($1, 'approve', 200, '本月配额紧')`, [q1]);
const a1 = await val(`select fulfil_resource_request($1, $2) v`, [q1, rs]);
const fa = await one(`select quota, user_id, request_id from api.allocation where id = $1`, [a1]);
ok(Number(fa.quota) === 200 && fa.user_id === U.mem2 && fa.request_id === q1, '分发后生成使用权记录，数量是批准的数量');
ok((await one(`select status from api.resource_request where id = $1`, [q1])).status === 'fulfilled', '分发后申请完成');
await raises('不能重复分发', /批准后方可分发/, `select fulfil_resource_request($1, $2)`, [q1, rs]);
const pl2 = await one(`select asked, granted, plan_qty from api.resource_plan where id = $1`, [L2]);
ok(Number(pl2.granted) === 200 && Number(pl2.asked) === 0, '资源计划上看得到已经分发了多少');
await raises('计划数量不能低于已经申请的', /计划数量不得低于已申请的/, `select set_line_resource($1, $2, 100)`, [L2, rs]);
await raises('有申请的计划不能去掉', /该预算行已有资源申请，不得删除资源计划/, `select set_line_resource($1, null, null)`, [L2]);
await as(U.lead, D7);
const q2 = await val(srq, ['asset', stock, L1, 2, null, '双屏办公', null, false]);
ok((await one(`select status from api.resource_request where id = $1`, [q2])).status === 'reviewed', '项目负责人自己申请的直接到财务岗');
await q(`select save_resource_request($1, 'asset', $2, $3, 1, null, '单屏就够')`, [q2, stock, L1]);
await as(U.mem2, D7);
const q3 = await val(srq, ['asset', stock, L1, 2, null, '实验台', null, false]);
await raises('不能改别人的申请', /仅可修改本人的申请/, `select save_resource_request($1, 'asset', $2, $3, 1, null, '改')`, [q2, stock, L1]);
await raises('累计申请不能超过计划', /计划 4.*已申请 3.*剩余 1/, srq, ['asset', stock, L1, 2, null, '再要两台', null, false]);
await as(U.lead, D7);
await q(`select decide_resource_request($1, 'review')`, [q3]);
await as(U.fin, D7);
eq((await one(`select asked from api.resource where id = $1`, [stock])).asked, 3, '需求池汇总在途申请');
await q(`select decide_resource_request($1, 'approve')`, [q2]);
await q(`select fulfil_resource_request($1)`, [q2]);
await q(`select decide_resource_request($1, 'approve')`, [q3]);
await raises('分发时库存不够照样拦', /库存/, `select fulfil_resource_request($1)`, [q3]);
await raises('驳回要写原因', /驳回原因/, `select decide_resource_request($1, 'reject')`, [q3]);
await as(U.mem2, D7);
await q(`select decide_resource_request($1, 'withdraw')`, [q3]);
await raises('撤回后不能再改', /该申请已在处理中，不得修改；如需调整请撤回后重新提交/, `select save_resource_request($1, 'asset', $2, $3, 1, null, '改')`, [q3, stock, L1]);

await as(U.fin, D7);
await raises('没加密的密钥不收', /密钥未经加密，拒绝保存/, `select set_secret('resource', $1, 'sk-plain-text')`, [rs]);
await q(`select set_secret('allocation', $1, 'v1.aaaa.bbbb', 'sk-…9f3a')`, [a1]);
await q(`select set_secret('resource', $1, 'v1.cccc.dddd', '已保存')`, [rs]);
await as(U.mem2, D7);
ok(await val(`select get_secret('allocation', $1) v`, [a1]) === 'v1.aaaa.bbbb', '使用人能取自己名下的密钥');
const ma = await one(`select has_secret, secret_hint from api.allocation where id = $1`, [a1]);
ok(ma.has_secret && ma.secret_hint === 'sk-…9f3a', '使用权记录上只显示掩码');
await raises('成员取不到资源池的密钥', /仅可查看分配至本人名下且在有效期内的密钥/, `select get_secret('resource', $1)`, [rs]);
await raises('成员不能保存密钥', /当前角色/, `select set_secret('allocation', $1, 'v1.x.y')`, [a1]);
await as(U.mem, D7);
await raises('别人名下的密钥取不到', /仅可查看分配至本人名下且在有效期内的密钥/, `select get_secret('allocation', $1)`, [a1]);
await as(U.fin, D7);
const sa = await q(`select * from api.secret_access`);
ok(sa.length === 1 && sa[0].user_name === '成员乙' && sa[0].resource_name === '大模型接口', '每次取用密钥都有记录');
await q(`select return_allocation($1)`, [a1]);
await raises('收回使用权时密钥一并删除', /尚未保存密钥/, `select get_secret('allocation', $1)`, [a1]);
await raises('已收回的记录不能再存密钥', /已经收回/, `select set_secret('allocation', $1, 'v1.x.y')`, [a1]);
await q(`select set_secret('resource', $1, '')`, [rs]);
ok(!(await one(`select has_secret from api.resource where id = $1`, [rs])).has_secret, '密钥可以清除');


await as(U.mem2, D7);
await raises('备用金要选预算行', /请选择预算行/, `select save_petty_cash(null, 2000, '会议茶歇', null)`);
await raises('备用金不能超过预算行剩下的', /核定 200000.*已用 168000.*不足 40000/, `select save_petty_cash(null, 40000, '会议茶歇', $1)`, [L1]);
const pc = await val(`select save_petty_cash(null, 2000, '会议茶歇', $1) v`, [L1]);
await raises('在外的备用金也占预算', /在外备用金 2000.*不足 31000/, `select save_petty_cash(null, 31000, '再领一笔', $1)`, [L1]);
await as(U.mem, D7);
eq((await q(`select * from api.petty_cash`)).length, 0, '成员看不到别人的备用金');
await as(U.lead, D7);
eq((await q(`select * from api.petty_cash where budget_line_id = $1`, [L1])).length, 1, '项目负责人看得到挂在自己项目上的备用金');
await as(U.fin, D7);
await raises('备用金要中心负责人批', /当前角色/, `select decide_petty_cash($1, 'approve')`, [pc]);
await raises('没批准不能核销', /仅已批准且未核销的备用金可核销/, `select settle_petty_cash($1, 100)`, [pc]);
await as(U.dir, D7);
await q(`select decide_petty_cash($1, 'approve')`, [pc]);
await as(U.fin, D7);
await raises('核销不能超过领用', /超过领用/, `select settle_petty_cash($1, 2500)`, [pc]);
await raises('花掉的钱要对应支出申请', /已支出款项须对应一笔支出申请：请先将票据按支出申请或补登入账至该预算行，再办理核销/, `select settle_petty_cash($1, 1800)`, [pc]);
await raises('支出申请要在同一行预算上', /对应的支出申请不存在、尚未批准，或不在该备用金的预算行上/, `select settle_petty_cash($1, 1800, null, null, $2)`, [pc, other]);
await q(`select settle_petty_cash($1, 1800, null, '余款 200 已退回', $2)`, [pc, pr1]);
const pcr = await one(`select status, spent, expense_request_id from api.petty_cash where id = $1`, [pc]);
ok(pcr.status === 'settled' && Number(pcr.spent) === 1800 && pcr.expense_request_id === pr1, '备用金核销后记下实际支出和对应的支出申请');
// 合并账号时新加的表也跟着改
await as(U.dir, D7);
const dup2 = await val(`select save_user(null, '重复账号二', 'dup2@example.com', 'member', true) v`);
await db.exec(`reset role`);
await q(`insert into petty_cash (requested_by, project_id, budget_line_id, amount, purpose, status) values ($1, $2, $3, 10, '合并测试', 'withdrawn')`, [dup2, P1, L1]);
await q(`insert into resource_request (kind, requested_by, project_id, budget_line_id, resource_id, amount, period, purpose, status) values ('api', $1, $2, $3, $4, 5, '2027-12-01', '合并测试', 'withdrawn')`, [dup2, P1, L2, rs]);
await db.exec(`set role app_api`);
await q(`select merge_user($1, $2)`, [dup2, U.mem]);
await db.exec(`reset role`);
ok((await one(`select count(*)::int c from petty_cash where requested_by = $1`, [dup2])).c === 0
  && (await one(`select count(*)::int c from resource_request where requested_by = $1 and purpose = '合并测试'`, [U.mem])).c === 1, '合并账号时备用金和资源申请一起并过去');
await db.exec(`set role app_api`);
await as(U.lead, '2027-07-05');

// 07 复盘与调整
await raises('项目负责人不能写复盘结论', /./, `select review_project(2027, 2, $1, '正常')`, [P1]);
await as(U.fin, '2027-07-05');
await raises('复盘结论必填', /复盘结论/, `select review_project(2027, 2, $1, ' ')`, [P1]);
await q(`select review_project(2027, 2, $1, '设备到货偏慢')`, [P1]);
await q(`select review_project(2027, 2, $1, '设备已到货，执行正常')`, [P1]);
await raises('财务岗不能调核定数', /./, `select revise_fixed($1, 180000, '试')`, [L1]);
await as(U.lead, '2027-07-05');
ok((await q(`select * from api.budget_review`)).length === 1 && (await one(`select note from api.budget_review`)).note === '设备已到货，执行正常', '项目负责人看得到自己项目的复盘结论，同一期只留一条');
await as(U.dir, '2027-07-05');
await raises('调整核定数要写原因', /调整原因/, `select revise_fixed($1, 180000, '')`, [L1]);
await raises('核定数不能低于已用', /已使用 168000/, `select revise_fixed($1, 150000, '压缩')`, [L1]);
await raises('调增不能超过年度总预算', /超过年度总预算/, `select revise_fixed($1, 50000, '追加')`, [L0]);
await q(`select revise_fixed($1, 180000, '第二期复盘：设备询价低于预期')`, [L1]);
al7 = await alloc(L1);
ok(al7['4131-G'] === 130000 && al7['2121-C'] === 50000, '调减时收回多下达的部分，已经用掉的不动', JSON.stringify(al7));
await q(`select revise_fixed($1, 55000, '第二期复盘：少招一名学生')`, [L2]);
al7 = await alloc(L2);
ok(al7['4131-G'] === 50000 && al7['2121-C'] === 5000, '调减先收可结转的卡，回收卡最后动', JSON.stringify(al7));
await q(`select revise_fixed($1, 65000, '第二期复盘：维保范围扩大')`, [L0]);
eq((await q(`select * from api.budget_revision where year = 2027`)).length, 3, '每次调整都留痕');
le7 = await one(`select fixed, allocated from api.line_exec where id = $1`, [L0]);
ok(Number(le7.fixed) === 65000 && Number(le7.allocated) === 40000, '调增的部分要再下达');
await as(U.fin, '2027-07-05');
await q(`select allocate_line($1, $2)`, [L0, JSON.stringify([{ card_id: C.C, subject_id: SUB.P.equip, amount: 65000 }])]);
eq((await alloc(L0))['2121-C'], 65000, '下达之后还可以补下达');

// 晨星只是标签：课题、研究单元上可以标上或取消；额度的入口已取消
await as(U.fin, '2027-07-05');
await q(`select open_budget_year(2028, '2027-11-30')`);
const tagP = (await one(`select id from api.project limit 1`)).id;
await q(`select set_project_morningstar($1, true)`, [tagP]);
ok((await one(`select morningstar from api.project_tag where id = $1`, [tagP])).morningstar === true, '课题或研究单元可以标为晨星');
await q(`select set_project_morningstar($1, false)`, [tagP]);
ok((await one(`select morningstar from api.project_tag where id = $1`, [tagP])).morningstar === false, '晨星标签可以取消');
await as(U.mem, '2027-07-05');
await raises('成员不能改晨星标签', /需要权限|当前角色/, `select set_project_morningstar($1, true)`, [tagP]);
eq((await q(`select 1 from pg_proc where proname in ('save_quota', 'quota_to_project', 'set_request_quota', 'submit_request_quota')`)).length, 0, '晨星额度的函数已取消');
eq((await q(`select 1 from pg_views where schemaname = 'api' and viewname in ('quota', 'quota_pick')`)).length, 0, '晨星额度的视图已取消');

// 年度决算
await as(U.dir, '2027-12-20');
await raises('年度没过完不能决算', /年度尚未结束，结束后方可办理年度决算/, `select advance_budget_year(2027, 'final')`);
await as(U.dir, '2028-01-10');
await raises('有待批的支出不能决算', /1 笔支出申请未审批/, `select advance_budget_year(2027, 'final')`);
await as(U.fin, '2028-01-10');
await raises('财务岗不能做年度决算', /当前角色/, `select advance_budget_year(2027, 'final')`);
await as(U.dir, '2028-01-10');
await q(`select reject_request($1, '年度结束')`, [pr2]);
await q(`select advance_budget_year(2027, 'final')`);
ok((await one(`select stage, closed_at from api.budget_year where year = 2027`)).stage === 'closed', '年度决算后年度关闭');
le7 = await one(`select fixed, used, actual from api.line_exec where id = $1`, [L1]);
ok(Number(le7.fixed) === 180000 && Number(le7.used) === 118000 && Number(le7.actual) === 118000, '决算后预算行留下核定数和决算数，未用的不结转');
await raises('决算后不能再调核定数', /预算下达后、年度决算前方可调整核定数/, `select revise_fixed($1, 100000, '试')`, [L1]);
await raises('决算后不能再下达', /年度总预算确定后方可下达/, `select allocate_line($1, $2)`, [L0, JSON.stringify([])]);
await as(U.mem2, '2028-01-10');
await raises('决算后不能再按这一年的预算支出', /年度已决算，不得再支出/, sp, [L1, TY['服务器与 GPU'], '迟到', 100, '2028-02-01']);
// ---------- 权限点、角色、按范围授权 ----------
const hp = async (code, ...a) => (await one(`select has_perm($1${a.map((_, i) => `, $${i + 2}`).join('')}) v`, [code, ...a])).v;
const RID = {};
await as(U.dir, '2028-01-10');
for (const r of await q(`select id, code from api.role`)) RID[r.code] = r.id;
ok(Object.keys(RID).length === 14, '中心负责人能看到全部预置角色');
let myp = (await one(`select perms from api.me`)).perms;
ok(myp.includes('rbac.manage') && myp.includes('request.approve') && myp.includes('ledger.post') && myp.includes('request.process') && myp.includes('card.fund'), '中心负责人是管理员：能批，也能经办入账和登记回收');
await as(U.fin, '2028-01-10');
myp = (await one(`select perms from api.me`)).perms;
ok(myp.includes('ledger.post') && myp.includes('request.process') && !myp.includes('request.approve') && !myp.includes('rbac.manage'), '财务岗的权限点和原来一致：能入账不能批');
await raises('财务岗不能管授权', /需要权限：管理角色和授权/, `select grant_role($1, $2, null, null, null, null, null)`, [U.mem2, RID.auditor]);
await as(U.mem2, '2028-01-10');
myp = (await one(`select perms from api.me`)).perms;
ok(myp.join() === 'card.own,petty.use,request.submit,resource.request', '成员只有提申请的三个权限点，加上查看本人负责的经费卡', myp.join());
eq((await one(`select count(*) c from api.role`)).c, 0, '成员看不到角色表');
eq((await one(`select count(*) c from api.card`)).c, 0, '成员看不到经费卡');
await raises('成员不能批申请，报错说明缺哪个权限', /需要权限：批准或驳回支出申请/, `select approve_request(gen_random_uuid())`);

await as(U.dir, '2028-01-10');
const gAud = await val(`select grant_role($1, $2, null, null, null, null, '年度审计') v`, [U.mem2, RID.auditor]);
await raises('同一范围不能重复授权', /该用户在该范围内已有此角色，请先收回原授权再重新授权/, `select grant_role($1, $2, null, null, null, null, null)`, [U.mem2, RID.auditor]);
await raises('不能给自己授权', /不得给本人授权/, `select grant_role($1, $2, null, null, null, null, null)`, [U.dir, RID.auditor]);
await raises('中心负责人不能通过授权给人', /」仅可在「权限管理」中指定/, `select grant_role($1, $2, null, null, null, null, null)`, [U.mem2, RID.director]);
await raises('项目负责人角色不用授权', /」随课题或研究单元确定，无需单独授权；更换负责人请修改课题或研究单元/, `select grant_role($1, $2, null, null, null, null, null)`, [U.mem2, RID.project_owner]);
await raises('中心负责人角色不能改', /」角色不得修改，以免授权管理被锁死/, `select save_role($1, '中心负责人', null, '["request.submit"]')`, [RID.director]);
await as(U.mem2, '2028-01-10');
ok((await one(`select count(*) c from api.card`)).c > 0, '拿到审计只读后能看到经费卡');
ok((await one(`select count(*) c from api.users`)).c > 0, '审计只读能看人员');
await raises('审计只读不能批', /需要权限/, `select approve_request(gen_random_uuid())`);
await raises('审计只读不能入账', /需要权限：入账/, `select record_expenses('[]')`);
eq((await one(`select count(*) c from api.role_grant`)).c, 1, '能看到自己名下的授权');

// 代理：带起止日期
await as(U.dir, '2028-01-10');
await raises('截止不能早于开始', /截止日期不得早于开始日期/, `select grant_role($1, $2, null, null, '2028-02-10', '2028-02-01', null)`, [U.lead, RID.deputy_approve]);
const gDep = await val(`select grant_role($1, $2, null, null, '2028-02-01', '2028-02-10', '主任出差') v`, [U.lead, RID.deputy_approve]);
ok((await one(`select state from api.role_grant where id = $1`, [gDep])).state === 'upcoming', '没到开始日期的授权显示为未生效');
await as(U.lead, '2028-01-10'); ok(!(await hp('request.approve')), '代理没到开始日期不生效');
await as(U.lead, '2028-02-05'); ok(await hp('request.approve'), '代理期内能批');
await as(U.dir, '2028-02-05');
await db.exec(`reset role`);
await raises('有第二位审批人时，自己提的不能自己批', /职责分离：本人提交的支出申请不得由本人审批/, `select sod_self('request.approve', $1, '支出申请')`, [U.dir]);
await db.exec(`set role app_api`);
await as(U.lead, '2028-02-11'); ok(!(await hp('request.approve')), '代理过期自动失效');
await as(U.dir, '2028-02-11');
ok((await one(`select state from api.role_grant where id = $1`, [gDep])).state === 'expired', '过期的授权显示为已过期');

// 职责分离：批的人不经办
await as(U.dir, '2028-01-10');
await raises('财务岗不能再拿审批角色', /职责分离：批准支出申请的人不能同时/, `select grant_role($1, $2, null, null, null, null, null)`, [U.fin, RID.deputy_approve]);
await raises('手里有代理审批的人不能改成财务岗', /职责分离/, `select set_user_role($1, 'finance', true)`, [U.lead]);
await raises('同一个角色里不能又批又入账', /，不得放入同一角色/, `select save_role(null, '全能', null, '["request.approve","ledger.post"]')`);
await raises('不认识的权限点', /含无效权限点/, `select save_role(null, '乱填', null, '["x.y"]')`);

// 按项目、按经费卡授权
await raises('含全中心权限的角色不能按项目授权', /不得按课题\/研究单元授权/, `select grant_role($1, $2, $3, null, null, null, null)`, [U.mem2, RID.cashier, P1]);
await raises('项目副手不能按经费卡授权', /不得按经费卡授权/, `select grant_role($1, $2, null, $3, null, null, null)`, [U.mem2, RID.project_deputy, C.A]);
await as(U.mem2, '2028-01-10');
ok(!(await one(`select can_edit_project($1) v`, [P1])).v, '授权前不能动别人的项目预算');
await as(U.dir, '2028-01-10');
await q(`select revoke_grant($1, '审计结束')`, [gAud]);
const gPj = await val(`select grant_role($1, $2, $3, null, null, null, null) v`, [U.mem2, RID.project_deputy, P1]);
const gCard = await val(`select grant_role($1, $2, null, $3, null, null, null) v`, [U.mem2, RID.card_viewer, C.A]);
await as(U.mem2, '2028-01-10');
ok((await one(`select can_edit_project($1) v`, [P1])).v, '项目副手能填被授权的项目');
ok((await one(`select mine from api.project where id = $1`, [P1])).mine, '被授权的项目算自己的');
ok(!(await one(`select mine from api.project where id = $1`, [P2])).mine, '别的项目不算');
ok(await hp('resource.review', P1), '项目副手能批示这个项目的资源申请');
ok(!(await hp('resource.review')), '项目副手的权限不出这个项目');
const meS = await one(`select perms, scoped from api.me`);
ok(meS.scoped.includes('card.read') && meS.scoped.includes('budget.project') && !meS.perms.includes('budget.project'), '按范围拿到的权限点单独列出，不混进全中心的');
eq((await one(`select count(*) c from api.card`)).c, 1, '经费卡协管只看到被授权的那一张');
ok((await one(`select count(*) c from api.cell where card_id = $1`, [C.A])).c > 0, '能看这张卡的预算格子');

// 自定义角色
await as(U.dir, '2028-01-10');
const rNew = await val(`select save_role(null, '报销助理', '只管交学校', '["request.process"]') v`);
await raises('角色不能重名', /已存在同名角色/, `select save_role(null, '报销助理', null, '["request.process"]')`);
const gNew = await val(`select grant_role($1, $2, null, null, null, null, null) v`, [U.mem2, rNew]);
await as(U.mem2, '2028-01-10'); ok(await hp('request.process'), '自定义角色授权后生效');
await as(U.dir, '2028-01-10');
await q(`select save_role($1, '报销助理', '只管交学校', '["card.fund"]')`, [rNew]);
await as(U.mem2, '2028-01-10'); ok(!(await hp('request.process')) && await hp('card.fund'), '改角色的权限点，持有人立即跟着变');
await as(U.dir, '2028-01-10');
await raises('有人持有的角色不能删', /先收回授权/, `select delete_role($1)`, [rNew]);
await raises('预置角色不能删', /预置角色不得删除/, `select delete_role($1)`, [RID.finance]);
await q(`select revoke_grant($1, '试完了')`, [gNew]);
await raises('不能重复收回', /该授权已收回/, `select revoke_grant($1, null)`, [gNew]);
await q(`select delete_role($1)`, [rNew]);
await q(`select revoke_grant($1, null)`, [gPj]);
await q(`select revoke_grant($1, null)`, [gCard]);
await as(U.mem2, '2028-01-10');
eq((await one(`select count(*) c from api.card`)).c, 0, '收回后立即看不到');
ok(!(await one(`select can_edit_project($1) v`, [P1])).v, '收回项目副手后不能再动项目预算');
eq((await one(`select count(*) c from api.rbac_log`)).c, 0, '成员看不到授权记录');
await as(U.dir, '2028-01-10');
const lg = await q(`select action, summary from api.rbac_log order by id`);
ok(lg.filter((x) => x.action === 'grant').length === 5 && lg.filter((x) => x.action === 'revoke').length === 4, '每次授权和收回都有记录', JSON.stringify(lg.map((x) => x.action)));
ok(lg.some((x) => x.action === 'role_edit' && /新增：登记到款和回收.*移除：交学校/.test(x.summary)), '改角色记下加了什么去掉什么');
await db.exec(`reset role`);
await q(`select sod_self('request.approve', $1, '支出申请')`, [U.dir]);
await db.exec(`set role app_api`);
ok((await one(`select count(*) c from api.rbac_log where action = 'self_approve'`)).c > 0, '只有一位审批人时自己批自己的会留一笔记录');
await as(U.mem2, '2028-01-10');
await db.exec(`reset role`);
ok((await one(`select count(*) c from audit_log`)).c > 0, '审计日志有记录');

// ====================================================================
// 上限、名单、层层确认、超预算、调剂、设备归公共、盘点、经费卡总金额（2029 年度的一套新数据）
// ====================================================================
{
await db.exec(`set role app_api`);
const D8 = '2028-11-20', D9 = '2029-03-10';
await as(U.fin, D8);
const BX = await val(`select save_project(null, 'P-09', '可信评测', 'project', $1, true) v`, [U.lead]);
const PX1 = await val(`select save_project(null, '', '论文：评测基准', null, $1, true, $2) v`, [U.mem, BX]);
await q(`select open_budget_year(2029, '2028-11-30')`);
await raises('财务岗不能定上限', /需要权限/, `select set_project_cap(2029, $1, 50000)`, [BX]);
await as(U.dir, D8);
await raises('上限按档定', /上限按档设定：1 千、5 千、2 万、5 万、20 万、50 万，50 万以上按实际数填写/, `select set_project_cap(2029, $1, 30000)`, [BX]);
await raises('上限只给大项目定', /上限仅对课题设定；研究单元计入所属课题，中心公共开支不设上限/, `select set_project_cap(2029, $1, 50000)`, [PX1]);
await raises('公共开支不设上限', /上限仅对课题设定；研究单元计入所属课题，中心公共开支不设上限/, `select set_project_cap(2029, $1, 50000)`, [P0]);
await q(`select set_project_cap(2029, $1, 50000)`, [BX]);
await as(U.lead, D8);
const BXL = await val(`select save_budget_line(null, 2029, $1, $2, '公用工作站', 20000, 0, 0, 0) v`, [BX, cE]);
await q(`select set_project_budget(2029, $1, 'submit')`, [BX]);
await as(U.mem, D8);
await raises('研究单元不设预算行，用的是课题的钱', /研究单元不设预算行：研究单元使用所属课题的预算/, `select save_budget_line(null, 2029, $1, $2, '算力与设备', 6000, 6000, 6000, 6000)`, [PX1, cE]);
await as(U.lead, D8);
await q(`select set_project_budget(2029, $1, 'withdraw')`, [BX]);
const PLa = await val(`select save_budget_line(null, 2029, $1, $2, '算力与设备', 6000, 6000, 6000, 6000) v`, [BX, cE]);
const PLb = await val(`select save_budget_line(null, 2029, $1, $2, '实验耗材', 2000, 2000, 2000, 2000) v`, [BX, cE]);
await raises('课题的预算超过上限就提交不了', /上限为 50000(\.00)?，.*合计 52000(\.00)?，超出 2000/, `select set_project_budget(2029, $1, 'submit')`, [BX]);
await q(`select delete_budget_line($1)`, [PLa]); await q(`select delete_budget_line($1)`, [PLb]);
await q(`select set_project_budget(2029, $1, 'submit')`, [BX]);
await as(U.mem, D8);
await raises('论文项目负责人不能申请提高上限', /仅课题负责人和副手可申请提高上限/, `select request_cap(2029, $1, 200000, '要买设备')`, [BX]);
eq((await q(`select * from api.project_cap`)).length, 1, '课题全公开：研究单元负责人看得到课题的上限');
await as(U.lead, D8);
let cp = await one(`select amount, used from api.project_cap where project_id = $1 and year = 2029`, [BX]);
ok(Number(cp.amount) === 50000 && Number(cp.used) === 20000, '大项目负责人看到上限和已经占了多少', JSON.stringify(cp));
await raises('提高上限要写理由', /请填写申请理由/, `select request_cap(2029, $1, 200000, ' ')`, [BX]);
await raises('申请的上限要比现在高', /申请上限须高于现行上限/, `select request_cap(2029, $1, 20000, '少一点')`, [BX]);
const cr = await val(`select request_cap(2029, $1, 200000, '论文项目要租算力') v`, [BX]);
await raises('同时只能有一份提高上限的申请', /已有一份提高上限的申请待中心负责人审批/, `select request_cap(2029, $1, 500000, '再多一点')`, [BX]);
await raises('大项目负责人不能自己批', /需要权限/, `select decide_cap_request($1, true)`, [cr]);
await as(U.dir, D8);
await raises('不同意提高上限要写原因', /不同意须填写原因/, `select decide_cap_request($1, false)`, [cr]);
await q(`select decide_cap_request($1, true)`, [cr]);
await raises('提高上限的申请不能批两次', /该申请不存在或已处理/, `select decide_cap_request($1, true)`, [cr]);
await as(U.lead, D8);
await q(`select set_project_budget(2029, $1, 'withdraw')`, [BX]);
const PL1 = await val(`select save_budget_line(null, 2029, $1, $2, '算力与设备', 6000, 6000, 6000, 6000) v`, [BX, cE]);
const PL2 = await val(`select save_budget_line(null, 2029, $1, $2, '实验耗材', 2000, 2000, 2000, 2000) v`, [BX, cE]);
await q(`select set_project_budget(2029, $1, 'submit')`, [BX]);
await as(U.dir, D8);
await raises('上限不能低于已提交的预算合计', /该课题连同研究单元已提交的预算合计/, `select set_project_cap(2029, $1, 50000)`, [BX]);
await as(U.fin, D8);
await q(`select advance_budget_year(2029, 'close')`);
await as(U.dir, D8); await q(`select advance_budget_year(2029, 'approve')`);
await as(U.fin, D8);
await q(`select advance_budget_year(2029, 'apply', null, '2028-12-20')`);
await q(`select advance_budget_year(2029, 'grant', 200000, '2029-01-10')`);
await as(U.dir, D8);
await raises('年度总预算不能低于各大项目上限合计', /上限合计/, `select advance_budget_year(2029, 'fix', 100000)`);
await q(`select advance_budget_year(2029, 'fix', 200000)`);
await raises('各大项目上限合计不能超过年度总预算', /超过年度总预算/, `select set_project_cap(2029, $1, 500000)`, [BX]);
await db.exec(`reset role`);
const H = await id(`insert into fund_card (card_no, name, template_id, start_date, cutoff_date, end_rule) values ('2121-H', '海外人才项目二期', $1, '2029-01-01', '2029-12-31', 'carry')`, [T.P]);
await q(`insert into budget_line (card_id, subject_id, amount) values ($1,$2,100000), ($1,$3,50000)`, [H, SUB.P.equip, SUB.P.mat]);
for (const t of ['服务器与 GPU', '耗材']) await q(`insert into reimb_ruling (card_id, expense_type_id, ruled_on, ruled_by, verdict) values ($1,$2,'2029-01-05','财务甲','yes')`, [H, TY[t]]);
await db.exec(`set role app_api`);
await as(U.fin, D9);
for (const [l, s, a] of [[BXL, SUB.P.equip, 20000], [PL1, SUB.P.equip, 24000], [PL2, SUB.P.mat, 8000]])
  await q(`select allocate_line($1, $2)`, [l, JSON.stringify([{ card_id: H, subject_id: s, amount: a }])]);
await q(`select advance_budget_year(2029, 'issue')`);

// 经费卡记总金额和执行年限，只有财务岗和中心负责人看得到
await raises('执行年限的止不能早于起', /执行年限的结束日期不得早于开始日期/, `select set_card_total($1, 300000, '2029-01-01', '2028-01-01')`, [H]);
await q(`select set_card_total($1, 300000, '2029-01-01', '2031-12-31')`, [H]);
let hc = await one(`select total_amount, period_start::text s, period_end::text e from api.card where card_id = $1`, [H]);
ok(Number(hc.total_amount) === 300000 && hc.s === '2029-01-01' && hc.e === '2031-12-31', '经费卡记下总金额和执行年限', JSON.stringify(hc));
await as(U.lead, D9);
await raises('项目负责人不能改经费卡', /需要权限/, `select set_card_total($1, 1, null, null)`, [H]);
eq((await q(`select * from api.card`)).length, 0, '项目负责人看不到任何经费卡');
let ba = await q(`select card_id, card_no, card_name, amount from api.budget_alloc where line_id = $1`, [BXL]);
ok(ba.length === 1 && ba[0].card_no === null && ba[0].card_name === null && ba[0].card_id === null && Number(ba[0].amount) === 20000, '项目负责人看得到下达了多少，看不到落在哪张卡', JSON.stringify(ba));

// 名单：负责人直接加；大项目负责人看得到论文项目的名单
await as(U.mem2, D9);
eq((await q(`select * from api.line_pick where project_id = $1`, [BX])).length, 0, '不在名单里选不到这个课题的预算行');
eq((await q(`select * from api.people_pick`)).length > 3 ? 1 : 0, 1, '加人时能按姓名选人');
ok(!('email' in (await one(`select * from api.people_pick limit 1`))), '选人的名单里只有姓名');
await as(U.lead, D9);
await raises('大项目负责人不能替论文项目加人', /仅研究单元负责人、副手和财务岗可修改成员名单/, `select add_project_member($1, $2)`, [PX1, U.mem2]);
await as(U.mem, D9);
ok((await one(`select can_roster, member from api.project where id = $1`, [PX1])).can_roster === true, '论文项目负责人能管自己项目的名单');
await q(`select add_project_member($1, $2)`, [PX1, U.mem2]);
await as(U.lead, D9);
const ros = await q(`select user_name, holding from api.project_member where project_id = $1 and left_on is null`, [PX1]);
ok(ros.length === 1 && ros[0].user_name === '成员乙', '大项目负责人看得到下面论文项目的名单', JSON.stringify(ros));
ok((await one(`select members from api.project where id = $1`, [PX1])).members === 1, '项目上带着成员人数');
await as(U.mem2, D9);
eq((await q(`select * from api.line_pick where project_id = $1`, [BX])).length, 3, '进了研究单元的名单，就能选所属课题的预算行');

// 支出：成员提 → 项目负责人确认 → 财务岗核对；核对不通过退回并写原因
const sp9 = `select submit_project_request($1, $2, $3, $4, $5) v`;
const e1 = await val(sp9, [PL2, TY['耗材'], '试剂一批', 3000, '2029-04-30']);
ok((await one(`select project_id from api.request where id = $1`, [e1])).project_id === PX1, '用的是课题的预算行，申请记在本人所在的研究单元名下');
await raises('指明的研究单元须属于预算行所在的课题', /所选研究单元不属于该预算行所在的课题/, `select submit_project_request($1, $2, '试', 10, '2029-04-30', false, null, $3)`, [PL2, TY['耗材'], PA1]);
await as(U.mem, D9);
await q(`select confirm_request($1, true)`, [e1]);
await as(U.fin, D9);
await q(`select check_request($1, false, '报价单没附')`, [e1]);
await as(U.mem2, D9);
let e9 = await one(`select status, return_note, card_id from api.request where id = $1`, [e1]);
ok(e9.status === 'rejected' && e9.return_note === '报价单没附' && e9.card_id === null, '财务岗核对不通过退回，申请人看得到原因', JSON.stringify(e9));
// 项目负责人不同意
const e2 = await val(sp9, [PL2, TY['耗材'], '不必要的耗材', 500, '2029-04-30']);
await as(U.mem, D9);
await q(`select confirm_request($1, false, '这批先不买')`, [e2]);
ok((await one(`select status from api.request where id = $1`, [e2])).status === 'rejected', '项目负责人不同意，申请就退回');
// 超预算：不拦，标出超多少，项目负责人确认后到中心负责人
await as(U.mem2, D9);
const e3 = await val(sp9, [PL2, TY['耗材'], '试剂二批', 6000, '2029-04-30']);
const e4 = await val(sp9, [PL2, TY['耗材'], '试剂三批', 4000, '2029-04-30']);
e9 = await one(`select step, over_amount from api.request where id = $1`, [e4]);
ok(e9.step === 'confirm' && Number(e9.over_amount) === 2000, '超出预算行的支出不拦，标出超了多少', JSON.stringify(e9));
await as(U.mem, D9);
await q(`select confirm_request($1, true)`, [e3]); await q(`select confirm_request($1, true)`, [e4]);
ok((await one(`select step from api.request where id = $1`, [e4])).step === 'director', '超预算的确认后到中心负责人');
await as(U.fin, D9);
await raises('超预算的没批之前财务岗不能核对', /该申请不在待财务岗核对状态/, `select check_request($1, true)`, [e4]);
await q(`select check_request($1, true)`, [e3]);
await as(U.dir, D9);
await q(`select approve_request($1)`, [e4]);
await as(U.mem, D9);
ok(Number((await one(`select fixed from api.budget_line where id = $1`, [PL2])).fixed) === 10000, '中心负责人批了超预算的，这一行的核定数跟着调高');
ok((await q(`select note from api.budget_revision where line_id = $1`, [PL2])).some(r => /超预算支出.*中心负责人批准/.test(r.note)), '调高留了一笔版本记录');
await as(U.lead, D9);
eq((await one(`select sum(amount) v from api.budget_alloc where line_id = $1`, [PL2])).v, 10000, '调高的部分同时下达到这笔支出落的地方');
await as(U.fin, D9);
await q(`select check_request($1, true)`, [e4]);
ok((await one(`select status from api.request where id = $1`, [e4])).status === 'committed', '超预算的经中心负责人批、财务岗核对后承诺');
// 负责人自己提的：没有副手，记本人确认，直接到财务岗
await as(U.mem, D9);
const e5 = await val(sp9, [PL1, TY['服务器与 GPU'], '工作站一台', 9000, '2029-04-30']);
e9 = await one(`select step, self_confirmed, confirmed_by_name from api.request where id = $1`, [e5]);
ok(e9.step === 'check' && e9.self_confirmed === true && e9.confirmed_by_name === '成员甲', '负责人自己提的、没有副手，记本人确认', JSON.stringify(e9));
await as(U.fin, D9);
eq((await q(`select * from api.request where self_confirmed and project_id = $1`, [PX1])).length, 1, '本人确认的可以筛出来');
await q(`select check_request($1, true)`, [e5]);
const ob9 = await q(`select user_id, text from api.outbox`);
ok(ob9.some(o => o.user_id === U.mem && /^待确认：「试剂一批」/.test(o.text)), '成员提交后通知项目负责人确认');
ok(ob9.some(o => o.user_id === U.dir && /^超出预算，待审批：「试剂三批」/.test(o.text)), '超预算的通知中心负责人');
ok(ob9.some(o => o.user_id === U.mem2 && /^已退回：「试剂一批」.*报价单没附/.test(o.text)), '退回通知申请人并带原因');
ok(!ob9.some(o => [U.mem, U.mem2].includes(o.user_id) && /海外人才研究单元二期|2121-H/.test(o.text)), '发给成员和项目负责人的通知里不带经费卡');

// 科目间调剂：预算行都在课题上，由课题负责人在本课题的预算行之间调。全年自己调的累计不超过课题年度预算的 10% 直接生效，超过的交中心负责人
await as(U.mem2, D9);
await raises('成员不能调剂预算', /仅课题负责人和副手可调剂本课题预算/, `select shift_budget($1, $2, 1000, '试')`, [PL1, PL2]);
await as(U.mem, D9);
await raises('研究单元负责人不能调剂课题的预算', /仅课题负责人和副手可调剂本课题预算/, `select shift_budget($1, $2, 1000, '试')`, [PL1, PL2]);
await as(U.lead, D9);
await raises('调剂要写原因', /请填写调剂原因/, `select shift_budget($1, $2, 1000, '')`, [PL1, PL2]);
await raises('不能跨课题调剂', /仅可在同一课题、同一年度的预算行之间调剂/, `select shift_budget($1, $2, 1000, '试')`, [PL1, L1]);
await raises('调出不能超过这一行剩的', /剩余 15000/, `select shift_budget($1, $2, 16000, '试')`, [PL1, PL2]);
const s1x = await val(`select shift_budget($1, $2, 3000, '耗材用得比预想多') v`, [PL1, PL2]);
let sh = await one(`select status, from_purpose, to_purpose from api.budget_shift where id = $1`, [s1x]);
ok(sh.status === 'applied' && sh.from_purpose === '算力与设备' && sh.to_purpose === '实验耗材', '10% 以内的调剂直接生效', JSON.stringify(sh));
let fx = await q(`select id, fixed from api.budget_line where id in ($1, $2)`, [PL1, PL2]);
ok(Number(fx.find(x => x.id === PL1).fixed) === 21000 && Number(fx.find(x => x.id === PL2).fixed) === 13000, '调剂后两行的核定数一减一加');
eq((await one(`select sum(amount) v from api.budget_alloc where line_id = $1`, [PL1])).v, 21000, '调出的一行多下达的部分收回');
eq((await q(`select * from api.budget_revision where line_id in ($1, $2) and note like '科目间调剂%'`, [PL1, PL2])).length, 2, '调剂留两笔版本记录');
const bxl0 = Number((await one(`select fixed from api.budget_line where id = $1`, [BXL])).fixed);
const mv = await val(`select shift_budget($1, $2, 2000, '研究单元耗材不够') v`, [BXL, PL2]);
fx = await q(`select id, fixed from api.budget_line where id in ($1, $2)`, [BXL, PL2]);
ok((await one(`select status from api.budget_shift where id = $1`, [mv])).status === 'applied' && Number(fx.find(x => x.id === BXL).fixed) === bxl0 - 2000 && Number(fx.find(x => x.id === PL2).fixed) === 15000, '课题里各行之间都这样调，一减一加', JSON.stringify(fx));
ok(Number((await one(`select coalesce(sum(amount), 0) v from api.budget_alloc where line_id = $1`, [BXL])).v) <= bxl0 - 2000, '调出的一行多下达的部分收回');
const s2x = await val(`select shift_budget($1, $2, 1000, '再补一点') v`, [PL1, PL2]);
ok((await one(`select status from api.budget_shift where id = $1`, [s2x])).status === 'pending', '累计超过 10% 的调剂等中心负责人批');
await raises('有一笔在等批时不能再提', /该课题已有一笔调剂待中心负责人审批，审批后再提交/, `select shift_budget($1, $2, 100, '再来')`, [PL1, PL2]);
await raises('课题负责人不能自己批调剂', /需要权限/, `select decide_budget_shift($1, true)`, [s2x]);
await as(U.dir, D9);
await q(`select decide_budget_shift($1, true)`, [s2x]);
ok(Number((await one(`select fixed from api.budget_line where id = $1`, [PL2])).fixed) === 16000, '中心负责人批了之后调剂生效');
await as(U.lead, D9);
eq((await q(`select * from api.budget_shift where project_id = $1`, [BX])).length, 3, '课题负责人看得到本课题的调剂记录');
await raises('同一课题的两行不走课题之间的调剂', /两行属同一研究单元，请使用研究单元内调剂/, `select move_budget($1, $2, 1000, '试')`, [PL1, PL2]);
await as(U.mem2, D9);
eq((await q(`select * from api.budget_shift where id = $1`, [mv])).length, 1, '课题全公开：成员看得到课题的调剂');
const ue = await q(`select project_id, n, used, actual from api.unit_exec where topic_id = $1 and year = 2029`, [BX]);
ok(ue.some((x) => x.project_id === PX1 && x.n > 0 && Number(x.used) > 0) && ue.every((x) => [PX1, BX].includes(x.project_id)), '课题的执行按研究单元分列，成员看得到汇总数', JSON.stringify(ue));

// 设备买回来归公共设备，记下哪个项目出的钱；出钱项目的成员优先领用
await as(U.fin, D9);
const ws = await val(`select save_resource(null, 'asset', '图形工作站', null, 1, '台') v`);
await q(`select stock_in($1, 1, 9000, null, '供应商乙', null, $2)`, [ws, e5]);
const stk = await one(`select project_id, project_name, line_purpose from api.resource_stock where resource_id = $1`, [ws]);
ok(stk.project_id === PX1 && stk.project_name === '论文：评测基准' && stk.line_purpose === '算力与设备', '入库记下是哪个项目哪一行预算出的钱', JSON.stringify(stk));
const api9 = await val(`select save_resource(null, 'api', '评测接口二号', 'sk-…9x', 1000, '美元') v`);
await q(`select set_line_resource($1, $2, 2)`, [PL1, ws]);
await q(`select set_line_resource($1, $2, 1)`, [BXL, ws]);
await q(`select set_line_resource($1, $2, 500)`, [PL2, api9]);
await as(U.mem, D9);
const pa = await q(`select resource_name, qty, holders, line_purpose from api.project_asset where project_id = $1`, [PX1]);
ok(pa.length === 1 && pa[0].resource_name === '图形工作站' && pa[0].holders === null, '项目负责人看得到本项目出钱买的设备，现在没人领', JSON.stringify(pa));
const srq9 = `select save_resource_request(null, $1, $2, $3, $4, $5, $6, $7, $8) v`;
await as(U.lead, D9);
const rq9a = await val(srq9, ['asset', null, BXL, 1, null, '组里公用', null, false]);
await as(U.mem2, D9);
const rq9b = await val(srq9, ['asset', null, PL1, 2, null, '跑评测', null, false]);
const rq9c = await val(srq9, ['api', null, PL2, 100, '2029-03-20', '评测调用', null, false]);
await as(U.mem, D9);
await q(`select decide_resource_request($1, 'review')`, [rq9b]); await q(`select decide_resource_request($1, 'review')`, [rq9c]);
await as(U.fin, D9);
const pr9 = await q(`select id, priority from api.resource_request where id in ($1, $2)`, [rq9a, rq9b]);
ok(pr9.find(x => x.id === rq9b).priority === true && pr9.find(x => x.id === rq9a).priority === false, '出钱项目成员的申领标着优先');
for (const x of [rq9a, rq9b, rq9c]) await q(`select decide_resource_request($1, 'approve')`, [x]);
await raises('出钱项目的申领没发完，不能先发给别人', /优先领用/, `select fulfil_resource_request($1)`, [rq9a]);
await q(`select fulfil_resource_request($1)`, [rq9b]);
const al9 = await val(`select fulfil_resource_request($1) v`, [rq9c]);
await as(U.mem, D9);
ok((await one(`select holders from api.project_asset where project_id = $1`, [PX1])).holders === '成员乙 ×2', '设备发出去后项目负责人看得到在谁手里');
const pal = await q(`select * from api.project_allocation where project_id = $1`, [PX1]);
ok(pal.length === 1 && pal[0].user_name === '成员乙' && Number(pal[0].quota) === 100 && pal[0].current && !('has_secret' in pal[0]) && !('secret_hint' in pal[0]), '项目负责人看得到本项目的接口额度分给了谁，不带密钥', JSON.stringify(pal));
// 移出成员前要先逐项收回接口额度
ok((await one(`select holding from api.project_member where project_id = $1 and left_on is null`, [PX1])).holding === 1, '名单上看得到这个人手里还有几项接口额度');
await raises('接口额度没收回不能移出', /尚有 1 项接口额度未收回/, `select remove_project_member($1, $2)`, [PX1, U.mem2]);
await as(U.lead, D9);
await raises('别的项目负责人不能收回', /仅研究单元负责人、副手和财务岗可收回/, `select recall_project_allocation($1)`, [al9]);
await as(U.mem, D9);
await q(`select recall_project_allocation($1)`, [al9]);
await raises('不能重复收回', /该分配已收回/, `select recall_project_allocation($1)`, [al9]);
await q(`select remove_project_member($1, $2)`, [PX1, U.mem2]);
await raises('不在名单里的不能再移', /该用户不在名单内/, `select remove_project_member($1, $2)`, [PX1, U.mem2]);
await as(U.mem2, D9);
eq((await q(`select * from api.line_pick where project_id = $1`, [BX])).length, 0, '移出后选不到课题的预算行');
await raises('移出后不能再从这个项目提支出', /拦截：本人不在该课题及其研究单元的成员名单内，请研究单元负责人先将本人加入名单/, sp9, [PL1, TY['服务器与 GPU'], '再买一台', 100, '2029-04-30']);
ok((await q(`select * from api.allocation where resource_id = $1 and current`, [ws])).length === 1, '手里的设备是公共设备，不跟着名单走');

// 年末盘点和对账
await raises('成员不能盘点', /需要权限/, `select save_year_check(2029, $1, 2)`, [ws]);
await as(U.fin, D9);
await raises('实际数和账面对不上要写原因', /不一致，须填写原因/, `select save_year_check(2029, $1, 1)`, [ws]);
await q(`select save_year_check(2029, $1, 1, '一台送修未归')`, [ws]);
await q(`select save_year_check(2029, $1, 2)`, [ws]);
const yc = await q(`select resource_id, book, actual, diff from api.year_check where year = 2029`);
ok(yc.length > 1 && Number(yc.find(x => x.resource_id === ws).diff) === 0 && yc.some(x => x.actual === null), '盘点表每种资源一行，看得出哪些还没盘', String(yc.length));
await db.exec(`reset role`);
}

// ---------- 任务列表 ----------
{
const cardA = (await one(`select id from fund_card order by card_no limit 1`)).id;
const D9 = '2029-03-10';
await db.exec(`set role app_api`);
await as(U.mem, D9);
await raises('成员不能给别人派任务', /仅可为本人创建任务，指派他人须有任务指派权限/, `select create_task('交材料', $1, null, null, null, null)`, [U.mem2]);
await raises('任务要有名称', /请填写任务名称/, `select create_task('  ', null, null, null, null, null)`);
await raises('看不到卡的人不能把卡挂到任务上', /无权查看该经费卡，不得关联至任务/, `select create_task('试', null, null, $1, null, null)`, [cardA]);
const own = await val(`select create_task('整理发票', null, '2029-03-20', null, null, E'找发票\n\n贴好') v`);
const ownRow = await one(`select * from api.task where id = $1`, [own]);
ok(ownRow.mine && ownRow.can_manage && ownRow.steps === 2 && ownRow.steps_done === 0 && ownRow.assignee_id === U.mem, '每个人都能给自己建任务，空行不算步骤', JSON.stringify(ownRow));

await as(U.dir, D9);
const obBefore = Number(await val(`select count(*) v from api.outbox`));
const tk = await val(`select create_task('结算基金', $1, '2029-04-30', $2, '样例说明', E'第一步\n第二步\n第三步') v`, [U.fin, cardA]);
const st = await q(`select id, sort, text, done from api.task_step where task_id = $1 order by sort`, [tk]);
ok(st.length === 3 && st[0].text === '第一步' && st[2].sort === 3 && !st[0].done, '步骤按行拆开，按顺序排', JSON.stringify(st));
ok(Number(await val(`select count(*) v from api.outbox`)) === obBefore + 1, '派任务通知办理人');
ok((await q(`select id from api.task`)).length === 2, '有派任务权限的人看得到全部任务');

await as(U.mem2, D9);
ok((await q(`select id from api.task`)).length === 0 && (await q(`select id from api.task_step`)).length === 0, '别人的任务和步骤看不到');
await raises('别人不能勾步骤', /仅办理人和指派人可勾选/, `select tick_task_step($1, true, null)`, [st[0].id]);
await raises('别人不能办结', /仅办理人和指派人可办结/, `select finish_task($1, null)`, [tk]);

await as(U.fin, D9);
const mineT = await q(`select * from api.task`);
ok(mineT.length === 1 && mineT[0].mine && !mineT[0].can_manage && mineT[0].card_id === cardA && mineT[0].card_name && mineT[0].creator_name === '负责人', '办理人看得到派给自己的任务和挂的卡', JSON.stringify(mineT));
await raises('没勾完不能办结', /尚有 3 步未完成/, `select finish_task($1, null)`, [tk]);
await raises('办理人不能撤销', /仅指派人可撤销/, `select cancel_task($1, '试')`, [tk]);
await raises('办理人不能改任务', /仅指派人可修改/, `select edit_task($1, '改名', $2, null, null)`, [tk, U.fin]);
await q(`select tick_task_step($1, true, '已交学校')`, [st[0].id]);
await q(`select tick_task_step($1, true, null)`, [st[1].id]);
await q(`select tick_task_step($1, null, '只写备注不勾')`, [st[2].id]);
const st2 = await q(`select sort, done, done_by_name, note from api.task_step where task_id = $1 order by sort`, [tk]);
ok(st2[0].done && st2[0].done_by_name === '财务岗' && st2[0].note === '已交学校' && st2[1].done && !st2[2].done && st2[2].note === '只写备注不勾', '勾一步记下谁勾的，备注可以单独写', JSON.stringify(st2));
await q(`select tick_task_step($1, false, null)`, [st[1].id]);
ok((await one(`select done, done_by_name from api.task_step where id = $1`, [st[1].id])).done === false, '勾错了可以取消');
await q(`select add_task_steps($1, '第四步')`, [tk]);
ok((await one(`select steps, steps_done from api.task where id = $1`, [tk])).steps === 4, '办理人办的过程中可以加步骤');
for (const x of await q(`select id from api.task_step where task_id = $1 and not done`, [tk])) await q(`select tick_task_step($1, true, null)`, [x.id]);
await q(`select finish_task($1, '都办完了')`, [tk]);
const doneT = await one(`select status, closed_by_name, close_note, steps, steps_done from api.task where id = $1`, [tk]);
ok(doneT.status === 'done' && doneT.closed_by_name === '财务岗' && doneT.close_note === '都办完了' && doneT.steps_done === 4, '全部勾完后办结', JSON.stringify(doneT));
ok((await q(`select text from api.outbox where user_id = $1 and text like '%已办结任务「结算基金」%'`, [U.dir])).length === 1, '办结通知派任务的人');
await raises('办结之后不能再勾', /已办结或已撤销的任务不得修改步骤/, `select tick_task_step($1, false, null)`, [st[0].id]);
await raises('办理人不能自己退回重办', /仅指派人可退回重办/, `select reopen_task($1, '试')`, [tk]);

await as(U.dir, D9);
await raises('退回重办要写原因', /请填写需重办的事项/, `select reopen_task($1, ' ')`, [tk]);
await q(`select reopen_task($1, '第三步的材料不全')`, [tk]);
ok((await one(`select status, closed_at from api.task where id = $1`, [tk])).status === 'open', '派任务的人可以退回重办');
await q(`select edit_task($1, '结算基金（改期）', $2, '2029-05-15', null)`, [tk, U.lead]);
const ed = await one(`select title, assignee_id, due_date, detail from api.task where id = $1`, [tk]);
ok(ed.title === '结算基金（改期）' && ed.assignee_id === U.lead && ed.detail === null, '派任务的人可以改名称、期限和办理人', JSON.stringify(ed));
await as(U.lead, D9);
const leadT = await one(`select mine, card_id, card_name from api.task where id = $1`, [tk]);
ok(leadT.mine && leadT.card_id === null && leadT.card_name === null, '看不到卡的办理人看不到任务挂的卡', JSON.stringify(leadT));
await as(U.fin, D9);
ok((await q(`select id from api.task where id = $1`, [tk])).length === 0, '转给别人之后原办理人不再看到');
await as(U.dir, D9);
await raises('撤销要写原因', /请填写撤销原因/, `select cancel_task($1, '')`, [tk]);
await q(`select cancel_task($1, '学校通知延期')`, [tk]);
ok((await one(`select status, close_note from api.task where id = $1`, [tk])).status === 'cancelled', '派任务的人可以撤销');
await raises('撤销之后不能改', /已办结或已撤销的任务不得修改/, `select edit_task($1, '试', $2, null, null)`, [tk, U.lead]);
await db.exec(`reset role`);
ok((await one(`select count(*) v from audit_log where table_name = 'task'`).catch(() => ({ v: 1 }))).v > 0, '任务的改动留审计记录');
}

// ---------- 经费项目与按年的经费卡 ----------
{
await db.exec(`set role app_api`);
const lines = (o) => JSON.stringify(Object.entries(o).map(([k, amount]) => ({ subject_id: SUB.N[k], amount })));
const card = async (cid) => one(`select * from api.card where card_id = $1`, [cid]);
await as(U.mem, '2031-01-10');
await raises('成员不能建经费项目', /需要权限/, `select save_fund_project(null, '越权', 'national', null, null, 1, null, null, $1, 'carry')`, [T.N]);
eq((await q(`select * from api.fund_project`)).length, 0, '成员看不到经费项目');
await as(U.fin, '2031-01-10');
const fp = await val(`select save_fund_project(null, '国家重点项目', 'national', 'vertical', $1, 300000, '2031-01-01', '2033-12-31', $2, 'carry') v`, [U.lead, T.N]);
const kOut = await val(`select open_card($1, 2034, '7001-N', 1, '2034-01-05', '2034-12-20') v`, [fp]);
ok((await card(kOut)).year === 2034, '项目期限之外的年度也可以开经费卡，期限只作提示');
await q(`select save_fund_project($1, '国家重点项目', 'national', 'vertical', $2, 300000, '2031-01-01', '2032-12-31', $3, 'carry')`, [fp, U.lead, T.N]);
ok((await one(`select period_end from api.fund_project where id = $1`, [fp])).period_end != null, '已有经费卡在期限之外时，项目期限仍可修改');
await q(`select save_fund_project($1, '国家重点项目', 'national', 'vertical', $2, 300000, '2031-01-01', '2033-12-31', $3, 'carry')`, [fp, U.lead, T.N]);
await q(`select delete_card($1)`, [kOut]);
await raises('下达日要在该年度内', /下达日须在 2031 年内/, `select open_card($1, 2031, '7001-N', 1, '2032-01-05', '2032-12-20')`, [fp]);
const k1 = await val(`select open_card($1, 2031, '7001-N', 120000, '2031-01-05', '2031-12-20', '2031-12-31') v`, [fp]);
let c = await card(k1);
ok(c.year === 2031 && c.project_id === fp && Number(c.applied) === 120000 && c.name === '国家重点项目' && c.end_rule === 'carry', '在经费项目下开出当年的卡，名称和年底规则取自项目', JSON.stringify(c));
await raises('同一年度卡号不能重复', /2031 年已有卡号为「7001-N」的经费卡/, `select open_card($1, 2031, '7001-N', 1, '2031-02-01', '2031-12-20')`, [fp]);
const k1b = await val(`select open_card($1, 2031, '7002-N', null, '2031-02-01', '2031-12-20', '2031-12-31', '间接费') v`, [fp]);
ok((await card(k1b)).name === '间接费' && (await one(`select cards from api.fund_project where id = $1`, [fp])).cards === 2, '同一项目同一年度可以开多张经费卡，各有名称');
await q(`select set_card_granted($1, 50000)`, [k1b]);
ok(Number((await card(k1b)).granted) === 50000 && Number((await one(`select granted from api.fund_project where id = $1`, [fp])).granted) === 50000, '当年下达数可直接填写，计入项目历年下达合计');
await raises('明细合计不能超过下达数', /超过当年下达数/, `select set_budget($1, $2)`, [k1b, lines({ biz: 60000 })]);
await q(`select set_card_granted($1, null)`, [k1b]);
ok((await card(k1b)).granted == null, '下达数可清空，清空后按明细合计算');
await q(`select delete_card($1)`, [k1b]);
await q(`select set_budget($1, $2)`, [k1, lines({ equip: 100000, labor: 20000 })]);
await raises('下达数不能小于已录入的明细合计', /小于已录入各科目的明细合计/, `select set_card_granted($1, 100000)`, [k1]);
let pj = await one(`select * from api.fund_project where id = $1`, [fp]);
ok(Number(pj.granted) === 120000 && Number(pj.quota) === 300000 && pj.cards === 1, '项目上看得到额度和历年下达合计', JSON.stringify(pj));
await raises('额度不能改到低于已下达数', /已超过拟填的额度/, `select save_fund_project($1, '国家重点项目', 'national', 'vertical', $2, 100000, '2031-01-01', '2033-12-31', $3, 'carry')`, [fp, U.lead, T.N]);
await raises('还有卡没结清不能结题', /尚有 1 张经费卡未结清/, `select close_fund_project($1)`, [fp]);
// 年底结清：规则为结转的，结余带到下一年的卡
await as(U.dir, '2032-01-05');
await q(`select settle_card($1)`, [k1]);
c = await card(k1);
ok(Number(c.carried_out) === 120000 && Number(c.recalled) === 0, '结转的卡结清时记下结转数', JSON.stringify([c.carried_out, c.recalled]));
await as(U.fin, '2032-01-06');
const k2 = await val(`select open_card($1, 2032, '7001-N', 150000, '2032-01-03', '2032-12-20', '2032-12-31') v`, [fp]);
c = await card(k2);
ok(Number(c.carried_in) === 120000 && Number(c.cur) === 120000 && c.card_no === '7001-N', '卡号可以跨年沿用，上年结转的结余按科目带进来', JSON.stringify([c.carried_in, c.cur]));
eq((await one(`select granted from api.fund_project where id = $1`, [fp])).granted, 120000, '结转进来的钱不重复计入下达数');
await raises('下达合计不能超过项目额度', /超过项目额度/, `select set_budget($1, $2)`, [k2, lines({ equip: 250001, labor: 50000 })]);
await q(`select set_budget($1, $2)`, [k2, lines({ equip: 250000, labor: 50000 })]);
eq((await one(`select granted from api.fund_project where id = $1`, [fp])).granted, 300000, '只有结转时财务岗仍可录入当年预算，下达合计到额度为止');
// 下一年的卡先开、上一年后结清：结清时自动带过去
const f3 = await val(`select save_fund_project(null, '结转在后', 'school', null, null, null, null, null, $1, 'carry') v`, [T.N]);
const a1 = await val(`select open_card($1, 2031, '7003-N', null, '2031-01-05', '2031-12-20', '2031-12-31') v`, [f3]);
await q(`select set_budget($1, $2)`, [a1, lines({ equip: 10000 })]);
const a2 = await val(`select open_card($1, 2032, '7003-N', null, '2032-01-03', '2032-12-20', '2032-12-31') v`, [f3]);
await as(U.dir, '2032-01-08');
await q(`select settle_card($1)`, [a1]);
c = await card(a2);
ok(Number(c.carried_in) === 10000 && Number(c.cur) === 10000, '上一年后结清的，结余自动带到已开出的下一年卡', JSON.stringify([c.carried_in, c.cur]));
// 规则为回收的：结余记为回收数，各年都结清后可以结题
await as(U.fin, '2032-01-08');
const f2 = await val(`select save_fund_project(null, '学校年度项目', 'school', 'fiscal', null, 50000, '2031-01-01', '2031-12-31', $1, 'recall') v`, [T.N]);
const b1 = await val(`select open_card($1, 2031, '7004-N', 50000, '2031-01-05', '2031-12-20', '2031-12-31') v`, [f2]);
await q(`select set_budget($1, $2)`, [b1, lines({ biz: 50000 })]);
await as(U.dir, '2032-01-08');
await q(`select settle_card($1)`, [b1]);
c = await card(b1);
ok(Number(c.recalled) === 50000 && Number(c.carried_out) === 0, '回收的卡结清时记下回收数', JSON.stringify([c.recalled, c.carried_out]));
await as(U.fin, '2032-01-08');
eq((await one(`select recalled from api.fund_project where id = $1`, [f2])).recalled, 50000, '项目上看得到历年回收合计');
eq((await one(`select granted from api.fund_project where id = $1`, [f2])).granted, 0, '结清后被回收的部分不再占项目额度');
// 结余上缴按项目办：经费卡只有到期回收和结转；项目结束处理为结余上缴的，结题时额度剩余记为上缴数
await raises('经费卡到期处理不再接受结余上缴', /到期回收或结转/, `select save_fund_project(null, '上缴样例项目', 'school', 'fiscal', null, 80000, '2031-01-01', '2031-12-31', $1, 'return')`, [T.N]);
const f4 = await val(`select save_fund_project(null, '上缴样例项目', 'school', 'fiscal', null, 80000, '2031-01-01', '2031-12-31', $1, 'recall') v`, [T.N]);
await raises('项目结束处理只有两种', /须为结余上缴或无须上缴/, `select set_project_close_rule($1, 'carry')`, [f4]);
await q(`select set_project_close_rule($1, 'return')`, [f4]);
const d1 = await val(`select open_card($1, 2031, '7006-N', null, '2031-01-05', '2031-12-20', '2031-12-31') v`, [f4]);
await q(`select set_budget($1, $2)`, [d1, lines({ biz: 30000 })]);
await as(U.dir, '2032-01-08');
await q(`select settle_card($1)`, [d1]);
await as(U.fin, '2032-01-08');
let p4 = await one(`select granted, recalled, close_rule, returned from api.fund_project where id = $1`, [f4]);
ok(Number(p4.granted) === 0 && Number(p4.recalled) === 30000 && p4.close_rule === 'return' && p4.returned == null, '经费卡到期回收的结余回到额度剩余，结题前不记上缴数', JSON.stringify(p4));
await q(`select close_fund_project($1)`, [f4]);
p4 = await one(`select status, returned from api.fund_project where id = $1`, [f4]);
ok(p4.status === 'closed' && Number(p4.returned) === 80000, '结束处理为结余上缴的项目，结题时额度剩余记为上缴数', JSON.stringify(p4));
await q(`select close_fund_project($1)`, [f2]);
ok((await one(`select status from api.fund_project where id = $1`, [f2])).status === 'closed', '各年的卡都结清后可以结题');
await raises('结题后不能再开卡', /已结题/, `select open_card($1, 2031, '7005-N', 1, '2031-02-01', '2031-12-20')`, [f2]);
// 现有的卡不是项目：自动补的只是占位，归入正式的经费项目后占位删掉
await q(`select save_fund_project($1, '国家重点项目', 'national', 'vertical', $2, 300000, '2031-01-01', '2033-12-31', $3, 'carry', '任务书编号 X') v`, [fp, U.lead, T.N]);
ok((await one(`select note, auto from api.fund_project where id = $1`, [fp])).note === '任务书编号 X', '经费项目可以修改');
const loose = await val(`select save_card(null, '7009-N', '散卡', $1, null, '2033-01-05', '2033-12-20', '2033-12-31', 'carry') v`, [T.N]);
const ph = (await card(loose)).project_id;
ok((await one(`select auto from api.fund_project where id = $1`, [ph])).auto === true, '不经经费项目建的卡，自动补的项目标为占位');
await raises('不能归入占位项目', /占位/, `select move_card($1, $2)`, [k2, ph]);
await raises('科目模板不一致不能归入', /科目模板与项目不一致/, `select move_card($1, $2)`, [C.A, fp]);
await q(`select move_card($1, $2)`, [loose, fp]);
c = await card(loose);
ok(c.project_id === fp && c.name === '散卡', '经费卡归入正式的项目，同一年度可与其他卡并存，名称保留');
eq((await q(`select 1 from api.fund_project where id = $1`, [ph])).length, 0, '归走之后空的占位项目删掉');
const loose2 = await val(`select save_card(null, '7010-N', '散卡二', $1, null, '2033-01-05', '2033-12-20', '2033-12-31', 'recall') v`, [T.N]);
const ph2 = (await card(loose2)).project_id;
await q(`select save_fund_project($1, '散卡二项目', 'school', null, null, 80000, '2033-01-01', '2033-12-31', $2, 'recall')`, [ph2, T.N]);
ok((await one(`select auto from api.fund_project where id = $1`, [ph2])).auto === false, '占位项目补全后即为正式的经费项目');
// 开错的卡、建错的项目可以删；有预算或记录的不行
await raises('有预算的卡不能删', /已录入预算，不得删除/, `select delete_card($1)`, [k2]);
await raises('有卡的项目不能删', /已有经费卡，不得删除/, `select delete_fund_project($1)`, [fp]);
const fx = await val(`select save_fund_project(null, '建错的项目', 'school', null, null, null, null, null, $1, 'recall') v`, [T.N]);
const kx = await val(`select open_card($1, 2033, '7011-N', null, '2033-01-05', '2033-12-20') v`, [fx]);
await as(U.mem, '2032-01-08');
await raises('成员不能删卡', /需要权限/, `select delete_card($1)`, [kx]);
await as(U.fin, '2032-01-08');
await q(`select delete_card($1)`, [kx]);
eq((await q(`select 1 from api.card where card_id = $1`, [kx])).length, 0, '没有预算和记录的卡可以删除');
await q(`select delete_fund_project($1)`, [fx]);
eq((await q(`select 1 from api.fund_project where id = $1`, [fx])).length, 0, '没有卡的项目可以删除');
// 横向经费到账前不得支出；纵向、财政的不受此限
await as(U.fin, '2032-06-01');
const fh = await val(`select save_fund_project(null, '企业合作项目', 'enterprise', 'horizontal', null, null, null, null, $1, 'carry') v`, [T.N]);
const kh = await val(`select open_card($1, 2032, '7020-N', null, '2032-01-05', '2032-12-20', '2032-12-31') v`, [fh]);
await q(`select set_budget($1, $2)`, [kh, lines({ biz: 50000 })]);
const recH = `select record_expense($1, $2, $3, $4, $5, '2032-05-01', null)`;
await raises('横向经费未到账不能支出', /横向经费到账前不得支出/, recH, [kh, SUB.N.biz, TY['耗材'], '未到账', 100]);
await q(`select set_card_info($1, 'horizontal', 30000, null)`, [kh]);
await q(recH, [kh, SUB.N.biz, TY['耗材'], '到账内', 20000]);
await raises('横向经费支出不能超过已到账', /已到账 30000.00，含本笔在内的申请、承诺和已入账合计 40000.00/, recH, [kh, SUB.N.biz, TY['耗材'], '超到账', 20000]);
const fv = await val(`select save_fund_project(null, '纵向课题', 'national', 'vertical', null, null, null, null, $1, 'carry') v`, [T.N]);
const kv = await val(`select open_card($1, 2032, '7021-N', null, '2032-01-05', '2032-12-20', '2032-12-31') v`, [fv]);
await q(`select set_budget($1, $2)`, [kv, lines({ biz: 50000 })]);
await q(recH, [kv, SUB.N.biz, TY['耗材'], '纵向未填到账', 20000]);
ok(Number((await card(kv)).actual) === 20000, '纵向经费不受到账限制');
// 在经费卡上导入学校的明细账
const fl = await val(`select save_fund_project(null, '海外样例项目', 'national', 'vertical', null, null, null, null, $1, 'carry') v`, [T.N]);
const kl = await val(`select open_card($1, 2032, '7030-N', null, '2032-01-05', '2032-12-20', '2032-12-31') v`, [fl]);
const led = JSON.stringify([
  { posted_on: '2032-02-01', voucher_no: '(B)001', title: '样例差旅', amount: 700, school_code: '72-3021101', school_name: '非财政支出-国内差旅费' },
  { posted_on: '2032-02-01', voucher_no: '(B)001', title: '样例盒饭', amount: 300, school_code: '72-3020103', school_name: '非财政支出-工作盒饭' }]);
const imp = `select import_ledger($1, $2, $3, $4, $5, $6) v`;
const inc = JSON.stringify([{ posted_on: '2032-01-10', voucher_no: '(J)001', title: '样例拨款', amount: 95000, school_code: '61', school_name: '其他部委拨款' }]);
await as(U.mem, '2032-06-01');
await raises('成员不能导入明细账', /无权导入明细账/, imp, [kl, led, inc, 5000, 99000, true]);
await as(U.fin, '2032-06-01');
let ir = await val(imp, [kl, led, inc, 5000, 99000, true]);
ok(ir.added === 2 && ir.skipped === 0 && Number(ir.amount) === 1000, '导入明细账：不用指定科目和支出类型，支出行记为已入账', JSON.stringify(ir));
c = await card(kl);
ok(Number(c.granted) === 95000 && Number(c.received) === 95000 && Number(c.carried_in) === 5000 && Number(c.cur) === 100000 && Number(c.actual) === 1000 && Number(c.avail) === 99000 && Number(c.school_balance) === 99000,
  '导入明细账：收入逐笔保存并写入下达数和已到账，年初余额记为上年结转，可用与学校余额一致', JSON.stringify([c.granted, c.received, c.carried_in, c.cur, c.actual, c.avail, c.school_balance]));
ok(Number(c.income) === 95000 && Number(c.ledger_actual) === 1000 && Number(c.carried_in) + Number(c.income) - Number(c.ledger_actual) === Number(c.school_balance) && c.stray_n === 0, '按明细核对：上年结转 + 收入 − 明细账支出 = 学校余额', JSON.stringify([c.income, c.ledger_actual, c.stray_n]));
ir = await val(imp, [kl, led, inc, 5000, 99000, true]);
ok(ir.added === 0 && ir.skipped === 2 && ir.incomes === 0 && Number((await card(kl)).income) === 95000, '重复导入同一份明细账，支出和收入都不重复写入', JSON.stringify(ir));
const ss = await q(`select * from api.card_school_subject where card_id = $1 order by school_name`, [kl]);
ok(ss.length === 2 && ss.some(x => x.school_name === '非财政支出-国内差旅费' && Number(x.amount) === 700), '已入账支出可按学校科目汇总', JSON.stringify(ss));
await val(imp, [kv, JSON.stringify([{ posted_on: '2032-03-01', voucher_no: '(B)009', title: '财政卡差旅', amount: 50, school_code: '99-3021101', school_name: '财政支出-国内差旅费' }]), null, null, null, null]);
const sameSub = await q("select subject_id from api.cell where subject_code = '3021101' and card_id in ($1, $2) and actual > 0", [kl, kv]);
ok(sameSub.length === 2 && sameSub[0].subject_id === sameSub[1].subject_id, '经费类别不同的两张卡，差旅费记在同一个科目上', JSON.stringify(sameSub));
// 在途支出：补登后计入在途，导入明细账时按金额对上，转为已入账而不重复记
const fi = await val(`select save_fund_project(null, '在途样例项目', 'national', 'vertical', null, null, null, null, $1, 'carry') v`, [T.N]);
const ki = await val(`select open_card($1, 2032, '7040-N', null, '2032-01-05', '2032-12-20', '2032-12-31') v`, [fi]);
const reg = `select register_inflight($1, $2, $3, $4, $5) v`;
await as(U.mem, '2032-06-01');
await raises('成员不能补登在途支出', /无权补登/, reg, [ki, '样例电脑', 1234.5, '2032-05-20', 'at_school']);
await as(U.fin, '2032-06-01');
await raises('在途支出只有两种状态', /当前状态只能是/, reg, [ki, '样例电脑', 1234.5, '2032-05-20', 'posted']);
await raises('在途支出的发生日期不能晚于当日', /发生日期/, reg, [ki, '样例电脑', 1234.5, '2032-06-02', 'at_school']);
const ri = await val(reg, [ki, '样例电脑', 1234.5, '2032-05-20', 'at_school']);
await val(reg, [ki, '样例盒饭', 88, '2032-05-21', 'committed']);
c = await card(ki);
ok(Number(c.commit) === 1322.5 && Number(c.actual) === 0, '补登的在途支出计入经费卡的在途金额', JSON.stringify([c.commit, c.actual]));
const ledI = JSON.stringify([
  { posted_on: '2032-06-01', voucher_no: '(B)101', title: '付样例公司设备款', amount: 1234.5, school_code: '72-3100201', school_name: '非财政支出-办公设备购置' },
  { posted_on: '2032-06-01', voucher_no: '(B)102', title: '样例耗材', amount: 500, school_code: '72-3021801', school_name: '非财政支出-专用材料费' }]);
ir = await val(imp, [ki, ledI, null, null, null, true]);
ok(ir.matched === 1 && ir.added === 1 && Number(ir.amount) === 1734.5, '导入明细账：金额对上的在途申请转为已入账，其余新记', JSON.stringify(ir));
const pr = await one(`select status, title, posted_amount, voucher_no from api.request where id = $1`, [ri]);
ok(pr.status === 'posted' && pr.title === '样例电脑' && Number(pr.posted_amount) === 1234.5 && pr.voucher_no === '(B)101', '对上的申请保留原事项，带上学校的凭证', JSON.stringify(pr));
c = await card(ki);
ok(Number(c.commit) === 88 && Number(c.actual) === 1734.5 && c.stray_n === 0, '对上之后同一笔钱不重复计：在途减少，已入账增加', JSON.stringify([c.commit, c.actual, c.stray_n]));
ir = await val(imp, [ki, ledI, null, null, null, true]);
ok(ir.matched === 0 && ir.added === 0 && ir.skipped === 2, '重复导入：已对上的行也不重复写入', JSON.stringify(ir));
// 结清后学校仍有出账的卡，改回未结清
const fr = await val(`select save_fund_project(null, '改回样例项目', 'national', 'vertical', null, null, null, null, $1, 'recall') v`, [T.N]);
const kr = await val(`select open_card($1, 2032, '7041-N', null, '2032-01-05', '2032-05-20', '2032-05-31') v`, [fr]);
await val(imp, [kr, JSON.stringify([{ posted_on: '2032-03-01', voucher_no: '(B)201', title: '样例支出', amount: 400, school_code: '72-3021801', school_name: '非财政支出-专用材料费' }]),
  JSON.stringify([{ posted_on: '2032-01-10', voucher_no: '(J)201', title: '样例拨款', amount: 1000, school_code: '61', school_name: '其他部委拨款' }]), 0, 600, true]);
await as(U.dir, '2032-06-01');
await raises('未结清的卡无须改回', /未结清，无须改回/, `select reopen_card($1, '学校仍有出账')`, [kr]);
await q(`select settle_card($1)`, [kr]);
c = await card(kr);
ok(c.status === 'settled' && Number(c.recalled) === 600, '到期回收的卡结清时记下回收数', JSON.stringify([c.status, c.recalled]));
await raises('改回未结清要写原因', /请填写改回未结清的原因/, `select reopen_card($1, ' ')`, [kr]);
await raises('结余已结转的卡不能改回', /已结转至后续经费卡/, `select reopen_card($1, '学校仍有出账')`, [k1]);
await as(U.fin, '2032-06-01');
await raises('已结清的卡不能补登在途支出', /已结清/, reg, [kr, '结清后出账', 100, '2032-05-30', 'at_school']);
await raises('财务岗不能改回未结清', /需要权限/, `select reopen_card($1, '学校仍有出账')`, [kr]);
await as(U.dir, '2032-06-01');
await q(`select reopen_card($1, '学校仍有出账')`, [kr]);
c = await card(kr);
ok(c.status === 'active' && Number(c.recalled) === 0 && Number(c.actual) === 400, '改回未结清：恢复在用，回收数清零，已入账不变', JSON.stringify([c.status, c.recalled, c.actual]));
eq((await q(`select 1 from api.settlement where card_id = $1`, [kr])).length, 0, '改回后结清记录撤销');
await as(U.fin, '2032-06-01');
await val(reg, [kr, '结清后出账', 100, '2032-05-30', 'at_school']);
ok(Number((await card(kr)).commit) === 100, '改回后可以补登在途支出');
// 学校中途回收的经费：登记后核对时扣除，不计入支出
await q(`select add_fund_event($1, '回收', '2032-05-31', 300, null)`, [kr]);
c = await card(kr);
ok(Number(c.school_recalled) === 300 && Number(c.actual) === 400 && Number(c.carried_in) + Number(c.income) - Number(c.ledger_actual) - Number(c.school_recalled) === 300, '学校回收单独记，核对时扣除，已入账的花销不变', JSON.stringify([c.school_recalled, c.actual, c.income, c.ledger_actual]));
// 只控总额的卡：支出只与整张卡的总额核对，与科目的预算无关
ok((await card(kl)).pooled === true, '导入时可把经费卡设为只控总额');
await q(recH, [kl, SUB.N.biz, TY['耗材'], '科目上没有预算', 5000]);
ok(Number((await card(kl)).avail) === 94000, '只控总额的卡，科目上没有预算也能支出，可用按总额算');
c = await card(kl);
ok(c.stray_n === 1 && Number(c.stray_amount) === 5000, '明细账之外的已入账支出单独计数', JSON.stringify([c.stray_n, c.stray_amount]));
eq(await val(`select void_stray_posted($1) v`, [kl]), 1, '明细账里没有的已入账支出可以作废');
c = await card(kl);
ok(c.stray_n === 0 && Number(c.actual) === 1000 && Number(c.avail) === 99000, '作废后不再计入已入账，可用与学校余额重新一致', JSON.stringify([c.actual, c.avail]));
await raises('只控总额的卡支出不能超过总额', /可用 99000/, recH, [kl, SUB.N.biz, TY['耗材'], '超总额', 99500]);
await q(`select set_card_pooled($1, false)`, [kl]);
await raises('改回按科目控制后，科目上没有预算不能支出', /可用/, recH, [kl, SUB.N.equip, TY['耗材'], '按科目', 100]);
// 导入过明细账的卡，各科目的预算仍可更正（学校明细账这一项本来就没有预算）
const schoolSub = (await one("select subject_id as id from api.cell where card_id = $1 and subject_code = '3021101'", [kl])).id;
const sc0 = await one("select actual, subject_name from api.cell where card_id = $1 and subject_id = $2", [kl, schoolSub]);
ok(Number(sc0.actual) === 700 && sc0.subject_name === '国内差旅费', '导入的支出记在学校的科目上；科目不分经费类别，取编号和名称的后半段', JSON.stringify(sc0));
await as(U.dir, '2032-06-01');
await q("select set_budget($1, $2)", [kl, JSON.stringify([{ subject_id: schoolSub, amount: 0 }, { subject_id: SUB.N.equip, amount: 0 }, { subject_id: SUB.N.biz, amount: 6000 }])]);
ok(Number((await card(kl)).assigned) === 6000, '学校科目上已有支出、尚未补预算时，其他科目的预算仍可更正');
await q("select set_budget($1, $2)", [kl, JSON.stringify([{ subject_id: schoolSub, amount: 2000 }])]);
await raises('不能把学校科目的预算调低到已入账以下', /./, "select set_budget($1, $2)", [kl, JSON.stringify([{ subject_id: schoolSub, amount: 100 }])]);
// 经费卡自编预算科目：明细按任务书的预算科目编，学校科目对应到预算科目
await as(U.mem, '2032-06-01');
await raises('成员不能编预算科目', /需要权限/, `select save_card_subject(null, $1, '差旅费')`, [kl]);
await as(U.fin, '2032-06-01');
const it = await val(`select save_card_subject(null, $1, '差旅费') v`, [kl]);
ok((await one(`select subject_name, orig from api.cell where card_id = $1 and subject_id = $2`, [kl, it])).subject_name === '差旅费', '财务岗可在经费卡上自己新增预算科目');
ok((await one(`select card_id from api.subject where id = $1`, [it])).card_id === kl, '预算科目是这张卡自己的');
await raises('同一张卡预算科目不重名', /已有同名的预算科目/, `select save_card_subject(null, $1, '差旅费')`, [kl]);
await q(`select save_card_subject($1, null, '差旅费（国内）')`, [it]);
ok((await one(`select name from api.subject where id = $1`, [it])).name === '差旅费（国内）', '预算科目可以改名');
const boxSub = (await one("select subject_id as id from api.cell where card_id = $1 and subject_code = '3020103'", [kl])).id;
await raises('已录金额的学校科目先更正为零再对应', /已录有明细金额/, `select map_school_subject($1, $2, $3)`, [kl, schoolSub, it]);
eq(await val(`select map_school_subject($1, $2, $3) v`, [kl, boxSub, it]), 1, '学校科目对应到预算科目，已入账的支出随之改记');
ok(Number((await one(`select actual from api.cell where card_id = $1 and subject_id = $2`, [kl, it])).actual) === 300 && Number((await one(`select actual from api.cell where card_id = $1 and subject_id = $2`, [kl, boxSub])).actual) === 0, '执行归到预算科目下');
ok((await q(`select * from api.card_school_subject where card_id = $1 and subject_id = $2`, [kl, it])).some(x => x.school_name === '非财政支出-工作盒饭' && Number(x.amount) === 300), '预算科目下仍能按学校科目看入账');
await val(imp, [kl, JSON.stringify([{ posted_on: '2032-04-01', voucher_no: '(B)020', title: '样例盒饭二', amount: 400, school_code: '72-3020103', school_name: '非财政支出-工作盒饭' }]), null, null, null, null]);
ok(Number((await one(`select actual from api.cell where card_id = $1 and subject_id = $2`, [kl, it])).actual) === 700, '之后再导入明细账，已对应的学校科目直接记在预算科目下');
eq((await q(`select * from api.card_subject_map where card_id = $1`, [kl])).length, 1, '可查到学校科目对应到哪个预算科目');
await raises('有支出的预算科目不能删', /请先取消对应/, `select delete_card_subject($1)`, [it]);
await as(U.dir, '2032-06-01');
await raises('一张卡的预算科目不能用在另一张卡上', /属于另一张经费卡|不属于该卡/, "select set_budget($1, $2)", [kv, JSON.stringify([{ subject_id: it, amount: 1 }])]);
eq(Number((await one(`select count(*) v from api.cell where card_id = $1 and subject_id = $2`, [kv, it])).v), 0, '一张卡自编的预算科目不出现在别的卡上');
await q("select set_budget($1, $2)", [kl, JSON.stringify([{ subject_id: it, amount: 1500 }])]);
ok(Number((await one(`select avail from api.cell where card_id = $1 and subject_id = $2`, [kl, it])).avail) === 800, '预算科目的可用 = 明细 − 对应学校科目的入账');
await as(U.fin, '2032-06-01');
eq(await val(`select map_school_subject($1, $2, null) v`, [kl, boxSub]), 2, '取消对应，支出改回学校科目下');
ok(Number((await one(`select actual from api.cell where card_id = $1 and subject_id = $2`, [kl, boxSub])).actual) === 700, '取消对应后执行回到学校科目');
await raises('录有金额的预算科目不能删', /请先更正为零/, `select delete_card_subject($1)`, [it]);
await as(U.dir, '2032-06-01');
await q("select set_budget($1, $2)", [kl, JSON.stringify([{ subject_id: it, amount: 0 }])]);
await as(U.fin, '2032-06-01');
await q(`select delete_card_subject($1)`, [it]);
eq((await q(`select 1 from api.cell where card_id = $1 and subject_id = $2`, [kl, it])).length, 0, '没有金额、支出和对应的预算科目可以删除');
await as(U.fin, '2032-06-01');
// ---------- 年度预算按档次：财务岗编总预算、直接确定金额的课题、档次，课题带明细申请档次，中心负责人评定 ----------
const fy = await val(`select save_fund_project(null, '档次测算项目', 'school', null, null, 500000, '2033-01-01', '2033-12-31', $1, 'recall') v`, [T.N]);
await q(`select open_budget_year(2033, '2032-11-30')`);
await raises('没测算总预算编不了档次', /超过总预算/, `select save_budget_tier(null, 2033, '一档', 100000, 1, 0.3, null)`);
await q(`select save_budget_source(2033, $1, 300000)`, [fy]);
await q(`select save_budget_module(null, 2033, $1, 60000)`, [P0]);
const t1 = await val(`select save_budget_tier(null, 2033, '一档', 100000, 1, 0.3, $1::text::jsonb) v`, [JSON.stringify([{ category_id: cE, ratio: 0.5 }])]);
const t2 = await val(`select save_budget_tier(null, 2033, '二档', 50000, 2, 0.3, null) v`);
await raises('直接确定金额的课题和档次合计不能超过总预算', /超过总预算，超出 60000/, `select save_budget_tier(null, 2033, '三档', 50000, 2, null, null)`);
const pl = await one(`select total, modules, tiers, published from api.budget_plan where year = 2033`);
ok(Number(pl.total) === 300000 && Number(pl.modules) === 60000 && Number(pl.tiers) === 200000 && pl.published === false, '总预算、直接确定的金额合计、档次合计', JSON.stringify(pl));
// 中心公共开支就是一个课题：方案里直接选课题、写金额
ok((await one(`select name, project_id from api.budget_module where year = 2033 and project_id = $1`, [P0])).name === '中心公共开支', '方案里直接给课题确定金额，名称就是课题的名称');
await raises('同一课题一个年度只确定一次金额', /已在本年度方案中确定了金额/, `select save_budget_module(null, 2033, $1, 100)`, [P0]);
await raises('要选课题', /请选择课题/, `select save_budget_module(null, 2033, null, 100)`);
const MT = await val(`select save_project(null, 'P-T0', '学术交流', 'project', $1, true) v`, [U.dir]);
await q(`select save_budget_module(null, 2033, $1, 20000)`, [MT]);
const TB = await val(`select save_project(null, 'P-T1', '档次课题甲', 'project', $1, true) v`, [U.lead]);
const TU = await val(`select save_project(null, '', '档次研究单元', null, $1, true, $2) v`, [U.mem, TB]);
await raises('财务岗不能批准方案', /需要权限/, `select publish_budget_plan(2033)`);
await as(U.lead, '2032-06-02');
eq((await q(`select * from api.budget_tier where year = 2033`)).length, 0, '方案批准前课题负责人看不到档次');
await raises('方案批准前不能申请档次', /方案尚未批准/, `select pick_tier(2033, $1, $2)`, [TB, t1]);
await as(U.dir, '2032-06-02');
await q(`select publish_budget_plan(2033)`);
await as(U.fin, '2032-06-02');
await raises('方案批准后不能再改', /方案已批准/, `select save_budget_module(null, 2033, $1, 10000)`, [TB]);
await raises('编了档次的年度不走旧的截止申报', /按档次评定/, `select advance_budget_year(2033, 'close')`);
const ML = await val(`select save_budget_line(null, 2033, $1, $2, '会议注册', 30000, 0, 0, 0) v`, [MT, cE]);
await raises('明细不能超过方案为课题确定的金额', /超过预算方案为本课题确定的金额 20000/, `select set_project_budget(2033, $1, 'submit')`, [MT]);
await q(`select save_budget_line($1, null, null, $2, '会议注册', 15000, 0, 0, 0)`, [ML, cE]);
await q(`select set_project_budget(2033, $1, 'submit')`, [MT]);
await raises('方案直接确定金额的课题不申请档次', /已由本年度预算方案直接确定/, `select pick_tier(2033, $1, $2)`, [MT, t2]);
await as(U.lead, '2032-06-03');
eq((await q(`select * from api.budget_tier where year = 2033`)).length, 2, '方案批准后课题负责人看得到档次');
eq((await q(`select * from api.budget_module`)).length, 0, '课题负责人看不到方案里直接确定金额的一栏');
const TL = await val(`select save_budget_line(null, 2033, $1, $2, '工作站', 60000, 0, 0, 0) v`, [TB, cE]);
await raises('没选档次不能提交预算', /请先为课题选择申请的档次/, `select set_project_budget(2033, $1, 'submit')`, [TB]);
await q(`select pick_tier(2033, $1, $2, '上年度执行良好')`, [TB, t1]);
await raises('类别比例超过档次限制提交不了', /类预算 60000(\.00)? 超过「一档」的上限 50000/, `select set_project_budget(2033, $1, 'submit')`, [TB]);
await q(`select save_budget_line($1, null, null, $2, '工作站', 40000, 0, 0, 0)`, [TL, cE]);
await q(`select set_project_budget(2033, $1, 'submit')`, [TB]);
await as(U.mem, '2032-06-03');
await raises('研究单元不单独申请档次', /档次按课题申请/, `select pick_tier(2033, $1, $2)`, [TU, t2]);
await raises('研究单元不设预算行', /研究单元不设预算行：研究单元使用所属课题的预算/, `select save_budget_line(null, 2033, $1, $2, '学生劳务', 40000, 0, 0, 0)`, [TU, cL]);
await as(U.lead, '2032-06-03');
await q(`select set_project_budget(2033, $1, 'withdraw')`, [TB]);
const TM = await val(`select save_budget_line(null, 2033, $1, $2, '学生劳务', 40000, 0, 0, 0) v`, [TB, cL]);
await raises('课题的劳务超过档次的劳务上限', /劳务类预算 40000(\.00)? 超过「一档」的上限 30000/, `select set_project_budget(2033, $1, 'submit')`, [TB]);
await q(`select save_budget_line($1, null, null, $2, '学生劳务', 30000, 0, 0, 0)`, [TM, cL]);
await q(`select set_project_budget(2033, $1, 'submit')`, [TB]);
// 立项申请：负责人直接提出新课题和研究单元，先记为待立项
await db.exec(`reset role`);
ok((await one(`select count(*)::int n from rbac_role_perm x join rbac_role r on r.id = x.role_id where r.code = 'member' and x.perm = 'card.own'`)).n === 1, '成员带有查看本人负责的经费卡这一项，负责人不再是单独的基础角色');
const plain = (await one(`insert into app_user (name, role, feishu_open_id) values ('普通成员', 'member', 'ou_plain_test') returning id`)).id;
await db.exec(`set role app_api`);
await as(plain, '2032-06-03');
const NPm = await val(`select propose_project(2033, '成员立项课题', $1, '研究内容：成员也可以申请立项') v`, [t2]);
ok(!!NPm, '任何成员都可以申请立项');
await q(`select withdraw_proposal(2033, $1)`, [NPm]);
await as(U.lead, '2032-06-03');
await raises('立项申请须写研究内容和理由', /请填写研究内容和申请理由/, `select propose_project(2033, '新立课题乙', $1, '')`, [t2]);
await raises('立项申请里不再一并列研究单元', /研究单元须在课题成立后单独申请/, `select propose_project(2033, '新立课题乙', $1, '研究内容：长任务评测', E'研究单元一\n研究单元二')`, [t2]);
const NP = await val(`select propose_project(2033, '新立课题乙', $1, '研究内容：长任务评测') v`, [t2]);
const np = await one(`select p.code, p.proposed, p.owner_id, (select count(*)::int from project q where q.parent_id = p.id and q.proposed) units from project p where p.id = $1`, [NP]).catch(() => null);
const npk = await one(`select kind, units, rejected from api.tier_pick where year = 2033 and project_id = $1`, [NP]);
ok(npk.kind === 'new' && npk.units === 0 && npk.rejected === false, '立项申请只登记课题，不带研究单元', JSON.stringify(npk));
ok((await one(`select proposed from api.project_tag where id = $1`, [NP])).proposed === true, '新课题先记为待立项');
const NP2 = await val(`select propose_project(2033, '新立课题丙', $1, '研究内容：另一方向') v`, [t2]);
await q(`select withdraw_proposal(2033, $1)`, [NP2]);
eq((await q(`select 1 from api.tier_pick where project_id = $1`, [NP2])).length, 0, '评定前可以撤回立项申请，课题一并删除');
const NL = await val(`select save_budget_line(null, 2033, $1, $2, '评测算力', 20000, 0, 0, 0) v`, [NP, cE]);
await q(`select set_project_budget(2033, $1, 'submit')`, [NP]);
ok((await one(`select kind from api.tier_pick where year = 2033 and project_id = $1`, [TB])).kind === 'renew', '已有课题申请档次记为延续');
await as(U.dir, '2032-06-04');
const pk = await one(`select total, drafts, violation, tier_id from api.tier_pick where year = 2033 and project_id = $1`, [TB]);
ok(Number(pk.total) === 70000 && pk.drafts === 0 && pk.violation === null && pk.tier_id === t1, '评定时看得到课题连同研究单元的明细合计', JSON.stringify(pk));
await raises('没评定完不能转入下达', /尚有 2 个课题未评定/, `select settle_tiers(2033)`);
await raises('明细超过所定档次的金额不能录入', /明细合计 70000(\.00)? 超过「二档」的金额 50000/, `select decide_tier(2033, $1, $2, null, '2032-06-04')`, [TB, t2]);
await raises('录入评定结果须填联席会议日期', /请填写联席会议日期/, `select decide_tier(2033, $1, $2, '同意')`, [TB, t1]);
await as(U.fin, '2032-06-04');
await raises('财务岗不能录入评定结果', /需要权限/, `select decide_tier(2033, $1, $2, '同意', '2032-06-04')`, [TB, t1]);
await as(U.dir, '2032-06-04');
await q(`select decide_tier(2033, $1, $2, '同意', '2032-06-04')`, [TB, t1]);
ok((await one(`select meeting_on::text d from api.tier_pick where year = 2033 and project_id = $1`, [TB])).d === '2032-06-04', '评定结果上记下联席会议日期');
eq((await one(`select decided from api.budget_tier where id = $1`, [t1])).decided, 1, '档次上记下已评定的名额');
await raises('尚有课题未评定不能转入下达', /尚有 1 个课题未评定/, `select settle_tiers(2033)`);
await raises('不予通过须写原因', /请填写不予通过的原因/, `select reject_tier(2033, $1, '', '2032-06-04')`, [NP]);
await q(`select reject_tier(2033, $1, '研究内容与现有课题重复', '2032-06-04')`, [NP]);
ok((await one(`select rejected from api.tier_pick where year = 2033 and project_id = $1`, [NP])).rejected === true, '评定结果可以是不予通过');
await as(U.lead, '2032-06-04');
await raises('评定后不能改申请的档次', /已评定，不得再改/, `select pick_tier(2033, $1, $2)`, [TB, t2]);
await as(U.dir, '2032-06-04');
await q(`select settle_tiers(2033)`);
const st = await one(`select stage, fixed_total from api.budget_year where year = 2033`);
ok(st.stage === 'fixed' && Number(st.fixed_total) === 300000, '评定完成后转入待下达，总预算记为年度总预算', JSON.stringify(st));
eq((await one(`select amount from api.project_cap where year = 2033 and project_id = $1`, [TB])).amount, 100000, '档次金额成为课题的年度上限');
eq((await one(`select fixed from api.budget_line where id = $1`, [TM])).fixed, 30000, '提交的明细成为核定的预算行');
await db.exec(`reset role`);
const npAfter = await one(`select active, proposed, (select fixed from project_budget_line where id = $2) fixed, (select count(*)::int from project_cap where year = 2033 and project_id = $1) cap from project where id = $1`, [NP, NL]);
await db.exec(`set role app_api`);
ok(npAfter.active === false && npAfter.fixed === null && npAfter.cap === 0, '立项未通过的课题不成立，预算不带入、没有上限', JSON.stringify(npAfter));
await as(U.dir, '2032-06-04');
await q(`select unsettle_tiers(2033)`);
ok((await one(`select stage from api.budget_year where year = 2033`)).stage === 'declare' && (await q(`select 1 from api.project_cap where year = 2033`)).length === 0, '撤回评定完成后回到评定阶段，上限一并撤销');
// 撤回后把立项申请改为定档，再评定完成：课题正式成立
await q(`select decide_tier(2033, $1, $2, '补充材料后同意', '2032-06-04')`, [NP, t2]);
await q(`select decide_tier(2033, $1, $2, '补充材料后同意', '2040-01-01')`, [NP, t2]);
ok((await one(`select meeting_on::text as d from api.tier_pick where year = 2033 and project_id = $1`, [NP])).d === '2040-01-01', '联席会议日期可以晚于今日');
await q(`select decide_tier(2033, $1, $2, '补充材料后同意', '2032-06-04')`, [NP, t2]);
ok((await one(`select (app_today() = (now() at time zone 'Asia/Shanghai')::date) as b from (select set_config('app.today', '', true)) s`)).b, '今日按北京时间算');
await q(`select settle_tiers(2033)`);
await db.exec(`reset role`);
{ const n = async (like) => Number((await one(`select count(*)::int as n from feishu_outbox where payload ->> 'text' like $1`, [like])).n);
  ok(await n('2033 年度预算方案已批准%') > 0, '方案批准通知全体成员');
  ok(await n('2033 年度%申请：%') > 0, '课题提交申请通知录入评定结果的人');
  ok(await n('%2033 年度评定为%') > 0 && await n('%2033 年度%申请不予通过%') > 0, '录入评定结果通知课题负责人');
  ok(await n('2033 年度评定完成：%') > 0 && await n('2033 年度评定完成，转入下达') > 0 && await n('%评定完成已撤回%') > 0, '评定完成和撤回通知课题负责人与财务岗'); }
const npOk = await one(`select active, proposed, (select fixed from project_budget_line where id = $2) fixed, (select amount from project_cap where year = 2033 and project_id = $1) cap,
  (select count(*)::int from project q where q.parent_id = $1 and not q.proposed) units from project where id = $1`, [NP, NL]);
await db.exec(`set role app_api`);
ok(npOk.active === true && npOk.proposed === false && Number(npOk.fixed) === 20000 && Number(npOk.cap) === 50000 && npOk.units === 0, '立项通过的课题正式成立，档次成为上限', JSON.stringify(npOk));
eq((await one(`select amount from api.project_cap where year = 2033 and project_id = $1`, [MT])).amount, 20000, '评定完成后方案确定的金额成为该课题的年度上限');
eq((await one(`select fixed from api.budget_line where id = $1`, [ML])).fixed, 15000, '该课题的明细一并核定');
await as(U.fin, '2032-06-05');
const autoId = await val(`select save_project(null, null, '编号自动生成的课题', 'public', null, true) v`);
const autoCode = (await one(`select code from api.project where id = $1`, [autoId])).code;
ok(/^P-\d{2,}$/.test(autoCode), '新立课题不填编号时自动生成', autoCode);
await raises('课题类型只有课题和中心公共开支两种', /类型仅限课题或中心公共开支/, `select save_project(null, null, '第三种类型', 'line', null, true)`);
// 研究单元立项：一律独立申请，挂在已立项的课题下面；先经联席会议通过，再在系统里申请，助理对照纪要核对后成立
await as(plain, '2032-06-09');
ok((await val(`select can_use_project($1) v`, [P0])) === false, '不在任何课题或研究单元名单里的人，不能从中心公共开支申请');
const pu = `select propose_unit($1, $2, $3, $4, $5, $6, $7) v`;
await raises('中心公共开支之下不设研究单元', /中心公共开支之下不设研究单元/, pu, [null, P0, '公共下面的单元', '2032-06-04', '2032-06-07', '说明', null]);
ok(!(await one(`select prosrc from pg_proc where proname = 'propose_unit'`)).prosrc.includes('不得晚于今日'), '研究单元申请的日期不限制在今日以前');
await raises('纪要不会早于会议', /纪要发出日期不得早于会议日期/, pu, [null, TB, '日期颠倒的单元', '2032-06-07', '2032-06-04', '说明', null]);
await raises('研究单元申请须写说明', /请填写说明/, pu, [null, TB, '没有说明的单元', '2032-06-04', '2032-06-07', ' ', null]);
const U1 = await val(pu, [null, TB, '成员申请的研究单元', '2032-06-04', '2032-06-07', '研究内容：长任务评测的一个子方向', U.mem2]);
let ua = await one(`select code, parent_id, proposed, mine, veto_until::text vu, member_names, return_note from api.unit_apply where id = $1`, [U1]);
ok(ua.parent_id === TB && ua.proposed === true && ua.mine === true && ua.vu === '2032-06-10' && ua.member_names === '成员乙' && /-02$/.test(ua.code), '研究单元申请登记为待立项，否决期按三个工作日计，编号自动顺延', JSON.stringify(ua));
ok((await val(`select can_use_project($1) v`, [TB])) === false, '成立之前不能使用课题的预算');
await as(U.mem, '2032-06-09');
await raises('他人不能改申请', /仅申请人可修改申请/, pu, [U1, TB, '改名', '2032-06-04', '2032-06-07', '说明', null]);
await raises('不是所挂课题的负责人不能同意', /仅所挂课题的负责人和副手可以同意/, `select approve_unit($1)`, [U1]);
await as(U.lead, '2032-06-09');
ok((await q(`select 1 from api.unit_apply where id = $1`, [U1])).length === 1, '所挂课题的负责人看得到这份申请');
// 卡片上直接办理：待同意的通知带着动作，发送端能按编号取回
{ await db.exec(`reset role`);
  const row = await one(`select id, user_id, payload from feishu_outbox where payload->>'text' like '研究单元申请待同意：%成员申请的研究单元%' order by id desc limit 1`);
  const plain = await one(`select id from feishu_outbox where not (payload ? 'act') and user_id is not null order by id desc limit 1`);
  await db.exec(`set role app_api`);
  ok(row && row.user_id === U.lead && row.payload.act?.kind === 'unit_consent' && row.payload.act.unit === U1, '待同意的通知带着要办的动作和研究单元', JSON.stringify(row?.payload));
  await raises('登录用户取不到通知的动作', /当前角色/, `select * from outbox_act($1)`, [row.id]);
  await as('', '2032-06-09');
  const got = await one(`select * from outbox_act($1)`, [row.id]);
  ok(got.user_id === U.lead && got.body.act.unit === U1 && /^o[un]_/.test(got.target_id), '发送端按编号取回这条通知发给谁、办什么', JSON.stringify(got));
  ok((await q(`select * from outbox_act($1)`, [plain.id])).length === 0, '不带动作的通知取不到');
  await as(U.lead, '2032-06-09'); }
await raises('课题负责人不核对，核对由助理按会议结果办', /需要权限/, `select confirm_unit($1)`, [U1]);
ua = await one(`select can_ok, parent_ok_at from api.unit_apply where id = $1`, [U1]);
ok(ua.can_ok === true && ua.parent_ok_at === null, '提交后先待所挂课题的负责人同意');
await q(`select approve_unit($1)`, [U1]);
ok((await one(`select parent_ok_by_name n from api.unit_apply where id = $1`, [U1])).n != null, '课题负责人同意后记下同意人');
await db.exec(`reset role`);
const asst = await id(`insert into app_user (name, role, feishu_open_id) values ('助理', 'member', 'ou_asst')`);
await db.exec(`set role app_api`);
await as(U.dir, '2032-06-10');
await q(`select grant_role($1, $2, null, null, null, null, null)`, [asst, RID.assistant]);
await as(asst, '2032-06-10');
await raises('否决期未满不能确认成立', /三个工作日的否决期至 2032-06-10 届满/, `select confirm_unit($1)`, [U1]);
await raises('退回须写原因', /请填写退回原因/, `select return_unit($1, ' ')`, [U1]);
await q(`select return_unit($1, '纪要里没有这一项')`, [U1]);
await as(U.dir, '2032-06-11');
await raises('已退回的须申请人修改后重新提交', /该申请已退回/, `select confirm_unit($1)`, [U1]);
await as(plain, '2032-06-11');
ok((await one(`select return_note from api.unit_apply where id = $1`, [U1])).return_note === '纪要里没有这一项', '申请人看得到退回原因');
await q(pu, [U1, TB, '成员申请的研究单元', '2032-06-08', '2032-06-09', '研究内容：长任务评测的一个子方向', U.mem2]);
ua = await one(`select return_note, veto_until::text vu from api.unit_apply where id = $1`, [U1]);
ok(ua.return_note === null && ua.vu === '2032-06-14', '修改后重新提交，否决期跨过周末', JSON.stringify(ua));
await as(U.dir, '2032-06-14');
await raises('重新提交后须课题负责人再次同意', /所挂课题的负责人尚未同意/, `select confirm_unit($1)`, [U1]);
await as(U.lead, '2032-06-12');
await q(`select approve_unit($1)`, [U1]);
await raises('同意过的不能重复同意', /已经同意过了/, `select approve_unit($1)`, [U1]);
await as(asst, '2032-06-14');
await raises('否决期最后一天仍不能确认', /否决期至 2032-06-14 届满/, `select confirm_unit($1)`, [U1]);
await as(asst, '2032-06-15');
await q(`select confirm_unit($1)`, [U1]);
await raises('已成立的不能再核对', /该研究单元不是待核对的申请/, `select confirm_unit($1)`, [U1]);
await as(plain, '2032-06-15');
const u1 = await one(`select mine, owner_id, parent_id, (select proposed from api.project_tag where id = $1) proposed from api.project where id = $1`, [U1]);
ok(u1.mine === true && u1.owner_id === plain && u1.proposed === false, '核对确认后研究单元成立，申请人即为负责人', JSON.stringify(u1));
ok((await val(`select can_use_project($1) v`, [TB])) === true && (await val(`select can_use_project($1) v`, [P0])) === true, '成立后可使用所挂课题的预算，也可从中心公共开支申请');
await raises('成立后不能撤回', /该研究单元不是待核对的申请/, `select withdraw_unit($1)`, [U1]);
const U2 = await val(pu, [null, TB, '要撤回的研究单元', '2032-06-08', '2032-06-09', '说明', null]);
await as(U.mem2, '2032-06-15');
ok((await one(`select member from api.project where id = $1`, [U1])).member === true, '申请里列的成员随成立进入名单');
await raises('他人不能撤回申请', /仅申请人和财务岗可撤回申请/, `select withdraw_unit($1)`, [U2]);
await as(plain, '2032-06-15');
await q(`select withdraw_unit($1)`, [U2]);
// 中心负责人本人确认即表示不否决，不必等否决期届满；课题负责人同意这一条照旧
const U3 = await val(pu, [null, TB, '负责人当天确认的研究单元', '2032-06-15', '2032-06-15', '说明', null]);
await as(U.dir, '2032-06-15');
await raises('中心负责人确认也须课题负责人先同意', /所挂课题的负责人尚未同意/, `select confirm_unit($1)`, [U3]);
await as(U.lead, '2032-06-15');
await q(`select approve_unit($1)`, [U3]);
await as(asst, '2032-06-15');
await raises('助理仍须等否决期届满', /三个工作日的否决期至 2032-06-18 届满/, `select confirm_unit($1)`, [U3]);
await as(U.dir, '2032-06-15');
await q(`select confirm_unit($1)`, [U3]);
ok((await one(`select proposed, checked_by_name n from api.unit_apply where id = $1`, [U3])).proposed === false, '中心负责人在否决期内确认，研究单元即成立');
await db.exec(`reset role`);
const nb = (await one(`select payload from feishu_outbox where payload->>'text' like '研究单元「负责人当天确认的研究单元」已成立%' order by id desc limit 1`)).payload;
ok(nb.by === '负责人' && /^\d\d-\d\d \d\d:\d\d$/.test(nb.at), '通知记下经办人和时间，供卡片落款', JSON.stringify(nb));
await db.exec(`set role app_api`);
await as(plain, '2032-06-15');
ok((await q(`select 1 from api.unit_apply where id = $1`, [U2])).length === 0, '成立之前申请人可以撤回');
await as(U.fin, '2032-06-22');
ok((await q(`select text from api.outbox where user_id = $1`, [U.lead])).some(o => /之下新成立研究单元「成员申请的研究单元」/.test(o.text)), '成立后通知所挂课题的负责人');
// 代币：名义币改为回应质疑记入，原来按身份发、登记时间的办法停止；成果按四级登记、助理核对
await as(plain, '2032-06-23');
await raises('不再登记时间', /不再登记时间/, `select save_time_log(token_period('2032-06-23'), $1::jsonb)`, [JSON.stringify([{ project_id: U1, percent: 60 }])]);
await as(U.fin, '2032-06-23');
await q(`select set_user_kind($1, 'phd')`, [plain]); await q(`select set_user_kind($1, 'master')`, [U.mem2]);
await as(plain, '2032-06-23');
const tm = await one(`select kind, nominal, period_start::text ps, period_end::text pe from api.token_me`);
ok(tm.kind === 'phd' && Number(tm.nominal) === 80 && tm.ps === '2032-06-14' && tm.pe === '2032-06-27', '按身份得到本期的名义币，两周一期', JSON.stringify(tm));
const tp = await one(`select token_period('2026-11-23')::text a, token_period('2026-12-06')::text b, token_period('2026-12-07')::text c`);
ok(tp.a === '2026-11-23' && tp.b === '2026-11-23' && tp.c === '2026-12-07', '第一期自 2026-11-23 起，至 12-06', JSON.stringify(tp));
await as(U.mem, '2032-06-23');
eq((await q(`select * from api.unit_pool where project_id = $1`, [U1])).length, 1, '池子的合计所有人都看得到');
// 成果
await as(U.mem2, '2032-06-23');
await raises('成员不能提交成果', /仅研究单元负责人和副手可提交成果/, `select submit_outcome($1, 1, 'https://arxiv.org/abs/3206.01234')`, [U1]);
await as(plain, '2032-06-23');
await raises('一级须为公开发布的链接', /请填写 arXiv 或公开投稿页的链接/, `select submit_outcome($1, 1, 'https://example.com/paper.pdf')`, [U1]);
await raises('须先有一级', /须先提交一级成果/, `select submit_outcome($1, 2, 'https://example.com/project')`, [U1]);
const O1 = await val(`select submit_outcome($1, 1, 'https://arxiv.org/abs/3206.01234') v`, [U1]);
await raises('提交人不能自己核对', /需要权限/, `select check_outcome($1, true)`, [O1]);
await as(U.dir, '2032-06-23');
await raises('退回须写原因', /请写明原因/, `select check_outcome($1, false, ' ')`, [O1]);
await q(`select check_outcome($1, false, '链接打不开')`, [O1]);
await as(plain, '2032-06-23');
ok((await one(`select status, check_note from api.outcome where id = $1`, [O1])).status === 'rejected', '被退回的看得到原因');
await q(`select submit_outcome($1, 1, 'https://arxiv.org/abs/3206.01235')`, [U1]);
await as(U.dir, '2032-06-23');
await q(`select check_outcome($1, true)`, [O1]);
await raises('核对过的不能再核对', /该成果已核对过/, `select check_outcome($1, true)`, [O1]);
ok((await one(`select level from api.unit_pool where project_id = $1`, [U1])).level === 1, '核对通过后研究单元达到一级');
await as(plain, '2032-06-23');
await raises('核对通过的不得修改', /已核对通过，不得修改/, `select submit_outcome($1, 1, 'https://arxiv.org/abs/3206.09999')`, [U1]);
await q(`select submit_outcome($1, 4, 'https://example.org/accepted', 'ACL')`, [U1]);
// 参数与档次
await raises('成员不能改参数', /需要权限/, `select set_token_param('nominal', '{"phd": 90}'::jsonb)`);
await as(U.dir, '2032-06-23');
await raises('名义币的数要合理', /0 到 1000 之间/, `select set_token_param('nominal', '{"phd": 5000}'::jsonb)`);
await q(`select set_token_param('nominal', '{"postdoc": 80, "phd": 90, "ra": 80, "master": 50, "ri": 40, "visitor": 0}'::jsonb)`);
await q(`select set_pool_cap($1, 100)`, [U1]);
await as(U.fin, '2032-06-23');
await q(`select set_tier_token($1, 12000)`, [t1]);
eq((await one(`select token_amount from api.tier_token where tier_id = $1`, [t1])).token_amount, 12000, '档次上记每个课题的实际币');
await as(plain, '2032-06-23');
ok(Number((await one(`select nominal from api.token_me`)).nominal) === 90 && Number((await one(`select pool_cap from api.unit_pool where project_id = $1`, [U1])).pool_cap) === 100, '参数和池子上限改了之后成员看得到');
await as(U.dir, '2032-06-23');
eq((await q(`select * from api.token_param`)).length, 10, '代币参数都设在系统里');
await raises('各级系数要齐', /参数不完整/, `select set_token_param('levels', '{"r1": 1}'::jsonb)`);
await raises('评定的比例不能太低', /30% 到 100% 之间/, `select set_token_param('split', '{"eval": 0.1}'::jsonb)`);
await q(`select set_token_param('split', '{"eval": 0.85}'::jsonb)`);
await q(`select set_token_param('levels', '{"r1": 1, "t1": 0.2, "l2": 0.3, "l3": 1, "l4": 3}'::jsonb)`);
await q(`select set_token_param('resubmit', '{"lower": 0.4, "decay": 0.8, "rounds": 3, "extra": 0.3}'::jsonb)`);
ok(Number((await one(`select value from api.token_param where key = 'split'`)).value.eval) === 0.85, '中心负责人可以改参数');
await as(plain, '2032-07-27');
await raises('不再确认时间登记', /不再登记时间/, `select confirm_time_logs($1, $2)`, [U1, '2032-06-14']);
// 旧入口直接建的卡自动补上经费项目
await db.exec(`reset role`);
const legacyCard = await one(`select c.year, p.name from fund_card c join fund_project p on p.id = c.project_id where c.card_no = '4131-A'`);
ok(legacyCard.year === 2026 && legacyCard.name === '人才启动经费', '不经经费项目建的卡自动补一个同名项目，年度取下达日所在年', JSON.stringify(legacyCard));
ok((await one(`select count(*) v from audit_log where table_name = 'fund_project'`).catch(() => ({ v: 1 }))).v > 0, '经费项目的改动留审计记录');

// 访问令牌：只存哈希；凭哈希换身份；默认只读；停用和过期后失效；写操作留记录
{
  const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
  const other2 = (await one(`insert into app_user (name, role, feishu_open_id) values ('另一位成员', 'member', 'ou_plain_test2') returning id`)).id;
  await as(plain, '2032-07-27');
  const tk1 = (await one(`select create_api_token('我的智能体', $1, 'abcd', false, 30) v`, [H1])).v;
  await raises('令牌有效期有上限', /1 到 365 天/, `select create_api_token('x', $1, 'abcd', false, 400)`, [H2]);
  await raises('令牌要写用途', /用途/, `select create_api_token(' ', $1, 'abcd', false, 30)`, [H2]);
  const mineTok = await q(`select * from api.api_token`);
  ok(mineTok.length === 1 && mineTok[0].mine && mineTok[0].live && !('hash' in mineTok[0]), '本人看得到自己的令牌，视图不带哈希');
  await as(null);
  const who = await one(`select * from api_token_login($1)`, [H1]);
  ok(who && who.user_id === plain && who.can_write === false, '凭哈希换到持有人身份，默认只读');
  eq((await q(`select * from api_token_login($1)`, [H2])).length, 0, '不存在的令牌换不到身份');
  eq((await q(`select * from api.api_token`)).length, 0, '未登录看不到令牌');
  await as(other2, '2032-07-27');
  eq((await q(`select * from api.api_token`)).length, 0, '别人看不到我的令牌');
  await raises('不能停用别人的令牌', /只能停用本人的令牌/, `select revoke_api_token($1)`, [tk1]);
  await raises('不能替别人的令牌记调用', /令牌与身份不符/, `select log_api_call($1, 'x', true, null)`, [tk1]);
  await as(plain, '2032-07-27');
  await q(`select log_api_call($1, 'save_time_log', false, '登记的期次有误')`, [tk1]);
  const calls = await q(`select * from api.api_call`);
  ok(calls.length === 1 && calls[0].ok === false && calls[0].token_name === '我的智能体', '经令牌做的写操作留一条记录');
  for (let i = 0; i < 4; i++) await q(`select create_api_token('第 ${i} 个', $1, 'abcd', true, 7)`, [String(i).repeat(64)]);
  await raises('每人最多五个有效令牌', /最多同时持有 5 个/, `select create_api_token('多了', $1, 'abcd', false, 7)`, ['c'.repeat(64)]);
  await as(null);
  ok((await one(`select * from api_token_login($1)`, ['1'.repeat(64)])).can_write === true, '可写的令牌换到可写');
  await as(plain, '2032-07-27');
  await q(`select revoke_api_token($1)`, [tk1]);
  await as(null);
  eq((await q(`select * from api_token_login($1)`, [H1])).length, 0, '停用后换不到身份');
  await db.query(`update api_token set expires_at = now() - interval '1 day' where hash = $1`, ['1'.repeat(64)]);
  eq((await q(`select * from api_token_login($1)`, ['1'.repeat(64)])).length, 0, '过期后换不到身份');
  await db.query(`update app_user set active = false where id = $1`, [plain]);
  eq((await q(`select * from api_token_login($1)`, ['2'.repeat(64)])).length, 0, '持有人停用后换不到身份');
  await db.query(`update app_user set active = true where id = $1`, [plain]);
}

// 双周表：每个研究单元每两周登记一次，负责人和成员都可以登记；上一期结束后三日内可以补登；所有登录的人看得到登记和未登记情况
{ const BW = `select save_biweekly_report($1, $2, $3, $4, $5, $6, $7, $8, $9) v`;
  const F = { stage: 'abstract', question: '长任务评测能否区分规划错误与执行错误', done: '两组基线跑完，规划错误占六成', changed: '原以为瓶颈在执行，实际在规划', issues: null, division: '普通成员：基线；成员乙：错误分析', next: '补第三组基线，预期写出摘要' };
  const bw = (u, ps, x = {}) => { const f = { ...F, ...x }; return db.query(BW, [u, ps, f.stage, f.question, f.done, f.changed, f.issues, f.division, f.next]).then((r) => r.rows[0].v); };
  const st = async () => one(`select filled, prev_filled, prev_open, last_period::text lp, last_stage, missed, can_fill, period_start::text ps from api.biweekly_status where project_id = $1`, [U1]);
  await db.exec(`reset role`); await q(`update project set checked_at = '2032-06-22 10:00+08' where id = $1`, [U1]); await db.exec(`set role app_api`);
  await as(plain, '2032-06-23');
  await raises('期次须为两周一期的起始日', /登记的期次有误/, BW, [U1, '2032-06-15', 'idea', 'a', 'b', 'c', null, 'd', 'e']);
  await raises('更早的期次不能登记', /仅可登记本期/, BW, [U1, '2032-05-31', 'idea', 'a', 'b', 'c', null, 'd', 'e']);
  await raises('课题本身不登记双周表', /双周表按研究单元登记/, BW, [TB, '2032-06-14', 'idea', 'a', 'b', 'c', null, 'd', 'e']);
    await raises('写作进度只有六档', /写作进度仅限想法、摘要、首图、核心结果表、完整初稿、投稿稿/, BW, [U1, '2032-06-14', 'poster', 'a', 'b', 'c', null, 'd', 'e']);
  await raises('须写本轮回答的问题', /请填写本轮回答的问题/, BW, [U1, '2032-06-14', 'idea', ' ', 'b', 'c', null, 'd', 'e']);
  await raises('须写本轮改变的判断', /请填写本轮改变的判断/, BW, [U1, '2032-06-14', 'idea', 'a', 'b', '', null, 'd', 'e']);
    await raises('须写下一轮安排', /请填写下一轮安排与预期/, BW, [U1, '2032-06-14', 'idea', 'a', 'b', 'c', null, 'd', ' ']);
  await raises('问题不能太长', /不得超过 300 个字/, BW, [U1, '2032-06-14', 'idea', 'x'.repeat(301), 'b', 'c', null, 'd', 'e']);
  let s = await st();
  ok(s.filled === false && s.missed === 0 && s.prev_open === false && s.can_fill === true && s.ps === '2032-06-14', '成立所在的一期起须登记，此前的期次不算未登记', JSON.stringify(s));
  await as(U.mem, '2032-06-23');
  await raises('不在研究单元名单里的不能登记', /仅研究单元负责人和成员可登记双周表/, BW, [U1, '2032-06-14', 'idea', 'a', 'b', 'c', null, 'd', 'e']);
  // 待成立的研究单元直接写入，不经申请流程，免得随立项方式的改动而改动
  await db.exec(`reset role`);
  const U3 = await id(`insert into project (code, name, kind, owner_id, active, layer, parent_id, proposed, applied_at)
    select 'BW-PENDING', '待成立的研究单元', kind, $1, true, 'paper', id, true, now() from project where id = $2`, [U.mem, TB]);
  await db.exec(`set role app_api`);
  await raises('研究单元须已成立', /尚未成立或已停用/, BW, [U3, '2032-06-14', 'idea', 'a', 'b', 'c', null, 'd', 'e']);
  await db.exec(`reset role`);
  await q(`delete from project where id = $1`, [U3]);
  await db.exec(`set role app_api`);
  await as(U.mem2, '2032-06-23');
  const R1 = await bw(U1, '2032-06-14');
  await as(plain, '2032-06-23');
  ok(await bw(U1, '2032-06-14', { stage: 'first_figure', issues: '第三组数据还没拿到' }) === R1, '同一研究单元同一期只有一份，负责人修改的是成员登记的那份');
  const r = await one(`select stage, issues, submitted_by_name, updated_by_name, unit_name, topic_id, leader_name from api.biweekly_report where project_id = $1`, [U1]);
  ok(r.stage === 'first_figure' && r.issues === '第三组数据还没拿到' && r.submitted_by_name === '成员乙' && r.updated_by_name === '普通成员' && r.topic_id === TB && r.leader_name === '普通成员', '修改后记下登记人和修改人', JSON.stringify(r));
  s = await st();
  ok(s.filled === true && s.last_stage === 'first_figure' && s.missed === 0, '本期已登记', JSON.stringify(s));
  await as(plain, '2032-06-30');
  s = await st();
  ok(s.filled === false && s.prev_filled === true && s.prev_open === false && s.missed === 0, '进入下一期，上一期已登记的不算未登记', JSON.stringify(s));
  await raises('上一期不能再补登或修改', /仅可登记本期/, BW, [U1, '2032-06-14', 'results_table', 'a', 'b', 'c', null, 'd', 'e']);
  await as(plain, '2032-07-14');
  s = await st();
  ok(s.missed === 1 && s.prev_filled === false && s.prev_open === false, '上一期没登记即未登记一期，不能补登', JSON.stringify(s));
  await as(plain, '2032-07-15');
  await raises('不能再登记上一期', /仅可登记本期/, BW, [U1, '2032-06-28', 'idea', 'a', 'b', 'c', null, 'd', 'e']);
  await bw(U1, '2032-07-12', { stage: 'full_draft' });
  s = await st();
  ok(s.filled === true && s.missed === 1 && s.lp === '2032-07-12', '本期登记了，漏掉的上一期仍计入', JSON.stringify(s));
  await as(plain, '2032-08-24');
  s = await st();
  ok(s.filled === false && s.missed === 2 && s.lp === '2032-07-12' && s.last_stage === 'full_draft', '从上一期往前数连续未登记的期数', JSON.stringify(s));
  await as(U.mem, '2032-08-24');
  const seen = await q(`select period_start::text ps, question from api.biweekly_report where project_id = $1 order by period_start`, [U1]);
  ok(seen.length === 2 && seen[0].ps === '2032-06-14' && seen[0].question === F.question, '不在名单里的成员也看得到各研究单元的双周表', JSON.stringify(seen));
  s = await st();
  ok(s.can_fill === false && s.missed === 2, '不在名单里的成员看得到登记情况，但不能登记', JSON.stringify(s));
  eq((await q(`select 1 from api.biweekly_status where project_id = $1`, [U3])).length, 0, '未成立的研究单元不列入');
  await as(null);
  eq((await q(`select 1 from api.biweekly_report`)).length + (await q(`select 1 from api.biweekly_status`)).length, 0, '未登录看不到双周表');
  await as(null);
}
}

// 中台征名：不预放候选，名字由成员提；每人一票，可改投；截止后不能再提、再投；不给出谁提的谁投的
{ // 截止时间是写死的日期，测试里先拨到将来，不依赖运行测试的那一天
  await db.exec(`reset role`); await db.query(`update name_poll set closes_at = now() + interval '1 day'`); await db.exec(`set role app_api`);
  await as(U.mem2);
  eq((await q(`select 1 from api.name_option`)).length, 0, '征名开始时没有候选');
  ok((await one(`select open from api.name_poll`)).open === true, '没有候选时也看得到征名进行中');
  await raises('提名须写出处', /请填写出处或寓意/, `select propose_name('云中君', ' ')`);
  const nid = (await one(`select propose_name('云中君', '《九歌》篇名') as v`)).v;
  await raises('重名的不能再提', /已有「云中君」/, `select propose_name('云中君', '重复')`);
  const n2 = (await one(`select propose_name('湘君', '《九歌》篇名') as v`)).v; await q(`select propose_name('山鬼', '《九歌》篇名')`);
  await raises('每人最多提三个', /每人最多提 3 个名字/, `select propose_name('国殇', '《九歌》篇名')`);
  await q(`select vote_name($1)`, [n2]); await q(`select vote_name($1)`, [nid]);
  const v = await q(`select id, votes, mine from api.name_option`);
  ok(v.find((x) => x.id === n2).votes === 0 && v.find((x) => x.id === nid).votes === 1 && v.find((x) => x.id === nid).mine === true, '每人一票，改投后原来那票撤掉');
  await q(`select vote_name(null)`);
  await as(U.mem); await q(`select vote_name($1)`, [nid]);
  ok((await one(`select votes, mine from api.name_option where id = $1`, [nid])).votes === 1, '新提的名字可以投票');
  ok(!Object.keys(await one(`select * from api.name_option limit 1`)).some((k) => /by|user/.test(k)), '视图不给出提名人和投票人');
  await db.exec(`reset role`); await db.query(`update name_poll set closes_at = now() - interval '1 minute'`); await db.exec(`set role app_api`);
  await raises('截止后不能投票', /征名已截止/, `select vote_name($1)`, [nid]);
  await raises('截止后不能提名', /征名已截止/, `select propose_name('东君', '《九歌》篇名')`);
}

// 谷歌学术主页：本人填写，只认个人主页链接；课题负责人和成员名单随姓名给出链接，可以清除
{ await db.exec(`reset role`);
  const t0 = await one(`select id, owner_id from project where layer = 'big' and kind = 'project' and active and not proposed and owner_id is not null order by code limit 1`);
  await db.query(`insert into project_member (project_id, user_id, joined_on) select $1, $2, '2026-01-01' where not exists (select 1 from project_member where project_id = $1 and user_id = $2 and left_on is null)`, [t0.id, U.mem2]);
  await db.exec(`set role app_api`);
  await as(U.mem2);
  await raises('须是谷歌学术的链接', /请填写谷歌学术个人主页的链接/, `select set_scholar_url('https://example.com/me')`);
  await raises('须是个人主页', /请填写谷歌学术个人主页的链接/, `select set_scholar_url('https://scholar.google.com/citations?hl=zh-CN')`);
  await q(`select set_scholar_url(' https://scholar.google.com/citations?hl=zh-CN&user=AbC_12-x ')`);
  const url = 'https://scholar.google.com/citations?hl=zh-CN&user=AbC_12-x';
  ok((await one(`select scholar_url from api.me`)).scholar_url === url, '本人填写后回显，去掉首尾空格');
  await as(t0.owner_id);
  await q(`select set_scholar_url('https://scholar.google.com.hk/citations?user=Own3r')`);
  await as(U.mem);
  ok((await one(`select scholar_url from api.project_member where project_id = $1 and user_id = $2 and left_on is null`, [t0.id, U.mem2])).scholar_url === url, '成员名单里随姓名给出链接');
  const tp = await one(`select owner_scholar_url, members, can_roster from api.project where id = $1`, [t0.id]);
  ok(tp.owner_scholar_url === 'https://scholar.google.com.hk/citations?user=Own3r' && tp.members >= 1 && tp.can_roster != null, '课题列表给出负责人的链接，原有字段不变', JSON.stringify(tp));
  await as(U.mem2); await q(`select set_scholar_url(' ')`);
  ok((await one(`select scholar_url from api.me`)).scholar_url === null, '留空即清除');
}

// 人员档案：档案独立于账号；账号的身份和启停跟着档案走；没有档案的新面孔登录后待人事确认
{ const D = '2026-11-23';
  const save = `select save_person_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as v`;
  const rec = (id, name, kind, status, no = null) => [id, no, name, kind, status, null, null, null, null, null, null, null];
  const acct = async (uid) => { await db.exec(`reset role`); const r = await one(`select active, kind from app_user where id = $1`, [uid]); await db.exec(`set role app_api`); return r; };
  await as(U.fin, D);
  const p1 = await val(save, [null, null, '档案甲', 'ra', 'active', '2026-09-01', null, '硕士', '某大学', '金融', null, null]);
  const r1 = await one(`select * from api.person where id = $1`, [p1]);
  ok(/^RA-\d{3}$/.test(r1.no) && r1.status === 'active' && r1.user_id === null && r1.has_feishu === false && r1.school === '某大学', '新建档案按类别顺延编号，可以先没有账号');
  await raises('档案不能重名', /同名请加备注区分/, save, rec(null, '档案甲', 'ri', 'active'));
  await raises('类别只能是规定的几种', /类别仅限/, save, rec(null, '档案乙', 'boss', 'active'));
  await raises('待确认不能手工设置', /状态仅限在岗、非编或已离开/, save, rec(null, '档案乙', 'ri', 'pending'));
  await raises('编号不能重复', /已被占用/, save, rec(null, '档案乙', 'ri', 'active', r1.no));
  await as(U.mem, D);
  await raises('成员不能维护档案', /需要权限/, save, rec(null, '档案丙', 'ri', 'active'));
  eq((await q(`select 1 from api.person`)).length, 0, '成员看不到人员档案');
  await as(U.fin, D);
  await q(`select link_person($1, $2)`, [p1, U.mem]);
  ok((await acct(U.mem)).kind === 'ra', '账号对到档案后，身份随档案');
  await raises('一条档案只能对应一个账号', /该档案已对应账号/, `select link_person($1, $2)`, [p1, U.mem2]);
  await q(save, rec(p1, '档案甲', 'master', 'active', r1.no));
  ok((await acct(U.mem)).kind === 'master', '改档案的类别，账号的身份跟着变');
  await q(`select set_user_kind($1, 'phd')`, [U.mem]);
  ok((await one(`select kind from api.person where id = $1`, [p1])).kind === 'phd' && (await acct(U.mem)).kind === 'phd', '在权限管理里登记身份，改的是档案');
  await q(save, rec(p1, '档案甲', 'phd', 'left', r1.no));
  const gone = await one(`select status, left_on, account_active from api.person where id = $1`, [p1]);
  ok(gone.status === 'left' && gone.account_active === false && !!gone.left_on && (await acct(U.mem)).active === false, '档案登记为已离开，账号随即停用，离开日期默认当天');
  await as(U.mem, D);
  eq((await q(`select 1 from api.me`)).length, 0, '已离开的人进不来');
  await as(U.fin, D);
  await q(save, rec(p1, '档案甲', 'phd', 'active', r1.no));
  ok((await acct(U.mem)).active === true && (await one(`select left_on from api.person where id = $1`, [p1])).left_on === null, '改回在岗，账号恢复启用');
  const pf = await val(save, rec(null, '财务岗本人', null, 'active'));
  await q(`select link_person($1, $2)`, [pf, U.fin]);
  await raises('不能把自己登记为已离开', /不得将本人登记为已离开/, save, rec(pf, '财务岗本人', null, 'left'));
  // 预先登记了飞书身份的，首次登录直接认领档案
  const pp = await val(save, rec(null, '预登记', 'ri', 'active'));
  await db.exec(`reset role`); await db.query(`update person set feishu_union_id = 'on_pre' where id = $1`, [pp]); await db.exec(`set role app_api`);
  await as(null, D);
  const lg = await one(`select id, active, kind from login_feishu('ou_pre', '预登记的飞书名', null, 'on_pre')`);
  ok(lg.active === true && lg.kind === 'ri', '预先登记飞书身份的，首次登录即认领档案，账号可用');
  // 没有档案的新面孔
  const before = (await (async () => { await db.exec(`reset role`); const r = await one(`select count(*)::int n from feishu_outbox`); await db.exec(`set role app_api`); return r; })()).n;
  const nw = await one(`select id, active from login_feishu('ou_stranger', '陌生人', null, 'on_str')`);
  ok(nw.active === false, '没有档案的新面孔登录，账号不启用');
  await as(nw.id, D);
  eq((await q(`select 1 from api.me`)).length, 0, '待确认的人看不到任何数据');
  eq((await q(`select 1 from api.project`)).length, 0, '待确认的人看不到课题');
  await as(U.fin, D);
  const pend = await one(`select id, status, name, account_active from api.person where user_id = $1`, [nw.id]);
  ok(pend.status === 'pending' && pend.name === '陌生人' && pend.account_active === false, '同时建一条待人事确认的档案');
  await db.exec(`reset role`); const after = (await one(`select count(*)::int n from feishu_outbox`)).n; await db.exec(`set role app_api`);
  ok(after > before, '并通知有人员权限的人');
  await as(null, D);
  ok((await one(`select id from login_feishu('ou_stranger', '陌生人', null, 'on_str')`)).id === nw.id, '待确认期间再次登录仍是同一个账号');
  await as(U.fin, D);
  eq((await q(`select 1 from api.person where name = '陌生人'`)).length, 1, '不会重复建档');
  await q(save, rec(pend.id, '陌生人', 'ri', 'active'));
  ok((await acct(nw.id)).active === true && (await acct(nw.id)).kind === 'ri', '人事确认在岗后账号启用');
  // 并入已有档案
  const po = await val(save, rec(null, '老成员', 'phd', 'active'));
  await as(null, D);
  const n2 = await one(`select id, active from login_feishu('ou_s2', '老成员的飞书名', null, 'on_s2')`);
  await as(U.fin, D);
  await raises('待确认的档案不能作为并入目标', /该档案已对应账号|待确认的档案不能作为并入的目标/, `select link_person((select id from api.person where user_id = $1), $2)`, [n2.id, U.mem2]);
  await q(`select link_person($1, $2)`, [po, n2.id]);
  const merged = await one(`select user_id, has_feishu, account_active from api.person where id = $1`, [po]);
  ok(merged.user_id === n2.id && merged.has_feishu === true && merged.account_active === true && (await acct(n2.id)).kind === 'phd', '待确认的账号并入已有档案后启用，身份随档案');
  eq((await q(`select 1 from api.person where name = '老成员的飞书名'`)).length, 0, '原来那条待确认的档案并掉');
  // 档案已离开的，预先登记了飞书身份也进不来
  const pl = await val(save, rec(null, '已走的人', 'ri', 'left'));
  await db.exec(`reset role`); await db.query(`update person set feishu_union_id = 'on_left' where id = $1`, [pl]); await db.exec(`set role app_api`);
  await as(null, D);
  ok((await one(`select active from login_feishu('ou_left', '已走的人', null, 'on_left')`)).active === false, '档案已离开的人登录，账号不启用');
  // 合并账号：被并掉的一方只有待确认档案的，档案一并删掉
  const m1 = await one(`select id from login_feishu('ou_m1', '重复账号', null, 'on_m1')`);
  await as(U.dir, D);
  await q(`select merge_user($1, $2)`, [m1.id, U.mem2]);
  eq((await q(`select 1 from api.person where name = '重复账号'`)).length, 0, '合并账号时并掉待确认的档案');
  // 首次登录按姓名自动对上原有账号或档案
  await db.exec(`reset role`);
  const oldA = (await one(`insert into app_user (feishu_open_id, name, active) values ('ou_old_a', '旧账号甲', true) returning id`)).id;
  await db.query(`insert into app_user (feishu_open_id, name, active) values ('ou_old_b1', '同名乙', true), ('ou_old_b2', '同名乙', true)`);
  const oldC = (await one(`insert into app_user (feishu_open_id, name, active, role) values ('ou_old_c', '旧账号丙', true, 'finance') returning id`)).id;
  const nq0 = (await one(`select count(*)::int n from feishu_outbox where payload->>'text' like '人员档案自动对应：%'`)).n;
  await db.exec(`set role app_api`); await as(null, D);
  const ca = await one(`select id, active, feishu_union_id u from login_feishu('ou_new_a', '旧账号甲', null, 'on_new_a')`);
  ok(ca.id === oldA && ca.active === true && ca.u === 'on_new_a', '旧账号没有记 union_id 的，首次登录按姓名对到原账号，不另建', JSON.stringify(ca));
  ok((await one(`select id from login_feishu('ou_new_a', '旧账号甲', null, 'on_new_a')`)).id === oldA, '对上之后再登录仍是原账号');
  const cb = await one(`select id, active from login_feishu('ou_new_b', '同名乙', null, 'on_new_b')`);
  ok(cb.active === false, '同名账号不止一个的不自动对，仍待人事确认');
  const cc = await one(`select id, active from login_feishu('ou_new_c', '旧账号丙', null, 'on_new_c')`);
  ok(cc.id !== oldC && cc.active === false, '有成员以外角色的账号不按姓名自动对');
  await as(U.fin, D);
  const pd = await val(save, rec(null, '只有档案丁', 'ri', 'active'));
  await as(null, D);
  const cd = await one(`select id, active, kind from login_feishu('ou_new_d', '只有档案丁', null, 'on_new_d')`);
  await as(U.fin, D);
  const pdn = await one(`select user_id, has_feishu from api.person where id = $1`, [pd]);
  ok(cd.active === true && cd.kind === 'ri' && pdn.user_id === cd.id && pdn.has_feishu === true, '只有档案没有账号的，首次登录按姓名对到档案，账号启用', JSON.stringify([cd, pdn]));
  eq((await q(`select 1 from api.person where name in ('旧账号甲', '只有档案丁') and status = 'pending'`)).length, 0, '自动对上的不留待确认档案');
  await db.exec(`reset role`);
  eq((await one(`select count(*)::int n from feishu_outbox where payload->>'text' like '人员档案自动对应：%'`)).n - nq0 > 0 ? 1 : 0, 1, '自动对上的通知人事核对');
  await db.exec(`set role app_api`);
}

// ---------- 通知发到全员群：研究单元成立公告、双周表三次汇总 ----------
{
  await db.exec(`reset role`);
  const g = await one(`select payload, user_id from feishu_outbox where target = 'group' and payload->>'text' like '研究单元成立：研究单元「负责人当天确认的研究单元」已成立，挂在课题「%' order by id desc limit 1`);
  ok(g && g.user_id === null && g.payload.by === '负责人' && /负责人 \S+$/.test(g.payload.text), '研究单元成立时在群里公布，写明所挂课题和负责人', JSON.stringify(g));
  const cur = (await one(`select token_period(date '2033-03-01')::text c`)).c;
  const day = async (n) => (await one(`select ($1::date + $2::int)::text d`, [cur, n])).d;
  const last = async () => (await one(`select payload->>'text' t from feishu_outbox where target = 'group' order by id desc limit 1`)).t;
  const cnt = async () => (await one(`select count(*)::int n from feishu_outbox where target = 'group'`)).n;
  const tick = async (n) => { await db.exec(`set role app_api`); await as(null, await day(n)); const r = (await one(`select group_digest_tick() k`)).k; await db.exec(`reset role`); return r; };
  const n0 = await cnt();
  ok((await tick(5)) === null && (await tick(7)) === null && (await tick(12)) === null, '不是通报日不发，原来的期中汇总和期末提醒取消');
  eq(await cnt(), n0, '不是通报日队列里不多出消息');
  ok((await tick(13)) === 'eve', '登记日前一天发提醒');
  const nd = await day(14), span2 = (await one(`select to_char($1::date, 'MM-DD') || ' 至 ' || to_char($1::date + 13, 'MM-DD') s`, [nd])).s;
  const t1 = await last();
  ok(t1.startsWith(`登记日提醒：明天（${nd.slice(5)}）是 ${span2} 一期的登记日`) && t1.includes('当天 24:00 截止，不补登'), '前一日提醒写明哪天、只在当天办、不补登', t1);
  ok((await one(`select payload->'all' a from feishu_outbox where target = 'group' order by id desc limit 1`)).a === true && !('all' in g.payload), '前一日的提醒 @所有人');
  ok((await tick(13)) === null, '同一期同一种通报只发一次');
  eq(await cnt(), n0 + 1, '重复触发不重复入队');
  ok((await tick(14)) === 'open', '登记日当天发通知');
  ok((await last()).startsWith(`登记日：今天（${nd.slice(5)}）是 ${span2} 一期的登记日`), '登记日当天的通知', await last());
  ok((await tick(15)) === 'final', '登记日次日发本期结果');
  const t3 = await last();
  ok(t3.startsWith(`双周表本期结果：${span2} 一期的登记已于 ${nd.slice(5)} 24:00 截止，应登记 `) && /已登记 \d+ 个，未登记 \d+ 个。/.test(t3) && t3.includes('\n未登记\n· ') && t3.includes('\n连续两期及以上未登记\n· ') && t3.includes('转为停滞'), '本期结果列出未登记的，标出连续未登记的并说明转为停滞', t3);
  eq((await one(`select count(*)::int n from feishu_outbox where target = 'group' and payload ? 'all'`)).n, 1, '只有前一日的提醒 @所有人');
  await db.exec(`set role app_api`); await as(U.dir, await day(21));
  await raises('登录的人不能触发汇总', /当前角色不能执行此操作/, `select group_digest_tick()`);
  await raises('群发函数不对接口开放', /permission denied/, `select notify_group('x')`);
}

// ---------- ARR 担保名额 ----------
{
  await db.exec(`reset role`);
  const un = await one(`select p.id, p.name, p.owner_id from project p where p.layer = 'paper' and p.active and not p.proposed and p.owner_id is not null and p.owner_id <> $1 and p.owner_id <> $2 order by p.code limit 1`, [U.mem2, U.fin]);
  const un2 = await one(`select p.id from project p where p.layer = 'paper' and p.active and not p.proposed and p.owner_id = $1 and p.id <> $2 limit 1`, [un.owner_id, un.id]);
  const out = (await one(`insert into app_user (name, role, feishu_open_id) values ('担保无关人', 'member', 'ou_arr_out') returning id`)).id;
  await db.exec(`set role app_api`);
  const D2 = '2033-05-01', own = un.owner_id;
  await as(out, D2);
  await raises('成员不能开启轮次', /需要权限/, `select open_arr_cycle('2033 年 5 月')`);
  await raises('成员不能登记担保资格', /需要权限/, `select save_arr_sponsor($1, true, 2)`, [U.mem2]);
  await as(own, D2);
  await raises('没有轮次时不能申请', /尚未开启 ARR 轮次/, `select ask_arr($1, $2)`, [un.id, U.mem2]);
  await as(U.fin, D2);
  await q(`select open_arr_cycle('2033 年 5 月')`);
  await raises('轮次不能重名', /已有名为/, `select open_arr_cycle('2033 年 5 月')`);
  await raises('名额有上下限', /0 到 20 之间/, `select save_arr_sponsor($1, true, 21)`, [U.mem2]);
  await q(`select save_arr_sponsor($1, true, 1, '合格')`, [U.mem2]);
  await q(`select save_arr_sponsor($1, false, 2, '不合格的备注')`, [out]);
  ok((await q(`select note from api.arr_sponsor where note is not null`)).length === 2, '人事岗看得到备注和不合格人员');
  await as(own, D2);
  await raises('没有资格的人不能被请', /不具备 ARR 担保资格/, `select ask_arr($1, $2)`, [un.id, U.fin]);
  const sp = await q(`select user_name, remaining, note from api.arr_sponsor`);
  ok(sp.length === 1 && sp[0].remaining === 1 && sp[0].note === null, '研究单元负责人只看得到合格的担保人和余量，看不到备注', JSON.stringify(sp));
  const c1 = await val(`select ask_arr($1, $2) v`, [un.id, U.mem2]);
  await raises('一个研究单元一轮只请一位', /已有担保申请/, `select ask_arr($1, $2)`, [un.id, U.mem2]);
  ok((await one(`select remaining from api.arr_sponsor`)).remaining === 0, '待答复的申请先占着名额');
  await raises('不是担保人不能答复', /本人答复/, `select answer_arr($1, true)`, [c1]);
  if (un2) await raises('名额用完不能再请', /名额已用完/, `select ask_arr($1, $2)`, [un2.id, U.mem2]);
  await as(out, D2);
  eq((await q(`select 1 from api.arr_sponsor`)).length, 0, '不是研究单元负责人、也不是担保人的成员看不到余量');
  await raises('别人不能代负责人申请', /由研究单元的负责人申请/, `select ask_arr($1, $2)`, [un.id, U.mem2]);
  await as(U.mem2, D2);
  ok((await one(`select can_answer, status from api.arr_claim where id = $1`, [c1])).can_answer === true, '担保人看得到请自己的申请并可答复');
  await raises('不同意须写原因', /写明原因/, `select answer_arr($1, false)`, [c1]);
  await q(`select answer_arr($1, false, '本轮已有其他安排')`, [c1]);
  ok((await one(`select remaining from api.arr_sponsor`)).remaining === 1, '不同意的，名额退回');
  await raises('已答复的不能再答复', /已答复或已撤回/, `select answer_arr($1, true)`, [c1]);
  await as(own, D2);
  const c2 = await val(`select ask_arr($1, $2) v`, [un.id, U.mem2]);
  // 待答复期间人事岗取消资格：担保人不能再同意
  await as(U.fin, D2); await q(`select save_arr_sponsor($1, false, 1)`, [U.mem2]);
  await as(U.mem2, D2);
  await raises('资格取消后不能同意', /资格已取消/, `select answer_arr($1, true)`, [c2]);
  // 待答复期间名额被线下占用：超出名额不能同意
  await as(U.fin, D2); await q(`select save_arr_sponsor($1, true, 1, null, 1)`, [U.mem2]);
  ok((await one(`select used, offline_used, remaining from api.arr_sponsor where user_id = $1`, [U.mem2])).used === 2, '本轮线下已占计入已占');
  await as(U.mem2, D2);
  await raises('名额超出后不能同意', /名额已用完/, `select answer_arr($1, true)`, [c2]);
  await as(U.fin, D2); await q(`select save_arr_sponsor($1, true, 1, null, 0)`, [U.mem2]);
  await as(U.mem2, D2);
  await q(`select answer_arr($1, true)`, [c2]);
  await as(out, D2);
  await raises('无关的人不能撤回', /担保人本人或人事岗撤回/, `select withdraw_arr($1)`, [c2]);
  await as(own, D2);
  const v2 = await one(`select status, can_withdraw from api.arr_claim where id = $1`, [c2]);
  ok(v2.status === 'agreed' && v2.can_withdraw === false, '同意后研究单元页显示已有担保，负责人不能自行撤回', JSON.stringify(v2));
  await raises('负责人不能撤回已同意的担保', /担保人本人或人事岗撤回/, `select withdraw_arr($1)`, [c2]);
  await db.exec(`reset role`); const nOwn = (await one(`select count(*)::int n from feishu_outbox where user_id = $1 and payload->>'text' like 'ARR 担保申请已撤回%'`, [own])).n; await db.exec(`set role app_api`);
  await as(U.fin, D2);
  await q(`select withdraw_arr($1)`, [c2]);
  await db.exec(`reset role`);
  ok((await one(`select count(*)::int n from feishu_outbox where user_id = $1 and payload->>'text' like 'ARR 担保申请已撤回%'`, [own])).n === nOwn + 1, '人事岗撤回的，也通知研究单元负责人');
  await db.exec(`set role app_api`);
  await raises('已撤回的不必再撤', /已结束/, `select withdraw_arr($1)`, [c2]);
  await as(U.mem2, D2);
  ok((await one(`select remaining, used from api.arr_sponsor`)).remaining === 1, '撤回后名额退回');
  // 新一轮：余量按名额重新起算，上一轮未答复的申请结束
  await as(own, D2); const c4 = await val(`select ask_arr($1, $2) v`, [un.id, U.mem2]);
  await as(U.fin, D2); await q(`select save_arr_sponsor($1, true, 1, null, 1)`, [U.mem2]); await q(`select open_arr_cycle('2033 年 7 月')`);
  ok((await one(`select remaining, offline_used from api.arr_sponsor where user_id = $1`, [U.mem2])).remaining === 1 && (await q(`select 1 from api.arr_cycle where current`)).length === 1, '开启新一轮后余量重新起算，上一轮的线下已占不再计入');
  ok((await one(`select status from api.arr_claim where id = $1`, [c4])).status === 'expired', '开启新一轮后上一轮未答复的申请结束');
  await as(U.mem2, D2);
  ok((await one(`select can_answer from api.arr_claim where id = $1`, [c4])).can_answer === false, '往轮的申请不再出现在待答复里');
  await raises('往轮的申请不能答复', /已答复或已撤回|往轮/, `select answer_arr($1, true)`, [c4]);
  await db.exec(`reset role`);
  ok((await one(`select count(*)::int n from feishu_outbox where payload->>'text' like 'ARR 担保申请已结束%'`)).n === 2, '申请结束通知申请人和担保人');
  await db.exec(`set role app_api`);
  await as(U.fin, D2);
  await q(`select save_arr_sponsor($1, false, 1)`, [U.mem2]);
  await as(own, D2);
  await raises('取消资格后不能被请', /不具备 ARR 担保资格/, `select ask_arr($1, $2)`, [un.id, U.mem2]);
  // 请本人担保的直接生效
  await as(U.fin, D2); await q(`select save_arr_sponsor($1, true, 1)`, [own]);
  await as(own, D2);
  const c3 = await val(`select ask_arr($1, $2) v`, [un.id, own]);
  ok((await one(`select status from api.arr_claim where id = $1`, [c3])).status === 'agreed', '负责人本人有资格的，自己担保直接生效');
  await db.exec(`reset role`);
  ok((await one(`select count(*)::int n from feishu_outbox where payload->>'text' like 'ARR 担保申请%'`)).n >= 4, '申请、答复、撤回都通知对方');
  await db.exec(`set role app_api`);
}

// ---------- 负责人自己改名 ----------
{
  await db.exec(`reset role`);
  const un = await one(`select p.id, p.name, p.code, p.owner_id, t.owner_id town, t.id tid, t.name tname from project p join project t on t.id = p.parent_id where p.layer = 'paper' and p.active and not p.proposed and p.owner_id is not null and t.owner_id is not null and t.owner_id <> p.owner_id and t.active and not t.proposed order by p.code limit 1`);
  const out = (await one(`insert into app_user (name, role, feishu_open_id) values ('改名无关人', 'member', 'ou_rn_out') returning id`)).id;
  const n0 = (await one(`select count(*)::int n from feishu_outbox where payload->>'text' like '%改名：%'`)).n;
  await db.exec(`set role app_api`);
  const D3 = '2033-06-01';
  await as(out, D3);
  await raises('不是负责人不能改名', /名称由负责人修改/, `select rename_project($1, '乱改')`, [un.id]);
  await as(un.owner_id, D3);
  await raises('名称不能为空', /请填写名称/, `select rename_project($1, '  ')`, [un.id]);
  await raises('名称有长度上限', /不得超过 60 个字/, `select rename_project($1, $2)`, [un.id, '长'.repeat(61)]);
  await q(`select rename_project($1, '改过的稿子名')`, [un.id]);
  const after = await one(`select name, code, owner_id, parent_id from api.project where id = $1`, [un.id]);
  ok(after.name === '改过的稿子名' && after.code === un.code && after.parent_id === un.tid, '研究单元负责人可以改名，编号和所挂课题不变', JSON.stringify(after));
  await as(un.town, D3);
  await q(`select rename_project($1, '改过的课题名')`, [un.tid]);
  ok((await one(`select name from api.project where id = $1`, [un.tid])).name === '改过的课题名', '课题负责人可以改课题的名称');
  await db.exec(`reset role`);
  const ns = await db.query(`select payload->>'text' t, user_id from feishu_outbox where payload->>'text' like '%改名：%' order by id desc limit 6`);
  ok(ns.rows.some((x) => x.t.startsWith('研究单元改名：') && x.user_id === un.town && x.t.includes(`由「${un.name}」改为「改过的稿子名」`)), '研究单元改名通知所挂课题的负责人', JSON.stringify(ns.rows.map((x) => x.t)));
  ok(ns.rows.some((x) => x.t.startsWith('课题改名：') && x.user_id === U.dir), '课题改名通知中心负责人');
  await db.query(`update project set name = $2 where id = $1`, [un.id, un.name]); await db.query(`update project set name = $2 where id = $1`, [un.tid, un.tname]);
  await db.exec(`set role app_api`);
}

// ---------- 登记日：研究单元申请和双周表只在每期第一天办 ----------
{
  await db.exec(`reset role`); await db.exec(REAL_GATES);
  const fx = await one(`select id, owner_id, parent_id from project where name = '成员申请的研究单元' and layer = 'paper' and active and not proposed`);
  const U1 = fx.id, plain = fx.owner_id, TB = fx.parent_id, pu = `select propose_unit($1, $2, $3, $4, $5, $6, $7) v`;
  await db.exec(`set role app_api`);
  const D0 = (await one(`select token_period(date '2034-03-01')::text c`)).c;
  const day = async (n) => (await one(`select ($1::date + $2::int)::text d`, [D0, n])).d;
  const D1 = await day(1), N0 = await day(14), N1 = await day(15), mmdd = (x) => x.slice(5);
  // 判断本身，含第一期切换时的例外
  const open = async (today, period) => { await as(plain, today); return (await one(`select biweekly_open($1) v, is_register_day() r, next_register_day()::text n`, [period])); };
  ok((await open(D0, D0)).v === true && (await open(D1, D0)).v === false && (await open(await day(13), D0)).v === false && (await open(D0, await day(-14))).v === false, '双周表只在本期第一天开放');
  let o = await open(D1, D0);
  ok(o.r === false && o.n === N0 && (await open(D0, D0)).r === true && (await open(D0, D0)).n === D0, '登记日是每期第一天；其余日子给出下一个登记日', JSON.stringify(o));
  ok((await open('2026-11-23', '2026-11-23')).v === true && (await open('2026-11-24', '2026-11-23')).v === true && (await open('2026-11-25', '2026-11-23')).v === false, '第一期切换时放到 11-24，之后不放宽');
  // 双周表
  const BW = `select save_biweekly_report($1, $2, 'idea', 'a', 'b', 'c', null, 'd', 'e') v`;
  const st = async () => one(`select filled, missed, open, register_day::text rd, prev_open from api.biweekly_status where project_id = $1`, [U1]);
  await as(plain, D1);
  await raises('登记日过了不能登记本期', new RegExp(`双周表只在每期第一天登记，本期的登记日已过，下一个登记日为 ${mmdd(N0)}`), BW, [U1, D0]);
  const m0 = (await st());
  ok(m0.filled === false && m0.open === false && m0.rd === N0 && m0.prev_open === false, '登记日过后：不开放，给出下一个登记日', JSON.stringify(m0));
  await as(plain, D0);
  const mOpen = await st();
  ok(mOpen.open === true && mOpen.rd === D0 && mOpen.missed === m0.missed - 1, '登记日当天还没登记不算未登记；过了当天还没登记的，当期就计一期', JSON.stringify([mOpen, m0]));
  await q(BW, [U1, D0]);
  await q(BW, [U1, D0]);
  ok((await st()).filled === true, '登记日当天可以登记，也可以修改');
  await as(plain, D1);
  await raises('登记日过后不能再改', /登记日已过/, BW, [U1, D0]);
  ok((await st()).missed === mOpen.missed, '登记了的，过了登记日不计未登记');
  // 研究单元申请：提交不限日子，同意、退回、核对只在登记日
  await as(U.mem2, D1);
  const A1 = await val(pu, [null, TB, '登记日之外提交的研究单元', D0, D0, '说明', null]);
  ok(!!A1, '研究单元申请平时可以提交');
  await as(U.lead, D1);
  const gate = new RegExp(`研究单元申请只在每期第一天办理，下一个办理日为 ${mmdd(N0)}`);
  await raises('不是登记日不能同意', gate, `select approve_unit($1)`, [A1]);
  await raises('不是登记日不能退回', gate, `select return_unit($1, '原因')`, [A1]);
  await as(U.dir, D1);
  await raises('不是登记日不能核对', gate, `select confirm_unit($1)`, [A1]);
  await as(U.lead, N0);
  await q(`select approve_unit($1)`, [A1]);
  ok((await one(`select parent_ok_at from api.unit_apply where id = $1`, [A1])).parent_ok_at != null, '登记日当天可以同意');
  await as(U.dir, N0);
  await q(`select confirm_unit($1)`, [A1]);
  ok((await one(`select proposed from project where id = $1`, [A1]).catch(() => null)) !== undefined, '登记日当天可以核对成立');
  // 登记时段过后才成立的，从下一期起登记
  await db.exec(`reset role`);
  const from = async (ts) => { await q(`update project set checked_at = $2::timestamptz where id = $1`, [A1, ts]); return (await one(`select biweekly_from($1)::text v`, [A1])).v; };
  ok((await from(`${N0} 10:00+08`)) === N0 && (await from(`${N1} 00:28+08`)) === (await day(28)) && (await from(`${await day(20)} 10:00+08`)) === (await day(28)), '登记日当天成立的从当期起登记；之后才成立的从下一期起');
  ok((await from('2026-11-24 23:00+08')) === '2026-11-23' && (await from('2026-11-25 00:28+08')) === '2026-12-07', '第一期：11-24 之前成立的算当期，零点之后成立的算下一期');
  await db.exec(`set role app_api`);
  // 飞书任务：登记日当天建，截止日是当天；登记了完成，过了当天没登记的撤掉
  const plan = (c = true) => q(`select act, project_id, period_start::text ps, target_id, summary, due::text due, task_guid from biweekly_task_plan($1)`, [c]);
  const mark = (pid, ps, act, okv, guid = null, err = null) => q(`select biweekly_task_mark($1, $2, $3, $4, $5, $6)`, [pid, ps, act, okv, guid, err]);
  await as(plain, N0);
  await raises('登录用户不能取任务计划', /当前角色/, `select * from biweekly_task_plan(true)`);
  await as('', await day(20));
  eq((await plan()).filter((x) => x.act === 'create').length, 0, '不是登记日不建任务');
  await as('', N0);
  eq((await plan(false)).filter((x) => x.act === 'create').length, 0, '后半夜不建新任务');
  let pl = await plan(), mine = pl.find((x) => x.project_id === U1);
  ok(mine && mine.act === 'create' && mine.ps === N0 && mine.due === N0 && mine.summary.endsWith(`（${mmdd(N0)} 登记日，当天 24:00 截止）`) && /^o[un]_/.test(mine.target_id), '登记日当天给未登记的研究单元建任务，截止日是当天', JSON.stringify(mine));
  eq((await plan()).length, pl.length, '没回报之前再取还是这些，不会重复登记');
  await mark(U1, N0, 'create', false, null, '网络错误');
  ok((await plan()).some((x) => x.project_id === U1 && x.act === 'create'), '建失败的下次再试');
  await mark(U1, N0, 'create', true, 'guid-1');
  ok(!(await plan()).some((x) => x.project_id === U1), '建好之后不再出现');
  const other = pl.find((x) => x.project_id !== U1);
  if (other) { await mark(other.project_id, other.ps, 'create', true, 'guid-9');
    await as('', N1);
    const dr = (await plan(false)).find((x) => x.project_id === other.project_id);
    ok(dr && dr.act === 'drop' && dr.task_guid === 'guid-9', '登记日过了仍未登记的，撤掉任务', JSON.stringify(dr));
    await mark(other.project_id, other.ps, 'drop', true);
    ok(!(await plan(false)).some((x) => x.project_id === other.project_id), '撤掉之后不再出现'); }
  await as(plain, N0);
  await q(BW, [U1, N0]);
  await as('', N0);
  mine = (await plan(false)).find((x) => x.project_id === U1);
  ok(mine && mine.act === 'done' && mine.task_guid === 'guid-1', '登记之后任务标为完成', JSON.stringify(mine));
  await mark(U1, N0, 'done', true);
  await as('', N1);
  ok(!(await plan()).some((x) => x.project_id === U1), '完成的任务过了登记日不会被撤，也不再建');
  for (let i = 0; i < 5; i++) await mark(U1, N0, 'done', false, null, '没有权限');
  await as(null);
}

// ---------- 投稿与评审（0091、0092）：挂在研究单元上，登录的中心成员都看得到，未登录看不到 ----------
{
  await db.exec(`reset role`);
  const u = await one(`select p.id, p.owner_id, (select owner_id from project where id = p.parent_id) as topic_owner from project p
    where p.layer = 'paper' and p.active and not p.proposed and p.owner_id is not null and p.parent_id is not null
      and (select owner_id from project where id = p.parent_id) is not null and (select owner_id from project where id = p.parent_id) <> p.owner_id limit 1`);
  ok(!!u, '有一个负责人与课题负责人不同的研究单元可用');
  const out = (await one(`insert into app_user (name, role, feishu_open_id) values ('评审外人', 'member', 'ou_review_out') returning id`)).id;
  const mem = (await one(`insert into app_user (name, role, feishu_open_id) values ('评审成员', 'member', 'ou_review_mem') returning id`)).id;
  await q(`insert into project_member (project_id, user_id, joined_on) values ($1, $2, '2026-11-01')`, [u.id, mem]);
  const s0 = (await one(`insert into submission (project_id, venue, cycle, forum, number, title, status, ac_overall, ac_gist) values ($1, 'ACL ARR', '2026-08-01', 'f-old', 11, '旧稿', 'resubmitted', 3.5, '补充基线') returning id`, [u.id])).id;
  const s1 = (await one(`insert into submission (project_id, venue, cycle, forum, number, title, prev_id) values ($1, 'ACL ARR', '2026-10-01', 'f-new', 22, '新稿', $2) returning id`, [u.id, s0])).id;
  await q(`update submission set keep_reviewers = false, keep_ac = true where id = $1`, [s1]);
  const r1 = (await one(`insert into submission_review (submission_id, reviewer, overall, soundness, excitement, confidence, weaknesses) values ($1, 'Reviewer_a', 2, 2.5, 2.5, 4, 'too small') returning id`, [s1])).id;
  await q(`insert into submission_review (submission_id, reviewer, overall) values ($1, 'Reviewer_b', 3.5)`, [s1]);
  const th = (await one(`insert into review_thread (project_id, axis, label) values ($1, 'ti', '数据规模小') returning id`, [u.id])).id;
  await q(`insert into review_point (review_id, ord, axis, gist, quote, thread_id) values ($1, 0, 'ti', '数据太少', 'too small', $2), ($1, 1, 'li', '范围窄', null, null)`, [r1, th]);
  await raises('四字之外的归类不收', /review_point_axis_check/, `insert into review_point (review_id, axis, gist) values ($1, 'qi', 'x')`, [r1]);
  await raises('轮次须记当月一日', /submission_cycle_check/, `insert into submission (project_id, venue, cycle, forum, title) values ($1, 'ACL ARR', '2026-10-10', 'f-bad', 'x')`, [u.id]);
  await raises('同一位审稿人在一轮里只有一份', /submission_review_submission_id_reviewer_key/, `insert into submission_review (submission_id, reviewer) values ($1, 'Reviewer_a')`, [s1]);
  await db.exec(`set role app_api`);
  const sees = async (uid) => { await as(uid, '2026-11-25');
    return [(await q(`select 1 from api.submission where project_id = $1`, [u.id])).length, (await q(`select 1 from api.submission_review where project_id = $1`, [u.id])).length,
      (await q(`select 1 from api.review_point where project_id = $1`, [u.id])).length, (await q(`select 1 from api.review_thread where project_id = $1`, [u.id])).length].join(','); };
  const want = async (uid, v, name) => { const g = await sees(uid); ok(g === v, name, g); };
  await want(u.owner_id, '2,2,2,1', '研究单元负责人看得到投稿、评审、质疑和追踪');
  await want(mem, '2,2,2,1', '名单内成员看得到');
  await want(u.topic_owner, '2,2,2,1', '所挂课题的负责人看得到');
  await want(U.dir, '2,2,2,1', '中心负责人看得到');
  await want(out, '2,2,2,1', '名单外的成员也看得到（0092）');
  await want(null, '0,0,0,0', '未登录看不到');
  await as(u.owner_id, '2026-11-25');
  const row = await one(`select mean_overall, prev_id, relation, status, keep_reviewers, keep_ac from api.submission where id = $1`, [s1]);
  ok(Number(row.mean_overall) === 2.75 && row.prev_id === s0 && row.relation === 'self' && row.status === 'review' && row.keep_reviewers === false && row.keep_ac === true, '投稿带审稿人均分和换审稿人的申请，并指向上一轮', JSON.stringify(row));
  // 汇总（0093）：每篇稿件一行，分数和质疑取最近一轮有评审的
  const sm = await one(`select rounds, judged_rounds, mean, prev_mean, ac_overall, li, ju, ti, yong, threads, threads_open, status, number, keep_reviewers from api.review_summary where project_id = $1`, [u.id]);
  ok(sm.rounds === 2 && sm.judged_rounds === 1 && Number(sm.mean) === 2.75 && sm.prev_mean == null && Number(sm.ac_overall) === 3.5 && sm.li === 1 && sm.ti === 1 && sm.ju === 0 && sm.yong === 0 && sm.threads === 1 && sm.threads_open === 1 && sm.number === 22 && sm.keep_reviewers === false, '汇总按稿件一行，取最近一轮有评审的', JSON.stringify(sm));
  await as(null);
  ok((await q(`select 1 from api.review_summary`)).length === 0, '未登录看不到汇总');
  await as(u.owner_id, '2026-11-25');
  // 自行填报（0095）：名单内成员、负责人、中心负责人可以填；按会议分开
  const call = (sql, a) => one(`select ${sql} as r`, a).then((x) => x.r);
  await as(out, '2026-11-25');
  await raises('名单外的成员不能填报', /可以填报/, `select submission_save(null, $1, 'self', 'ICLR', '2026-09', 77, '另投', 'review', null, 10, null, null, null)`, [u.id]);
  await as(mem, '2026-11-25');
  const m1 = await call(`submission_save(null, $1, 'self', 'ICLR', '2026-09', 77, '另投', 'review', 'https://openreview.net/forum?id=abcDEF1234', 10, null, null, null)`, [u.id]);
  await raises('同一个帖子不能登记两次', /已经登记过/, `select submission_save(null, $1, 'self', 'ICLR', '2026-10', 78, '另投二', 'review', 'abcDEF1234', 10, null, null, null)`, [u.id]);
  await raises('轮次要有年月', /年月/, `select submission_save(null, $1, 'self', 'ICLR', '九月', 78, '另投二', 'review', null, 10, null, null, null)`, [u.id]);
  const rv1 = await call(`review_save(null, $1, 'R1', 6, null, null, 4, null, '实验不足', null)`, [m1]);
  await call(`review_save(null, $1, 'R2', 8, null, null, 3, null, null, null)`, [m1]);
  await raises('分数不能超过分制', /0 到 10 之间/, `select review_save(null, $1, 'R3', 11, null, null, null, null, null, null)`, [m1]);
  await raises('同一位审稿人一轮只登记一份', /已经登记过/, `select review_save(null, $1, 'R1', 5, null, null, null, null, null, null)`, [m1]);
  await call(`review_save($1, null, 'R1', 5, null, null, 4, null, '实验不足', null)`, [rv1]);
  const m2 = await call(`submission_save(null, $1, 'self', 'ICLR', '2027-01', 12, '另投', 'review', null, 10, 'new', null, null)`, [u.id]);
  const mrow = await one(`select forum, scale, source, can_edit, prev_id, keep_reviewers, mean_overall from api.submission where id = $1`, [m2]);
  ok(mrow.forum == null && Number(mrow.scale) === 10 && mrow.source === 'manual' && mrow.can_edit === true && mrow.prev_id === m1 && mrow.keep_reviewers === false, '自行填报的投稿记分制、来源，并接到同一会议的上一轮', JSON.stringify(mrow));
  ok(Number((await one(`select mean_overall from api.submission where id = $1`, [m1])).mean_overall) === 6.5, '改过的评审按新分数算均分');
  const sums = await q(`select venue, rounds, judged_rounds, mean, scale, status from api.review_summary where project_id = $1 order by venue`, [u.id]);
  ok(sums.length === 2 && sums[0].venue === 'ACL ARR' && sums[1].venue === 'ICLR' && sums[1].rounds === 2 && sums[1].judged_rounds === 1 && Number(sums[1].mean) === 6.5 && Number(sums[1].scale) === 10 && sums[0].rounds === 2, '汇总按会议各一行', JSON.stringify(sums));
  await raises('导入的评审不能在页面上改', /导入的评审/, `select review_save($1, null, 'Reviewer_a', 3, null, null, null, null, null, null)`, [r1]);
  await raises('导入的投稿不能在页面上删', /不能在页面上删除/, `select submission_delete($1)`, [s1]);
  await call(`submission_save($1, null, null, 'x', '2026-10', null, 'x', 'accepted', null, null, null, 4, '同意录用')`, [s1]);
  const imp = await one(`select status, title, venue, ac_overall, ac_text from api.submission where id = $1`, [s1]);
  ok(imp.status === 'accepted' && imp.title === '新稿' && imp.venue === 'ACL ARR' && Number(imp.ac_overall) === 4 && imp.ac_text === '同意录用', '导入的投稿只改状态和 AC 意见', JSON.stringify(imp));
  await call(`submission_save($1, null, null, 'x', '2026-10', null, 'x', 'review', null, null, null, null, null)`, [s1]);
  await call(`review_delete($1)`, [rv1]);
  await call(`submission_delete($1)`, [m1]);
  ok((await one(`select prev_id from api.submission where id = $1`, [m2])).prev_id == null && (await q(`select 1 from api.submission_review where submission_id = $1`, [m1])).length === 0, '删掉一轮，评审跟着删，下一轮不再指向它');
  await call(`submission_delete($1)`, [m2]);
  await as(u.owner_id, '2026-11-25');
  await raises('页面一侧不能直接写评审', /permission denied/, `insert into submission_review (submission_id, reviewer) values ($1, 'Reviewer_z')`, [s1]);
  await raises('页面一侧不能读底表', /permission denied/, `select 1 from submission`);
  await as(null);
}

// ---------- 成长主线：身份与主线任务清单 ----------
{
  await db.exec(`reset role`);
  for (const k of ['mem', 'mem2', 'dir', 'fin'])
    if (!(await q(`select 1 from person where user_id = $1`, [U[k]])).length) await q(`insert into person (name, user_id, status) select name, id, 'active' from app_user where id = $1`, [U[k]]);
  const P = {}; for (const k of ['mem', 'mem2', 'dir', 'fin']) P[k] = (await one(`select id from person where user_id = $1`, [U[k]])).id;
  const unitOwnedBy = (await one(`select owner_id from project where layer = 'paper' and not proposed and owner_id is not null order by code limit 1`)).owner_id;
  await db.exec(`set role app_api`);
  const D4 = '2033-08-01';
  await as(U.mem, D4);
  const mp = await q(`select person_id, rank, tasks, done, mine from api.path_person`);
  ok(mp.length === 1 && mp[0].mine && mp[0].rank === 'intern' && mp[0].tasks === 8, '成员只看得到本人，加入即为 Intern，本级 8 条主线任务', JSON.stringify(mp));
  const tr = await q(`select code, status, verify_label, can_confirm from api.path_tracker order by seq`);
  ok(tr.length === 8 && tr.every((t) => !t.can_confirm) && tr.find((t) => t.code === 'ri-three').status === 'open' && tr.find((t) => t.code === 'ri-sign').verify_label === '人事岗位',
    '任务清单：写明认定方，本人不能自己确认', JSON.stringify(tr));
  await raises('成员不能确认任务', /由人事岗位认定/, `select confirm_path_task($1, 'ri-sign')`, [P.mem]);
  await raises('成员不能认定身份', /由中心负责人认定/, `select set_rank($1, 'assistant', '考核通过')`, [P.mem]);
  await as(U.dir, D4);
  ok((await q(`select 1 from api.path_person`)).length >= 4, '中心负责人看得到全中心');
  await raises('自动任务不能手工确认', /自动认定/, `select confirm_path_task($1, 'ri-unit')`, [P.mem]);
  await raises('完成日期不能晚于今天', /不能晚于今天/, `select confirm_path_task($1, 'ri-sign', '2033-09-01')`, [P.mem]);
  await q(`select confirm_path_task($1, 'ri-sign', '2033-07-30', '协议已签')`, [P.mem]);
  await raises('不能重复确认', /已确认过/, `select confirm_path_task($1, 'ri-sign')`, [P.mem]);
  await as(U.mem, D4);
  const s1 = await one(`select status, done_on::text d, confirmed_by_name from api.path_tracker where code = 'ri-sign'`);
  ok(s1.status === 'done' && s1.d === '2033-07-30' && s1.confirmed_by_name === '负责人', '确认后本人看到已完成、日期和确认人', JSON.stringify(s1));
  ok((await one(`select done from api.path_person`)).done >= 1, '概况里完成数随之增加');
  await as(U.dir, D4);
  await q(`select undo_path_task($1, 'ri-sign')`, [P.mem]);
  await db.exec(`reset role`);
  ok((await one(`select count(*)::int n from feishu_outbox where payload->>'text' like '主线任务认定已撤销：%'`)).n >= 1, '撤销认定通知本人');
  ok((await val(`select has_function_privilege('app_api', 'path_latch(uuid)', 'execute') v`)) === false, '补记函数不对外开放');
  await db.exec(`set role app_api`);
  await as(U.dir, D4);
  await raises('撤销未确认的', /尚未确认/, `select undo_path_task($1, 'ri-sign')`, [P.mem]);
  // 自动任务：研究单元负责人进入研究单元、提出研究单元
  await db.exec(`reset role`);
  const po = (await one(`select id from person where user_id = $1`, [unitOwnedBy]).catch(() => null))?.id
    ?? (await one(`insert into person (name, user_id, status) select name, id, 'active' from app_user where id = $1 returning id`, [unitOwnedBy])).id;
  await db.exec(`set role app_api`);
  await as(U.dir, D4);
  ok((await one(`select status from api.path_tracker where person_id = $1 and code = 'ri-unit'`, [po])).status === 'done', '负责研究单元的人，「进入一个研究单元」自动完成');
  await raises('自动任务不能撤销', /不能撤销/, `select undo_path_task($1, 'ri-unit')`, [po]);
  // 换负责人前先记下：原负责人已完成的自动任务不倒退
  await db.exec(`reset role`);
  const uid = (await one(`select id from project where layer = 'paper' and not proposed and owner_id = $1 order by code limit 1`, [unitOwnedBy])).id;
  const others = (await one(`select count(*)::int n from project where layer = 'paper' and not proposed and active and owner_id = $1 and id <> $2`, [unitOwnedBy, uid])).n;
  await q(`update project set owner_id = $2 where id = $1`, [uid, U.mem2]);
  const latched = await q(`select task_code, note, confirmed_by from path_done where person_id = $1 and task_code in ('ri-unit', 'ra-unit') order by task_code`, [po]);
  ok(latched.length === 2 && latched.every((x) => x.note === '中台自动' && x.confirmed_by === null), '换负责人前，原负责人的自动任务记下，确认人为空', JSON.stringify(latched) + ' 其余单元 ' + others);
  await q(`update project set owner_id = $2 where id = $1`, [uid, unitOwnedBy]);
  await db.exec(`set role app_api`);
  await as(U.mem2);
  await raises('登录用户不能跑补记', /当前角色/, `select path_latch_tick()`);
  await as(null);
  ok((await val(`select path_latch_tick() v`)) >= 0, '定时补记可以跑');
  await as(U.dir, D4);
  // 认定身份
  await raises('依据必填', /写明认定的依据/, `select set_rank($1, 'assistant', ' ')`, [P.mem]);
  await raises('身份只有六种', /六种之内/, `select set_rank($1, 'master', '误填')`, [P.mem]);
  await q(`select set_rank($1, 'assistant', 'RA 考核通过')`, [P.mem]);
  await raises('同一身份不必再认定', /已是/, `select set_rank($1, 'assistant', '再来')`, [P.mem]);
  await as(U.mem, D4);
  const r2 = await one(`select rank, rank_label, tasks from api.path_person`);
  ok(r2.rank === 'assistant' && r2.rank_label === 'Assistant（RA）' && r2.tasks === 5, '认定为 RA 后，清单换成 RA 的 5 条任务', JSON.stringify(r2));
  const ch = await q(`select from_label, to_label, basis, decided_by_name from api.rank_change`);
  ok(ch.length === 1 && ch[0].from_label === 'Intern（RI）' && ch[0].basis === 'RA 考核通过', '身份变动留记录，本人看得到', JSON.stringify(ch));
  const bw = await one(`select status, progress from api.path_tracker where code = 'ra-biweekly'`);
  ok(bw.status === 'open' && /共需 6 期/.test(bw.progress), '双周表累计期数显示进度', JSON.stringify(bw));
  await as(U.mem2, D4);
  eq((await q(`select 1 from api.rank_change`)).length, 0, '别人的身份变动成员看不到');
  await db.exec(`reset role`);
  ok((await one(`select count(*)::int n from feishu_outbox where target = (select coalesce(feishu_union_id, feishu_open_id) from app_user where id = $1) and payload->>'text' like '身份认定：%'`, [U.mem]).catch(() => ({ n: 1 }))).n >= 1, '认定身份通知本人');
  await db.exec(`set role app_api`);
  await as(null);
}

// ---------- 迭代、质疑与积累 ----------
{
  await db.exec(`reset role`);
  const fx = await one(`select id, owner_id, parent_id from project where name = '成员申请的研究单元' and layer = 'paper' and active and not proposed`);
  const UU = fx.id, own = fx.owner_id;
  for (const u of [own, U.lead, U.mem, U.mem2, U.fin]) if (!(await q(`select 1 from person where user_id = $1`, [u])).length) await q(`insert into person (name, user_id, status) select name, id, 'active' from app_user where id = $1`, [u]);
  const PID = async (u) => (await one(`select id from person where user_id = $1`, [u])).id;
  const [Pown, Plead, Pmem, Pmem2, Pfin] = [await PID(own), await PID(U.lead), await PID(U.mem), await PID(U.mem2), await PID(U.fin)];
  ok((await val(`select is_on_project($1, $2) v`, [UU, U.mem2])) === true && (await val(`select is_on_project($1, $2) v`, [UU, U.mem])) === false, '前提：成员乙在名单里，成员甲不在');
  await db.exec(`update person set rank = 'intern' where id = any($1)`.replace('$1', `array['${Pmem}','${Pmem2}']::uuid[]`));
  await db.exec(`set role app_api`);
  const P1 = (await one(`select token_period(date '2035-03-01')::text c`)).c;
  const d = async (n) => (await one(`select ($1::date + $2::int)::text d`, [P1, n])).d;
  const A1 = await d(2), A2 = await d(16), A3 = await d(30);
  // 研讨会组织者
  await as(U.dir, A1);
  await q(`select set_rank($1, 'researcher', '测试：课题负责人')`, [Plead]).catch(() => null);
  await raises('组织者由 Researcher 担任', /Researcher 担任/, `select set_seminar_organizer('med', $1)`, [U.mem]);
  await q(`select set_seminar_organizer('cog', $1)`, [U.lead]);
  await as(U.mem, A1);
  await raises('成员不能指定组织者', /中心负责人指定/, `select set_seminar_organizer('fin', $1)`, [U.lead]);
  ok((await q(`select code from api.seminar order by seq`)).map((r) => r.code).join() === 'cog,med,fin,hum', '四个主题研讨会');
  // 快照
  await raises('不在名单里的不能交快照', /负责人和名单里的人/, `select save_snapshot($1, 'https://example.org/d1')`, [UU]);
  await as(own, A1);
  await raises('有改动的人须在名单里', /须在研究单元的名单里/, `select save_snapshot($1, 'https://example.org/d1', null, $2)`, [UU, [own, U.mem]]);
  await raises('快照须有链接', /链接/, `select save_snapshot($1, 'draft.pdf')`, [UU]);
  const S1 = await val(`select save_snapshot($1, 'https://example.org/d1', '第一稿', $2) v`, [UU, [own, U.mem2]]);
  eq(await val(`select pitch_snapshot($1, array['cog','med']) v`, [S1]), 2, '同一期可以交给几个研讨会');
  const pitches = await q(`select id, seminar from api.snapshot_pitch where snapshot_id = $1`, [S1]);
  const pc1 = pitches.find((x) => x.seminar === 'cog').id, pm1 = pitches.find((x) => x.seminar === 'med').id;
  ok((await one(`select seq from api.snapshot where id = $1`, [S1])).seq === 1, '快照依次编号');
  await as(U.lead, A1);
  await raises('不是该研讨会的组织者不能接收', /组织者决定/, `select decide_pitch($1, true)`, [pm1]);
  await q(`select decide_pitch($1, true)`, [pc1]);
  await raises('质疑须指明哪一问', /理、据、体、用/, `select add_query($1, null, '缺一问')`, [pc1]);
  const Q1 = await val(`select add_query($1, 'li', '为什么值得做', $2) v`, [pc1, U.mem]);
  const Q2 = await val(`select add_query($1, 'ti', '方法写得不清楚') v`, [pc1]);
  const Q3 = await val(`select add_query($1, 'yong', '记错了') v`, [pc1]);
  await q(`select remove_query($1)`, [Q3]);
  await raises('本期提出的不必再次提出', /不必再次提出/, `select add_query($1, null, '又来', null, $2)`, [pc1, Q1]);
  eq(await val(`select close_pitch($1) v`, [pc1]), 0, '第一期没有可结算的质疑');
  await raises('结束后不能再记', /尚未结束/, `select add_query($1, 'li', '会后补记')`, [pc1]);
  // 小队
  await as(U.mem, A1);
  ok((await q(`select 1 from api.query where project_id = $1 and status = 'open'`, [UU])).length === 2, '未回应的质疑全中心公开');
  await raises('本人不能自行入队', /负责人加人/, `select add_query_member($1, $2)`, [Q1, U.mem]);
  await q(`select ask_join_query($1, '做过相关工作')`, [Q1]);
  await as(own, A1);
  await q(`select add_query_member($1, $2)`, [Q1, U.mem]);
  await q(`select add_query_member($1, $2)`, [Q1, U.mem2]);
  await raises('不能重复入队', /已在队里/, `select add_query_member($1, $2)`, [Q1, U.mem2]);
  // 第二期：Q1 无人再提、队员已有分配资格，结算；Q2 被再次提出
  const S2 = await val(`select save_snapshot($1, 'https://example.org/d2', null, $2) v`, [UU, [own, U.mem2]]).catch(() => null);
  ok(S2 === null, '往期的快照不再改（本期是第一期之后才能交第二期）');
  await as(own, A2);
  const S2b = await val(`select save_snapshot($1, 'https://example.org/d2', null, $2) v`, [UU, [own, U.mem2]]);
  await q(`select pitch_snapshot($1, array['cog'])`, [S2b]);
  const pc2 = (await one(`select id from api.snapshot_pitch where snapshot_id = $1`, [S2b])).id;
  ok((await one(`select seq from api.snapshot where id = $1`, [S2b])).seq === 2, '第二次快照');
  await as(U.lead, A2);
  await q(`select decide_pitch($1, true)`, [pc2]);
  await q(`select add_query($1, null, '方法还是不清楚', $2, $3)`, [pc2, U.fin, Q2]);
  eq(await val(`select close_pitch($1) v`, [pc2]), 1, '无人再提的一条结算');
  await db.exec(`reset role`);
  const ne = await q(`select user_id, coins::float c, axis from nominal_entry where query_id = $1 order by user_id`, [Q1]);
  ok(ne.length === 2 && ne.every((x) => x.c === 8 && x.axis === 'li'), '每条 16 名义币，队员平分，记在所针对的一问上', JSON.stringify(ne));
  const qs = await one(`select (select status from query where id = $1) a, (select status from query where id = $2) b`, [Q1, Q2]);
  ok(qs.a === 'resolved' && qs.b === 'open', '再次提出的继续留着', JSON.stringify(qs));
  await db.exec(`set role app_api`);
  await as(U.mem, A2);
  const pool = await one(`select coins::float c, people, pending from api.unit_pool where project_id = $1`, [UU]);
  ok(pool.c === 16 && pool.people === 2 && pool.pending === 1, '名义池子按回应计入，未回应的仍挂着', JSON.stringify(pool));
  const at = await one(`select a_li::float li, d_li from api.person_attr where user_id = $1`, [U.mem]);
  ok(at.li === 8 && Number(at.d_li) === 12, '理加上回应所得；给别人的快照提质疑记 4、回应别的研究单元的质疑按所得名义币，都记入利', JSON.stringify(at));
  ok((await one(`select again from api.query where id = $1`, [Q2])).again === 1, '再次提出的挂在原来那一条下面');
  // 新入队的自下一期起参与分配
  await as(own, A2);
  await q(`select add_query_member($1, $2)`, [Q2, U.mem2]);
  await as(U.lead, A2);
  // 出勤与日常任务
  await as(U.dir, A2);
  const ev = await val(`select record_attendance('lecture', null, $1, '周日讲座', $2, $3) v`, [A2, [U.mem2], [U.mem]]);
  await as(U.mem2, A2);
  await raises('成员不能登记出勤', /人事岗登记/, `select record_attendance('lecture', null, $1, '讲座', $2)`, [A2, [U.mem2]]);
  const dm = await one(`select lecture_ok, change_ok, biweekly_ok, done from api.daily_mine where current`);
  ok(dm.lecture_ok === true && dm.change_ok === true && dm.biweekly_ok === null && dm.done === true, '本期的日常任务：出勤和快照改动都有', JSON.stringify(dm));
  await as(U.dir, A2);
  ok((await one(`select lecture_ok from daily_check($1, $2::date)`, [U.mem, await d(14)])).lecture_ok === false, '请假未补看回放的不算出勤');
  await q(`select mark_made_up($1, $2)`, [ev, U.mem]);
  ok((await one(`select lecture_ok from daily_check($1, $2::date)`, [U.mem, await d(14)])).lecture_ok === true, '补看回放后计为出勤');
  // RA 考核
  await as(U.mem2, A2);
  await raises('任务没做完不能申请', /未完成/, `select apply_assessment('ra')`);
  await db.exec(`reset role`);
  await q(`insert into path_done (person_id, task_code, done_on, note) select $1, code, '2035-01-01', '测试' from path_task where rank = 'intern' and verify <> 'auto' on conflict do nothing`, [Pmem2]);
  await q(`insert into nominal_entry (project_id, user_id, query_id, period_start, axis, coins) select $1, $2, $3, d, 'li', 1 from unnest(array['2035-01-01','2035-01-15']::date[]) d on conflict do nothing`, [UU, U.mem2, Q1]).catch(() => null);
  await q(`update path_task set ready = true`);
  await db.exec(`set role app_api`);
  await as(U.mem2, A2);
  const left = await q(`select code from api.path_tracker where mine and status <> 'done'`);
  if (left.length) { await db.exec(`reset role`); for (const t of left) await q(`insert into path_done (person_id, task_code, done_on, note) values ($1, $2, '2035-01-01', '测试') on conflict do nothing`, [Pmem2, t.code]); await db.exec(`set role app_api`); await as(U.mem2, A2); }
  const AS = await val(`select apply_assessment('ra') v`);
  await raises('同时只办一项', /已有一项考核/, `select apply_assessment('ra')`);
  await as(U.mem, A2);
  await raises('考核人由 Researcher 担任', /Researcher 担任/, `select join_examiner($1, true)`, [AS]);
  await as(U.dir, A2);
  await q(`select set_rank($1, 'researcher', '测试')`, [Pown]).catch(() => null);
  await q(`select set_rank($1, 'researcher', '测试')`, [Pfin]).catch(() => null);
  await as(own, A2);
  await raises('所在研究单元的负责人不担任考核人', /负责人不担任考核人/, `select join_examiner($1, true)`, [AS]);
  await as(U.lead, A2);
  await raises('须确认没有私人关系', /私人关系/, `select join_examiner($1, false)`, [AS]);
  await q(`select join_examiner($1, true)`, [AS]);
  await raises('考核人齐了才布置', /两名考核人齐了/, `select set_small_task($1, '题', '内容')`, [AS]);
  await as(U.fin, A2);
  await q(`select join_examiner($1, true)`, [AS]);
  await q(`select set_small_task($1, '复现一张表', '取研究单元里的一个真实问题，两周内独立完成')`, [AS]);
  await as(U.lead, A2);
  await q(`select judge_small_task($1, true, '结果可以核对')`, [AS]);
  ok((await one(`select status from api.assessment where id = $1`, [AS])).status === 'examining', '一人通过还不算');
  await as(U.fin, A2);
  await q(`select judge_small_task($1, true)`, [AS]);
  await as(U.mem2, A2);
  const ar = await one(`select status, mentor_name from api.assessment where id = $1`, [AS]);
  const rk = await one(`select rank from api.path_person where mine`);
  ok(ar.status === 'passed' && rk.rank === 'assistant', '两名考核人一致通过即为 RA', JSON.stringify([ar, rk]));
  await db.exec(`reset role`);
  const mt = await val(`select first_mentor($1) v`, [U.mem2]);
  const Pmt = await PID(mt);
  ok((await one(`select done from path_auto($1, 'ra-mentor')`, [Pmt])).done === true && ar.mentor_name != null, '最早接收此人进入研究单元的负责人，「带其通过 RA 考核」自动完成');
  await db.exec(`set role app_api`); await as(mt, A2);
  ok((await one(`select d_yuan from api.person_attr where user_id = $1`, [mt])).d_yuan >= 1, '带的人通过考核记入元');
  await db.exec(`reset role`);
  // Researcher 考核：联席会议表决，中心负责人决定
  const AR = (await one(`insert into assessment (person_id, kind, period_start, link) values ($1, 'researcher', $2, 'https://example.org/proposal') returning id`, [Pmem2, P1])).id;
  await db.exec(`set role app_api`);
  await as(U.mem, A2);
  await raises('成员不能录入表决', /中心助理录入/, `select record_council_vote($1, true, $2)`, [AR, A2]);
  await as(U.dir, A2);
  await raises('须先经联席会议', /联席会议表决推荐/, `select decide_assessment($1, true)`, [AR]);
  await q(`select record_council_vote($1, true, $2, '同意推荐')`, [AR, A2]);
  await q(`select decide_assessment($1, true, '认可')`, [AR]);
  await as(U.mem2, A2);
  ok((await one(`select rank from api.path_person where mine`)).rank === 'researcher', '中心负责人认可后即为 Researcher');
  // 须过问的情形
  await as(U.dir, A3);
  ok(Array.isArray(await q(`select * from api.path_alert`)), '须过问的情形可以列出');
  await as(null);
}

// ---------- 我的事项：当日、嘉许、称号与挑战、实际币 ----------
{
  await db.exec(`reset role`);
  const fx = await one(`select id, owner_id from project where name = '成员申请的研究单元' and layer = 'paper' and active and not proposed`);
  const UU = fx.id, own = fx.owner_id;
  const D = (await one(`select (token_period(date '2035-06-01') + 3)::text d`)).d;
  await db.exec(`set role app_api`);
  // 当日：修订、审阅
  await as(U.mem2, D);
  await q(`select log_revision($1, null, '改了引言')`, [UU]);
  await q(`select log_revision($1, null, null)`, [UU]);
  const td = await one(`select rev_done, day_no from api.today_mine`);
  ok(td.rev_done === true && td.day_no === 4, '当日修订登记一次，本回合第几日', JSON.stringify(td));
  await as(U.mem, D);
  await raises('不在研究单元里不能登记修订', /本人所在研究单元/, `select log_revision($1)`, [UU]);
  const sn = await val(`select id v from api.snapshot where project_id = $1 order by seq desc limit 1`, [UU]);
  const RV = await val(`select submit_review($1, '图 2 的坐标没有单位') v`, [sn]);
  await as(U.mem2, D);
  await raises('不能审阅本单元的快照', /其他研究单元/, `select submit_review($1, '自己看自己')`, [sn]);
  await raises('成员不能采纳', /负责人采纳/, `select adopt_review($1)`, [RV]);
  await as(own, D);
  await q(`select adopt_review($1)`, [RV]);
  // 嘉许
  await as(U.mem, D);
  await raises('不能嘉许本人', /不能嘉许本人/, `select give_praise($1, 'li')`, [U.mem]);
  await q(`select give_praise($1, 'zhen', '每天都在改')`, [U.mem2]);
  await q(`select give_praise($1, 'li')`, [own]);
  await raises('每期至多两次', /至多给出两次/, `select give_praise($1, 'heng')`, [U.mem2]);
  const at = await one(`select d_li::float li, title from api.person_attr where user_id = $1`, [U.mem]);
  ok(at.li >= 16, '审阅意见被采纳记入利', JSON.stringify(at));
  const ch = await q(`select code, progress from api.challenge_mine order by seq`);
  ok(ch.length === 5 && ch.find((c) => c.code === 'review').progress === 1, '学期挑战按记录计进度', JSON.stringify(ch));
  await as(U.mem2, D);
  ok((await q(`select name from api.title_mine where earned`)).some((t) => t.name === '入稿'), '本人的改动进入快照即得称号「入稿」');
  // 实际币：额度未定不发；定了按期发、铸造、换卡时、到期作废
  await as(null, D);
  eq(await val(`select coin_tick() v`), 0, '额度和铸造率未定的，不发不铸');
  await as(U.dir, D);
  await raises('身份只有六种', /六种之内/, `select set_token_param('salary', '{"master": 10}'::jsonb)`);
  await q(`select set_token_param('salary', '{"intern": 50, "assistant": 80, "researcher": 120, "rising_star": 120, "pi": null, "director": null}'::jsonb)`);
  await q(`select set_token_param('price', '2'::jsonb)`);
  await q(`select set_token_param('rate', '0.5'::jsonb)`);
  await as(null, D);
  const n1 = await val(`select coin_salary_tick() v`);
  ok(n1 > 0 && (await val(`select coin_salary_tick() v`)) === 0, '每人每期只发一次', String(n1));
  await as(U.mem2, D);
  const cm = await one(`select balance::float b, salary::float s from api.coin_mine`);
  ok(cm.b === cm.s && cm.s > 0, '按身份发到本人账户', JSON.stringify(cm));
  await raises('只能投给研究单元', /只能投给已成立的研究单元/, `select invest_coins((select parent_id from api.project where id = $1), 10)`, [UU]);
  await raises('余额不足', /实际币不足/, `select invest_coins($1, 100000)`, [UU]);
  await q(`select invest_coins($1, 30, '补实验')`, [UU]);
  ok((await one(`select balance::float b from api.coin_mine`)).b === cm.b - 30, '投给研究单元，从个人账上扣');
  await raises('成员不能换卡时', /负责人办理/, `select buy_compute($1, 10)`, [UU]);
  await as(own, D);
  await raises('卡时须为整数', /卡时须为正整数/, `select buy_compute($1, 1.5)`, [UU]);
  await raises('研究单元的实际币不足', /研究单元的实际币不足/, `select buy_compute($1, 1000)`, [UU]);
  await q(`select buy_compute($1, 10)`, [UU]);
  const ub = await one(`select balance::float b, hours::float h from api.unit_coin_balance where project_id = $1`, [UU]);
  ok(ub.b === 10 && ub.h >= 10, '负责人用研究单元的实际币按标价换卡时，集群一侧可读', JSON.stringify(ub));
  await as(U.mem, D);
  ok((await q(`select 1 from api.unit_coin where project_id = $1`, [UU])).length >= 2, '研究单元的实际币账全中心看得到');
  // 铸造：研究单元有经核对的一级成果
  await db.exec(`reset role`);
  const hasOut = (await q(`select 1 from outcome where project_id = $1 and level = 1 and checked_at is not null and not rejected`, [UU])).length > 0;
  if (!hasOut) await q(`insert into outcome (project_id, level, link, submitted_by, checked_by, checked_at) values ($1, 1, 'https://arxiv.org/abs/3506.00001', $2, $2, now())`, [UU, own]);
  await db.exec(`set role app_api`);
  await as(null, D);
  const mn = await val(`select coin_mint_tick() v`);
  ok(mn > 0 && (await val(`select coin_mint_tick() v`)) === 0, '解锁后按份额铸造，同一级只铸一次', String(mn));
  // 到期
  await as(null, '2040-01-01');
  ok((await val(`select coin_expire_tick() v`)) > 0, '到期的作废');
  await as(U.mem2, '2040-01-01');
  ok(Number((await one(`select balance from api.coin_mine`)).balance) === 0, '作废后余额为零');
  await as(U.mem2, D);
  ok((await q(`select kind from api.coin_ledger`)).some((l) => l.kind === 'expire'), '流水里看得到作废');
  await as(null);
}

// ---------- GitHub 事件发到协助群 ----------
{
  await as(U.mem2);
  await raises('登录用户不能直接入队 GitHub 事件', /当前角色/, `select github_notice('d-1', 'PR 待审：#1 示例')`);
  await as(null);
  ok((await val(`select github_notice('d-1', 'PR 待审：#1 示例', 'https://github.com/example/repo/pull/1', '查看 PR') v`)) === true, 'GitHub 事件入队');
  ok((await val(`select github_notice('d-1', 'PR 待审：#1 示例') v`)) === false, '同一次投递重发的不再入队');
  await raises('内容为空的不入队', /内容为空/, `select github_notice('d-2', '  ')`);
  await db.exec(`reset role`);
  const rows = await q(`select target, payload from feishu_outbox where payload->>'text' like 'PR 待审：#1%'`);
  ok(rows.length === 1 && rows[0].target === 'assist' && rows[0].payload.kind === 'post' && rows[0].payload.btn === '查看 PR', '对象为协助群，按通报发', JSON.stringify(rows));
  await db.exec(`set role app_api`);
}

// ---------- 协助群话题：一个 PR 一个 ----------
{
  await as(null);
  ok((await val(`select github_notice('d-9', 'PR 待审：#9 示例', null, null, 'pr:9') v`)) === true, '带话题键入队');
  await raises('话题键不对的不入队', /话题键不对/, `select github_notice('d-10', 'PR 待审：#10 示例', null, null, 'assist')`);
  await db.exec(`reset role`);
  ok((await val(`select payload->>'thread' v from feishu_outbox where payload->>'text' like 'PR 待审：#9%'`)) === 'pr:9', '队列里记着话题键');
  await db.exec(`set role app_api`);
  await as(U.dir);
  await raises('登录用户不能改话题', /当前角色/, `select notice_thread_set('pr:9', 'om_x')`);
  ok((await val(`select notice_thread('pr:9') v`)) === null, '登录用户读不到话题编号');
  await as(null);
  ok((await val(`select notice_thread('pr:9') v`)) === null, '还没有话题');
  await q(`select notice_thread_set('pr:9', 'om_root9')`);
  await q(`select notice_thread_set('pr:10', 'om_root10')`);
  ok((await val(`select notice_thread('pr:9') v`)) === 'om_root9' && (await val(`select notice_thread('pr:10') v`)) === 'om_root10', '各 PR 各记各的根消息');
  await raises('不再有共用话题', /check|违反|约束/i, `select notice_thread_set('assist', 'om_x')`);
  await q(`select notice_thread_set('pr:9', null)`);
  ok((await val(`select notice_thread('pr:9') v`)) === null, '清掉后重开');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
