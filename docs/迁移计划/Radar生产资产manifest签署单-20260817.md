# Radar 生产资产 manifest 签署单

生成时间：2026-08-17 17:38（Asia/Shanghai）  
环境：production  
状态：技术盘点完成，等待四方负责人签署  

## 1. 技术盘点结论

切换时保留的生产源资产仍位于旧 Radar 数据目录，旧服务和独立调度均已停止。盘点仅输出计数、字节数和聚合 SHA-256，不在 manifest 中保存正文、账号内容、绝对文件名或凭据。

| 资产类别 | 记录数 | 文件数 | 字节数 | 聚合 SHA-256 | 处置 |
|---|---:|---:|---:|---|---|
| Radar 候选 JSONL | 6,071 | 6 | 70,716,910 | `e7c3185517c86afb81c1b19da56cd5ea683e4d90fd2be2a2c8f7b5cdb9fcd9fd` | 已迁入 MySQL，源文件只读保留 |
| 微信群原始消息 | 0 | 0 | 0 | `08638fbc7d2cf977cd966f1b7f167cb3e89b8b0f8b02477cfc04d2f0ad73b70d` | 源端无原始消息文件，3 条历史候选已保留 |
| 采集状态 | 47 | 4 | 565,429 | `1f213d3ae0fbbfb9d5a5ad1e01d139bbcb9fa1c86caf6f202da9bcaddd49d6f4` | 已迁入 MySQL，源文件只读保留 |
| 公众号账号 Excel | 1,252 | 1 | 41,369 | `775a10d0aeb1651c5aebe8152b9a7c4cbd29fe4274936d0c9a1378100fd0e263` | 已迁入 MySQL，源文件只读保留 |

候选 JSONL 的 6,071 条与迁移基线一致；公众号 Excel 的 1,252 条与 MySQL 账号注册数量一致。

## 2. 签署要求

四名负责人均需提供稳定身份标识和批准时间。只有四个角色全部存在时，验收脚本才会接受 manifest：

| 角色 | 稳定身份标识 | 批准时间 | 结论 |
|---|---|---|---|
| 产品负责人（`product`） | 待填写 | 待填写 | 待批准 |
| 研发负责人（`development`） | 待填写 | 待填写 | 待批准 |
| 运维负责人（`operations`） | 待填写 | 待填写 | 待批准 |
| 数据负责人（`data`） | 待填写 | 待填写 | 待批准 |

批准人确认：上述计数、哈希、源缺失处置、MySQL 迁移结果和只读保留策略可作为本次 `project-discovery` 下线的生产资产证据。

## 3. 批准后的 JSON 结构

将候选 manifest 复制为生产批准文件，把 `approved` 改为 `true`，填写 `ownerApprovedAt`，并补充：

```json
"approvals": [
  { "role": "product", "approverId": "稳定身份", "approvedAt": "ISO-8601 时间" },
  { "role": "development", "approverId": "稳定身份", "approvedAt": "ISO-8601 时间" },
  { "role": "operations", "approverId": "稳定身份", "approvedAt": "ISO-8601 时间" },
  { "role": "data", "approverId": "稳定身份", "approvedAt": "ISO-8601 时间" }
]
```

不得使用“Codex”“系统”“自动批准”等身份代替真实负责人。
