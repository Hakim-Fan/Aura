import { createHash } from 'node:crypto'
import { createStructuredError } from '../runtimeErrors.mjs'

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function splitReadableLines(text) {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const lines = source.split('\n')
  if (source.endsWith('\n')) {
    lines.pop()
  }
  return lines
}

function resolveReadRange(text, args = {}) {
  const startLine = Number(args.startLine)
  const endLine = Number(args.endLine)
  const hasStartLine = Number.isFinite(startLine)
  const hasEndLine = Number.isFinite(endLine)
  const lines = splitReadableLines(text)

  if (!hasStartLine && !hasEndLine) {
    return {
      lines,
      start: 1,
      end: lines.length,
      selected: lines,
    }
  }

  const start = hasStartLine ? Math.floor(startLine) : 1
  const end = hasEndLine ? Math.floor(endLine) : lines.length

  if (start < 1 || end < start || start > Math.max(lines.length, 1)) {
    throw createStructuredError('read_file 的行号范围无效。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'INVALID_READ_RANGE',
      detail: `Received startLine=${args.startLine}, endLine=${args.endLine}; file has ${lines.length} line(s).`,
      suggestedAction:
        '请使用 1-based 行号，并确保 startLine <= endLine 且起始行没有超过文件总行数。',
    })
  }

  const boundedEnd = Math.min(lines.length, end)
  return {
    lines,
    start,
    end: boundedEnd,
    selected: lines.slice(start - 1, boundedEnd),
  }
}

export function formatNumberedLines(lines, start, prefix = '') {
  return lines.map((line, index) => `${prefix}${start + index}: ${line}`).join('\n')
}

export function readTextSlice(text, args = {}) {
  const { lines, start, end, selected } = resolveReadRange(text, args)
  const mode = typeof args.mode === 'string' ? args.mode.trim() : ''
  const hasExplicitRange =
    Number.isFinite(Number(args.startLine)) || Number.isFinite(Number(args.endLine))
  const rawText = selected.join('\n')

  if (!mode && !hasExplicitRange) {
    return text
  }

  if (mode === 'raw') {
    return rawText
  }

  if (mode === 'display') {
    return formatNumberedLines(selected, start, 'L')
  }

  if (mode === 'edit_context') {
    return {
      path: args.path,
      startLine: start,
      endLine: end,
      lineCount: lines.length,
      text: rawText,
      numberedText: formatNumberedLines(selected, start, 'L'),
      sha256: sha256Text(rawText),
    }
  }

  if (args.lineNumbers === false) {
    return selected.join('\n')
  }
  return selected.map((line, index) => `${start + index}:${line}`).join('\n')
}

function getLineIndentWidth(line) {
  const match = String(line || '').match(/^[\t ]*/u)
  const indent = match ? match[0] : ''
  let width = 0
  for (const char of indent) {
    width += char === '\t' ? 2 : 1
  }
  return width
}

function looksLikeBlockOpener(line) {
  const trimmed = String(line || '').trim()
  return (
    /[\{\(\[]\s*$/u.test(trimmed) ||
    /=>\s*(?:\{|\()\s*$/u.test(trimmed) ||
    /(?:function|class|interface|type|enum)\b/u.test(trimmed)
  )
}

function looksLikeBlockCloser(line) {
  return /^[\}\]\)]\s*[,;)]*\s*$/u.test(String(line || '').trim())
}

function findReadBlockAnchor(lines, args = {}) {
  const anchorLine = Number(args.anchorLine)
  if (Number.isFinite(anchorLine)) {
    const index = Math.floor(anchorLine) - 1
    if (index < 0 || index >= lines.length) {
      throw createStructuredError('read_block 的 anchorLine 超出文件范围。', {
        source: 'tool',
        category: 'invalid_input',
        code: 'INVALID_BLOCK_ANCHOR',
        detail: `Received anchorLine=${args.anchorLine}; file has ${lines.length} line(s).`,
        suggestedAction: '请先用 search_code 或 read_file 找到当前文件里的有效行号。',
      })
    }
    return index
  }

  const anchorText = typeof args.anchorText === 'string' ? args.anchorText.trim() : ''
  if (anchorText) {
    const index = lines.findIndex(line => line.includes(anchorText))
    if (index >= 0) {
      return index
    }
    throw createStructuredError('read_block 没有找到 anchorText。', {
      source: 'tool',
      category: 'not_found',
      code: 'BLOCK_ANCHOR_NOT_FOUND',
      detail: `Could not find anchorText in file: ${anchorText}`,
      suggestedAction: '请先用 search_code 查找目标符号，再用返回行号调用 read_block。',
    })
  }

  throw createStructuredError('read_block 需要 anchorLine 或 anchorText。', {
    source: 'tool',
    category: 'invalid_input',
    code: 'MISSING_BLOCK_ANCHOR',
    detail: 'Expected anchorLine or anchorText.',
    suggestedAction: '请提供一个目标行号，或提供要定位的唯一文本片段。',
  })
}

function resolveReadBlockRange(lines, anchorIndex, args = {}) {
  const anchorIndent = getLineIndentWidth(lines[anchorIndex])
  const anchorIsOpener = looksLikeBlockOpener(lines[anchorIndex])
  let startIndex = anchorIndex
  let blockIndent = anchorIndent

  if (!anchorIsOpener) {
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!String(line || '').trim()) {
        continue
      }

      const indent = getLineIndentWidth(line)
      if (indent < anchorIndent) {
        startIndex = index
        blockIndent = indent
        break
      }
    }
  }

  let endIndex = startIndex
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = String(line || '').trim()
    if (!trimmed) {
      endIndex = index
      continue
    }

    const indent = getLineIndentWidth(line)
    if (indent < blockIndent) {
      break
    }

    if (index > startIndex && indent === blockIndent) {
      if (looksLikeBlockCloser(line)) {
        endIndex = index
      }
      break
    }

    endIndex = index
  }

  const contextLines = Math.max(0, Math.min(20, Math.floor(Number(args.contextLines) || 0)))
  startIndex = Math.max(0, startIndex - contextLines)
  endIndex = Math.min(lines.length - 1, endIndex + contextLines)

  const maxLines = Math.max(20, Math.min(500, Math.floor(Number(args.maxLines) || 160)))
  let truncated = false
  if (endIndex - startIndex + 1 > maxLines) {
    truncated = true
    const halfWindow = Math.floor(maxLines / 2)
    startIndex = Math.max(startIndex, anchorIndex - halfWindow)
    endIndex = Math.min(lines.length - 1, startIndex + maxLines - 1)
  }

  return {
    startLine: startIndex + 1,
    endLine: endIndex + 1,
    truncated,
  }
}

export function readTextBlock(text, args = {}) {
  const lines = splitReadableLines(text)
  const anchorIndex = findReadBlockAnchor(lines, args)
  const { startLine, endLine, truncated } = resolveReadBlockRange(
    lines,
    anchorIndex,
    args,
  )
  const selected = lines.slice(startLine - 1, endLine)
  const rawText = selected.join('\n')

  return {
    path: args.path,
    anchorLine: anchorIndex + 1,
    startLine,
    endLine,
    lineCount: lines.length,
    text: rawText,
    numberedText: formatNumberedLines(selected, startLine, 'L'),
    sha256: sha256Text(rawText),
    truncated,
  }
}

export function detectBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048))
  let suspicious = 0

  for (const byte of sample) {
    if (byte === 0) {
      return true
    }
    if ((byte < 7 || (byte > 14 && byte < 32)) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1
    }
  }

  return sample.length > 0 && suspicious / sample.length > 0.15
}

function readPngDimensions(buffer) {
  if (buffer.length < 24) {
    return null
  }
  const signature = '89504e470d0a1a0a'
  if (buffer.subarray(0, 8).toString('hex') !== signature) {
    return null
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

export function summarizeBinaryFile(target, buffer) {
  const basename = target.split(/[\\/]/u).pop() || target
  const extension = basename.includes('.')
    ? basename.split('.').at(-1)?.toLowerCase() || 'unknown'
    : 'unknown'
  const size = buffer.byteLength
  const pngDimensions = readPngDimensions(buffer)
  const details = [
    `Binary file detected: ${basename}`,
    `Type: ${extension.toUpperCase()}`,
    `Size: ${size} bytes`,
  ]

  if (pngDimensions) {
    details.push(`Dimensions: ${pngDimensions.width} x ${pngDimensions.height}`)
  }

  details.push(
    'This tool only previews text safely. For images, rely on visual input or use a dedicated metadata/image tool instead of reading raw bytes as text.',
  )
  return details.join('\n')
}
