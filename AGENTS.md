# 给 coding agent 的贡献指南（正则）

正则是 CLAIN 中心的中台。各岗位的负责人及其 coding agent 都可以修自己负责的议题、提 PR。本文写给 agent：照着做，PR 就能直接审、直接合。

## 1. 从哪里开始

- **议题**：<https://github.com/whunextgen/whunextgen.github.io/issues>。成员在正则右下角「遇到问题？」提的反馈会自动转成议题，正文里写着「负责：某某」（按页面所属岗位自动分派），协助群里也会 @ 负责人。
- **认领**：动手前在议题下回复一条以「认领」开头的评论，写上谁来修、预计什么时候提 PR。这条评论会同步到协助群。
- **分支**：从 `finance-portal` 分支拉新分支，PR 提到 `finance-portal`。**不要提到 `main`**（`main` 是中心网站）。
- **合并与上线**：由济民（中心负责人的 coding agent）审、合并并发布修订版。PR 里不要改版本号、`CHANGELOG.md`，也不要自己部署。

## 2. 本地跑起来

```bash
npm install
npm test                      # 在内存 Postgres（PGlite）里应用全部迁移并跑全部断言
(cd web && npm install && npx tsc --noEmit -p .)
(cd worker && npm install && npx tsc --noEmit -p . && npm test)
```

`npm test` 必须全部通过。测试只用虚构数据，不连任何线上数据库。

看页面效果用演示环境（虚构数据，只监听本机）：

```bash
DEMO_OUT=/tmp/demo.tgz npm test      # 导出演示数据库
(cd web && npm run build)
node scripts/demo/server.mjs /tmp/demo.tgz 8788
# 浏览器打开 http://127.0.0.1:8788/demo 选一个虚构账号登录
```

## 3. 代码在哪里

| 位置 | 内容 |
|---|---|
| `supabase/migrations/` | 表、视图（`api.*`）、业务函数、权限。**业务规则写在这里**，前端只做展示和校验提示 |
| `worker/src/index.ts` | API 和飞书登录、通知发送。新视图要加进 `VIEWS`，新 RPC 要在 `RPC`（参数名和类型）里登记 |
| `web/src/` | 前端（Vite + React）。页面在 `web/src/pages/` 和 `web/src/*.tsx` |
| `test/db.test.mjs` | 数据库断言；也可以另建 `test/xxx.test.mjs`，并加进根目录 `package.json` 的 `test` 命令 |
| `docs/manual/` | 按角色分册的使用手册源文件；`web/src/guide.tsx` 是系统内使用指南 |

## 4. 迁移编号（最容易撞）

- 一个 PR 一个迁移文件，命名 `NNNN_英文短名.sql`。
- 编号取 `origin/finance-portal` 上**当前最大编号加一**。提 PR 前和合并前各核对一次：`git fetch origin finance-portal && git ls-tree --name-only origin/finance-portal supabase/migrations/ | tail -3`。撞号时改自己的编号，内容不变。
- 迁移只追加，不改已经合并的迁移。改已有函数或视图用 `create or replace`；改视图只能在末尾加列。
- 迁移在线上按文件名执行一次，必须可重复在空库上从头跑通（测试就是这么跑的）。

## 5. 必须遵守

- **不提交**：真实姓名名单、工资、合同、面试评价、身份证号、飞书或 GitHub 的编号和令牌、数据库地址、`.env`、`internal/`。测试和截图只用虚构人员。合并前会扫描 `ou_`、`oc_`、`cli_` 开头的编号和数据库地址，命中即退回。
- **权限在服务端判断**：新 RPC 用 `need_role(...)` / `has_perm(...)` 检查；视图里按 `app_uid()` 过滤。前端隐藏按钮不算权限。
- **用户可见的改动同步改指南和手册**：入口、按钮、步骤、权限、日期规则有变化的，同一个 PR 里改 `web/src/guide.tsx` 和 `docs/manual/` 对应章节（见 `docs/user-guide-maintenance.md`）。
- **界面用语**：项目、经费卡、课题、研究单元、名义币、实际币、中心负责人；时间一律按北京时间。
- **通知**：发给成员的飞书消息一律写进 `feishu_outbox`（个人用 `notify_user`），由正则发出；不要自己调飞书接口发消息。

## 6. PR 怎么写

按 `.github/PULL_REQUEST_TEMPLATE.md` 填：问题、修改后的行为、实际做了哪些验证（`npm test` 的通过数、类型检查、演示环境核对）、是否改了指南和手册、需要的迁移。正文写 `Closes #议题号`。PR 小而专一：一个议题一个 PR，别顺手改不相关的东西。

审 PR 时会在最新的 `finance-portal` 上合并后重跑全部测试；有冲突或撞号的，会在 PR 里说明怎么改。
