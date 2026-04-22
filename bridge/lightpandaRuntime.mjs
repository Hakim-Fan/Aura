import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createStructuredError } from './runtimeErrors.mjs'

const execFileAsync = promisify(execFile)
const LIGHTPANDA_PROVIDER_ID = 'lightpanda'
const DEFAULT_LIGHTPANDA_TIMEOUT_MS = 12_000
const DEFAULT_LIGHTPANDA_CONCURRENCY = 4
const LIGHTPANDA_MAX_BUFFER = 8 * 1024 * 1024

let activeLightpandaRuns = 0
const lightpandaWaiters = []

function resolveAuraLightpandaInstallDir() {
  return path.join(os.homedir(), '.aura', 'lightpanda')
}

function lightpandaNameScore(entryPath) {
  const fileName = path.basename(String(entryPath || '')).toLowerCase()
  if (
    fileName === 'lightpanda' ||
    fileName === 'lightpanda.exe' ||
    fileName === 'lightpanda.app'
  ) {
    return 3
  }
  if (fileName.includes('lightpanda')) {
    return 2
  }
  return 0
}

function resolveAppBundleExecutable(entryPath) {
  if (!String(entryPath || '').toLowerCase().endsWith('.app')) {
    return ''
  }

  const executableName = path.basename(entryPath, '.app')
  const macosDir = path.join(entryPath, 'Contents', 'MacOS')
  const namedCandidate = path.join(macosDir, executableName)
  if (fs.existsSync(namedCandidate) && fs.statSync(namedCandidate).isFile()) {
    return namedCandidate
  }

  try {
    const entries = fs.readdirSync(macosDir)
    const fallbackEntry = entries.find(entry => {
      const candidate = path.join(macosDir, entry)
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    })
    return fallbackEntry ? path.join(macosDir, fallbackEntry) : ''
  } catch {
    return ''
  }
}

function resolveExecutablePath(entryPath) {
  if (!entryPath) {
    return ''
  }

  try {
    const stat = fs.statSync(entryPath)
    if (stat.isFile()) {
      return entryPath
    }
    if (stat.isDirectory()) {
      return resolveAppBundleExecutable(entryPath)
    }
  } catch {
    return ''
  }

  return ''
}

function collectLightpandaInstallCandidates(dirPath, remainingDepth, candidates) {
  let entries = []
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase().endsWith('.app')) {
        if (lightpandaNameScore(entryPath) > 0) {
          const executable = resolveAppBundleExecutable(entryPath)
          if (executable) {
            candidates.push(executable)
          }
        }
        continue
      }

      if (remainingDepth > 0) {
        collectLightpandaInstallCandidates(entryPath, remainingDepth - 1, candidates)
      }
      continue
    }

    if (entry.isFile() && lightpandaNameScore(entryPath) > 0) {
      candidates.push(entryPath)
    }
  }
}

function resolveInstalledLightpandaExecutable() {
  const candidates = []
  collectLightpandaInstallCandidates(resolveAuraLightpandaInstallDir(), 2, candidates)
  candidates.sort((left, right) => {
    const scoreDelta = lightpandaNameScore(right) - lightpandaNameScore(left)
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    return left.localeCompare(right)
  })
  return candidates[0] || ''
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function stripMarkdown(value) {
  return collapseWhitespace(
    String(value || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_~>-]+/g, ' ')
      .replace(/\s+/g, ' '),
  )
}

function extractTitleFromMarkdown(markdown, url) {
  const headingMatch = String(markdown || '')
    .split('\n')
    .map(line => line.trim())
    .find(line => /^#\s+\S/u.test(line))
  if (headingMatch) {
    return headingMatch.replace(/^#\s+/u, '').trim()
  }

  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return url
  }
}

function resolveLightpandaSettings(settings) {
  const runtimeSettings = settings?.browser?.lightpanda || {}
  const configuredPath =
    typeof runtimeSettings.executablePath === 'string' && runtimeSettings.executablePath.trim()
      ? runtimeSettings.executablePath.trim()
      : ''
  const resolvedConfiguredPath = resolveExecutablePath(configuredPath)
  const installedPath = resolveInstalledLightpandaExecutable()
  return {
    enabled: runtimeSettings.enabled === true,
    executablePath: resolvedConfiguredPath || installedPath || configuredPath || 'lightpanda',
    timeoutMs: Math.max(
      3_000,
      Math.round((Number(runtimeSettings.timeoutSeconds) || 12) * 1_000),
    ),
    maxConcurrency: Math.max(
      1,
      Math.min(
        12,
        Math.round(Number(runtimeSettings.maxConcurrency) || DEFAULT_LIGHTPANDA_CONCURRENCY),
      ),
    ),
  }
}

async function acquireLightpandaSlot(limit) {
  if (activeLightpandaRuns < limit) {
    activeLightpandaRuns += 1
    return
  }

  await new Promise(resolve => {
    lightpandaWaiters.push(resolve)
  })
  activeLightpandaRuns += 1
}

function releaseLightpandaSlot() {
  activeLightpandaRuns = Math.max(0, activeLightpandaRuns - 1)
  const next = lightpandaWaiters.shift()
  if (next) {
    next()
  }
}

async function runLightpandaCommand({ executablePath, args, cwd, timeoutMs, signal }) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd,
      signal,
      timeout: timeoutMs,
      maxBuffer: LIGHTPANDA_MAX_BUFFER,
    })
    return collapseWhitespace(stdout || stderr)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw createStructuredError('Lightpanda 读取网页失败。', {
      source: 'tool',
      category: 'execution_failed',
      code: 'LIGHTPANDA_FETCH_FAILED',
      detail,
      suggestedAction:
        '请确认 Lightpanda 已正确安装，或改为显式要求打开系统浏览器处理需要登录/验证码的页面。',
      retryable: true,
    })
  }
}

async function runDump({
  executablePath,
  url,
  dump,
  cwd,
  timeoutMs,
  signal,
}) {
  return runLightpandaCommand({
    executablePath,
    cwd,
    timeoutMs,
    signal,
    args: [
      'fetch',
      url,
      '--dump',
      dump,
      '--wait-until',
      'networkidle',
      '--wait-ms',
      '4000',
      '--strip-mode',
      'ui',
    ],
  })
}

export function isLightpandaEnabled(settings) {
  return resolveLightpandaSettings(settings).enabled
}

export function getLightpandaProviderId() {
  return LIGHTPANDA_PROVIDER_ID
}

export async function runLightpandaFetch(
  { url, mode = 'article' },
  runtime = {},
) {
  const resolved = resolveLightpandaSettings(runtime.settings || {})
  if (!resolved.enabled) {
    throw createStructuredError('Lightpanda 当前未启用。', {
      source: 'tool',
      category: 'unsupported',
      code: 'LIGHTPANDA_DISABLED',
      suggestedAction: '请先在设置中启用 Lightpanda，或改用纯 web_* 工具。',
    })
  }

  await acquireLightpandaSlot(resolved.maxConcurrency)
  try {
    const markdown = await runDump({
      executablePath: resolved.executablePath,
      url,
      dump: 'markdown',
      cwd: runtime.cwd || process.cwd(),
      timeoutMs: resolved.timeoutMs,
      signal: runtime.signal,
    })
    const plain = stripMarkdown(markdown)

    if (markdown || plain) {
      return {
        provider: LIGHTPANDA_PROVIDER_ID,
        title: extractTitleFromMarkdown(markdown, url),
        markdown,
        plain,
      }
    }

    const semanticTree = await runDump({
      executablePath: resolved.executablePath,
      url,
      dump: 'semantic_tree_text',
      cwd: runtime.cwd || process.cwd(),
      timeoutMs: resolved.timeoutMs,
      signal: runtime.signal,
    })
    const normalizedText = collapseWhitespace(semanticTree)
    if (!normalizedText) {
      throw createStructuredError('Lightpanda 没有返回可用内容。', {
        source: 'tool',
        category: 'unsupported',
        code: 'LIGHTPANDA_EMPTY_CONTENT',
        suggestedAction: '请稍后重试，或改为显式要求打开系统浏览器。',
      })
    }

    return {
      provider: LIGHTPANDA_PROVIDER_ID,
      title: extractTitleFromMarkdown('', url),
      markdown: normalizedText,
      plain: normalizedText,
    }
  } finally {
    releaseLightpandaSlot()
  }
}
