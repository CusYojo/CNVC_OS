type CodedError = Error & {
  code?: unknown
  upstreamCode?: unknown
  qualityIssues?: unknown
}

function errorCode(error: unknown) {
  return String((error as CodedError | null)?.code ?? '')
}

export function safeAiTaskFailureStage(error: unknown) {
  const code = errorCode(error)
  if (code === 'PROJECT_KNOWLEDGE_COMPLETE_STUDY_FAILED') return '全部项目资料片段研读未完成'
  if (code === 'DIRECT_SKILL_AGENT_AUTH_OR_QUOTA') return '直接 Skill Agent 模型额度不可用'
  if (code === 'DIRECT_SKILL_AGENT_AUTHENTICATION_FAILED') return '直接 Skill Agent 模型认证失败'
  if (code === 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED') return '直接 Skill Agent 模型额度不足'
  if (code === 'DIRECT_SKILL_AGENT_UPSTREAM_FORBIDDEN') return '直接 Skill Agent 模型网关暂时拒绝'
  if (code === 'DIRECT_SKILL_NOT_INVOKED') return '直接 Skill 未被调用'
  if (code === 'DIRECT_SKILL_OUTPUT_CONTRACT_FAILED') return 'Skill 成品输出检查未通过'
  if (code === 'DIRECT_SKILL_OUTPUT_INVALID') return 'Skill 成品文件不完整'
  if (code.startsWith('DIRECT_SKILL_AGENT_')) return '直接 Skill Agent 未完成'
  if (code === 'DUE_DILIGENCE_CONTENT_QUALITY_REJECTED') return '正文质量检查未通过'
  if (code === 'DUE_DILIGENCE_MODEL_UNAVAILABLE') return '大模型正文生成未完成'
  if (code === 'DUE_DILIGENCE_NETWORK_UNAVAILABLE') return '联网资料补全未完成'
  if (code === 'DUE_DILIGENCE_PUBLIC_RESEARCH_AUDIT_REQUIRED') return '公开研究覆盖审计未通过'
  if (code === 'DUE_DILIGENCE_SKILL_RUNTIME_UNAVAILABLE') return '尽调技能运行环境未就绪'
  if (code === 'DUE_DILIGENCE_EVIDENCE_EMPTY') return '尽调证据台账为空'
  if (code.startsWith('DUE_DILIGENCE_SKILL_')) return '尽调技能交付门禁未通过'
  if (code === 'PROJECT_QA_DEPTH_GATE_FAILED') return 'Q&A 投资分析深度检查未通过'
  if (code === 'INVESTMENT_RECOMMENDATION_CONTENT_QUALITY_REJECTED') {
    return '投资建议书正文专业性检查未通过'
  }
  if (code === 'INVESTMENT_RECOMMENDATION_CONTENT_REJECTED') {
    return 'Gorden 可编辑分层检查未通过'
  }
  if (code === 'INVESTMENT_PPT_SKILL_CHAIN_NOT_EXECUTED') {
    return '三技能生成链未完整执行'
  }
  if (code === 'REFERENCE_DRIVEN_PDF_BRIDGE_FAILED') return '图片版 PDF 桥接未完成'
  if (code === 'REFERENCE_DRIVEN_PIPELINE_HANDOFF_REJECTED') return '可编辑版交接检查未通过'
  if (code.startsWith('REFERENCE_DRIVEN_IMAGE_DECK_')) return '图片高保真版文件检查未通过'
  if (code.startsWith('PDF_')) return '元素级可编辑转换未完成'
  if (code === 'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED') return 'Gorden 页面文字检查未通过'
  if (code === 'GORDEN_VISION_GATEWAY_FAILED') return 'Gorden 页面视觉定位未完成'
  if (code === 'GORDEN_VISUAL_QA_REJECTED') return 'Gorden 最终视觉复核未通过'
  if (code === 'GORDEN_LAYOUT_GUARD_REJECTED') return 'Gorden 页面布局检查未通过'
  if (code.startsWith('GORDEN_')) return 'Gorden PPT 生成未完成'
  if (code.startsWith('PPTX_')) return 'PPTX 文件质量检查未通过'
  return '文档尚未完成'
}

export function safeAiTaskFailureMessage(error: unknown) {
  const code = errorCode(error)
  const upstreamCode = String((error as CodedError | null)?.upstreamCode ?? '')
  if (code === 'PROJECT_KNOWLEDGE_COMPLETE_STUDY_FAILED') {
    return '全部项目资料片段中仍有批次未完成研读，因此未使用部分资料生成提案。系统已保留任务参数，请稍后点击“继续生成”；系统只会拆分并重试失败批次，不会减少项目资料。'
  }
  if (code === 'DIRECT_SKILL_AGENT_AUTH_OR_QUOTA') {
    return '正式文档模型的认证或额度当前不可用，系统已停止自动重跑并保留 Agent 工作区。请恢复凭据或额度后点击“继续生成”。'
  }
  if (code === 'DIRECT_SKILL_AGENT_AUTHENTICATION_FAILED') {
    return '正式文档模型认证失败，系统已停止自动重跑并保留 Agent 工作区。请修复当前文档模型凭据后点击“继续生成”。'
  }
  if (code === 'DIRECT_SKILL_AGENT_QUOTA_EXHAUSTED') {
    return '正式文档模型明确返回令牌额度或余额不足，系统已停止自动重跑并保留 Agent 工作区。请恢复对应 API Key 的额度后点击“继续生成”。'
  }
  if (code === 'DIRECT_SKILL_AGENT_UPSTREAM_FORBIDDEN') {
    return '模型网关连续返回普通 403。系统已保留全部资料和 Agent 工作区，但本轮全新上下文仍未完成最终复核；可稍后点击“继续生成”。'
  }
  if (code === 'DIRECT_SKILL_NOT_INVOKED') {
    return '隔离 Agent 未实际调用当前任务绑定的 Skill，因此系统未发布替代稿。任务参数已保留，可点击“继续生成”。'
  }
  if (code === 'DIRECT_SKILL_OUTPUT_CONTRACT_FAILED' || code === 'DIRECT_SKILL_OUTPUT_INVALID') {
    return 'Skill 未生成唯一且完整的正式成品文件，系统未发布示例、模板或占位文件。任务参数已保留，可点击“继续生成”。'
  }
  if (code.startsWith('DIRECT_SKILL_AGENT_')) {
    return '直接 Skill Agent 本轮未完成生成与审阅，因此系统没有使用旧模板链路或宿主兜底稿。任务参数已保留，可点击“继续生成”。'
  }
  if (code === 'DUE_DILIGENCE_CONTENT_QUALITY_REJECTED') {
    return '尽调正文未通过完整性、章节匹配或可读性检查，因此未生成文件。系统已保留参数，可点击“继续生成”重新生成并复核。'
  }
  if (code === 'DUE_DILIGENCE_MODEL_UNAVAILABLE') {
    if (upstreamCode === 'DUE_DILIGENCE_MODEL_OUTPUT_TRUNCATED') {
      return '大模型输出达到长度上限，正文 JSON 未完整返回，因此未生成文件。系统已切换为精简的高密度生成规则，请点击“继续生成”。'
    }
    if (upstreamCode === 'DUE_DILIGENCE_MODEL_INVALID_JSON') {
      return '大模型返回的正文结构不完整，系统未交付损坏文档。请点击“继续生成”重新生成。'
    }
    if (upstreamCode === 'DUE_DILIGENCE_MODEL_EMPTY_RESPONSE') {
      return '大模型本次未返回有效正文，因此未生成文件。请稍后点击“继续生成”。'
    }
    if (upstreamCode === 'DUE_DILIGENCE_MODEL_HTTP_ERROR') {
      return '大模型网关返回服务错误，因此未生成文件。请确认网关服务恢复后点击“继续生成”。'
    }
    if (upstreamCode === 'DUE_DILIGENCE_MODEL_TIMEOUT') {
      return '大模型正文生成超过允许等待时间，因此未生成文件。请稍后点击“继续生成”。'
    }
    return '大模型请求超时、返回格式异常或服务暂不可用，因此未生成文件。请稍后点击“继续生成”。'
  }
  if (code === 'DUE_DILIGENCE_NETWORK_UNAVAILABLE') {
    return '公开资料补全服务暂不可用，因此未生成文件。请确认联网检索服务恢复后点击“继续生成”。'
  }
  if (code === 'DUE_DILIGENCE_PUBLIC_RESEARCH_AUDIT_REQUIRED') {
    return '当前尽调主要依赖公开信息，但尚未完成公司、产品、团队、市场、竞争、客户、融资及合规八个领域的覆盖审计。请补充项目原始资料，或完成公开研究审计后再继续生成。'
  }
  if (code === 'DUE_DILIGENCE_SKILL_RUNTIME_UNAVAILABLE') {
    return 'draft-due-diligence-report 运行环境未就绪，因此未生成文件。请管理员检查 Python 依赖、LibreOffice 及仿宋/黑体中文字体。'
  }
  if (code === 'DUE_DILIGENCE_EVIDENCE_EMPTY') {
    return '现有资料中没有可进入尽调证据台账的有效事实，因此未生成文件。请先补充项目原始资料。'
  }
  if (code === 'DUE_DILIGENCE_SKILL_FIELD_GATE_FAILED') {
    return '关键尽调字段缺少可核验证据，未达到对应报告模式的生成条件，因此未交付空泛或推测性文档。请补充项目资料后继续生成。'
  }
  if (code.startsWith('DUE_DILIGENCE_SKILL_')) {
    return '尽调报告未通过证据、字段、内容、人工文风、DOCX 样式或逐页渲染中的一项交付门禁，因此未发布文件。请根据任务阶段检查资料或技能运行环境后继续生成。'
  }
  if (code === 'PROJECT_QA_DEPTH_GATE_FAILED') {
    return 'Q&A 中部分回答的正文密度、与本题相关的因果层级，或整份报告的投资维度覆盖尚未达到交付要求。系统已保留参数，可继续生成；如重复出现，请补充能够改变相关问题判断的项目事实。'
  }
  if (code === 'INVESTMENT_RECOMMENDATION_CONTENT_QUALITY_REJECTED') {
    const issues = Array.isArray((error as CodedError | null)?.qualityIssues)
      ? (error as CodedError).qualityIssues as unknown[]
      : []
    const issueText = issues.map(String).join(' ')
    const categories = [
      /章节数量|信息密度|内容过少|有效发现|占位/.test(issueText) ? '章节内容' : '',
      /来源|证据覆盖|追溯/.test(issueText) ? '来源引用' : '',
      /数据|表格|指标|交易条款/.test(issueText) ? '数据与表格' : '',
      /标题职责|标题匹配|正文与标题/.test(issueText) ? '章节匹配' : '',
      /内部|模型化|套话|文风|固定字段/.test(issueText) ? '投资经理文风' : '',
    ].filter(Boolean)
    const detail = categories.length
      ? `尚需完善：${categories.join('、')}。`
      : '章节完整性、证据覆盖、数据表格、标题匹配或投资经理文风仍需完善。'
    return `投资建议书正文未达到交付标准，${detail}系统已保留参数，请点击“继续生成”重新检索并生成正文。`
  }
  if (code === 'INVESTMENT_RECOMMENDATION_CONTENT_REJECTED') {
    return '投资建议书未通过 Gorden 页面生成、四层可编辑还原或页面文字与事实检查。系统已保留参数，请点击“继续生成”重新生成并复核。'
  }
  if (code === 'INVESTMENT_PPT_SKILL_CHAIN_NOT_EXECUTED') {
    return '投资建议书未完整执行图片高保真版、PDF 桥接和元素级可编辑版链路，系统已停止最终交付。请检查技能运行时后继续生成。'
  }
  if (code === 'REFERENCE_DRIVEN_PDF_BRIDGE_FAILED') {
    return '图片高保真版已经保留，但桥接 PDF 未能完成页数、比例或哈希检查。请点击“继续生成”恢复可编辑版。'
  }
  if (code === 'REFERENCE_DRIVEN_PIPELINE_HANDOFF_REJECTED') {
    return '图片高保真版已经保留，但元素级可编辑版未通过页面、哈希、水印或可编辑性综合交接检查。请点击“继续生成”恢复可编辑版。'
  }
  if (code.startsWith('REFERENCE_DRIVEN_IMAGE_DECK_')) {
    return '图片高保真版 PPTX 的文件大小或页数检查未通过，系统未发布不完整文件。请点击“继续生成”。'
  }
  if (code === 'PDF_SEMANTIC_OVERRIDES_MISSING') {
    return '图片版已经保留，但可编辑转换所需的页面语义清单缺失。请点击“继续生成”从检查点恢复。'
  }
  if (code.startsWith('PDF_')) {
    return '图片高保真版已经保留，但元素级可编辑转换或最终页面校验未完成。请检查 PDF 转 PPT 运行环境后点击“继续生成”。'
  }
  if (code === 'GORDEN_IMAGE_GATEWAY_UNCONFIGURED') {
    return 'GordenSuperPPTSkill 缺少图片生成网关密钥，无法执行逐页出图。请配置 GATEWAY_IMAGE_API_KEY 后继续生成。'
  }
  if (code === 'GORDEN_SUPER_PPT_SKILL_INCOMPLETE') {
    return 'GordenSuperPPTSkills 文件不完整，无法执行页面生成与可编辑分层重建。请重新同步技能目录后继续生成。'
  }
  if (code === 'GORDEN_SUPER_PPT_TIMEOUT') {
    return 'Gorden 页面生成或可编辑分层重建超过允许等待时间。系统已保留参数，请稍后继续生成。'
  }
  if (code === 'GORDEN_IMAGE_GATEWAY_TIMEOUT') {
    return 'Gorden 图片网关已接受页面生成请求，但结果轮询超过等待时间。任务诊断已保留，可稍后继续生成。'
  }
  if (code === 'GORDEN_IMAGE_GATEWAY_FAILED') {
    return 'Gorden 图片网关在页面或可编辑图层生成阶段返回异常。系统已保留具体页码、图层和最后网关响应，请确认网关恢复后继续生成。'
  }
  if (code === 'GORDEN_ICON_LAYER_UNSAFE') {
    return 'Gorden 图标层中的元素接触图片外边界，无法安全切分为可编辑对象。系统未交付被截断的 PPTX，请点击“继续生成”重新生成该图标层。'
  }
  if (code === 'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED') {
    return 'Gorden 页面包含文字清单之外的额外标题、标签、编号或来源文字，无法保证分层后内容完整。系统已停止交付，请继续生成该页面。'
  }
  if (code === 'GORDEN_VISION_GATEWAY_FAILED') {
    return 'Gorden 页面视觉定位网关连续返回临时错误。系统已保留成品页和已完成图层，请稍后继续生成，任务将从当前页面检查点恢复。'
  }
  if (code === 'GORDEN_VISUAL_QA_REJECTED') {
    return 'Gorden 可编辑稿存在契约文字缺失、严重遮挡、裁切或不可读问题，未通过最终交付复核。系统已保留检查点，请继续生成有问题的页面。'
  }
  if (code === 'GORDEN_LAYOUT_GUARD_REJECTED') {
    return 'Gorden 已完成页面和图层生成，但可编辑文本的字号、换行或字重未通过布局检查。系统已保留检查点，请继续生成有问题的页面。'
  }
  if (code === 'GORDEN_SUPER_PPT_FAILED') {
    return 'Gorden 页面生成、图片分层或可编辑 PPTX 合成失败。系统已保留参数，请检查图片网关和 Python 运行环境后继续生成。'
  }
  if (code === 'PPTX_OPENXML_INVALID') {
    return '生成的 PPTX 包结构不完整，系统未交付损坏文件。请点击“继续生成”。'
  }
  if (code === 'PPTX_UNICODE_INVALID') {
    return '生成的 PPTX 包含损坏字符，系统未交付异常文件。请点击“继续生成”。'
  }
  if (code === 'PPTX_CJK_LANGUAGE_INVALID') {
    return '生成的 PPTX 中文文本语言标记不正确，可能引起字体回退。系统已保留参数，请点击“继续生成”。'
  }
  if (code === 'PPTX_REFERENCES_MISSING') {
    return '生成的 PPTX 缺少“资料来源与声明”末页，未通过交付检查。请点击“继续生成”。'
  }
  if (code === 'PPTX_CJK_THEME_MISSING') {
    return '生成的 PPTX 缺少有效中文主题字体，可能导致跨平台版式变化。请点击“继续生成”。'
  }
  if (code === 'PPTX_EDITABLE_CONTENT_INSUFFICIENT') {
    return '生成的 PPTX 可编辑文本对象不足，未达到可编辑交付要求。请点击“继续生成”。'
  }
  return '文档尚未完成，系统已保留本次生成参数，可继续生成。'
}
