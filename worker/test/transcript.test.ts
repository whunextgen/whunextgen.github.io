// 录音补漏：Zoom 逐字稿转成一行一句；中转的接口地址从资源备注里取
import { vttToText, llmBase } from '../src/index.ts';
let bad = 0, n = 0; const ok = (c: unknown, name: string, extra = '') => { n++; if (!c) { bad++; console.log('FAIL', name, extra); } };
const vtt = 'WEBVTT\n\n1\n00:01:05.120 --> 00:01:08.000\n张三: 数据从哪里来？\n\n2\n01:02:03.000 --> 01:02:05.000\n李四: 方法没讲清楚\n';
const t = vttToText(vtt);
ok(t === '[1:05] 张三: 数据从哪里来？\n[62:03] 李四: 方法没讲清楚', 'VTT 转成「[分:秒] 姓名: 话」', JSON.stringify(t));
ok(llmBase('接口地址：https://api.example-router.com/v1', null) === 'https://api.example-router.com', '备注里的地址去掉末尾的 /v1');
ok(llmBase('地址 https://r.example.com/v1/messages，模型见上', null) === 'https://r.example.com', '写成完整的 messages 地址也认');
ok(llmBase('https://r.example.com/anthropic/', null) === 'https://r.example.com/anthropic', '去掉末尾斜杠');
ok(llmBase(null, 'https://acct.example.com') === 'https://acct.example.com', '备注没有就看账号一栏');
ok(llmBase('没有地址', null) === null, '没有地址的直连 Anthropic');
console.log(bad ? `transcript: ${bad}/${n} failed` : `transcript: all passed (${n})`);
if (bad) process.exit(1);
