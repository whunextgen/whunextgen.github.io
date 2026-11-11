# 科研财务中台

按经费卡管理预算、执行和决算。Supabase Postgres 是唯一数据源，Cloudflare Worker 提供 API，飞书只负责登录和通知。

- `supabase/migrations/`：表结构、口径视图、业务函数、访问控制
- `test/`：在内存 Postgres 里应用全部迁移并核对口径和拦截规则，`npm test`
- `scripts/`：旧门户数据的导出和导入
- `worker/`：API 与飞书登录
- `docs/prototype.html`：前端原型（数据为虚构）
- `.env`（不提交）：`DATABASE_URL`、旧表标识 `FEISHU_BITABLE_APP` `LEGACY_USERS_TABLE` `LEGACY_ENTITY_TABLE` `LEGACY_SKIP_TABLES`

导出的旧数据含密钥，只放在仓库外，不提交。
