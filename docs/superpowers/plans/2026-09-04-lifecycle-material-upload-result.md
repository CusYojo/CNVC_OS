# 生命周期节点材料批量上传结果分类实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让项目生命周期节点的批量材料上传准确区分成功入库、资料已存在、解析失败和上传失败，并展示每类文件明细。

**架构：** 从 `ProjectDetailPage.tsx` 抽取纯函数结果模型与分组逻辑到独立模块，页面只负责文件传输和状态更新。新增专用结果卡片组件负责四类摘要、前三项预览和展开/收起，生命周期节点与项目文件页继续复用同一个上传弹窗。

**技术栈：** React 18、TypeScript、Node test runner、tsx、Tailwind CSS。

---

## 文件结构

- 创建 `src/lib/projectFileUploadResult.ts`：定义上传结果类型、错误分类、分组和摘要函数。
- 创建 `src/lib/projectFileUploadResult.test.ts`：验证四类结果、两个重复错误码和混合批次。
- 创建 `src/components/ProjectFileUploadResults.tsx`：渲染分组明细及展开/收起行为。
- 修改 `src/pages/ProjectDetailPage.tsx`：使用结构化结果替代四个数字计数和字符串摘要。
- 创建 `server/tests/projectFileUploadResultsUi.test.tsx`：服务端渲染结果卡片并验证默认三项、展开按钮和状态文案。
- 修改 `server/tests/fdeWorkspaceStep4.test.ts`：锁定生命周期面板和项目文件页共用上传入口。

### 任务 1：建立上传结果分类模型

**文件：**
- 创建：`src/lib/projectFileUploadResult.ts`
- 创建：`src/lib/projectFileUploadResult.test.ts`

- [ ] **步骤 1：编写失败的结果分类测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from './api.js'
import { classifyProjectFileUploadError, groupProjectFileUploadResults, summarizeProjectFileUploadBatch } from './projectFileUploadResult.js'

test('两个重复错误码都归入资料已存在', () => {
  for (const code of ['DUPLICATE', 'DUPLICATE_CONTENT']) {
    const result = classifyProjectFileUploadError('新版BP.pdf', new ApiError('相同内容已存在于「商业计划书.pdf」', code, 409))
    assert.equal(result.kind, 'duplicate')
    assert.equal(result.name, '新版BP.pdf')
  }
})

test('混合批次分别统计四类结果', () => {
  const groups = groupProjectFileUploadResults([
    { kind: 'success', name: 'a.pdf' },
    { kind: 'duplicate', name: 'b.pdf', detail: '已存在' },
    { kind: 'parse_failed', name: 'c.xlsx', detail: '工作表损坏' },
    { kind: 'upload_failed', name: 'd.wav', detail: '格式不支持' },
  ])
  assert.deepEqual(Object.fromEntries(groups.map(group => [group.kind, group.items.length])), {
    success: 1, duplicate: 1, parse_failed: 1, upload_failed: 1,
  })
  assert.equal(summarizeProjectFileUploadBatch(groups), '本批 4 个：成功入库 1，资料已存在 1，解析失败 1，上传失败 1')
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test src/lib/projectFileUploadResult.test.ts`

预期：FAIL，提示 `projectFileUploadResult.js` 模块不存在。

- [ ] **步骤 3：实现结果类型与纯函数**

```ts
import { ApiError } from './api.js'

export type ProjectFileUploadResult =
  | { kind: 'success'; name: string }
  | { kind: 'duplicate'; name: string; detail: string }
  | { kind: 'parse_failed'; name: string; detail: string }
  | { kind: 'upload_failed'; name: string; detail: string }

export const uploadResultOrder = ['success', 'duplicate', 'parse_failed', 'upload_failed'] as const

export function classifyProjectFileUploadError(name: string, error: unknown): ProjectFileUploadResult {
  const detail = error instanceof Error && error.message.trim() ? error.message.trim() : '未知错误'
  return error instanceof ApiError && ['DUPLICATE', 'DUPLICATE_CONTENT'].includes(error.code)
    ? { kind: 'duplicate', name, detail }
    : { kind: 'upload_failed', name, detail }
}

export function groupProjectFileUploadResults(results: ProjectFileUploadResult[]) {
  return uploadResultOrder.map(kind => ({ kind, items: results.filter(result => result.kind === kind) }))
}

const labels = { success: '成功入库', duplicate: '资料已存在', parse_failed: '解析失败', upload_failed: '上传失败' } as const

export function summarizeProjectFileUploadBatch(groups: ReturnType<typeof groupProjectFileUploadResults>) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  return `本批 ${total} 个：${groups.filter(group => group.items.length).map(group => `${labels[group.kind]} ${group.items.length}`).join('，')}`
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`node --import tsx --test src/lib/projectFileUploadResult.test.ts`

预期：PASS，两个测试通过、零失败。

- [ ] **步骤 5：提交任务 1**

运行：`git add src/lib/projectFileUploadResult.ts src/lib/projectFileUploadResult.test.ts && git commit -m "test: 建立项目资料上传结果分类"`

### 任务 2：实现分组结果卡片

**文件：**
- 创建：`src/components/ProjectFileUploadResults.tsx`
- 创建：`server/tests/projectFileUploadResultsUi.test.tsx`

- [ ] **步骤 1：编写失败的结果卡片渲染测试**

```tsx
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectFileUploadResults } from '../../src/components/ProjectFileUploadResults.js'

test('默认展示前三项并为更多文件提供展开按钮', () => {
  const html = renderToStaticMarkup(<ProjectFileUploadResults batches={[{
    id: 'batch-1',
    results: [1, 2, 3, 4].map(index => ({ kind: 'duplicate' as const, name: `重复资料${index}.pdf`, detail: '已存在，未重复入库' })),
  }]} />)
  assert.match(html, /资料已存在 4/)
  assert.match(html, /重复资料1\.pdf/)
  assert.match(html, /重复资料3\.pdf/)
  assert.doesNotMatch(html, /重复资料4\.pdf/)
  assert.match(html, /展开全部 4 个/)
})
```

- [ ] **步骤 2：运行测试确认失败**

运行：`node --import tsx --test server/tests/projectFileUploadResultsUi.test.tsx`

预期：FAIL，提示 `ProjectFileUploadResults.js` 不存在。

- [ ] **步骤 3：实现结果卡片组件**

组件接收 `batches: Array<{ id: string; results: ProjectFileUploadResult[] }>`，每批调用 `groupProjectFileUploadResults` 和 `summarizeProjectFileUploadBatch`。各非空组默认渲染 `items.slice(0, 3)`，超过三项时用本地展开状态显示“展开全部 N 个/收起”；成功组为绿色、重复组为琥珀色、两类失败组为红色，并为重复组显示“已跳过，未重复入库”。

- [ ] **步骤 4：运行组件测试确认通过**

运行：`node --import tsx --test server/tests/projectFileUploadResultsUi.test.tsx`

预期：PASS，一个测试通过、零失败。

- [ ] **步骤 5：提交任务 2**

运行：`git add src/components/ProjectFileUploadResults.tsx server/tests/projectFileUploadResultsUi.test.tsx && git commit -m "feat: 展示材料上传分类明细"`

### 任务 3：接入生命周期共用上传弹窗

**文件：**
- 修改：`src/pages/ProjectDetailPage.tsx:90-255`
- 修改：`src/pages/ProjectDetailPage.tsx:539-543`
- 修改：`server/tests/fdeWorkspaceStep4.test.ts`

- [ ] **步骤 1：补充失败的入口复用契约测试**

在 `server/tests/fdeWorkspaceStep4.test.ts` 增加断言，要求 `FdeWorkflowPanel` 的 `onUpload` 仍调用 `setShowUpload(true)`，并要求上传弹窗渲染 `ProjectFileUploadResults`。

```ts
assert.match(projectDetail, /FdeWorkflowPanel[\s\S]*onUpload=\{\(\) => setShowUpload\(true\)\}/)
assert.match(projectDetail, /<ProjectFileUploadResults batches=\{uploadBatches\}/)
```

- [ ] **步骤 2：运行入口契约测试确认失败**

运行：`node --env-file-if-exists=.env --import tsx --test server/tests/fdeWorkspaceStep4.test.ts`

预期：FAIL，缺少 `ProjectFileUploadResults` 渲染。

- [ ] **步骤 3：把单文件结果改为结构化类型**

`uploadOne` 上传成功时返回 `{ kind: 'uploaded', name, fileId }`；捕获异常时统一调用 `classifyProjectFileUploadError(file.name, error)`，其中两个重复错误码直接形成 `duplicate`，其他异常形成 `upload_failed`。不得再用 `'ok' | 'ingest-fail' | 'duplicate' | 'error'` 字符串状态。

- [ ] **步骤 4：把批量计数改为批次结果**

新增状态：

```ts
const [uploadBatches, setUploadBatches] = useState<Array<{ id: string; results: ProjectFileUploadResult[] }>>([])
```

`Promise.allSettled` 完成后把每个 rejected 项转换为 `upload_failed`。收集所有 `uploaded` 的文件 ID，并以一次 `/projects/:id/files` 请求每两秒轮询整批状态，最长五分钟：`成功` 转成 `success`，`失败` 转成 `parse_failed` 并保留 `parseError`；超时仍为 `解析中` 的文件转成 `parse_failed`，明细为“解析超时，请稍后在项目文件中查看最新状态”。最终把重复结果、上传失败结果和解析终态结果合并为一个批次追加到 `uploadBatches`。Toast 根据结果组判断：仅重复时用信息提示；有 `parse_failed` 或 `upload_failed` 时用错误提示并提示查看明细；否则用成功提示。

- [ ] **步骤 5：替换旧字符串摘要区域**

删除 `uploadSummaries: string[]` 及纯绿色摘要卡片，改为：

```tsx
{uploadBatches.length > 0 && <ProjectFileUploadResults batches={uploadBatches} />}
```

- [ ] **步骤 6：运行相关测试**

运行：`node --import tsx --test src/lib/projectFileUploadResult.test.ts server/tests/projectFileUploadResultsUi.test.tsx server/tests/fdeWorkspaceStep4.test.ts`

预期：全部测试通过、零失败。

- [ ] **步骤 7：运行类型检查与补丁检查**

运行：`npm run check:types`

运行：`git diff --check`

预期：两条命令退出码为 0。

- [ ] **步骤 8：提交任务 3**

运行：`git add src/pages/ProjectDetailPage.tsx server/tests/fdeWorkspaceStep4.test.ts && git commit -m "fix: 区分生命周期材料重复和失败"`
