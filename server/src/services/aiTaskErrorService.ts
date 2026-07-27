type CodedError = Error & {
  code?: unknown
  status?: unknown
}

export function safeAiTaskFailureMessage(error: unknown) {
  const coded = error as CodedError
  const code = String(coded?.code ?? '')
  const message = String(coded?.message ?? '')

  if (code === 'INVESTMENT_PROPOSAL_WEB_RESEARCH_FAILED') {
    return '投资提案公开资料检索暂不可用，请稍后重试；已停止生成以避免形成无依据结论。'
  }
  if (code === 'INVESTMENT_PROPOSAL_CHAPTER_GENERATION_FAILED') {
    return '投资提案章节生成失败：模型请求中断或返回格式异常，系统已自动重试；请稍后再次尝试。'
  }
  if (code === 'INVESTMENT_PROPOSAL_REVIEW_FAILED') {
    return '投资提案内容安全审查未通过：检测到结构、引用或事实支持问题，已阻止生成。请补充项目资料后重试。'
  }
  if (
    code === 'INVESTMENT_PROPOSAL_TEMPLATE_EVIDENCE_LEAK'
    || code === 'INVESTMENT_PROPOSAL_BLUEPRINT_DRIFT'
    || code === 'INVESTMENT_PROPOSAL_CORE_STANDARD_INVALID'
    || code === 'INVESTMENT_PROPOSAL_TEMPLATE_INVALID'
    || /投资提案模板|Document Blueprint/.test(message)
  ) {
    return '投资提案模板或结构规范校验未通过，请联系管理员同步模板与生成规则。'
  }
  if (/投资提案 Word Reviewer/.test(message)) {
    return '投资提案 Word 文件质量检查未通过，系统已停止交付；请重试或凭错误编号联系管理员。'
  }
  if (/投资提案 PDF Reviewer|投资提案 PDF/.test(message)) {
    return '投资提案 PDF 转换或质量检查未通过，系统已停止交付；请重试或凭错误编号联系管理员。'
  }
  return '任务生成失败，请重试；如问题持续，请凭错误编号联系管理员。'
}
