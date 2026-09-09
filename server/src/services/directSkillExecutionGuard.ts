export function createDirectSkillExecutionGuard(options: {
  totalMs: number
  idleMs: number
  pollMs?: number
  shouldCancel?: () => boolean | undefined | Promise<boolean | undefined>
}) {
  const controller = new AbortController()
  let disposed = false
  let checking = false
  const stop = (code: string, message: string) => {
    if (!disposed && !controller.signal.aborted) controller.abort(Object.assign(new Error(message), { code }))
  }
  const total = setTimeout(() => stop('DIRECT_SKILL_AGENT_TIMEOUT', '文档 Agent 总执行时间超过限制'), options.totalMs)
  const idleExpired = () => stop('DIRECT_SKILL_AGENT_IDLE_TIMEOUT', '文档 Agent 长时间未返回执行消息')
  let idle = setTimeout(idleExpired, options.idleMs)
  const polling = options.shouldCancel ? setInterval(() => {
    if (checking || disposed || controller.signal.aborted) return
    checking = true
    void Promise.resolve().then(options.shouldCancel!).then((cancelled) => {
      if (cancelled) stop('AI_TASK_CANCELLED', '用户已取消文档 Agent 任务')
    }).catch(() => {
      stop('DIRECT_SKILL_AGENT_CANCEL_CHECK_FAILED', '无法确认任务取消状态，已停止文档 Agent')
    }).finally(() => { checking = false })
  }, options.pollMs ?? 2000) : undefined
  return {
    controller,
    activity() {
      if (disposed || controller.signal.aborted) return
      clearTimeout(idle)
      idle = setTimeout(idleExpired, options.idleMs)
    },
    throwIfStopped() {
      if (controller.signal.aborted) throw controller.signal.reason
    },
    // Remove each listener when its operation settles, including operations
    // whose SDK promise ignores AbortSignal. No uncaught late rejections.
    async wait<T>(operation: Promise<T>): Promise<T> {
      if (controller.signal.aborted) {
        void operation.catch(() => {})
        throw controller.signal.reason
      }
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', aborted, { once: true })
        operation.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted))
      })
    },
    dispose() {
      disposed = true
      clearTimeout(total)
      clearTimeout(idle)
      if (polling) clearInterval(polling)
    },
  }
}
