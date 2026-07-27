import http from 'node:http'

const port = Number(process.env.AI_ACCEPTANCE_LLM_PORT ?? 18081)
let completionCount = 0

function json(res: http.ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    messages?: Array<{ role?: string; content?: string }>
  }
}

function chapterResponse(prompt: string) {
  const chapter = prompt.match(/请只生成“([^”]+)”章节JSON/)?.[1] ?? ''
  const sourceIndex = Number(prompt.match(/\[S(\d+)]/)?.[1] ?? 0)
  const evidence = prompt.match(/本章证据：\s*\[S\d+][^\n]*\n([\s\S]*?)\n\n请只生成/)?.[1]
    ?.trim()
    .split(/\n+/)
    .find((line) => line.trim().length >= 8)
    ?.trim()
  if (!chapter || !evidence) {
    return {
      summary: '当前项目暂无相关资料。',
      findings: [{
        text: '当前项目暂无相关资料。需补充对应章节的一手材料后再行核验。',
        status: '资料缺口',
        sourceIndexes: [],
      }],
    }
  }
  return {
    summary: `“${chapter}”仅依据当前项目证据生成。`,
    findings: [{
      text: evidence.slice(0, 220),
      status: '资料记载',
      sourceIndexes: [sourceIndex],
    }],
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    json(res, 200, {
      object: 'list',
      data: [{ id: 'compliance-acceptance-model', object: 'model' }],
    })
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, completionCount })
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const payload = await readJson(req)
      const prompt = [...(payload.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'user')
        ?.content ?? ''
      const content = chapterResponse(prompt)
      completionCount += 1
      console.log(`[acceptance-llm] chapter completion ${completionCount}`)
      json(res, 200, {
        id: `acceptance-${completionCount}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(content) },
        }],
      })
    } catch (error) {
      json(res, 400, { error: { message: (error as Error).message } })
    }
    return
  }
  json(res, 404, { error: { message: 'not found' } })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Compliance acceptance LLM listening on http://127.0.0.1:${port}/v1`)
})

process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
