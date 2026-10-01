# 尽调工作台合并后部署清单

本次发布必须同时更新前端、服务端和数据库，不能只替换前端静态文件。否则页面会显示“接口不存在或已停用”，头像、Skill 库和分身公开也无法使用。

## 必做项

1. 合并 PR 后拉取最新 `main`，安装锁定依赖并执行项目原有的数据库迁移流程，确认已应用 `0133_add_twin_avatars_and_skill_library.sql` 及之前所有迁移。
2. 生产环境设置：

   ```env
   NODE_ENV=production
   AUTH_ALLOWED_ORIGINS=https://cybernaut.newmin.cn
   AUTH_COOKIE_SECURE=true
   ```

3. 反向代理必须传递原始域名和协议（Nginx 示例）：

   ```nginx
   proxy_set_header Host $host;
   proxy_set_header X-Forwarded-Host $host;
   proxy_set_header X-Forwarded-Proto $scheme;
   ```

4. 重新构建并重启服务，再执行：

   ```bash
   npm run check:due-diligence-readiness
   ```

   `production-origin` 和 `database-schema-0133` 必须为 `ready: true`。

## 模型配置

尽调工作台不需要单独的 API Key，使用原平台“系统管理 → AI 模型”中的路由：

- `ai-document`：智能清单、访谈纪要、素材解析和 Skill 提炼。
- `interactive-assistant`：公司 Agent 分身对话。

两个路由可以指向同一个 OpenAI-compatible 模型。未配置时，标准尽调清单仍可用；模型相关功能会明确提示未配置，不会伪造回答。

## 可选的后台语音转写

浏览器实时转写不需要服务端配置。如需录音结束后后台补转写，配置 OpenAI-compatible `/audio/transcriptions` 服务：

```env
ASR_BASE_URL=https://your-asr-provider.example/v1
ASR_API_KEY=server-side-secret
ASR_MODEL=whisper-1
```

ASR 未配置不会阻断录音、浏览器文字和人工修订。

## 合并后冒烟验证

- 打开 `/due-diligence`，顶部显示“数据库就绪”和“写入来源正常”。
- 新建数字分身，刷新后仍存在；可公开、取消公开、删除。
- 切换分身时“沉淀的 Skill 库”只显示当前分身内容。
- 开始录音前不出现来源错误；结束后录音与转写均可保存。
- 标准模式可生成清单；模型就绪后再验证智能增强和 Agent 对话。

## 可直接发给负责部署同事的指令

> 请在合并尽调工作台修复 PR 后，同时部署前端与 Node 服务，执行全部数据库迁移并确认已应用 0133。设置 `AUTH_ALLOWED_ORIGINS=https://cybernaut.newmin.cn` 和 `AUTH_COOKIE_SECURE=true`，确认反向代理传递 `Host`、`X-Forwarded-Host` 与 `X-Forwarded-Proto`。在平台 AI 模型配置中启用 `ai-document` 和 `interactive-assistant` 路由，然后运行 `npm run check:due-diligence-readiness`，并按 `DUE_DILIGENCE_DEPLOYMENT.md` 完成冒烟验证。
