import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Run actual route/helper bodies with injected in-memory dependencies. No .env or DB.
const text = readFileSync(new URL('../src/routes/dueDiligence.ts', import.meta.url), 'utf8')
const source = ts.createSourceFile('dueDiligence.ts', text, ts.ScriptTarget.Latest, true)
function compile(expression: string, dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(`const subject = ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return runInNewContext(`${code}\nsubject`, dependencies)
}
function helper(name: string, dependencies: Record<string, unknown>) {
  const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(node, `missing helper ${name}`)
  return compile(node.getText(source), dependencies)
}
function route(method: string, path: string, dependencies: Record<string, unknown>) {
  for (const node of source.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
    const call = node.expression
    if (call.expression.getText(source) !== `dueDiligenceRouter.${method}` || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== path) continue
    return compile(call.arguments[1].getText(source), dependencies)
  }
  throw new Error(`missing route ${method} ${path}`)
}

test('shared due diligence content rejects project members lacking any source file access', async () => {
  const calls: string[] = []
  const guard = helper('requireDueDiligenceProject', {
    db: {}, requireAccessibleProject: async () => { calls.push('project'); return { id: 'project' } },
    canReadAllProjectFiles: async () => { calls.push('files'); return false },
  })
  await assert.rejects(guard('user', 'project'), { status: 403, code: 'DUE_DILIGENCE_SOURCE_FORBIDDEN' })
  assert.deepEqual(calls, ['project', 'files'])
})

test('shared due diligence content allows an actor with current project and source access', async () => {
  const guard = helper('requireDueDiligenceProject', {
    db: {}, requireAccessibleProject: async () => ({ id: 'project' }), canReadAllProjectFiles: async () => true,
  })
  assert.equal((await guard('user', 'project')).id, 'project')
})

test('every project route applies the source authorization boundary', () => {
  for (const node of source.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue
    const call = node.expression
    if (!call.expression.getText(source).startsWith('dueDiligenceRouter.') || !ts.isStringLiteral(call.arguments[0]) || !call.arguments[0].text.startsWith('/projects/')) continue
    assert.match(call.arguments[1].getText(source), /await requireDueDiligenceProject\(/, call.arguments[0].text)
  }
})

test('listing learning candidates never scans materials or calls the model', async () => {
  const table = { id: 'id', ownerUserId: 'owner', twinId: 'twin' }
  const query = { from() { return this }, where() { return this }, limit: async () => [{ id: 'twin' }], orderBy: async () => [] }
  const handler = route('get', '/twins/:id/learning-candidates', {
    routeId: (id: string) => id, db: { select: () => query }, digitalTwins: table, digitalTwinLearningCandidates: table,
    eq: () => true, and: () => true, desc: () => true, learningCandidateAccessCondition: () => true,
    scanExperienceMaterials: () => { throw new Error('GET performed a write') },
    synthesizeRuleCandidates: () => { throw new Error('GET performed a write') },
    enrichExperienceEventsWithModel: () => { throw new Error('GET called a model') },
  })
  let result: unknown
  await handler({ params: { id: 'twin' }, user: { uid: 'user' } }, { json: (value: unknown) => { result = value } }, (error: unknown) => { throw error })
  assert.equal(JSON.stringify(result), '{"list":[]}')
})

test('linking a file verifies the actor current file ACL and project binding', async () => {
  const validate = helper('validateProjectLinks', {
    db: {}, requireProjectFileAccess: async () => { throw Object.assign(new Error('denied'), { status: 403 }) },
  })
  await assert.rejects(validate('project', null, 'private-file', 'user'), { status: 403 })
  const crossProject = helper('validateProjectLinks', { db: {}, requireProjectFileAccess: async () => ({ projectId: 'other' }) })
  await assert.rejects(crossProject('project', null, 'file', 'user'), { status: 400, code: 'INVALID_FILE_LINK' })
})

test('remote prompt cannot reference a question from another project', () => {
  const start = text.indexOf("dueDiligenceRouter.post('/projects/:projectId/interviews/:id/prompts'")
  const end = text.indexOf('dueDiligenceRouter.', start + 20)
  assert.match(text.slice(start, end), /eq\(dueDiligenceQuestions.projectId, projectId\)/)
})

test('baseline generation excludes restricted and recycled files before reading contents', async () => {
  const files = [
    { id: 'visible', projectId: 'project', name: 'Public memo', contentText: 'allowed', parseStatus: '成功', visible: true, lifecycle: 'active' },
    { id: 'private', projectId: 'project', name: 'Private memo', contentText: 'secret', parseStatus: '成功', visible: false, lifecycle: 'active' },
    { id: 'trash', projectId: 'project', name: 'Deleted memo', contentText: 'deleted', parseStatus: '成功', visible: true, lifecycle: 'trashed' },
  ]
  const projects = { id: 'id', name: 'name' }, projectFiles = { id: 'id', projectId: 'projectId' }
  const query = { select: () => ({ from: (table: unknown) => ({ where: (predicate: (row: typeof files[0]) => boolean) => table === projects ? { limit: async () => [{ name: 'Project' }] } : Promise.resolve(files.filter(predicate)) }) }) }
  const generate = helper('generateQuestionPack', {
    db: query, projects, projectFiles, eq: (field: keyof typeof files[0], value: unknown) => (row: typeof files[0]) => row[field] === value,
    and: (...predicates: Array<(row: typeof files[0]) => boolean>) => (row: typeof files[0]) => predicates.every(predicate => predicate(row)),
    projectFileAccessCondition: () => (row: typeof files[0]) => row.visible && row.lifecycle === 'active',
    buildBaselineQuestions: (_project: unknown, selected: typeof files) => selected.map(file => file.contentText),
    persistQuestionPack: (input: unknown) => input,
    validateProjectLinks: async () => { throw Object.assign(new Error('denied'), { status: 403 }) },
  })
  const result = await generate('project', 'user', { fileIds: [], publicationIds: [], mode: 'baseline' })
  assert.equal(JSON.stringify(result.sourceFileIds), '["visible"]')
  assert.equal(JSON.stringify(result.questions), '["allowed"]')
  await assert.rejects(generate('project', 'user', { fileIds: ['private'], publicationIds: [], mode: 'baseline' }), { status: 403 })
})

test('learning remains an explicit POST action from the workspace', () => {
  const ui = readFileSync(new URL('../../src/pages/DueDiligencePage.tsx', import.meta.url), 'utf8')
  assert.match(ui, /apiPost<\{ created: number \}>\(`\/due-diligence\/twins\/\$\{twinDraft.id\}\/learning\/scan`\)/)
  assert.match(text, /dueDiligenceRouter.post\('\/twins\/:id\/learning\/scan'/)
})

test('learning sources and saved candidates apply current source permissions', () => {
  assert.match(text, /eq\(projectFiles.uploadedBy, ownerUserId\), eq\(projectFiles.parseStatus, '成功'\), projectFileAccessCondition\(ownerUserId\)/)
  assert.match(text, /eq\(projectFiles.parseStatus, '成功'\), eq\(projectFiles.uploadedBy, userId\), projectFileAccessCondition\(userId\)/)
  assert.match(text, /eq\(digitalTwinLearningCandidates.status, '待确认'\), learningCandidateAccessCondition\(current.userId\)/)
  assert.match(text, /const key = `\$\{event.projectId\}:\$\{event.topic\}`/)
  assert.match(text, /eligible.filter\(row => row.projectId === eligible\[0\]\?\.projectId\)/)
})
