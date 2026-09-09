# AI 助手对话经验记忆

该功能从用户明确表达的长期偏好，以及每五轮完整对话中提炼可复用的回答方式。自动总结默认开启，但候选不会自动影响助手；用户必须在 AI 助手右侧“经验”区域选择“采用”，经验才会从下一条消息开始生效。

## 数据与行为

- `sbl_assistant_experience_settings` 保存用户开关和已处理轮次游标。
- `sbl_assistant_experience_candidates` 保存待确认、已采用和已拒绝候选。
- `sbl_assistant_experiences` 只保存用户采用的有效经验。
- `sbl_assistant_experience_decisions` 保存采用、拒绝等决定的幂等审计。
- 项目经验只对对应项目生效，并优先于用户全局经验。
- 关闭“自动总结经验”只停止每五轮总结；用户明确说“以后……”时仍生成候选，已采用经验也继续生效。

## 发布

应用迁移使用 `server/drizzle/0112_add_assistant_experience_memory.sql`。迁移编号避开服务器已保留的 0104–0111 历史记录。该功能运行在现有 Node 主服务内，不需要新增 Docker、独立 Worker 或 systemd 服务。

先按项目现有发布流程执行迁移和构建，再重启主服务。只回退应用代码时可以保留四张新表；旧代码不读取这些表。若需要彻底移除，应在单独维护窗口确认数据不再需要后执行专门回退迁移。

## 验收

运行 `npm run accept:assistant-experience` 验证迁移、规则、API 接线、Runtime 注入和 UI 契约；再运行 `npm run check:types` 与 `npm run build`。
