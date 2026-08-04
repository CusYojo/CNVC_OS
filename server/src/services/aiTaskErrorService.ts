type CodedError = Error & {
  code?: unknown
  upstreamCode?: unknown
}

function errorCode(error: unknown) {
  return String((error as CodedError | null)?.code ?? '')
}

export function safeAiTaskFailureStage(error: unknown) {
  const code = errorCode(error)
  if (code === 'DUE_DILIGENCE_CONTENT_QUALITY_REJECTED') return '正文质量检查未通过'
  if (code === 'DUE_DILIGENCE_MODEL_UNAVAILABLE') return '大模型正文生成未完成'
  if (code === 'DUE_DILIGENCE_NETWORK_UNAVAILABLE') return '联网资料补全未完成'
  if (code === 'INVESTMENT_RECOMMENDATION_CONTENT_REJECTED') {
    return 'Gorden 可编辑分层检查未通过'
  }
  if (code === 'INVESTMENT_PPT_SKILL_CHAIN_NOT_EXECUTED') {
    return '三技能生成链未完整执行'
  }
  if (code === 'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED') return 'Gorden 页面文字检查未通过'
  if (code === 'GORDEN_VISUAL_QA_REJECTED') return 'Gorden 最终视觉复核未通过'
  if (code === 'GORDEN_LAYOUT_GUARD_REJECTED') return 'Gorden 页面布局检查未通过'
  if (code.startsWith('GORDEN_')) return 'Gorden PPT 生成未完成'
  if (code.startsWith('PPTX_')) return 'PPTX 文件质量检查未通过'
  return '文档尚未完成'
}

export function safeAiTaskFailureMessage(error: unknown) {
  const code = errorCode(error)
  const upstreamCode = String((error as CodedError | null)?.upstreamCode ?? '')
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
  if (code === 'INVESTMENT_RECOMMENDATION_CONTENT_REJECTED') {
    return '投资建议书未通过 Gorden 页面生成、四层可编辑还原或样本残留检查。系统已保留参数，请点击“继续生成”重新生成并复核。'
  }
  if (code === 'INVESTMENT_PPT_SKILL_CHAIN_NOT_EXECUTED') {
    return '投资建议书未完整执行 create-reference-driven-editable-ppt、GordenSuperPPTSkill 和 pdf-to-editable-ppt，系统已拒绝交付降级产物。请检查技能运行时后继续生成。'
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
    return '生成的 PPTX 缺少“引用资料与责任声明”末页，未通过交付检查。请点击“继续生成”。'
  }
  if (code === 'PPTX_CJK_THEME_MISSING') {
    return '生成的 PPTX 缺少有效中文主题字体，可能导致跨平台版式变化。请点击“继续生成”。'
  }
  if (code === 'PPTX_EDITABLE_CONTENT_INSUFFICIENT') {
    return '生成的 PPTX 可编辑文本对象不足，未达到可编辑交付要求。请点击“继续生成”。'
  }
  return '文档尚未完成，系统已保留本次生成参数，可继续生成。'
}
