// GitHub 事件：只发中台分支上的 PR，签名不对的不收
import { createHmac } from 'node:crypto';
import { githubText, githubSigned, noticeCard } from '../src/index.ts';
let bad = 0, n = 0; const ok = (c: unknown, name: string, extra = '') => { n++; if (!c) { bad++; console.log('FAIL', name, extra); } };
const pr = (more: object = {}) => ({ number: 7, title: '示例改动', html_url: 'https://github.com/example/repo/pull/7', draft: false, merged: false,
  user: { login: 'alice' }, head: { ref: 'feat-x' }, base: { ref: 'finance-portal' }, ...more });

let t = githubText('pull_request', { action: 'opened', pull_request: pr() });
ok(t?.text.startsWith('PR 待审：#7 示例改动\n提交人 alice · 分支 feat-x → finance-portal') && t.url.endsWith('/pull/7'), '开出 PR：待审', JSON.stringify(t));
ok(githubText('pull_request', { action: 'opened', pull_request: pr({ draft: true }) }) === null, '草稿 PR 不发');
ok(githubText('pull_request', { action: 'ready_for_review', pull_request: pr() })?.text.startsWith('PR 待审'), '草稿转为待审时发');
ok(githubText('pull_request', { action: 'opened', pull_request: pr({ base: { ref: 'main' } }) }) === null, '不是中台分支的 PR 不发');
ok(githubText('pull_request', { action: 'synchronize', pull_request: pr() }) === null, '推送新提交不发');
t = githubText('pull_request', { action: 'closed', pull_request: pr({ merged: true, merged_by: { login: 'bob' } }) });
ok(t?.text.startsWith('PR 已合并：#7 示例改动\n合并人 bob'), '合并', JSON.stringify(t));
t = githubText('pull_request', { action: 'closed', sender: { login: 'carol' }, pull_request: pr() });
ok(t?.text.startsWith('PR 已关闭：#7 示例改动\n关闭人 carol'), '关闭未合并', JSON.stringify(t));
t = githubText('pull_request_review', { action: 'submitted', pull_request: pr(), review: { state: 'approved', user: { login: 'dan' }, body: '', html_url: 'https://github.com/example/repo/pull/7#pullrequestreview-1' } });
ok(t?.text === 'PR 审查通过：#7 示例改动\n审查人 dan · 提交人 alice · 分支 feat-x → finance-portal' && t.url.endsWith('review-1') && t.btn === '查看审查', '审查通过', JSON.stringify(t));
t = githubText('pull_request_review', { action: 'submitted', pull_request: pr(), review: { state: 'commented', user: { login: 'dan' }, body: '长'.repeat(400) } });
ok(t?.text.startsWith('PR 审查意见：') && t.text.endsWith('……') && t.text.length < 400 && t.url.endsWith('/pull/7'), '审查意见截断到 300 字，链接不对时回 PR', String(t?.text.length));
ok(githubText('pull_request_review', { action: 'submitted', pull_request: pr(), review: { state: 'changes_requested', user: { login: 'dan' } } })?.text.startsWith('PR 要求修改'), '要求修改');
ok(githubText('pull_request', { action: 'opened', pull_request: pr({ html_url: 'javascript:alert(1)' }) }) === null, '链接不是 GitHub 的不发');
ok(githubText('push', { ref: 'refs/heads/finance-portal' }) === null, '其他事件不发');
ok(t?.thread === 'pr:7' && githubText('pull_request', { action: 'closed', pull_request: pr({ merged: true }) })?.thread === 'pr:7', '同一个 PR 的通报在同一个话题', String(t?.thread));
ok(githubText('pull_request', { action: 'opened', pull_request: pr({ number: 8 }) })?.thread === 'pr:8', '不同的 PR 各开一个话题');
ok(githubText('pull_request', { action: 'opened', pull_request: pr({ number: '7; x' }) }) === null, 'PR 编号不对的不发');
{ const v = noticeCard({ text: githubText('pull_request', { action: 'opened', pull_request: pr() })!.text, url: 'https://github.com/example/repo/pull/7', btn: '查看 PR', kind: 'post', group: true }, 'https://example.test').view;
  ok(v.kind === 'post' && v.btn.url === 'https://github.com/example/repo/pull/7' && v.btn.text === '查看 PR', '卡片：通报，按钮去 PR', JSON.stringify(v.btn)); }

const raw = JSON.stringify({ action: 'opened' });
const sig = 'sha256=' + createHmac('sha256', 'k-test').update(raw).digest('hex');
ok(await githubSigned('k-test', raw, sig), '签名对的收');
ok(!(await githubSigned('k-other', raw, sig)), '密钥不对的不收');
ok(!(await githubSigned('k-test', raw + ' ', sig)), '内容被改的不收');
ok(!(await githubSigned('k-test', raw, null)) && !(await githubSigned('k-test', raw, 'sha1=abc')), '没有签名或不是 sha256 的不收');
// issue：新建、关闭、重新打开、认领留言都发；反馈转成的新建不重复
{
  const issue = (x = {}) => ({ number: 46, title: '[反馈 #2] 双选页筛选', html_url: 'https://github.com/o/r/issues/46', labels: [{ name: '反馈' }], state_reason: 'completed', user: { login: 'bot' }, ...x });
  const c = githubText('issues', { action: 'closed', issue: issue(), sender: { login: 'someone' } });
  ok(c !== null && c.text.startsWith('反馈已处理') && c.thread === 'issue:46', '反馈议题关闭发到协助群，回在议题话题里');
  ok(githubText('issues', { action: 'opened', issue: issue() }) === null, '反馈转成的新建由正则直接通报，这里不重复');
  const o = githubText('issues', { action: 'opened', issue: issue({ number: 60, title: '侧栏高亮不对', labels: [{ name: 'bug' }], user: { login: 'dev' } }), sender: { login: 'dev' } });
  ok(o !== null && o.text.startsWith('新 issue：#60') && o.text.includes('标签 bug') && o.thread === 'issue:60', '其他 issue 新建也发', JSON.stringify(o));
  ok(githubText('issues', { action: 'closed', issue: issue({ labels: [] }) })?.text.startsWith('issue 已处理') === true, '不带反馈标签的关闭也发');
  ok(githubText('issues', { action: 'closed', issue: issue({ state_reason: 'not_planned' }) })?.text.startsWith('反馈不予处理') === true, '不予处理的写明');
  const cl = githubText('issue_comment', { action: 'created', issue: issue({ labels: [] }), comment: { body: '认领：由某某的 agent 来修', user: { login: 'dev' }, html_url: 'https://github.com/o/r/issues/46#c1' }, sender: { login: 'dev' } });
  ok(cl !== null && cl.text.startsWith('issue 已认领') && cl.text.includes('认领人 dev') && cl.thread === 'issue:46', '认领留言发到群里', JSON.stringify(cl));
  ok(githubText('issue_comment', { action: 'created', issue: issue(), comment: { body: '看起来是样式问题' } }) === null, '普通留言不发');
  ok(githubText('issue_comment', { action: 'created', issue: { ...issue(), pull_request: {} }, comment: { body: '认领' } }) === null, 'PR 上的留言不当 issue');
}
console.log(bad ? `${bad} failed` : `github: all passed (${n})`); process.exit(bad ? 1 : 0);
