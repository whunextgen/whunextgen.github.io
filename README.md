# 科研财务中台

按经费项目和各年的经费卡管理预算、执行和决算：经费项目记额度和期限，经费卡是项目某一年下来的经费。Supabase Postgres 是唯一数据源，Cloudflare Worker 提供 API，飞书只负责登录和通知。

- `supabase/migrations/`：表结构、口径视图、业务函数、访问控制
- `test/`：在内存 Postgres 里应用全部迁移并核对口径和拦截规则，`npm test`
- `scripts/`：旧门户数据的导出和导入
- `worker/`：API 与飞书登录，同时托管前端静态文件
- `web/`：前端（Vite + React）。`npm run build` 生成 `web/dist`，再在 `worker/` 下 `npx wrangler deploy` 一并发布；本地开发在 `web/.env.local` 里设 `API_TARGET` 后 `npm run dev`
- `pages/`：国内访问入口。`workers.dev` 在国内不稳定，所以另开一个 Cloudflare Pages 项目，用服务绑定把请求原样交给上面的 Worker，对外地址是 `pages.dev`。只在改转发逻辑时才需要在 `pages/` 下 `npx wrangler pages deploy --branch main`；平时发版只部署 Worker。新地址的登录回调要加进飞书应用的重定向白名单。
- `docs/prototype.html`：前端原型（数据为虚构）
- `.env`（不提交）：`DATABASE_URL`、旧表标识 `FEISHU_BITABLE_APP` `LEGACY_USERS_TABLE` `LEGACY_ENTITY_TABLE` `LEGACY_SKIP_TABLES`

导出的旧数据含密钥，只放在仓库外，不提交。
