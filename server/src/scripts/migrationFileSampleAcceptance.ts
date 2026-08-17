import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { imageSize } from 'image-size'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import XLSX from 'xlsx'
import { decodeAndValidateProjectFile } from '../security/projectFileValidation.js'

const root = process.cwd()
const evidenceDirectory = path.resolve(root, '.runtime/migration-evidence/file-sample-open')
const sampleDefinitions = [
  {
    kind: 'pdf',
    file: 'docs/agent/投资提案/德塔智能投资提案.pdf',
    mime: 'application/pdf',
  },
  {
    kind: 'docx',
    file: 'docs/ai-assistant/AI文档生成Prompt用户评审稿.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    kind: 'pptx',
    file: 'docs/ai-assistant/验收产物/AI-007-AI-010/AI-009_业务验收_投资建议书.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  {
    kind: 'xlsx',
    file: 'docs/需求追踪.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    kind: 'image',
    file: 'public/cybernaut-logo.png',
    mime: 'image/png',
  },
] as const

type SampleKind = typeof sampleDefinitions[number]['kind']

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function safeSampleBuffer(relativePath: string) {
  const absolute = path.resolve(root, relativePath)
  const relative = path.relative(root, absolute)
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'migration sample must remain inside the versioned workspace')
  const info = await lstat(absolute)
  assert(info.isFile() && !info.isSymbolicLink(), 'migration sample must be a regular non-symlink file')
  assert(info.size > 0 && info.size <= 100 * 1024 * 1024, 'migration sample must be non-empty and bounded')
  return readFile(absolute)
}

async function inspectPdf(buffer: Buffer) {
  const parser = new PDFParse({ data: buffer })
  try {
    const info = await parser.getInfo({ parsePageInfo: true })
    const text = await parser.getText()
    assert(info.total > 0, 'PDF sample has no readable pages')
    assert(text.text.trim().length > 0, 'PDF sample has no readable text layer')
    return { pages: info.total, textCharacters: text.text.trim().length }
  } finally {
    await parser.destroy()
  }
}

async function inspectDocx(buffer: Buffer) {
  const result = await mammoth.extractRawText({ buffer })
  const textCharacters = result.value.trim().length
  assert(textCharacters > 0, 'DOCX sample has no readable text')
  return { textCharacters, parserMessages: result.messages.length }
}

async function inspectPptx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  assert(slideNames.length > 0, 'PPTX sample has no readable slides')
  let textRuns = 0
  let textCharacters = 0
  for (const name of slideNames) {
    const xml = await zip.file(name)?.async('string')
    assert(xml, `PPTX slide entry is unreadable: ${name}`)
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
    textRuns += runs.length
    textCharacters += runs.reduce((total, match) => total + (match[1]?.trim().length || 0), 0)
  }
  assert(textRuns > 0 && textCharacters > 0, 'PPTX sample has no editable/readable text runs')
  return { slides: slideNames.length, textRuns, textCharacters }
}

async function inspectXlsx(buffer: Buffer) {
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
    assert(workbook.worksheets.length > 0, 'XLSX sample has no readable worksheets')
    let populatedCells = 0
    let formulas = 0
    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((row) => row.eachCell((cell) => {
        if (cell.value !== null && cell.value !== undefined && String(cell.value).trim()) populatedCells += 1
        if (cell.type === ExcelJS.ValueType.Formula) formulas += 1
      }))
    }
    assert(populatedCells > 0, 'XLSX sample has no readable populated cells')
    return { parser: 'exceljs', worksheets: workbook.worksheets.length, populatedCells, formulas }
  } catch (excelJsError) {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    assert(workbook.SheetNames.length > 0, 'XLSX sample has no readable worksheets')
    let populatedCells = 0
    let formulas = 0
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName]
      assert(worksheet, 'XLSX worksheet entry is missing')
      for (const [address, cell] of Object.entries(worksheet)) {
        if (address.startsWith('!')) continue
        if (cell?.v !== null && cell?.v !== undefined && String(cell.v).trim()) populatedCells += 1
        if (typeof cell?.f === 'string' && cell.f.trim()) formulas += 1
      }
    }
    assert(populatedCells > 0,
      `XLSX sample failed both ExcelJS and SheetJS readability: ${excelJsError instanceof Error ? excelJsError.name : 'unknown'}`)
    return { parser: 'sheetjs-fallback', worksheets: workbook.SheetNames.length, populatedCells, formulas }
  }
}

function inspectImage(buffer: Buffer) {
  const dimensions = imageSize(buffer)
  assert(dimensions.width && dimensions.height && dimensions.width > 0 && dimensions.height > 0,
    'image sample dimensions are unreadable')
  return { width: dimensions.width, height: dimensions.height, format: dimensions.type || 'unknown' }
}

async function inspect(kind: SampleKind, buffer: Buffer) {
  if (kind === 'pdf') return inspectPdf(buffer)
  if (kind === 'docx') return inspectDocx(buffer)
  if (kind === 'pptx') return inspectPptx(buffer)
  if (kind === 'xlsx') return inspectXlsx(buffer)
  return inspectImage(buffer)
}

async function writePrivate(file: string, value: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(file), 0o700)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  await chmod(file, 0o600)
}

async function main() {
  const samples = []
  for (const definition of sampleDefinitions) {
    const buffer = await safeSampleBuffer(definition.file)
    const validated = await decodeAndValidateProjectFile({
      name: `migration-sample.${definition.kind === 'image' ? 'png' : definition.kind}`,
      dataBase64: buffer.toString('base64'),
      declaredType: definition.mime,
    })
    assert.equal(validated.sha256, sha256(buffer), `${definition.kind} validation hash changed`)
    const metrics = await inspect(definition.kind, buffer)
    samples.push({
      kind: definition.kind,
      provenance: 'version-controlled-migration-sample',
      bytes: buffer.length,
      sha256: validated.sha256,
      signatureAndArchiveSafetyAccepted: true,
      structurallyReadable: true,
      metrics,
    })
  }
  assert.deepEqual(samples.map((sample) => sample.kind), ['pdf', 'docx', 'pptx', 'xlsx', 'image'])
  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: true,
    sampleCount: samples.length,
    formats: samples.map((sample) => sample.kind),
    pathsAndFileNamesExcluded: true,
    extractedContentExcluded: true,
    samples,
    scope: {
      versionControlledRepresentativeFiles: true,
      productionMissingAssetsProvenComplete: false,
      missingAssetQuarantineRemainsAuthoritative: true,
    },
  }
  await writePrivate(path.join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writePrivate(path.join(evidenceDirectory, 'summary.md'), [
    '# Migration file sample open acceptance',
    '',
    '- Formats opened: PDF, DOCX, PPTX, XLSX, image',
    '- Signature/archive safety: accepted for all five samples',
    '- Structural readability: accepted for all five samples',
    '- File names, paths and extracted content: excluded',
    '- Missing production assets: not claimed complete by this sample',
    '',
  ].join('\n'))
  console.log(JSON.stringify({
    ok: true,
    sampleCount: report.sampleCount,
    formats: report.formats,
    signatureAndArchiveSafetyAccepted: true,
    structurallyReadable: true,
    pathsAndFileNamesExcluded: true,
    extractedContentExcluded: true,
    productionMissingAssetsProvenComplete: false,
  }))
}

await main()
