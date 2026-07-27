# cybernaut-assistant

投资中台的本地 Flue Agent Runtime，提供 `assistant` 对话 Agent 和项目研究、
评分、摘要等 Workflow。

## 在主项目中运行

从主项目根目录执行：

```bash
npm ci
npm ci --prefix cybernaut-assistant
npm run dev
```

该命令会同时启动 Web、API 和本服务。本服务默认监听
`http://127.0.0.1:3584`，健康检查地址为 `/health`。

只启动 Runtime：

```bash
npm run dev:agent
```

验证运行状态：

```bash
npm run check:agent-runtime
```

`dev:local` 和 `start:local` 会共享主项目根目录的 `.env`。独立部署本服务时，
将 `.env.example` 复制为 `.env`，再运行 `npm run build && npm start`。
