// 通知卡片：句式 → 标题、分项、跳转页面
import { noticeCard, inFeishu, taskCall } from '../src/index.ts';
let bad = 0, n = 0; const ok = (c: unknown, name: string, extra = '') => { n++; if (!c) { bad++; console.log('FAIL', name, extra); } };
const O = 'https://example.test';
const parts = (text: string, by?: string, more: object = {}) => {
  const { title, view: v } = noticeCard({ text, by, at: '11-24 01:00', ...more }, O);
  return { title, fields: Object.fromEntries(v.fields), text: v.text, btn: { url: v.btn.url, type: v.btn.type, text: { content: v.btn.text } }, note: v.note, sub: v.sub, kind: v.kind, tag: v.tag };
};
const els = (b: any, id?: string, marks?: any) => { const body = (noticeCard(b, O, id, marks).card.body.elements as any[]); return { bar: body[0], main: body[1].columns[0].elements as any[] }; };
const button = (b: any, id?: string) => els(b, id).main.find((x) => x.tag === 'button');
let c = parts('研究单元申请待同意：甲 申请在课题「课题一」之下成立「单元一」，使用该课题的预算。请在「课题管理」中同意或退回', '甲');
ok(c.title === '研究单元申请待同意' && c.fields['申请人'] === '甲' && c.fields['所挂课题'] === '课题一' && c.fields['研究单元'] === '单元一', '待同意：标题和分项', JSON.stringify(c));
ok(c.btn.url === O + '/#/projects' && c.btn.text.content === '前往办理' && c.kind === 'todo' && c.tag === '待办', '待同意：按钮去课题管理，归为待办', JSON.stringify(c.btn));
ok(c.text === '使用该课题的预算。请在「课题管理」中同意或退回' && c.note === '正则 · 经办：甲' && c.sub === '11-24 01:00 北京时间', '待同意：正文只留余下的话，落款有经办人，时间在顶栏副行', JSON.stringify(c));
c = parts('研究单元申请待核对：甲 申请成立「单元一」，挂在课题「课题一」之下，课题负责人已同意，联席会议 2032-06-04 通过');
ok(c.title === '研究单元申请待核对' && c.fields['联席会议通过'] === '2032-06-04' && c.fields['研究单元'] === '单元一' && c.text === '课题负责人已同意', '待核对：会议日期进分项', JSON.stringify(c));
ok(c.note === '正则', '没有经办人时落款不留空位', c.note);
c = parts('研究单元「单元一」已成立，挂在课题「课题一」之下。本人为负责人，可管理成员名单，并请登记本期双周表');
ok(c.title === '研究单元已成立' && c.btn.url.endsWith('/#/projects') && c.text === '本人为负责人，可管理成员名单，并请登记本期双周表' && c.kind === 'pass' && c.btn.type === 'text', '已成立：标题按句式定，双周表字样不改去向，归为通过', JSON.stringify(c));
c = parts('研究单元「单元一」已成立，挂在课题「课题一」之下。本人为负责人，可管理成员名单', undefined, { url: '#/project/abc-123' });
ok(c.btn.url === O + '/#/project/abc-123', '站内链接直达那一页（#127）', c.btn.url);
c = parts('反馈已收到：你的第 3、5 号反馈已转为议题 #9、#11', undefined, { url: 'javascript:alert(1)' });
ok(c.btn.url === O + '/#/', '不认的链接不用', c.btn.url);
{ const sm = (noticeCard({ text: '研究单元申请待同意：甲 申请在课题「课题一」之下成立「单元一」，使用该课题的预算。' }, O).card as any).config.summary.content;
  ok(sm.startsWith('研究单元申请待同意；') && sm.includes('研究单元 单元一'), '卡片摘要带上要点，旧版网页至少看得到摘要（#138）', sm); }
c = parts('研究单元申请待同意：甲 申请在课题「课题一」之下成立「单元一」，使用该课题的预算。', '甲', { act: { kind: 'unit_consent', unit: '11111111-2222-3333-4444-555555555555' } });
ok(c.btn.url === O + '/#/projects/11111111-2222-3333-4444-555555555555', '研究单元申请的卡片直达那一笔（#136）', c.btn.url);
{ const m = els({ text: '议题分工：一句', group: true, kind: 'post', mention_ids: [{ id: 'ou_0123456789abcdef', name: '甲' }, { id: 'bad"></at>', name: '乙' }] }).main;
  const md = m.find((x: any) => x.tag === 'markdown' && String(x.content).includes('<at id=ou_'));
  ok(md && md.content === '<at id=ou_0123456789abcdef></at>', '群通知 @ 具体的人，编号不合法的不放', JSON.stringify(md)); }
c = parts('乙 给你派了任务「整理双周表和预算」');
ok(c.title === '任务' && c.btn.url.endsWith('/#/tasks') && c.text === '乙 给你派了任务「整理双周表和预算」' && c.kind === 'todo' && c.sub === '11-24 01:00 北京时间', '书名号里的字不参与归类；派任务归为待办', JSON.stringify(c));
c = parts('2032 年度评定完成：课题「课题一」定为「甲档」，年度上限 100 元');
ok(c.title === '2032 年度评定完成' && c.btn.url.endsWith('/#/plan') && c.btn.text.content === '前往查看' && c.kind === 'fyi' && c.sub === '年度评定 · 11-24 01:00 北京时间', '冒号前的短语作标题，业务类别进副行，归为知会', JSON.stringify(c));
c = parts('一句认不出的话');
ok(c.title === '通知' && c.btn.url === O + '/#/' && c.text === '一句认不出的话', '认不出的句式整句放正文，按钮回首页', JSON.stringify(c));
c = parts('研究单元立项提醒：你作为第一作者的项目「甲」还没有提交研究单元立项申请。\n请在 11 月 24 日 24:00 前完成', '乙');
ok(c.title === '研究单元立项提醒' && c.btn.url.endsWith('/#/projects') && c.btn.text.content === '前往办理' && c.text!.includes('\n') && c.kind === 'remind', '立项提醒去课题管理页，正文保留换行，归为提醒', JSON.stringify(c));
c = parts('研究单元成立：研究单元「单元一」已成立，挂在课题「课题一」之下，负责人 甲', '乙', { group: true });
ok(c.title === '研究单元成立' && c.fields['研究单元'] === '单元一' && c.fields['所挂课题'] === '课题一' && c.text === '负责人 甲' && c.btn.url.endsWith('/#/projects') && c.kind === 'post' && c.tag === '通报', '群里的成立公告：分项和负责人，归为通报', JSON.stringify(c));
c = parts('双周表登记情况：本期 11-23 至 12-06，应登记 3 个研究单元，已登记 1 个，未登记 2 个。\n未登记\n· 单元一（甲）');
ok(c.title === '双周表登记情况' && c.btn.url.endsWith('/#/biweekly') && c.text!.includes('\n· 单元一（甲）'), '双周表汇总去双周表页，名单分行', JSON.stringify(c));
{ const b2 = button({ text: '说明：已放到知识库', url: 'https://example.test/wiki/x', btn: '查看说明' });
  ok(b2.behaviors[0].default_url === 'https://example.test/wiki/x' && b2.text.content === '查看说明', '通知自带链接的，按钮去该链接', JSON.stringify(b2));
  const b3 = button({ text: '说明：已放到知识库', url: 'javascript:alert(1)', btn: '查看说明' });
  ok(b3.behaviors[0].default_url === O + '/#/' && b3.text.content === '前往查看', '不是 https 的链接不用', JSON.stringify(b3)); }
{ const e1 = els({ text: '公告：一句话', all: true }).main, e2 = els({ text: '公告：一句话' }).main;
  ok(e1[0].tag === 'markdown' && e1[0].content === '<at id=all></at>' && !e2.some((x) => x.tag === 'markdown'), '标了 @所有人 的卡片首行提到所有人，没标的不提', JSON.stringify(e1[0])); }
c = parts('研究单元改名：甲 把课题「课题一」之下的研究单元 P-01-01 由「旧名」改为「新名」', '甲');
ok(c.title === '研究单元改名' && c.btn.url.endsWith('/#/projects') && c.kind === 'fyi' && c.sub === '改名 · 11-24 01:00 北京时间', '改名通知去课题管理页，归为知会', JSON.stringify(c));
{ const btn = (b: any, id?: string) => button(b, id).behaviors[0].default_url as string;
  const u = btn({ text: '支出申请待审批：甲 提交了一笔' }, 'app_demo');
  ok(u.startsWith('https://applink.feishu.cn/client/web_app/open?appId=app_demo&lk_target_url=') && decodeURIComponent(u.split('lk_target_url=')[1]).startsWith(O + '/#/') && !u.split('lk_target_url=')[1].includes('#'), '中台页面走应用链接，目标地址整体转码', u);
  ok(btn({ text: '说明：已放到知识库', url: 'https://feishu.test/wiki/x', btn: '查看说明' }, 'app_demo') === 'https://feishu.test/wiki/x', '站外链接不动');
  ok(btn({ text: '说明：一句', url: O + '/', btn: '前往中台' }, 'app_demo').startsWith('https://applink.feishu.cn/'), '指定的中台链接也走应用链接');
  ok(btn({ text: '支出申请待审批：甲 提交了一笔' }).startsWith(O + '/#/'), '没有应用标识时保持原链接');
  ok(inFeishu(O + '.evil.test/x', O, 'app_demo') === O + '.evil.test/x', '前缀相同的别的域名不算中台'); }
c = parts('研究单元申请「」已退回：原因是名称重复'.replace('「」', '「单元一」'));
ok(c.kind === 'back' && c.tag === '已退回' && c.btn.text.content === '前往办理', '退回归为退回，要去办', JSON.stringify(c));
c = parts('双周表登记提醒：本期明日截止', undefined, { group: true, all: true });
ok(c.kind === 'remind', '群里的截止提醒归为提醒', c.kind);
c = parts('双周表登记情况：本期已登记 1 个', undefined, { group: true });
ok(c.kind === 'post', '群里的登记情况归为通报', c.kind);
c = parts('正则更新说明：v9.9.9（2033-01-01）\n新增\n1. 一条', '甲', { group: true, tag: 'v9.9.9' });
ok(c.kind === 'post' && c.tag === 'v9.9.9' && c.title === '正则更新说明', '更新说明：通报，右上角是版本号', JSON.stringify(c));
ok(parts('一句话', undefined, { kind: 'pass' }).kind === 'pass' && parts('一句话', undefined, { kind: 'nope' }).kind === 'fyi', '通知可以自带类别，不认识的类别不用');
{ const hostile = '<at id=all></at> **粗** [链](https://x.test)';
  const e = els({ text: `研究单元申请待同意：甲 申请在课题「${hostile}」之下成立「单元一」。请办理` });
  const texts = JSON.stringify(e).match(/"tag":"markdown"/g);
  ok(!texts && JSON.stringify(e).includes('"tag":"plain_text","content":"<at id=all></at> **粗** [链](https://x.test)"'), '业务文字按纯文本放，带标记的名称不会被解析成提到所有人或链接', JSON.stringify(e).slice(0, 300)); }
{ const a1 = els({ text: '研究单元申请待同意：一句。请办理' }, undefined, { red: 'img_r', white: 'img_w' }), a2 = els({ text: '研究单元改名：一句' }, undefined, { red: 'img_r', white: 'img_w' }), a3 = els({ text: '研究单元改名：一句' });
  ok(a1.bar.background_style === 'zz-brand' && a1.bar.columns[0].elements[0].img_key === 'img_w' && a2.bar.background_style === 'zz-raise' && a2.bar.columns[0].elements[0].img_key === 'img_r' && a3.bar.columns.length === 2, '待办顶栏砖红底配白底标志，其余配砖红标志；没有标志图时不放图', JSON.stringify(a3.bar).slice(0, 200));
  const full = noticeCard({ text: '研究单元改名：一句' }, O).card as any;
  ok(full.schema === '2.0' && !full.header && full.body.padding === '0px 0px 0px 0px' && full.config.summary.content === '研究单元改名；一句', '不用飞书自带标题栏，会话列表里的摘要是标题和要点'); }
{ const e = els({ text: '研究单元申请「单元一」已退回：名称重复，请修改' }).main;
  ok(e.some((x) => x.tag === 'interactive_container' && x.background_style === 'zz-bad-bg'), '退回的原因单独框出', JSON.stringify(e).slice(0, 200)); }
{ const body = { text: '研究单元申请待同意：甲 申请在课题「课题一」之下成立「单元一」，使用该课题的预算。请在「课题管理」中同意或退回', at: '11-24 01:00 北京时间', act: { kind: 'unit_consent', unit: '00000000-0000-0000-0000-000000000001' } };
  const main = (b: any, tok?: string) => (noticeCard(b, O, undefined, { red: 'img_r', white: 'img_w' }, tok).card.body.elements as any[])[1].columns[0].elements as any[];
  const withTok = main(body, 'tok-1'), rowEl = withTok.find((x) => x.tag === 'column_set' && x.columns.length === 2 && x.columns[0].elements[0]?.tag === 'button');
  const yes = rowEl?.columns[0].elements[0], no = rowEl?.columns[1].elements[0];
  ok(yes?.text.content === '同意' && yes.behaviors[0].type === 'callback' && yes.behaviors[0].value.t === 'tok-1' && yes.confirm?.title.content && no?.text.content === '退回' && no.behaviors[0].type === 'open_url' && no.type === 'danger_text', '带动作和凭据的待办：同意是回调并要二次确认，退回去页面', JSON.stringify(rowEl).slice(0, 300));
  ok(!withTok.some((x) => x.tag === 'button'), '有同意和退回时不再另放去页面的按钮');
  const noTok = main(body);
  ok(noTok.filter((x) => x.tag === 'button').length === 1 && !JSON.stringify(noTok).includes('callback'), '没有凭据时只有去页面的按钮');
  ok(!JSON.stringify(main({ ...body, group: true }, 'tok-1')).includes('callback') && !JSON.stringify(main({ ...body, act: { kind: 'other' } }, 'tok-1')).includes('callback'), '发到群里的、动作不认识的，都不放同意按钮');
  const d = noticeCard({ ...body, done: '你已同意 · 11-24 02:00' }, O), dm = (d.card.body.elements as any[])[1].columns[0].elements as any[];
  ok(d.view.kind === 'pass' && d.title === '研究单元申请已同意' && !JSON.stringify(dm).includes('callback') && dm.some((x) => x.tag === 'interactive_container' && x.background_style === 'zz-ok-bg' && x.elements[0].text.content === '你已同意 · 11-24 02:00') && dm.find((x) => x.tag === 'button')?.text.content === '查看', '办完后的卡片：标题改为已同意，绿框写明，按钮只剩查看', JSON.stringify(dm).slice(0, 300)); }
{ const m = (b: any) => els(b).main, J = (x: unknown) => JSON.stringify(x);
  const d1 = m({ text: '双周表登记情况：本期 11-23 至 12-06，应登记 4 个研究单元，已登记 1 个，未登记 3 个。\n已登记\n· 单元一（甲）\n未登记\n· 单元二（乙）\n· 单元三（丙）\n· **单元四**（丁）', group: true });
  const nums = d1.find((x) => x.tag === 'column_set' && x.columns.length === 3), bar = d1.find((x) => x.tag === 'markdown'), folds = d1.filter((x) => x.tag === 'collapsible_panel');
  ok(nums && nums.columns.map((c2: any) => c2.elements[1].text.content).join('/') === '4/1/3', '双周表通报：三个数并排', J(nums).slice(0, 200));
  ok(bar && (bar.content.match(/━/g) ?? []).length === 20 && bar.content.includes('25%') && !bar.content.includes('单元'), '进度条按已登记的比例画，里面没有业务文字', bar?.content);
  ok(folds.length === 2 && folds[0].header.title.content === '已登记（1）' && folds[1].header.title.content === '未登记（3）' && folds.every((x) => x.expanded === false) && folds[1].elements[0].text.tag === 'plain_text' && folds[1].elements[0].text.content.includes('**单元四**'), '名单按小标题折叠并标数量，名称按纯文本放', J(folds).slice(0, 300));
  const d2 = m({ text: '双周表登记提醒：本期 11-23 至 12-06 明日截止，尚有 2 个研究单元未登记，请负责人或名单内成员尽快登记。\n未登记\n· 单元二（乙）\n· 单元三（丙）', group: true, all: true });
  ok(d2.find((x) => x.tag === 'collapsible_panel')?.expanded === true && !d2.some((x) => x.tag === 'column_set' && x.columns.length === 3), '截止前的提醒：未登记名单展开，没有三个数时不画进度');
  const r1 = m({ text: '正则更新说明：v9.9.9（2033-01-01）\n新增\n1. 甲\n2. 乙\n3. 丙\n调整\n4. 丁\n5. 戊\n说明\n6. 己', group: true, tag: 'v9.9.9' });
  const shown = J(r1.filter((x) => x.tag !== 'collapsible_panel')), f1 = r1.find((x) => x.tag === 'collapsible_panel');
  ok(shown.includes('1. 甲') && shown.includes('4. 丁') && !shown.includes('5. 戊') && f1?.header.title.content === '其余 2 条，点开查看' && f1.elements[0].text.content === '调整\n5. 戊\n说明\n6. 己', '更新说明：露出前四条，其余带着小标题折叠', J(f1));
  const r2 = m({ text: '正则更新说明：v9.9.9\n新增\n1. 甲', group: true });
  ok(!r2.some((x) => x.tag === 'collapsible_panel'), '条目少的更新说明不折叠');
  const p1 = m({ text: '研究单元立项提醒：你的项目还没有提交。\n说明\n请尽快' });
  ok(p1.some((x) => x.tag === 'collapsible_panel') === false, '发给个人的提醒里出现小标题字样时不拆成名单', J(p1).slice(0, 200)); }
{ const base = { target_id: 'on_abc', summary: '登记双周表：单元一（08-23 至 09-05）', due: '2032-09-05', task_guid: null as string | null };
  const c1 = taskCall({ ...base, act: 'create' }, O, 'app_demo') as any;
  ok(c1.method === 'POST' && c1.path === '/task/v2/tasks?user_id_type=union_id' && c1.body.summary === base.summary && c1.body.due.is_all_day === true && c1.body.due.timestamp === String(Date.UTC(2032, 8, 5)) && c1.body.members[0].id === 'on_abc' && c1.body.members[0].role === 'assignee' && c1.body.origin.href.url.startsWith('https://applink.feishu.cn/'), '建任务：负责人为执行人，截止日为全天，带回中台的链接', JSON.stringify(c1));
  ok((taskCall({ ...base, act: 'create', target_id: 'ou_abc' }, O) as any).path.endsWith('user_id_type=open_id'), '没有跨应用标识的按本应用标识建');
  const c2 = taskCall({ ...base, act: 'done', task_guid: 'guid-0001' }, O, undefined, 1234) as any;
  ok(c2.method === 'PATCH' && c2.path === '/task/v2/tasks/guid-0001' && c2.body.task.completed_at === '1234' && c2.body.update_fields[0] === 'completed_at', '登记后把任务标为完成');
  ok((taskCall({ ...base, act: 'drop', task_guid: 'guid-0001' }, O) as any).method === 'DELETE' && taskCall({ ...base, act: 'drop' }, O) === null && taskCall({ ...base, act: 'done', task_guid: '../x' }, O) === null, '撤任务用删除；没有任务编号或编号不像编号的不调用'); }
{ const m = els({ text: '登记截止通报：本期应登记 4 个研究单元，已登记 1 个，未登记 3 个。\n第二句是规矩。\n第三句也是。\n未登记\n· 单元二（乙）', group: true }).main;
  const ps = m.filter((x) => x.tag === 'div').map((x) => [x.text.content, x.text.text_size]);
  ok(ps.some(([c2, z]) => c2.startsWith('本期应登记') && z === 'notation') && ps.some(([c2, z]) => c2 === '第二句是规矩。\n第三句也是。' && z === 'normal'), '带数字的通报：第一句小字，其余的话照常显示', JSON.stringify(ps)); }
{
  // 带图的通报：图在正文下面、按钮上面，图下一行小字；没传上图的不出现
  const main = (b: any) => (noticeCard(b, O).card.body.elements as any[])[1].columns[0].elements as any[];
  const m = main({ text: '分数画像：一句话', kind: 'post', group: true, img_key: 'img_x', img_note: '数据来源：某处' });
  const at = m.findIndex((x) => x.tag === 'img');
  ok(at > 0 && m[at].img_key === 'img_x' && m[at + 1].text.content === '数据来源：某处' && m.slice(at + 2).some((x) => x.tag === 'button'), '带图的通报：图、图下说明、按钮依次排');
  ok(!main({ text: '分数画像：一句话', kind: 'post', group: true, img: 'AAAA', img_note: '数据来源：某处' }).some((x) => x.tag === 'img'), '图没传上去的卡片不带图');
}
c = parts('ARR 担保申请待答复：甲 申请由你为研究单元「单元一」在「2033 年 5 月」一轮的 ARR 投稿担保。请在该研究单元页面答复', '甲');
ok(c.title === 'ARR 担保申请待答复' && c.btn.url === O + '/#/' && c.btn.text.content === '前往办理' && c.kind === 'todo', 'ARR 担保申请：标题取冒号前，按钮回首页待办，归为待办', JSON.stringify(c));
c = parts('ARR 担保申请已同意：乙 同意为研究单元「单元一」在「2033 年 5 月」一轮的 ARR 投稿担保');
ok(c.title === 'ARR 担保申请已同意' && c.kind === 'pass', 'ARR 担保已同意归为通过', JSON.stringify(c));
c = parts('ARR 担保申请不同意：乙 不同意为研究单元「单元一」在「2033 年 5 月」一轮的 ARR 投稿担保，原因：时间冲突');
ok(c.title === 'ARR 担保申请不同意' && c.kind === 'back', 'ARR 担保不同意归为退回', JSON.stringify(c));
c = parts('主线任务已认定：「开题」已由 甲 确认完成（2033-01-01）', '甲');
ok(c.title === '主线任务已认定' && c.btn.url.endsWith('/#/path') && c.kind === 'pass', '主线任务认定：去成长主线页，归为通过', JSON.stringify(c));
c = parts('身份认定：你的身份已由 甲 认定为 Assistant（RA）（原为 Intern（RI））。依据：考核通过', '甲');
ok(c.title === '身份认定' && c.btn.url.endsWith('/#/path'), '身份认定：去成长主线页', JSON.stringify(c));
c = parts('快照待接收：研究单元「单元一」把第 2 次快照提交给「认知基础」主题研讨会，请决定是否接收讨论', '甲');
ok(c.btn.url.endsWith('/#/iterate') && c.kind === 'todo', '快照待接收：去快照与质疑页，归为待办', JSON.stringify(c));
c = parts('质疑已回应：研究单元「单元一」的质疑（理：为什么值得做）本期无人再提，记 8 名义币，进入研究单元的池子', '甲');
ok(c.btn.url.endsWith('/#/iterate'), '质疑已回应：去快照与质疑页', JSON.stringify(c));
c = parts('RA 考核未通过：结果不能核对。可在下一期重新申请', '甲');
ok(c.btn.url.endsWith('/#/path') && c.kind === 'back', 'RA 考核未通过：去成长主线页，归为退回', JSON.stringify(c));
console.log(bad ? `${bad} failed` : `notice: all passed (${n})`); process.exit(bad ? 1 : 0);
