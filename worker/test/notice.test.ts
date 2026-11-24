// 通知卡片：句式 → 标题、分项、跳转页面
import { noticeCard } from '../src/index.ts';
let bad = 0, n = 0; const ok = (c: unknown, name: string, extra = '') => { n++; if (!c) { bad++; console.log('FAIL', name, extra); } };
const O = 'https://example.test';
const parts = (text: string, by?: string) => {
  const { title, card } = noticeCard({ text, by, at: '11-24 01:00' }, O); const e = card.elements as any[];
  const fields = Object.fromEntries((e.find((x) => x.fields)?.fields ?? []).map((f: any) => f.text.content.split('：')));
  return { title, fields, text: e.find((x) => x.tag === 'div' && x.text)?.text.content as string | undefined, btn: e.find((x) => x.tag === 'action').actions[0], note: e.find((x) => x.tag === 'note').elements[0].content as string, color: card.header.template };
};
let c = parts('研究单元申请待同意：甲 申请在课题「课题一」之下成立「单元一」，使用该课题的预算。请在「课题管理」中同意或退回', '甲');
ok(c.title === '研究单元申请待同意' && c.fields['申请人'] === '甲' && c.fields['所挂课题'] === '课题一' && c.fields['研究单元'] === '单元一', '待同意：标题和分项', JSON.stringify(c));
ok(c.btn.url === O + '/#/projects' && c.btn.text.content === '前往办理' && c.color === 'red', '待同意：按钮去课题管理', JSON.stringify(c.btn));
ok(c.text === '使用该课题的预算。请在「课题管理」中同意或退回' && c.note === '正则 · 经办：甲 · 11-24 01:00', '待同意：正文只留余下的话，落款有经办人和时间', JSON.stringify(c));
c = parts('研究单元申请待核对：甲 申请成立「单元一」，挂在课题「课题一」之下，课题负责人已同意，联席会议 2032-06-04 通过');
ok(c.title === '研究单元申请待核对' && c.fields['联席会议通过'] === '2032-06-04' && c.fields['研究单元'] === '单元一' && c.text === '课题负责人已同意', '待核对：会议日期进分项', JSON.stringify(c));
ok(c.note === '正则 · 11-24 01:00', '没有经办人时落款不留空位', c.note);
c = parts('研究单元「单元一」已成立，挂在课题「课题一」之下。本人为负责人，可管理成员名单，并请登记本期双周表');
ok(c.title === '研究单元已成立' && c.btn.url.endsWith('/#/projects') && c.text === '本人为负责人，可管理成员名单，并请登记本期双周表', '已成立：标题按句式定，双周表字样不改去向', JSON.stringify(c));
c = parts('乙 给你派了任务「整理双周表和预算」');
ok(c.title === '任务' && c.btn.url.endsWith('/#/tasks') && c.text === '乙 给你派了任务「整理双周表和预算」', '书名号里的字不参与归类', JSON.stringify(c));
c = parts('2032 年度评定完成：课题「课题一」定为「甲档」，年度上限 100 元');
ok(c.title === '2032 年度评定完成' && c.btn.url.endsWith('/#/plan') && c.btn.text.content === '前往查看' && c.color === 'grey', '冒号前的短语作标题', JSON.stringify(c));
c = parts('一句认不出的话');
ok(c.title === '通知' && c.btn.url === O + '/#/' && c.text === '一句认不出的话', '认不出的句式整句放正文，按钮回首页', JSON.stringify(c));
c = parts('研究单元立项提醒：你作为第一作者的项目「甲」还没有提交研究单元立项申请。\n请在 11 月 24 日 24:00 前完成', '乙');
ok(c.title === '研究单元立项提醒' && c.btn.url.endsWith('/#/projects') && c.btn.text.content === '前往办理' && c.text!.includes('\n'), '立项提醒去课题管理页，正文保留换行', JSON.stringify(c));
c = parts('研究单元成立：研究单元「单元一」已成立，挂在课题「课题一」之下，负责人 甲', '乙');
ok(c.title === '研究单元成立' && c.fields['研究单元'] === '单元一' && c.fields['所挂课题'] === '课题一' && c.text === '负责人 甲' && c.btn.url.endsWith('/#/projects') && c.color === 'grey', '群里的成立公告：分项和负责人', JSON.stringify(c));
c = parts('双周表登记情况：本期 11-23 至 12-06，应登记 3 个研究单元，已登记 1 个，未登记 2 个。\n未登记\n· 单元一（甲）');
ok(c.title === '双周表登记情况' && c.btn.url.endsWith('/#/biweekly') && c.text!.includes('\n· 单元一（甲）'), '双周表汇总去双周表页，名单分行', JSON.stringify(c));
{ const k = noticeCard({ text: '说明：已放到知识库', url: 'https://example.test/wiki/x', btn: '查看说明' }, O).card.elements as any[]; const b2 = k.find((x) => x.tag === 'action').actions[0];
  ok(b2.url === 'https://example.test/wiki/x' && b2.text.content === '查看说明', '通知自带链接的，按钮去该链接', JSON.stringify(b2));
  const k2 = noticeCard({ text: '说明：已放到知识库', url: 'javascript:alert(1)', btn: '查看说明' }, O).card.elements as any[]; const b3 = k2.find((x) => x.tag === 'action').actions[0];
  ok(b3.url === O + '/#/' && b3.text.content === '前往查看', '不是 https 的链接不用', JSON.stringify(b3)); }
{ const e1 = noticeCard({ text: '公告：一句话', all: true }, O).card.elements as any[], e2 = noticeCard({ text: '公告：一句话' }, O).card.elements as any[];
  ok(e1[0].text?.tag === 'lark_md' && e1[0].text.content === '<at id=all></at>' && !e2.some((x) => x.text?.tag === 'lark_md'), '标了 @所有人 的卡片首行提到所有人，没标的不提', JSON.stringify(e1[0])); }
console.log(bad ? `${bad} failed` : `notice: all passed (${n})`); process.exit(bad ? 1 : 0);
