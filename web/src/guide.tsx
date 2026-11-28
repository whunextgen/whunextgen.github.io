import { useState } from 'react';

// 使用指南：常用事项的简要步骤。带截图的完整手册在飞书 CLAIN 知识库「七、正则使用手册」，正文源文件在 docs/manual/。
// 改动成员可见的流程时，同一个 PR 里更新这里的条目和 docs/manual 对应手册，见 docs/user-guide-maintenance.md。
export const GUIDE_REVIEWED = '2026-11-28';
const WIKI = 'https://ucnbt9604qtb.feishu.cn/wiki/';
export const MANUAL_HOME = `${WIKI}H1vgwKjqMixhUZkSSSAc0y8unEf`;
// 按角色分册的完整手册：[书名, 适合谁、讲什么, 知识库节点]
export const MANUALS: Record<string, [string, string, string]> = {
  member: ['成员通用手册', '全体成员：我的事项、签到请假、成长主线、快照与质疑、双选、联席会议、加入与考核、双周表、支出申请、备用金、资源申领、反馈', 'AlSAwmqUYildutkpa93cX2Zknrc'],
  intern: ['新成员入门', '刚加入的 Intern：第一次登录、开题稿、进入研究单元、第一周要做的事', 'CsWTwjlQYiojBSkIWS0cvWrfnRb'],
  unit: ['研究单元负责人手册', '申请成立研究单元、成员名单、双周表、快照与研讨会、质疑队伍、确认支出、试做期、池子与代币', 'Njc0w7MGdivRGrkgr7kcYFcTnuh'],
  topic: ['课题负责人手册', '立项与延续申请、预算编制、预算期预算与复盘、调剂与调整、同意研究单元、研讨会组织者、联席会议、进展小组', 'KzY8wg8fpiChWekaK9KcPgmKnAc'],
  finance: ['财务岗手册', '项目与经费卡、采购、支出核对与入账、备用金核销、人员经费、结清、年度预算、按课题审核下达', 'KCjBwkMImigpXNkjsYfcNnRUnQd'],
  resource: ['资源岗手册', '资源调配、资产盘点、申领的批示批准与分发、密钥与回收、年末盘点', 'OyTPwdwu5iUp2TkuvB7cJ51BnEh'],
  hr: ['人事岗手册', '人员档案、新面孔确认、加入建档、新人提醒、人员经费、讲座与训练课程出勤', 'PtuswXnNRibckwkHPricbv3Ynzg'],
  assistant: ['中心助理手册', '联席会议主持、会外表决、备案、学期考核发起、研究单元确认、训练课程', 'NXoCw5w2wi7F52ko0SCc7bTGnHg'],
  director: ['中心负责人手册', '否决与决定、特批、加入名额、身份认定、年度预算批准与控制、超预算审批、权限管理', 'JfEgwuv9Vi0fWukcVvAcZfwMnJc'],
};
// entry：本主题的办理入口；一个主题涉及几类申请的，用 entries 分别列出（#121）
type Topic = { id: string; title: string; who: string; entry?: [string, string]; entries?: [string, string][]; steps: string[]; note: string; more: string[] };
export const GUIDE_TOPICS: Topic[] = [
  { id: 'start', more: ['intern', 'member'], title: '第一次使用：从哪里开始', who: '所有成员', entry: ['/', '我的事项'],
    steps: ['用本人的飞书账号登录中台。若提示账号尚未启用，请联系人事确认档案；GitHub 身份不会自动变成中台权限。',
      '在「我的事项」查看与本人有关的待办，点击事项进入对应办理页。',
      '在「成长主线」查看当前身份及任务要求。身份与博士、硕士等人员类别是不同概念。'],
    note: '看不到某个入口，可能是权限或项目归属不同；不要借用别人的账号。手机端也可从导航进入本指南。' },
  { id: 'select', more: ['member'], title: '双选：找研究、联系负责人、加入项目', who: '参与双选的成员', entry: ['/select', '双选'],
    steps: ['按课题查看下属研究单元，阅读研究介绍、负责人学术主页、最新快照和尚未回应的质疑。长介绍可以展开和收起。课题人数包含直属及下属有效研究单元成员，按账号去重；研究单元只统计本单元成员，课题同时注明直属人数。',
      '感兴趣时点击「表达意向」，填写本人情况和兴趣，可附研究资料或作品链接。也可以直接私聊负责人，不必先在系统表达意向。',
      '双方谈妥后，由有该项目权限的负责人加入成员名单。表达意向本身不代表已被接收。可在「我的意向」撤回仍未处理的意向。',
      '在双选页底部展开默认收起的「我的双选情况」，查看本人当前加入的课题、研究单元及加入日期。有人员查看或管理权限的经办在「人员双选情况」查看全员名单，按中心身份 / 硕士标注、状态或姓名筛选，找出尚未加入的人；线下谈妥的也需要负责人实际加进成员名单。人事可点击「一键提醒双选」，核对预览后将符合条件的 Intern 与待处理意向负责人加入正则飞书私信队列。Assistant 不在提醒范围，未关联、停用或未绑定飞书的账号需先核对；同人同类每日最多一次，入队不等于送达。'],
    note: '双选没有志愿排名或自动分配。「加入项目」与「加入中心」是两件事。加入名单后才能按项目权限申请相关支出与资源。' },
  { id: 'manage', more: ['unit'], title: '负责人：接收成员与安排试做', who: '课题或研究单元负责人、副手', entry: ['/select', '双选'],
    steps: ['在「我负责的招募与成员」查看本项目收到的意向；研究介绍直接取已有立项说明，联系对象是负责人。',
      '普通加人可进入「课题管理 → 对应课题或研究单元 → 成员 → 新增成员」。',
      '需要试做时，在双选页点击「加入并开始试做」，选择成员、指导人、结束日期，填写小任务（一句话，不超过 80 字）、交付要求（不超过 1000 字）和截止日期，确认指导人没有私人关系。'],
    note: '当前试做适用于 Intern、Assistant，指导人为 Researcher 及以上。必须有对应项目的管理权限；没有权限时联系现有管理者处理。' },
  { id: 'trial', more: ['member', 'unit'], title: '试做：交进展、看反馈、办期满结论', who: '试做成员和指导人', entry: ['/select', '双选 · 我的试做'],
    steps: ['成员在「我的试做」查看小任务和截止日期，使用「提交阶段进展」填写完成情况、困难和下一步，可附文档或代码链接。材料入口无需等到期才开放。',
      '指导人在同一页面使用「阶段反馈」回复。成员之后通过「提交期满交付」提交交付物说明和自述。',
      '指导人使用「期满结论」选择继续、延长、调整或结束，并写明理由。延长只能一次；结束参与前需收回未结接口额度。'],
    note: '结论报联席会议备案，不自动改变身份。结束本课题参与后，本人可在七日内申诉。试做与正式 RA 考核不同；普通加入中心本身不要求小任务。' },
  { id: 'records', more: ['member', 'unit'], title: '日常研究：快照、质疑与双周表', who: '研究成员和研究单元负责人', entry: ['/iterate', '快照与质疑'],
    steps: ['在「快照与质疑」查看本单元的研究稿件和待回应问题，按实际参与记录工作。',
      '研讨会组织者对本期投稿决定接收为口头报告、海报或不接收；决定点错了，本期内可点「撤回接收」或「撤回不接收」改回投稿待定，再重新决定。已接收的，记入过质疑、有人交了质疑卡或点过名后不能撤回。',
      '个人首页可登记当日修订，并查看被分配的推进、审阅事项。',
      '研究单元按现有登记日规则填写双周表；请先看页面显示的开放日期和当前期次。'],
    note: '个人试做的两周阶段检查，不等同于研究单元双周表，不会开放额外的双周表补登日期。' },
  { id: 'admission', more: ['member', 'hr', 'director'], title: '推荐新人加入中心', who: '推荐人及授权人事经办', entry: ['/members', '加入与考核 · 人员加入'],
    steps: ['在「人员加入」点击「推荐加入」，填写姓名、类别、学校、方向、推荐理由与可选材料链接。',
      '硕士研究生、研究实习生、访问学生由有人员管理权限的人事确认建档；博士、博士后、研究助理需在年度名额内，经联席会议程序和中心负责人决定。',
      '接收后建立人员档案；本人首次飞书登录时如未对应档案，由人事核对并入。进入具体课题或研究单元仍需负责人另行加人。'],
    note: '加入中心即为 Intern（RI），不要求先完成入组小任务。人事确认按钮仅对有人员管理权限的账号显示。' },
  { id: 'assessment', more: ['member', 'assistant', 'topic'], title: '身份晋级与学期考核', who: '成员、考核人及授权经办', entry: ['/path', '成长主线'],
    steps: ['在「成长主线」核对本级任务及完成记录，达到条件后从考核入口申请。',
      'RA 考核按现有规则由两名 Researcher 担任考核人、布置和认定两周小任务；指导关系和私人关系须遵守回避要求。',
      'Assistant 的「接收过至少一名 RI，并带其通过 RA 考核」：「接收」指这名 RI 最早进入的研究单元由你担任负责人（在研究单元「成员」一节加入名单，或加入质疑小队进入名单）；此人通过 RA 考核时中台自动判定完成。',
      '学期考核在「加入与考核 → 学期考核」，根据本人是成员、考核人或经办显示不同操作。'],
    note: '项目试做结论、正式身份晋级和学期考核是三件不同的事。需要改进或建议退组的，按页面列出的正式程序处理。' },
  { id: 'spend', more: ['member', 'topic', 'finance'], title: '提交支出、备用金或资源申请', who: '项目成员及相关经办', entries: [['/requests', '支出申请'], ['/petty', '备用金管理'], ['/resource', '资源申领']],
    steps: ['先确认自己在对应课题或研究单元的有效成员名单中。',
      '支出从对应年度可用的预算行发起，阅读页面给出的可用额度、办理条件及不可提交原因。',
      '提交后在「我的事项」或对应申请页跟进状态。备用金和资源申领使用各自入口，不能用代币余额代替预算。'],
    note: '看到课题上限不代表经费已下达或本人可直接支出。代币（名义币、实际币）不是人民币，也不是经费卡余额。没有可用预算行时请联系负责人或财务，不要重复提交。' },
  { id: 'coin-api', more: ['unit', 'member', 'resource'], title: '用名义币换 API 额度和 GPU 卡时', who: '研究单元负责人、名单内成员和财务岗', entries: [['/projects', '课题管理'], ['/stock', '资产盘点']],
    steps: ['研究单元负责人进入「课题管理 → 本研究单元 → 池子与成果」，在「名义币」一栏查看研究单元账上的余额（当季作废）、已换卡时和 API 额度。',
      '点「换 API 额度」，按财务岗本季度公布的比例用单元账上的名义币换额度，计入本研究单元的 key；额度按 key 所在平台的计价单位记，美元计价的按汇率折算。点「换 GPU 卡时」按标价换卡时。',
      '财务岗在「资产盘点 → 接口额度 → 研究单元 API key」指定 key 所在的接口资源、登记库存，并发放 key（加密保存）。名单内成员在研究单元页「API key」一栏点「取用 key」，每次取用均有记录；研究单元还没换额度或财务岗尚未发放 key 时，这一栏写明原因，取不到 key。'],
    note: '只能单向兑换，不能换回名义币、预算或人民币。全中心每季度换出的 API 额度不超过当季公布的总额（按汇率折算），换满即止，现有库存只做对账、不计入；这个上限不是给哪个研究单元的额度，研究单元要由负责人换了、财务岗发放 key 后才能取用；本季度比例未公布、或财务岗尚未指定 key 所在的接口资源时暂不能换。key 发到研究单元、名单内共用；成员移出名单后取不到，财务岗收到提醒更换 key。' },
  { id: 'attendance', more: ['member', 'hr'], title: '签到、请假与训练课程', who: '所有参与活动的成员', entry: ['/', '我的事项'],
    steps: ['在个人首页使用「签到」「请假」等入口，选择实际参加的会议或活动。',
      '训练要求和完成情况可在「训练课程」查看，按活动页面要求办理。',
      '发现出勤记录不一致，向活动组织者或有权限的经办提供具体场次核对。'],
    note: '不要代替他人签到。缺席、请假、补看和实到是不同状态，以系统记录及经办核验为准。' },
  { id: 'help', more: ['member'], title: '遇到问题、看不到按钮怎么办', who: '所有成员',
    steps: ['先查看当前账号、目标项目和页面提示：按钮可能受权限、日期、状态或成员资格限制。',
      '在出问题的页面点右下角「遇到问题？」，写明想做什么、操作步骤、报错文字，以及是否使用手机；正则会自动记下页面和时间。',
      '反馈会转入公开 GitHub issue；提交前删除个人信息、合同、评价、工资、令牌及真实名单。截图同样需要脱敏。'],
    note: '请勿在反馈里粘贴密码、登录凭证或完整个人资料。需要处理真实档案时私下联系授权经办。' },
];

declare const __APP_VERSION__: string;
export function GuidePage() {
  const [query, setQuery] = useState('');
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const topics = GUIDE_TOPICS.filter((t) => words.every((w) => [t.title, t.who, ...t.steps, t.note].join(' ').toLowerCase().includes(w)));
  return <div className="wb user-guide">
    <div className="top"><h2>使用指南</h2></div>
    <p className="lede">先找到你要办的事，按步骤进入对应页面。入口和按钮会随本人权限、项目归属及办理状态变化。</p>
    <p className="guide-meta">当前系统 v{__APP_VERSION__} · 指南核对日期 {GUIDE_REVIEWED}</p>
    <section className="guide-books" aria-label="完整手册">
      <h3>完整手册 <span className="h3sub">按角色分册，带截图分步说明，在飞书 CLAIN 知识库；先读成员通用手册，再读本人岗位的那一本 · <a href={MANUAL_HOME} target="_blank" rel="noreferrer">知识库目录</a></span></h3>
      <ul>{Object.values(MANUALS).map(([t, d, n]) => <li key={n}><a href={`${WIKI}${n}`} target="_blank" rel="noreferrer">{t}</a><span>{d}</span></li>)}</ul>
    </section>
    <label className="guide-search">搜索使用方法<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例如：双选、加入、支出、考核" /></label>
    <nav className="guide-index" aria-label="指南目录">{topics.map((t) => <a key={t.id} href="#/guide" onClick={(e) => { e.preventDefault(); const el = document.getElementById(`guide-${t.id}`) as HTMLDetailsElement | null; if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }}>{t.title}</a>)}</nav>
    <p role="status">{topics.length === 0 ? '没有找到相关说明，试试“加入”“成员”或“支出”等关键词。' : `找到 ${topics.length} 项说明`}</p>
    {topics.map((t) => <details key={t.id} id={`guide-${t.id}`} className="guide-topic" open={words.length > 0 || undefined}>
      <summary><strong>{t.title}</strong><span>{t.who}</span></summary>
      <ol>{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      <p className="guide-note">{t.note}</p>
      <p className="guide-more">详见：{t.more.map((k, i) => <span key={k}>{i ? '、' : ''}<a href={`${WIKI}${MANUALS[k][2]}`} target="_blank" rel="noreferrer">《{MANUALS[k][0]}》</a></span>)}</p>
      {t.entry && <a className="btn sm" href={`#${t.entry[0]}`}>打开{t.entry[1]}</a>}
      {t.entries?.map(([to, label]) => <a key={to} className="btn sm" href={`#${to}`} style={{ marginRight: 6 }}>打开{label}</a>)}
    </details>)}
  </div>;
}
