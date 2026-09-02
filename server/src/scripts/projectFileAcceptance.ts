import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  decodeAndValidateProjectFile,
  projectFileMimeType,
  supportedProjectFileExtensions,
} from '../security/projectFileValidation.js'

async function ooxml(entry: string, extra?: { name: string; content: string }) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file(entry, '<root/>')
  if (extra) zip.file(extra.name, extra.content)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function expectCode(run: () => Promise<unknown>, code: string) {
  const error = await run().then(() => null, (caught: unknown) => caught as Error & { code?: string })
  if (!error || error.code !== code) throw new Error(`expected ${code}, received ${error?.code || error?.message || 'success'}`)
}

async function main() {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)])
  const fixtures: Array<{ name: string; mime: string; buffer: Buffer; dataUrl?: boolean }> = [
    { name: 'sample.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF') },
    { name: 'sample.doc', mime: 'application/msword', buffer: ole },
    { name: 'sample.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await ooxml('word/document.xml') },
    { name: 'sample.xls', mime: 'application/vnd.ms-excel', buffer: ole },
    { name: 'sample.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await ooxml('xl/workbook.xml') },
    { name: 'sample.xlsm', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12', buffer: await ooxml('xl/workbook.xml') },
    { name: 'sample.ppt', mime: 'application/vnd.ms-powerpoint', buffer: ole },
    { name: 'sample.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await ooxml('ppt/presentation.xml') },
    { name: 'sample.txt', mime: 'text/plain', buffer: Buffer.from('项目资料文本'), dataUrl: true },
    { name: 'sample.md', mime: 'text/markdown', buffer: Buffer.from('# 项目资料') },
    { name: 'sample.markdown', mime: 'text/markdown', buffer: Buffer.from('# 项目资料') },
    { name: 'sample.csv', mime: 'text/csv', buffer: Buffer.from('name,value\n项目,1') },
    { name: 'sample.htm', mime: 'text/html', buffer: Buffer.from('<p>项目资料</p>') },
    { name: 'sample.html', mime: 'text/html', buffer: Buffer.from('<p>项目资料</p>') },
    { name: 'sample.log', mime: 'text/plain', buffer: Buffer.from('2026-08-09 project ready') },
    { name: 'sample.json', mime: 'application/json', buffer: Buffer.from('{"project":"ready"}') },
    { name: 'sample.png', mime: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { name: 'sample.jpg', mime: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]) },
    { name: 'sample.jpeg', mime: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]) },
    { name: 'sample.gif', mime: 'image/gif', buffer: Buffer.from('GIF89a') },
    { name: 'sample.bmp', mime: 'image/bmp', buffer: Buffer.from('BMfixture') },
    { name: 'sample.webp', mime: 'image/webp', buffer: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]) },
  ]
  if (new Set(fixtures.map((fixture) => path.extname(fixture.name).slice(1))).size !== supportedProjectFileExtensions.length) {
    throw new Error('acceptance fixtures do not cover every supported extension')
  }

  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'cybernaut-file-acceptance-'))
  const previousRoot = process.env.PROJECT_FILE_ROOT
  process.env.PROJECT_FILE_ROOT = storageRoot
  try {
    const storage = await import(`../services/projectFileStorageService.js?acceptance=${Date.now()}`)
    for (const [index, fixture] of fixtures.entries()) {
      const raw = fixture.buffer.toString('base64')
      const dataBase64 = fixture.dataUrl ? `data:${fixture.mime};base64,${raw}` : raw
      const validated = await decodeAndValidateProjectFile({ name: fixture.name, dataBase64, declaredType: fixture.mime })
      if (!validated.buffer.equals(fixture.buffer) || projectFileMimeType(fixture.name) !== validated.contentType) {
        throw new Error(`validated file mismatch: ${fixture.name}`)
      }
      const stored = await storage.saveProjectFile('project-file-acceptance', `file-${index}`, validated.buffer)
      if (!(await readFile(path.join(storageRoot, stored))).equals(fixture.buffer)) throw new Error(`stored file mismatch: ${fixture.name}`)
    }

    await expectCode(() => decodeAndValidateProjectFile({ name: 'fake.pdf', dataBase64: Buffer.from('not pdf').toString('base64'), declaredType: 'application/pdf' }), 'FILE_SIGNATURE_MISMATCH')
    await expectCode(() => decodeAndValidateProjectFile({ name: 'fake.txt', dataBase64: Buffer.from('text').toString('base64'), declaredType: 'image/png' }), 'FILE_MIME_MISMATCH')
    await expectCode(() => decodeAndValidateProjectFile({ name: 'fake.exe', dataBase64: Buffer.from('MZ').toString('base64') }), 'FILE_UNSUPPORTED_TYPE')
    await expectCode(() => decodeAndValidateProjectFile({ name: '../escape.txt', dataBase64: Buffer.from('text').toString('base64') }), 'INVALID_FILE_NAME')
    await expectCode(() => decodeAndValidateProjectFile({ name: 'bad.txt', dataBase64: 'not-base64' }), 'INVALID_FILE_ENCODING')
    await expectCode(() => decodeAndValidateProjectFile({ name: 'binary.txt', dataBase64: Buffer.from([0, 1, 2, 3]).toString('base64') }), 'FILE_TEXT_ENCODING_INVALID')

    const utf16Text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('项目资料', 'utf16le')])
    const utf16Validated = await decodeAndValidateProjectFile({ name: 'utf16.txt', dataBase64: utf16Text.toString('base64') })
    if (utf16Validated.buffer.toString('utf8') !== '项目资料') throw new Error('UTF-16 text was not converted to canonical UTF-8')
    const utf16WithoutBom = Buffer.from('项目资料', 'utf16le')
    const utf16WithoutBomValidated = await decodeAndValidateProjectFile({ name: 'utf16-no-bom.txt', dataBase64: utf16WithoutBom.toString('base64') })
    if (utf16WithoutBomValidated.buffer.toString('utf8') !== '项目资料') throw new Error('BOM-less UTF-16 text was not detected')

    // 项目资料 encoded as GB18030/GBK. Plain-text uploads must be converted
    // before persistence so browsers can safely use charset=utf-8.
    const gb18030Text = Buffer.from([0xcf, 0xee, 0xc4, 0xbf, 0xd7, 0xca, 0xc1, 0xcf])
    const gb18030Validated = await decodeAndValidateProjectFile({ name: 'gb18030.txt', dataBase64: gb18030Text.toString('base64') })
    if (gb18030Validated.buffer.toString('utf8') !== '项目资料') throw new Error('GB18030 text was not converted to canonical UTF-8')

    await expectCode(() => decodeAndValidateProjectFile({ name: '坏�文件.txt', dataBase64: Buffer.from('内容').toString('base64') }), 'FILE_NAME_ENCODING_INVALID')
    await expectCode(() => decodeAndValidateProjectFile({ name: 'damaged.txt', dataBase64: Buffer.from('内容���').toString('base64') }), 'FILE_TEXT_ENCODING_INVALID')

    const largeText = Buffer.alloc(16 * 1024 * 1024, 0x41)
    const largeValidated = await decodeAndValidateProjectFile({ name: 'large-linear.txt', dataBase64: largeText.toString('base64') })
    if (largeValidated.byteSize !== largeText.length) throw new Error('large Base64 validation truncated the payload')

    const previousMax = process.env.PROJECT_FILE_MAX_BYTES
    process.env.PROJECT_FILE_MAX_BYTES = '8'
    await expectCode(() => decodeAndValidateProjectFile({ name: 'large.txt', dataBase64: Buffer.alloc(9, 0x41).toString('base64') }), 'PAYLOAD_TOO_LARGE')
    if (previousMax == null) delete process.env.PROJECT_FILE_MAX_BYTES
    else process.env.PROJECT_FILE_MAX_BYTES = previousMax

    const previousArchiveMax = process.env.PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES
    process.env.PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = '1024'
    const expanded = await ooxml('word/document.xml', { name: 'word/expanded.bin', content: 'A'.repeat(2_048) })
    await expectCode(() => decodeAndValidateProjectFile({ name: 'expanded.docx', dataBase64: expanded.toString('base64') }), 'ARCHIVE_EXPANSION_LIMIT')
    if (previousArchiveMax == null) delete process.env.PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES
    else process.env.PROJECT_FILE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = previousArchiveMax

    console.log(JSON.stringify({
      ok: true,
      supportedExtensions: supportedProjectFileExtensions.length,
      checks: ['raw-base64', 'data-url-base64', 'all-supported-types', 'private-storage-roundtrip', 'signature-mismatch', 'mime-mismatch', 'unsupported-extension', 'unsafe-name', 'invalid-base64', 'binary-text', 'utf16-to-utf8', 'utf16-no-bom-to-utf8', 'gb18030-to-utf8', 'damaged-name-rejected', 'damaged-text-rejected', 'large-base64-linear-validation', 'size-limit', 'archive-expansion-limit'],
    }))
  } finally {
    if (previousRoot == null) delete process.env.PROJECT_FILE_ROOT
    else process.env.PROJECT_FILE_ROOT = previousRoot
    await rm(storageRoot, { recursive: true, force: true })
  }
}

await main()
