# 智灵动力 Q&A 内部证据台账

| 事实键 | 主题 | 主张 | 类型 | 来源及定位 | 日期/期间 | 单位/币种 | 证据等级 | 状态 | 对应问题 | 下一步验证 |
|---|---|---|---|---|---|---|---|---|---|---|
| company_positioning | 项目定位 | 智灵动力面向企业级 AI Agent 场景，产品覆盖研究、视频、短剧、数字人和品牌营销。 | 事实 | src/mock/data.ts：projects[p-2001].summary、leads[l-2001].product | 2026-07-02 | - | B / C | 部分核验 | Q1、Q4 | 核对官网产品归属与公司主体 |
| technology_route | 技术路径 | 公司以 ZeeLin 自进化智能体框架为底座，并采用 FDE 项目交付、能力组件化和产品复用路径。 | 企业陈述 | src/mock/data.ts：aiSummaries[p-2001].positioning、highlights | 2026-07-02 | - | C | 企业口径 | Q1、Q3、Q7 | 取得组件复用台账与项目版本记录 |
| desearch_features | 产品能力 | Desearch 呈现深度研究、行业研究、专家模式、知识库和多源数据融合能力。 | 事实 | src/mock/data.ts：leads[l-2001].sources[src-zl-2] | 2025 / 2026-07-02访问 | - | B | 官网可观察 | Q2 | 以企业账户复核功能与权限边界 |
| desearch_interfaces | 产品能力 | Desearch 对外提供企业级 API 与 MCP 接口。 | 事实 | src/mock/data.ts：leads[l-2001].companyNews[2025-12-19] | 2025-12-19 | - | B | 官方产品文档 | Q2 | 调取接口文档、定价与调用记录 |
| fde_economics | 商业模式 | FDE 是否形成规模效应取决于标准模块复用率、交付人天、实施周期和增购表现。 | 分析判断 | src/mock/data.ts：projects[p-2001].businessModel、aiSummaries[p-2001].risks | 2026-07-02 | - | C | 分析结论 | Q3、Q6、Q7 | 按项目取得合同额、工时、毛利和复用模块明细 |
| metav_workflow | 产品能力 | MetaV 覆盖创意引擎、内容工厂、智能获客和数据闭环，并与视频、数字人能力存在复用空间。 | 事实与推断 | src/mock/data.ts：leads[l-2001].sources[src-zl-3]、companyNews[2025] | 2025 / 2026-07-02访问 | - | B / C | 官网可观察与分析 | Q4、Q6 | 比较产品间账户、客户、模型与素材资产复用情况 |
| commercialization_signals | 商业化 | 产品可访问、企业接口开放及高校合作交流说明公司已形成产品载体和场景触达，但不等同于持续付费。 | 事实与判断 | src/mock/data.ts：leads[l-2001].companyNews、sources[src-zl-1至3] | 2025—2026 | - | B / C | 部分核验 | Q5、Q7 | 取得客户状态、合同、验收、回款、续费与增购序列 |
| valuation_framework | 估值 | 估值基础价值来自可重复收入与毛利，平台期权来自 Desearch、FDE 组件和 MetaV 之间的客户与技术复用。 | 分析判断 | src/mock/data.ts：projects[p-2001].businessModel、market；aiSummaries[p-2001] | 2026-07-02 | - | C | 分析结论 | 建立产品线收入、毛利、交付人天及交叉销售桥接表 |
| decision_conditions | 接触判断 | 项目值得继续接触，核心观察点是产品收入转化、FDE 经营杠杆和多产品协同。 | 投资判断 | src/mock/data.ts：aiSummaries[p-2001].highlights、risks、questions | 2026-07-02 | - | C | 条件性判断 | 以连续经营数据检验三组关系 |
| invalidation_conditions | 失效条件 | 定制收入与人数同步增长，或多产品客户重合度低且各自依赖独立销售交付，会削弱股权投资回报空间。 | 风险判断 | src/mock/data.ts：aiSummaries[p-2001].risks、leads[l-2001].risks | 2026-07-02 | - | C | 分析结论 | Q7 | 比较至少两个完整季度的人员、合同额、毛利与客户重合度 |
