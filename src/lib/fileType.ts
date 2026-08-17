/**
 * Return the short file-type label used by the UI.
 *
 * Older records may still contain a browser MIME value such as
 * `application/pdf`, so prefer the file-name extension and only fall back to
 * a normalized MIME label when the extension is unavailable.
 */
export function getFileTypeLabel(file: { name?: string | null; type?: string | null }): string {
  const name = file.name?.trim() ?? ''
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
  if (extension && extension.length <= 16 && /^[A-Z0-9]+$/.test(extension)) return extension

  const mime = (file.type ?? '').split(';', 1)[0].trim().toLowerCase()
  const mimeLabels: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.ms-powerpoint': 'PPT',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
    'text/html': 'HTML',
    'text/markdown': 'MD',
    'text/plain': 'TXT',
    'text/csv': 'CSV',
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
    'image/webp': 'WEBP',
  }
  if (mimeLabels[mime]) return mimeLabels[mime]

  const subtype = mime.split('/')[1] || mime.split('/')[0] || ''
  return subtype.slice(0, 16).toUpperCase() || 'FILE'
}
