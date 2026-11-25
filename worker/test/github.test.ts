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
{ const v = noticeCard({ text: githubText('pull_request', { action: 'opened', pull_request: pr() })!.text, url: 'https://github.com/example/repo/pull/7', btn: '查看 PR', kind: 'post', group: true }, 'https://example.test').view;
  ok(v.kind === 'post' && v.btn.url === 'https://github.com/example/repo/pull/7' && v.btn.text === '查看 PR', '卡片：通报，按钮去 PR', JSON.stringify(v.btn)); }

const raw = JSON.stringify({ action: 'opened' });
const sig = 'sha256=' + createHmac('sha256', 'k-test').update(raw).digest('hex');
ok(await githubSigned('k-test', raw, sig), '签名对的收');
ok(!(await githubSigned('k-other', raw, sig)), '密钥不对的不收');
ok(!(await githubSigned('k-test', raw + ' ', sig)), '内容被改的不收');
ok(!(await githubSigned('k-test', raw, null)) && !(await githubSigned('k-test', raw, 'sha1=abc')), '没有签名或不是 sha256 的不收');
console.log(bad ? `${bad} failed` : `github: all passed (${n})`); process.exit(bad ? 1 : 0);
