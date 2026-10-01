const MAX_MARKDOWN_BYTES = 128 * 1024
const SAFE_MD_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,119}\.md$/u

export async function readPromptMarkdownFile(file: File) {
  if (!SAFE_MD_NAME.test(file.name)) throw new Error('请选择文件名不含路径的 .md 文档')
  if (file.size > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件不能超过 128KB')
  let markdown: string
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，请重新导出为 UTF-8 Markdown')
  }
  if (!markdown.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(markdown)) {
    throw new Error('Markdown 正文为空或包含不可用字符')
  }
  return { fileName: file.name, name: file.name.slice(0, -3), markdown }
}
