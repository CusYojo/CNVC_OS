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
  return '文档尚未完成，系统已保留本次生成参数，可继续生成。'
}
