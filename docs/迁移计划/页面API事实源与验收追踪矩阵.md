# 页面、API、事实源与验收追踪矩阵

更新时间：2026-08-10

表名均省略运行时 `DB_FREFIX`。除明确标为外部基础设施的 LLM、公开搜索和文件字节外，业务状态的目标权威源均为 MySQL。浏览器只保存瞬时 UI 状态和认证 Cookie，不作为业务事实源。

## 1. 在线功能追踪

| 页面/入口 | 页面操作 | API/实时通道 | 当前事实源 | 目标 Repository/表或存储 | 审计/历史 | 主要验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/login` | 登录、恢复会话、退出 | `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout` | MySQL | `users`、`auth_sessions` | `audit_logs`、会话吊销/轮换 | `accept:auth`、`accept:auth-session-policy`、`accept:password-rotation` | 真实 |
| `/` | 查看首页项目、风险、会议、待办指标；完成/删除待办 | `/api/projects`、`/api/meetings`、`/api/todos`、`/api/risks`，待办写接口 | MySQL | `projects`、`meetings`、`todos`、`risks` | `audit_logs` | `accept:client-state-authority`、`accept:restart-persistence` | 真实；无固定演示指标 |
| `/projects` | 分页、创建、编辑、置顶、删除项目 | `/api/projects`、`PATCH/DELETE /api/projects/:id`、`POST /api/projects/:id/pin` | MySQL | `projects`、`project_members` | `audit_logs` | `accept:stable-pagination`、`accept:security-boundary` | 真实 |
| `/projects/:id` | 查看/编辑项目、成员和阶段 | `/api/projects/:id`、`PATCH /api/projects/:id` | MySQL | `projects`、`project_members` | `audit_logs`、OA 阶段日志 | `accept:security-boundary`、`accept:oa-workflow` | 真实 |
| `/projects/:id` | 上传、版本化、下载、预览、删除项目文件 | `/api/projects/files/upload`、`/api/projects/files/:id/*` | MySQL + 受控文件根 | `project_files`、`project_file_versions`、`file_chunks`、`knowledge_chunks`、`PROJECT_FILE_ROOT` | `audit_logs`（下载/预览只记对象 ID、容量和请求 ID）、文件版本链 | `accept:project-files`、`accept:project-file-integrity`、`accept:security-boundary` | 真实；缺失旧件隔离 |
| `/projects/:id` | 项目评分、查询状态、重试恢复 | `POST/GET /api/projects/:id/score` | MySQL + LLM Gateway | `project_score_jobs`、`projects.scoring/score`、Agent 审计链 | 任务状态、输入事件、Run/Decision/Evidence | `accept:project-score-lifecycle`、`accept:lead-scoring-agent` | 真实；异步租约 |
| `/sourcing` | 查看/分页/筛选线索、统计、编辑 | `/api/leads`、`/api/leads/stats`、`PATCH /api/leads/:id` | MySQL | `leads` | `audit_logs` | `accept:stable-pagination`、`accept:security-boundary` | 真实 |
| `/sourcing` | 线索评分、死信和人工重试 | `POST /api/leads/:id/score[/retry]`、`GET /api/leads/:id/score` | MySQL + LLM Gateway | `lead_score_jobs`、`leads.score/scoring`、Agent 审计链 | 不可变输入、Run/Decision/Evidence、人工重试计数 | `accept:lead-score-lifecycle`、`accept:lead-scoring-audit` | 真实；异步租约 |
| `/sourcing` | 公开情报新建/补全、Radar 摄入 | `/api/leads/public-intel/*`、Radar 进程内 Job | MySQL + 受控 Bing/Sogou | `lead_reserve`、`lead_pipeline_raw_events`、`lead_pipeline_items`、`lead_pipeline_transitions`、`lead_pipeline_runs`、`radar_*`、`runtime_jobs` | 原始事件、Transition、Run/Decision/Evidence、`audit_logs` | `accept:lead-public-intel`、`accept:lead-online-workflow`、`accept:radar-job-isolation` | 真实；Flue 已退场 |
| `/sourcing` | 人工复核、接受/拒绝并建档 | `/api/lead-pipeline/reviews`、`POST /api/lead-pipeline/reviews/:id/resolve` | MySQL | `lead_pipeline_reviews`、`lead_pipeline_decisions`、`lead_pipeline_evidence`、`leads` | 追加式决策/证据/状态历史 | `accept:lead-manual-review`、`accept:lead-pipeline-audit` | 真实；宿主事务提交 |
| `/sourcing` | 线索转项目 | `POST /api/leads/:id/convert` | MySQL | `leads`、`projects`、`project_members` | `audit_logs` | `accept:lead-conversion` | 真实；单事务 |
| `/sourcing` | 配置授权渠道推送规则、选择匹配线索并发送 | `/api/investment/leads/push-targets/*` | MySQL + 外部 IM Webhook | `im_lead_push_rules`、`im_bots`、`im_bot_bindings`、`im_outbox`、`im_delivery_logs` | 乐观锁、幂等键、投递日志、`audit_logs` | `accept:im-integrations` | 本地真实；仅安全目标元数据，原生渠道生产联调待验 |
| `/ai` | 创建、加载、删除会话和多轮消息 | `/api/conversations`、`/api/jw/*`、Socket.io `/socket.io` | MySQL + JW Runtime/LLM Gateway | `agent_conversations`、`agent_messages`、`agent_message_parts`、源映射表 | Runtime Run、消息 Part、`audit_logs` | `accept:jw-restart`、`accept:socket`、`accept:jw-runtime-boundary` | 真实；同一 3100 服务 |
| `/ai` | 选择模型和会话能力 | `/api/ai/model-settings/available`、`GET/PUT /api/ai/capabilities/conversations/:id` | MySQL | `ai_models`、`ai_model_routes`、`ai_capabilities`、`ai_capability_bindings`、`ai_conversation_capabilities` | `audit_logs`、乐观锁版本 | `accept:ai-model-settings`、`accept:ai-capabilities` | 真实；服务端复核授权 |
| `/ai` | 创建、取消、重试六类 AI 任务；查看/下载产物 | `/api/ai/tasks*`、`/api/ai/artifacts*` | MySQL + LLM/文档原生工具 + 受控产物目录 | `ai_tasks`、`ai_artifacts`、`ai_task_sources`、`ai_custom_templates`、`ai_template_analysis_progress` | 任务租约、尝试、错误、来源和产物链；产物下载/预览写请求关联 `audit_logs` | `accept:ai-task-unified`、`accept:ai-task-lifecycle`、`accept:ai-task-persistence`、`accept:security-boundary` | 真实；7 个缺件旧产物已隐藏 |
| `/meetings` | AI 生成纪要；创建会议和关联待办 | `POST /api/ai/meeting-summary`、`POST/PATCH /api/meetings` | MySQL + LLM Gateway | `meetings`、`meeting_participants`、`todos`、`ai_summaries` | `audit_logs` | `accept:meeting-persistence`、`accept:client-state-authority` | 真实；模型失败不制造纪要 |
| `/workflow` | 发起、审批、退回、拒绝、撤回、重提 | `/api/oa/requests*`、`/api/oa/workflow-logs` | MySQL | `oa_approval_requests`、`oa_approval_nodes`、`oa_approval_records`、`oa_workflow_logs`、`todos`、`projects` | OA 全阶段日志、`audit_logs` | `accept:oa-workflow` | 真实；事务状态机 |
| `/risks` | 查看、新建、更新风险 | `/api/risks`、`PATCH /api/risks/:id` | MySQL | `risks` | `audit_logs` | `accept:risk-persistence`、`accept:client-state-authority` | 真实；失败不制造建议 |
| `/knowledge` | 查看、上传、索引、删除知识文件 | `/api/projects/files/all`、`/api/projects/files/upload`、文件写接口 | MySQL + 受控文件根 | `project_files`、`project_file_versions`、`file_chunks`、`knowledge_chunks` | `audit_logs`、文件版本/解析状态 | `accept:project-files`、`accept:project-knowledge-tools` | 真实；真实字节优先 |
| `/system` | 管理用户、组织、角色权限和数据字典；查看模板、审计与迁移运维 | `/api/users*`、`/api/system-administration/*`、`/api/templates`、`/api/audit-logs` | MySQL | `users`、`departments`、`roles`、`permissions`、`role_permissions`、`user_roles`、`user_departments`、`dictionary_groups`、`dictionary_items`、`ai_task_templates`、`audit_logs` | 乐观版本、防自锁、会话吊销、事务内管理员审计 | `accept:system-administration`、`accept:identity-administration`、`accept:client-state-authority` | 本地真实；有效权限参与系统/AI/IM路由授权，生产多角色待验 |
| `/system/ai/models` | Provider/模型/主备路由、密钥替换、连接测试 | `/api/ai/model-settings/*` | MySQL + 外部 LLM Gateway | `ai_model_providers`、`ai_models`、`ai_model_routes` | AES-GCM 密文、掩码响应、`audit_logs` | `accept:ai-model-settings` | 真实；管理员限定 |
| `/system/ai/capabilities` | 同步、启停、测试能力、Agent 模型/工具/预算/超时/角色策略和作用域授权 | `/api/ai/capabilities/*`、`PATCH /api/ai/capabilities/agents/:id/policy` | MySQL + 代码内批准目录 | `ai_capabilities`、`ai_capability_bindings` | `audit_logs`、版本字段、服务端范围校验 | `accept:ai-capabilities` | 真实；策略只能收窄运行时上限，未知扩展不自动执行 |
| `/system/integrations/im-bots` | 配置/替换凭据、启停/测试机器人、绑定用户/部门/项目/群聊/Agent、测试发送和查看投递 | `/api/integrations/im/*`、签名入站 `/api/integrations/im/inbound/:botId` | MySQL + 外部 IM Webhook | `im_bots`、`im_bot_bindings`、`im_outbox`、`im_delivery_logs`、`im_inbound_messages` | AES-GCM 密文、掩码响应、乐观锁、租约/重试/死信、`audit_logs` | `accept:im-integrations`、`check:single-service` | 本地通用基座真实；钉钉/飞书/微信原生协议和生产凭据待验 |

## 2. 退场、隐藏和浏览器状态

| 入口/状态 | 处置 | 事实源结论 | 验收 |
| --- | --- | --- | --- |
| `/materials` | 永久重定向 `/ai` | 旧材料浏览器状态和固定成功 API 不再是事实源 | `accept:client-state-authority` |
| `/post-investment` | 永久重定向 `/projects` | 无目标契约的投后本地状态退场 | `accept:client-state-authority` |
| BP/批量导入模拟入口 | 删除并保持不可见 | 正式上传→解析任务→证据→人工复核契约完成前不恢复 | `accept:client-state-authority` |
| 通知铃铛/通知已读 | 隐藏 | 无服务端权威表时不展示假状态 | `accept:client-state-authority` |
| 组织、角色、字典写入 | 退场 | 系统页不提供无目标 Schema 的浏览器写入 | `accept:client-state-authority` |
| 钉钉/飞书/微信原生渠道生产联调 | 通用 IM 基座已上线，原生签名/事件协议和真实租户凭据保持未启用 | 不以 `mock://` 或通用签名验收冒充真实渠道收发；外部渠道仍可独立延期 | `IM-004～006` 保持未完成；`accept:im-integrations` 仅证明本地授权、加密和投递契约 |
| 搜索词、筛选项、当前 Tab、弹窗开关 | 浏览器瞬时偏好 | 可留在组件状态；不得被当作项目、线索、任务或审批事实 | `accept:client-state-authority` |
| Flue 3584、Radar 8121 | 服务退场 | 会话、Radar 候选/游标/运行状态迁入 MySQL 或隔离；无活动反代和监听 | `accept:single-service-runtime`、`check:single-service` |

## 3. 审批边界

该矩阵完成 `MIG-0009` 的技术追踪要求，但不替代业务、数据和运维审批。生产 `pg_catalog`、Radar/群聊/公众号原资产、全部文件根和最终页面人工操作矩阵尚未共同签字，因此 `PRE-012/013`、`GATE-M0-06` 继续保持未完成。
