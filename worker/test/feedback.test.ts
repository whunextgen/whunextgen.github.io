// 反馈转 GitHub issue：标题带编号和第一行，正文记下提交人、北京时间和页面
import { feedbackIssue } from '../src/index.ts';
let bad = 0, n = 0; const ok = (c: unknown, name: string, extra = '') => { n++; if (!c) { bad++; console.log('FAIL', name, extra); } };
const i = feedbackIssue({ seq: 7, body: '双选页的筛选点了没反应\n第二行细节', page: '#/select', page_title: '双选', user_name: '示例成员', created_at: '2026-11-26T02:30:00Z' });
ok(i.title === '[反馈 #7] 双选页的筛选点了没反应', '标题', i.title);
ok(i.body.includes('**提交人**：示例成员') && i.body.includes('2026-11-26 10:30（北京时间）') && i.body.includes('双选（https://clain-finance.pages.dev/#/select）') && i.body.includes('第二行细节'), '正文', i.body);
ok(feedbackIssue({ seq: 8, body: 'x', page: null, page_title: null, user_name: 'a', created_at: new Date() }).body.includes('**页面**：未记录'), '没有页面');
console.log(bad ? `feedback: ${bad}/${n} failed` : `feedback: all passed (${n})`);
if (bad) process.exit(1);
