# 性能专项审计

日期：2026-10-05  
范围：React/Vite 前端、Pages Worker、Finance Worker、飞书多维表格链路。

## 结论摘要

当前静态入口不是主要瓶颈。主要风险在于 Finance Worker 访问飞书时的整表读取、串行分页、同一页面的重复读取，以及所有 API 响应统一 `no-store`。由于本次执行环境没有可安全复用的已认证生产会话，匿名接口只能用于网络基线，不能冒充业务接口耗时。

## 当前链路

```text
浏览器 -> clain.org / Pages -> Pages Worker -> Finance Worker -> 飞书 API
```

生产事实源仍是飞书多维表格；本地 `finance.db` 不是生产读写源。

## 匿名网络基线

测试方式：PowerShell `Invoke-WebRequest`，单次冷请求，2026-10-05 当前网络环境。

| 请求 | 状态 | 耗时 | 响应体 | 说明 |
|---|---:|---:|---:|---|
| `https://clain.org/portal/` | 200 | 约 918 ms | 460 B | HTML 入口，不含业务数据 |
| `https://finance-portal-79i.pages.dev/` | 200 | 约 529 ms | 460 B | Pages 入口，不含业务数据 |
| Worker `/healthz` | 200 | 约 550 ms | 77 B | 健康检查，不访问飞书 |
| Worker `/api/auth/me` | 401 | 约 852 ms | 0 B | 未认证，未进入业务读取 |
| Worker `/api/finance/dashboard` | 401 | 约 120 ms | 0 B | 未认证，未进入飞书读取 |
| Worker `/api/finance/workspace` | 401 | 约 121 ms | 0 B | 未认证，未进入飞书读取 |
| Worker `/api/finance/api-resources` | 401 | 约 122 ms | 0 B | 未认证，未进入飞书读取 |

以上数据只证明入口和匿名链路，不能作为登录后 P50/P95。

## 代码级证据

### 飞书读取

- `recordsFiltered` 每页请求最多 500 条，并通过 `page_token` 串行循环，记录量增长会线性增加等待时间。
- `financeEntities(env)` 不传实体类型时会读取财务实体表全部记录，再由 Worker 本地过滤和聚合。
- `financeWorkspace`、`financeDashboard`、支出、资产等接口会重复读取相同实体集合。
- `saveFinanceEntity` 写入前调用 `records(env, tableId)` 全表扫描，以 `entity_type + 业务ID` 定位记录。

### 缓存

- Worker 使用进程内 `Map` 缓存，实例冷启动或切换后丢失，不是持久读模型。
- 已有实体 TTL：分类/优先级约 30 分钟，项目/里程碑约 5 分钟，预算/支出约 15 秒，晨星提交/明细约 10 秒。
- 全局 JSON 响应目前设置 `Cache-Control: no-store`，因此浏览器、Pages 和 Cloudflare 边缘不会缓存只读结果。

### 前端

- 前端通过 `frontend/src/lib/api.ts` 统一请求，登录后页面会触发多个业务 GET。
- 资源中台页面当前并行请求 Dashboard、Workspace、API Resources；其中 Dashboard 和 Workspace 存在数据重叠。
- 生产构建 JS 约 867 KB，gzip 约 266 KB；`xlsx` 等重模块仍在主包分析范围内。

## 本轮已完成的低风险改动

- 对完全相同、并发发生且没有自定义 AbortSignal 的 GET 请求增加 in-flight Promise 复用。
- 去重 key 绑定当前会话 token 和路径，不持久化业务数据，也不绕过权限判断。
- 写请求、带自定义 signal 的请求、不同会话请求均不复用。

## 尚未测量的生产指标

需要使用有效测试账号，在不写入业务数据的情况下补测：登录、`/api/auth/me`、Dashboard、Workspace、API Resources 的 P50/P95、飞书请求次数、分页数、响应体大小和失败率。后续应通过 request id 和非敏感服务端日志完成，而不是记录财务内容。
