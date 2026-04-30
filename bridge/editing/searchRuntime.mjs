import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStructuredError } from '../runtimeErrors.mjs'
import { buildShellEnv } from '../shellEnv.mjs'
import { detectBinary, splitReadableLines } from './readRuntime.mjs'

const execFileAsync = promisify(execFile)

function shouldSkipSearchEntry(name) {
  return (
    name === '.git' ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'target' ||
    name === '.next' ||
    name === '.turbo'
  )
}

function normalizeRelativePath(filePath, cwd) {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd, filePath)
  const relativePath = path.relative(cwd, absolutePath) || path.basename(absolutePath)
  return relativePath.split(path.sep).join('/')
}

function normalizeRelativeRoot(rootPath, cwd) {
  const absolutePath = path.isAbsolute(rootPath)
    ? path.resolve(rootPath)
    : path.resolve(cwd, rootPath)
  const relativePath = path.relative(cwd, absolutePath)
  return relativePath ? relativePath.split(path.sep).join('/') : '.'
}

function normalizeContextLines(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 8
  }
  return Math.max(1, Math.min(80, Math.floor(parsed)))
}

function normalizeMaxMatches(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 200
  }
  return Math.max(1, Math.min(500, Math.floor(parsed)))
}

function buildSuggestedRange(match, contextLines) {
  const startLine = Math.max(1, match.line - contextLines)
  const endLine = match.line + contextLines
  return {
    path: match.path,
    startLine,
    endLine,
    mode: 'edit_context',
  }
}

function makeMatch({ filePath, line, text, cwd, contextLines }) {
  const relativePath = normalizeRelativePath(filePath, cwd)
  const normalizedText = String(text || '').replace(/\r?\n$/u, '')
  const match = {
    path: relativePath,
    line,
    text: normalizedText,
  }
  return {
    ...match,
    suggestedRange: buildSuggestedRange(match, contextLines),
  }
}

function dedupeSuggestedRanges(matches) {
  const ranges = []
  const seen = new Set()
  for (const match of matches) {
    const range = match.suggestedRange
    if (!range) {
      continue
    }
    const key = `${range.path}:${range.startLine}:${range.endLine}:${range.mode}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    ranges.push(range)
  }
  return ranges
}

function finalizeSearchResult({
  query,
  target,
  cwd,
  matches,
  truncated = false,
  backend,
  maxMatches,
}) {
  const relativeRoot = normalizeRelativeRoot(target, cwd)
  return {
    query,
    root: relativeRoot,
    backend,
    total: matches.length,
    truncated: truncated || matches.length >= maxMatches,
    matches,
    suggestedRanges: dedupeSuggestedRanges(matches),
  }
}

function parseRgJsonOutput(stdout, cwd, contextLines, maxMatches) {
  const matches = []
  let truncated = false

  for (const line of String(stdout || '').split(/\r?\n/u)) {
    if (!line.trim()) {
      continue
    }

    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry?.type !== 'match') {
      continue
    }

    const data = entry.data || {}
    const filePath = data.path?.text
    const lineNumber = data.line_number
    if (typeof filePath !== 'string' || !Number.isFinite(lineNumber)) {
      continue
    }

    matches.push(
      makeMatch({
        filePath,
        line: lineNumber,
        text: data.lines?.text || '',
        cwd,
        contextLines,
      }),
    )

    if (matches.length >= maxMatches) {
      truncated = true
      break
    }
  }

  return { matches, truncated }
}

async function searchWithRipgrep({ query, target, cwd, signal, contextLines, maxMatches }) {
  try {
    const { stdout } = await execFileAsync(
      'rg',
      [
        '--json',
        '--hidden',
        '--glob',
        '!node_modules',
        '--glob',
        '!.git',
        query,
        target,
      ],
      {
        cwd,
        env: buildShellEnv(),
        maxBuffer: 4 * 1024 * 1024,
        signal,
      },
    )
    return parseRgJsonOutput(stdout, cwd, contextLines, maxMatches)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 1) {
      return { matches: [], truncated: false }
    }
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      return parseRgJsonOutput(error.stdout, cwd, contextLines, maxMatches)
    }
    throw error
  }
}

async function collectSearchMatches(rootPath, query, baseCwd, options, matches = []) {
  const { signal, contextLines, maxMatches } = options
  if (signal?.aborted) {
    throw createStructuredError('search_code 已被用户主动停止。', {
      source: 'tool',
      category: 'cancelled',
      code: 'STEP_CANCELLED',
      detail: 'Tool step cancelled: search_code',
      suggestedAction: 'Aura 已停止当前步骤，你可以继续补充要求或等待下一步规划。',
    })
  }

  let stats
  try {
    stats = await fs.stat(rootPath)
  } catch {
    return matches
  }

  if (stats.isFile()) {
    let content
    try {
      content = await fs.readFile(rootPath)
    } catch {
      return matches
    }

    if (detectBinary(content)) {
      return matches
    }

    const text = content.toString('utf8')
    const lines = splitReadableLines(text)
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) {
        continue
      }
      matches.push(
        makeMatch({
          filePath: rootPath,
          line: index + 1,
          text: lines[index],
          cwd: baseCwd,
          contextLines,
        }),
      )
      if (matches.length >= maxMatches) {
        return matches
      }
    }

    return matches
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true })

  for (const entry of entries) {
    if (shouldSkipSearchEntry(entry.name)) {
      continue
    }

    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      await collectSearchMatches(entryPath, query, baseCwd, options, matches)
      if (matches.length >= maxMatches) {
        return matches
      }
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    let content
    try {
      content = await fs.readFile(entryPath)
    } catch {
      continue
    }

    if (detectBinary(content)) {
      continue
    }

    const text = content.toString('utf8')
    const lines = splitReadableLines(text)
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) {
        continue
      }
      matches.push(
        makeMatch({
          filePath: entryPath,
          line: index + 1,
          text: lines[index],
          cwd: baseCwd,
          contextLines,
        }),
      )
      if (matches.length >= maxMatches) {
        return matches
      }
    }
  }

  return matches
}

export async function searchWorkspaceCode(query, target, cwd, options = {}) {
  const normalizedQuery = typeof query === 'string' ? query : ''
  if (!normalizedQuery.trim()) {
    throw createStructuredError('search_code 需要非空 query。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'MISSING_SEARCH_QUERY',
      detail: 'Expected args.query to be a non-empty string.',
      suggestedAction: '请提供要搜索的符号、文本或正则表达式。',
    })
  }

  const contextLines = normalizeContextLines(options.contextLines)
  const maxMatches = normalizeMaxMatches(options.maxMatches)
  const rgResult = await searchWithRipgrep({
    query: normalizedQuery,
    target,
    cwd,
    signal: options.signal,
    contextLines,
    maxMatches,
  })

  if (rgResult) {
    return finalizeSearchResult({
      query: normalizedQuery,
      target,
      cwd,
      matches: rgResult.matches,
      truncated: rgResult.truncated,
      backend: 'rg',
      maxMatches,
    })
  }

  const matches = await collectSearchMatches(
    target,
    normalizedQuery,
    cwd,
    {
      signal: options.signal,
      contextLines,
      maxMatches,
    },
  )

  return finalizeSearchResult({
    query: normalizedQuery,
    target,
    cwd,
    matches,
    truncated: matches.length >= maxMatches,
    backend: 'fallback',
    maxMatches,
  })
}

function truncateSearchText(value, maxLength) {
  const text = String(value || '')
  if (text.length <= maxLength) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxLength))}...<truncated>`
}

function compactSearchMatch(match, maxTextLength) {
  const text = typeof match?.text === 'string' ? match.text : ''
  return {
    path: match.path,
    line: match.line,
    text: truncateSearchText(text, maxTextLength),
    textTruncated: text.length > maxTextLength || undefined,
    suggestedRange: match.suggestedRange,
  }
}

function buildStructuredSearchPayload(result, options = {}) {
  const sourceMatches = Array.isArray(result?.matches) ? result.matches : []
  const matchLimit = Math.max(0, Math.min(sourceMatches.length, options.matchLimit ?? 80))
  const maxTextLength = Math.max(40, Math.min(500, options.maxTextLength ?? 240))
  const matches = sourceMatches
    .slice(0, matchLimit)
    .map(match => compactSearchMatch(match, maxTextLength))
  const outputTruncated =
    matchLimit < sourceMatches.length ||
    matches.some(match => match.textTruncated === true)

  return {
    query: result?.query || '',
    root: result?.root || '.',
    backend: result?.backend || 'unknown',
    total: Number.isFinite(result?.total) ? result.total : sourceMatches.length,
    returnedMatches: matches.length,
    truncated: result?.truncated === true || outputTruncated,
    outputTruncated,
    omittedMatches: Math.max(0, sourceMatches.length - matches.length),
    matches,
    suggestedRanges: dedupeSuggestedRanges(matches),
  }
}

export function formatStructuredSearchResultJson(result, options = {}) {
  const maxLength = Math.max(2000, Math.min(20000, Math.floor(Number(options.maxLength) || 11000)))
  const sourceMatches = Array.isArray(result?.matches) ? result.matches : []
  const initialMatchLimit = Math.min(sourceMatches.length, 80)
  const textLimits = [240, 160, 100, 60, 40]

  for (const maxTextLength of textLimits) {
    let matchLimit = initialMatchLimit
    while (matchLimit >= 0) {
      const json = JSON.stringify(
        buildStructuredSearchPayload(result, {
          matchLimit,
          maxTextLength,
        }),
        null,
        2,
      )
      if (json.length <= maxLength || matchLimit === 0) {
        return json
      }
      matchLimit = Math.floor(matchLimit / 2)
    }
  }

  return JSON.stringify(
    buildStructuredSearchPayload(result, {
      matchLimit: 0,
      maxTextLength: 40,
    }),
    null,
    2,
  )
}

export function formatSearchResultText(result) {
  const matches = Array.isArray(result?.matches) ? result.matches : []
  if (matches.length === 0) {
    return 'No matches found\n\nSuggested read_file ranges: []'
  }

  const matchLines = matches.map(match => `${match.path}:${match.line}:${match.text}`)
  const rangeLines = (Array.isArray(result.suggestedRanges) ? result.suggestedRanges : [])
    .slice(0, 40)
    .map(range => `- read_file ${JSON.stringify(range)}`)

  return [
    matchLines.join('\n'),
    rangeLines.length > 0
      ? `Suggested read_file ranges:\n${rangeLines.join('\n')}`
      : 'Suggested read_file ranges: []',
  ].join('\n\n')
}
