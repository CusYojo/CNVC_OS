import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  normalizeBusinessContent,
  type BusinessContent,
  type BusinessFinding,
  type EvidenceSource,
} from '../services/aiBusinessContentService.js'
import {
  generateBusinessDocx,
  generateBusinessPptx,
  generateBusinessPptxPreview,
  renderBusinessMarkdown,
} from '../services/aiBusinessDocumentService.js'
import {
  AI_TASK_TYPES,
  AI_TEMPLATE_CATALOG,
  type AiBusinessTaskType,
} from '../services/aiTemplateCatalog.js'
import { cleanCorruptedText, decodeTextBuffer } from '../services/textQualityService.js'
import { curateEvidenceSources } from '../services/aiEvidenceQualityService.js'

type Check = { name: string; passed: boolean; detail: string }

const outputDir = path.resolve(
  process.env.AI_ACCEPTANCE_DIR || path.join(tmpdir(), 'cybernaut-ai-business-acceptance'),
)
const sourceCutoffDate = '2026-07-24'

const project = {
  name: '业务验收示例项目',
  companyName: '杭州示例科技有限公司',
  industry: '企业服务与人工智能',
  stage: '尽调',
  financing: '拟进行 A 轮融资；金额及用途以正式交易文件为准',
  valuation: '估值尚待交易文件及可比公司分析核验',
  summary: '公司围绕企业知识管理提供软件产品，本验收数据为脱敏虚构内容。',
  businessModel: '拟采用软件订阅及实施服务模式，合同、收入确认和续费数据待核验。',
  market: '目标市场规模、增长率和竞争格局需以经批准的第三方报告交叉验证。',
  team: '核心团队背景以脱敏项目档案记载为准，任职经历仍需背调。',
}

const sources: EvidenceSource[] = [
  {
    sourceType: 'project_record',
    sourceId: 'acceptance-project',
    sourceName: '项目档案（脱敏验收数据）',
    chunkIndex: 0,
    content: '项目处于尽调阶段；公司定位、融资计划及基础团队信息已经录入项目档案。',
  },
  {
    sourceType: 'file',
    sourceId: 'acceptance-bp',
    sourceName: '示例项目商业计划书（脱敏）',
    chunkIndex: 3,
    content: '企业自述产品已形成标准化模块，客户、收入和续费数据仍需底稿核验。',
  },
  {
    sourceType: 'file',
    sourceId: 'acceptance-bp',
    sourceName: '示例项目商业计划书（脱敏）',
    chunkIndex: 4,
    content: '商业计划书另行说明产品采用订阅和实施服务模式，合同与收入确认口径仍需底稿核验。',
  },
  {
    sourceType: 'meeting',
    sourceId: 'acceptance-interview',
    sourceName: '管理层访谈纪要（脱敏）',
    chunkIndex: 1,
    content: '管理层说明本轮资金主要用于产品研发和市场拓展；实际用途以交易文件为准。',
  },
  {
    sourceType: 'file',
    sourceId: 'acceptance-unused',
    sourceName: '未使用来源（不得进入文尾）',
    chunkIndex: 9,
    content: '这是一条格式完整但未被任何正文发现引用的验收资料。',
  },
]

function findings(sectionIndex: number): BusinessFinding[] {
  return [
    {
      text: `本节已根据脱敏项目档案与样本证据整理；第 ${sectionIndex + 1} 项事实须回到原始资料复核。`,
      status: '资料记载',
      sourceIndexes: [sectionIndex % 4],
    },
    {
      text: '基于现有证据形成的分析判断不等同于经审计事实，投资团队应完成交叉验证。',
      status: 'AI推断',
      sourceIndexes: [0, 1],
    },
    {
      text: '合同、财务、客户及法律资质原件尚未在本次脱敏验收数据中提供。',
      status: sectionIndex % 2 === 0 ? '待核验' : '资料缺口',
      sourceIndexes: [],
    },
  ]
}

function contentFor(type: AiBusinessTaskType): BusinessContent {
  const template = AI_TEMPLATE_CATALOG[type]
  const raw: BusinessContent = {
    title: `${project.name}${template.label}`,
    executiveSummary: `本初稿采用公司标准模板，依据截至 ${sourceCutoffDate} 的脱敏证据形成。资料记载、AI 推断、待核验事项及资料缺口已分开标识，所有结论仍须业务审核。`,
    sections: template.sections.map((title, index) => ({
      title,
      summary: `${title}按照 docs 中可编辑主样本提炼的章节结构生成。`,
      findings: findings(index),
    })),
    highlights: ['产品定位较清晰，但商业证据仍需补强', '业务模式具备可讨论基础，尚不能作为已核验结论', '任务产物保留模板版本和来源定位'],
    risks: ['关键财务及客户数据尚未经独立核验', '法律合规结论必须由法务审核', '模型生成内容不得替代最终投资决策'],
    missing: ['审计口径财务底稿', '核心客户合同及访谈记录', '工商、知识产权及合规原件'],
  }
  return normalizeBusinessContent(raw, template, raw, sources.length)
}

async function openXmlText(filePath: string, prefix: RegExp) {
  const zip = await JSZip.loadAsync(await readFile(filePath))
  const names = Object.keys(zip.files).filter((name) => prefix.test(name))
  const xml = (await Promise.all(names.map((name) => zip.file(name)!.async('string')))).join('\n')
  return { zip, names, xml }
}

function assert(checks: Check[], name: string, condition: boolean, detail: string) {
  checks.push({ name, passed: condition, detail })
  if (!condition) throw new Error(`${name}：${detail}`)
}

async function main() {
  await mkdir(outputDir, { recursive: true })
  const checks: Check[] = []
  const artifacts: string[] = []
  const utf16Probe = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('中文编码验收', 'utf16le'),
  ])
  const decodedProbe = decodeTextBuffer(utf16Probe)
  assert(
    checks,
    '文本导入可识别 UTF-16LE 中文',
    decodedProbe.encoding === 'utf-16le' && decodedProbe.text === '中文编码验收',
    `${decodedProbe.encoding}:${decodedProbe.text}`,
  )
  const gb18030Probe = decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  assert(
    checks,
    '文本导入可识别 GB18030 中文',
    gb18030Probe.encoding === 'gb18030' && gb18030Probe.text === '中文',
    `${gb18030Probe.encoding}:${gb18030Probe.text}`,
  )
  const repairedProbe = cleanCorruptedText('u�Z��m��Z�vڱ�这是一份用于验收的中文项目资料，包含足够的可读内容。')
  assert(
    checks,
    '历史损坏片段不会把替换字符带入产物',
    repairedProbe.usable && !repairedProbe.cleaned.includes('\uFFFD') && repairedProbe.cleaned.startsWith('这是一份'),
    repairedProbe.cleaned,
  )
  const windows1252Broken = Buffer.from('中文编码测试', 'utf8').toString('latin1')
  const mojibakeProbe = cleanCorruptedText(`项目摘要：${windows1252Broken}，后续中文内容保持正常。`)
  assert(
    checks,
    '历史 Windows-1252 错译可恢复为中文',
    mojibakeProbe.usable
      && mojibakeProbe.cleaned.includes('中文编码测试')
      && !/[äåæçèé][\u0080-\u00FF\u2010-\u2030]{1,2}/.test(mojibakeProbe.cleaned),
    mojibakeProbe.cleaned,
  )
  const curatedProbe = curateEvidenceSources([
    {
      sourceType: 'file',
      sourceId: 'quality-a',
      sourceName: '有效经营资料.docx',
      chunkIndex: 1,
      content: '公司已签署两份客户合同，合同金额、交付进度和回款情况仍需以合同原件及银行流水核验。',
    },
    {
      sourceType: 'file',
      sourceId: 'quality-a',
      sourceName: '有效经营资料.docx',
      chunkIndex: 2,
      content: '公司已签署两份客户合同，合同金额、交付进度和回款情况仍需以合同原件及银行流水核验。',
    },
    {
      sourceType: 'file',
      sourceId: 'quality-test',
      sourceName: '大文件测试.txt',
      chunkIndex: 0,
      content: '赛智伯乐投资中台大文件上传测试。'.repeat(60),
    },
  ])
  assert(
    checks,
    '证据预处理排除测试与重复片段',
    curatedProbe.usable.length === 1
      && curatedProbe.usable[0].sourceName === '有效经营资料.docx'
      && curatedProbe.rejected.length >= 2,
    `采用 ${curatedProbe.usable.length} 条，排除 ${curatedProbe.rejected.length} 条`,
  )

  for (const type of AI_TASK_TYPES) {
    const template = AI_TEMPLATE_CATALOG[type]
    assert(checks, `${type} 主样本存在`, existsSync(template.referencePath), template.referencePath)
    const content = contentFor(type)
    if (template.outputFormat === 'pptx') {
      const outputPath = path.join(outputDir, 'AI-009_业务验收_投资建议书.pptx')
      const result = await generateBusinessPptx({
        outputPath,
        template,
        project,
        content,
        sources,
        sourceCutoffDate,
        pageCount: '12-15页',
      })
      const previewPath = path.join(outputDir, 'AI-009_业务验收_投资建议书.preview.png')
      const preview = await generateBusinessPptxPreview({
        outputPath: previewPath,
        template,
        project,
        content,
        sourceCutoffDate,
      })
      artifacts.push(outputPath, previewPath)
      const { zip, names, xml } = await openXmlText(outputPath, /^ppt\/slides\/slide\d+\.xml$/)
      const previewBuffer = await readFile(previewPath)
      assert(checks, 'AI-009 PPTX 为有效 OpenXML', Boolean(zip.file('ppt/presentation.xml')), outputPath)
      assert(checks, 'AI-009 页数符合 12-15 页参数', names.length >= 12 && names.length <= 15, `实际 ${names.length} 页`)
      const editableTexts = (xml.match(/<a:t>/g) || []).length
      assert(checks, 'AI-009 核心文本为可编辑对象', editableTexts >= names.length * 3, `文本对象 ${editableTexts}`)
      assert(
        checks,
        'AI-009 含原生可编辑表格与形状',
        xml.includes('<a:tbl>') && xml.includes('<p:sp>'),
        '项目核心信息表格及状态标识形状',
      )
      assert(
        checks,
        'AI-009 预览图有效且与封面元数据一致',
        previewBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && previewBuffer.length > 1000
          && preview.width === 1600
          && preview.height === 900,
        `${preview.width}×${preview.height}，${previewBuffer.length} bytes`,
      )
      assert(checks, 'AI-009 含免责声明', xml.includes(template.disclaimer), template.disclaimer)
      assert(checks, 'AI-009 含来源与截止日', xml.includes('来源：') && xml.includes(sourceCutoffDate), sourceCutoffDate)
      const finalSlideXml = await zip.file(`ppt/slides/slide${names.length}.xml`)?.async('string') || ''
      assert(
        checks,
        'AI-009 文尾包含去重后的引用资料',
        finalSlideXml.includes('引用资料与责任声明')
          && finalSlideXml.includes('示例项目商业计划书（脱敏）')
          && !finalSlideXml.includes('未使用来源（不得进入文尾）')
          && (finalSlideXml.match(/示例项目商业计划书（脱敏）/g) || []).length === 1,
        '最后一页只列正文实际使用来源，同一文件合并片段',
      )
      assert(checks, 'AI-009 生成元数据页数一致', result.slideCount === names.length, `${result.slideCount}/${names.length}`)
      const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string') || ''
      const forbiddenSampleTerms = ['佳量', '德塔', 'Epilcure', '曹鹏', 'recommendation-jialiang']
      assert(checks, 'AI-009 中文文本语言标记正确', !xml.includes('lang="en-US"') && xml.includes('lang="zh-CN"'), '全部中文文本使用 zh-CN')
      assert(checks, 'AI-009 设置东亚主题字体', /<a:ea[^>]+typeface="微软雅黑"/.test(themeXml), '微软雅黑')
      assert(checks, 'AI-009 不含损坏字符', !xml.includes('\uFFFD'), '未发现 U+FFFD')
      assert(checks, 'AI-009 不泄露示例项目与内部模板编号', forbiddenSampleTerms.every((term) => !xml.includes(term)), forbiddenSampleTerms.join('、'))
      assert(
        checks,
        'AI-009 已应用公司模板资产',
        result.templateApplied && result.inheritedCompanyAssets >= 3 && Boolean(result.templateSha256),
        `资产 ${result.inheritedCompanyAssets}，模板摘要 ${result.templateSha256.slice(0, 12)}`,
      )
      continue
    }

    const prefix = type === 'compliance_statement'
      ? 'AI-007_业务验收_合规性说明'
      : type === 'investment_proposal'
        ? 'AI-008_业务验收_投资提案'
        : 'AI-010_业务验收_尽调报告'
    const outputPath = path.join(outputDir, `${prefix}.docx`)
    const result = await generateBusinessDocx({ outputPath, template, project, content, sources, sourceCutoffDate })
    artifacts.push(outputPath)
    const { zip, xml } = await openXmlText(outputPath, /^word\/.*\.xml$/)
    assert(checks, `${type} DOCX 为有效 OpenXML`, Boolean(zip.file('word/document.xml')), outputPath)
    assert(checks, `${type} 含可编辑文本`, (xml.match(/<w:t/g) || []).length > template.sections.length * 2, `章节 ${template.sections.length}`)
    assert(checks, `${type} 章节完整`, template.sections.every((section) => xml.includes(section)), template.sections.join('、'))
    assert(checks, `${type} 含免责声明`, xml.includes(template.disclaimer), template.disclaimer)
    assert(checks, `${type} 含来源和核验状态`, xml.includes('引用资料') && xml.includes('资料记载') && xml.includes('待核验'), '来源/状态')
    const documentXml = await zip.file('word/document.xml')?.async('string') || ''
    const lastSectionTitle = template.sections[template.sections.length - 1]
    assert(
      checks,
      `${type} 引用资料位于文尾且只列已用来源`,
      documentXml.lastIndexOf('引用资料') > documentXml.lastIndexOf(lastSectionTitle)
        && documentXml.includes('示例项目商业计划书（脱敏）')
        && !documentXml.includes('未使用来源（不得进入文尾）')
        && (documentXml.match(/示例项目商业计划书（脱敏）/g) || []).length === 1,
      '引用在最后章节；同一文件合并片段；未使用来源不列示',
    )
    assert(
      checks,
      `${type} 全篇不重复同一分析段落`,
      (documentXml.match(/基于现有证据形成的分析判断不等同于经审计事实/g) || []).length <= 1,
      '重复分析段落最多出现一次',
    )
    assert(
      checks,
      `${type} 不使用通用元数据封面`,
      !documentXml.includes('文件性质') && !documentXml.includes('生成时间'),
      '遵循对应 docs 模板的正文结构',
    )
    const expectedBodyFont = type === 'compliance_statement' ? '宋体' : '仿宋'
    const forbiddenSampleTerms = ['佳量', '德塔', 'Epilcure', '曹鹏', template.templateVersion]
    assert(checks, `${type} 不含损坏字符`, !xml.includes('\uFFFD'), '未发现 U+FFFD')
    assert(checks, `${type} 不使用 Arial Unicode MS`, !xml.includes('Arial Unicode MS'), expectedBodyFont)
    assert(checks, `${type} 使用模板中文字体`, xml.includes(`w:eastAsia="${expectedBodyFont}"`) && xml.includes('w:eastAsia="黑体"'), `${expectedBodyFont}/黑体`)
    assert(checks, `${type} 不泄露示例项目与内部模板编号`, forbiddenSampleTerms.every((term) => !xml.includes(term)), forbiddenSampleTerms.join('、'))
    assert(
      checks,
      `${type} 已应用公司模板可复用部件`,
      result.templateApplied && result.templateParts.length > 0 && Boolean(result.templateSha256),
      `模板部件 ${result.templateParts.join('、')}，摘要 ${result.templateSha256.slice(0, 12)}`,
    )
    if (type !== 'compliance_statement') {
      assert(checks, `${type} 包含模板式页眉页码`, Boolean(zip.file('word/header1.xml')) && Boolean(zip.file('word/footer1.xml')), '页眉与页码')
    }
    if (type === 'investment_proposal') {
      assert(checks, 'AI-008 使用模板式投委会称谓', documentXml.includes('各位投资决策委员会成员：'), '提案正式开篇')
    }

    if (type === 'compliance_statement') {
      const markdownPath = path.join(outputDir, `${prefix}.md`)
      const markdown = renderBusinessMarkdown({ template, project, content, sources, sourceCutoffDate })
      await writeFile(markdownPath, markdown, 'utf8')
      artifacts.push(markdownPath)
      assert(
        checks,
        'AI-007 Markdown 固定责任分区完整',
        ['已核验事实', '风险提示', '待核验事项', '资料缺口', '免责声明'].every((title) => markdown.includes(`## ${title}`)),
        markdownPath,
      )
      assert(checks, 'AI-007 Markdown 与 DOCX 免责声明一致', markdown.includes(template.disclaimer) && xml.includes(template.disclaimer), template.disclaimer)
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir,
    passed: checks.every((check) => check.passed),
    checks,
    artifacts,
    note: '自动验收使用脱敏虚构数据；法务签字及 Microsoft Office/WPS 人工兼容验收仍需业务人员完成。',
  }
  const reportPath = path.join(outputDir, 'acceptance-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
