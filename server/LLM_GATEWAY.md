# LLM 网关调用约定（产品 ↔ 自建网关）

本产品（投资中台 MVP）所有 LLM 调用统一走 **`http://127.0.0.1:18081/v1`**，
这是团队自建的 OpenAI 兼容网关，**Zeelin 的真实 API key 由网关代管**。

## 为什么这样设计

- **一个网关管多模型 / 多产品的 key 与配额**：所有产品统一接入网关，
  zeelin key 在网关侧轮换、重试、计费、降级，产品不需要感知。
- **产品代码只配置网关 URL + 模型名**：即使 zeelin 改了 key 或切换了上游模型，
  本项目不需要重新发布。
- **网关颁发的客户端 token 可选**：如果未来网关开启鉴权，把 token 填到
  `LLM_GATEWAY_KEY` 即可。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:18081/v1` | 网关入口（OpenAI 兼容） |
| `LLM_MODEL` | `claude-sonnet-4-6` | 默认模型；可切换为网关支持的任意模型 |
| `LLM_GATEWAY_KEY` | （空） | 网关颁发的客户端 token；网关不要求时留空 |

## 支持的模型（来自 `/v1/models` 实测）

`claude-sonnet-4-6` / `gpt-5.5` / `DeepSeek-V4-Pro`（中文偶发返空）/ `Doubao-seed-2-1-pro` 等

## 调用契约

调用方传：
```json
POST /v1/chat/completions
Authorization: Bearer <LLM_GATEWAY_KEY?>  // 可选
{
  "model": "<LLM_MODEL>",
  "messages": [...],
  "temperature": 0.3~0.4,
  "max_tokens": 600~800
}
```

返回标准 OpenAI ChatCompletion 结构。

## 在项目里的位置

- `server/src/services/aiService.ts` — 实际发送请求的代码（约 90 行）
- `server/src/routes/index.ts` — `/api/ai/chat` 与 `/api/ai/project-summary` 两个端点
- `.env` — 当前部署用 `claude-sonnet-4-6` + 18180 网关

## 验证脚本

```bash
curl -X POST http://127.0.0.1:5180/api/ai/chat \
  -H 'Content-Type: application/json' \
  -d '{"question":"这个项目最大的风险是什么？","projectName":"智灵动力"}'
```
