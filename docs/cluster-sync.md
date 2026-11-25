# 正则与 GPU 集群的同步接口

中台只记账：研究单元用实际币换得多少 GPU 卡时，集群报回用了多少。QOS 怎么建、挂到谁的集群账号上、怎么限额，由集群一侧在 Slurm 里设置。

## 接入

- 地址：中台的 `/mcp`（MCP，HTTP），用访问令牌认证。
- 令牌由集群同步脚本的使用人本人在中台「智能体接入」页建立，须为可写令牌。
- 使用人须被授予「集群同步」角色（权限 `cluster.sync`），由中心负责人在「权限管理」授予。
- 用 `read_view` 读视图，`call_action` 调操作；`list_actions` 可查参数。

## 读

`read_view`，`view: "cluster_quota"`：每个已成立的研究单元一行。

| 列 | 含义 |
|---|---|
| project_id | 研究单元编号（UUID），报回时用它 |
| project_code、project_name | 研究单元的编号和名称，如 P-10-03 |
| granted_hours | 累计换得的 GPU 卡时 |
| used_hours | 集群已报回的用量合计 |
| left_hours | 剩余 = granted_hours − used_hours |
| members | 名单内的人（含负责人）：user_id、name、owner |
| last_ack | 最近一次执行回执：hours、ok、note、at |

`read_view`，`view: "cluster_usage"`：已报回的各期用量明细。

期次两周一期，自 2026-11-23 起：2026-11-23、2026-12-07、……

## 写

`call_action`，`action: "report_cluster_usage"`，参数 `project`（UUID）、`period`（该期第一天，如 2026-11-23）、`hours`（该期已用卡时）。同一研究单元同一期再报即覆盖，可每天报一次本期累计。

`call_action`，`action: "ack_cluster_quota"`，参数 `project`、`hours`（集群上当前执行的额度卡时）、`ok`（true / false）、`note`（失败原因等，选填）。每次在 Slurm 上更新额度后报一次。

## 约定

- 卡时按 GPU 计：一张卡用一小时为一卡时。卡型是否折算，由集群一侧在 Slurm 的计费权重里定，报回的是折算后的数。
- 额度是固定卡时，不限并发卡数。
- 集群一侧先只读核对，确认无误后再启用自动修改额度。
