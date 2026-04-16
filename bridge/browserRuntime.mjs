import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { createStructuredError } from './runtimeErrors.mjs'
import { resolveWorkspacePath, stringifyOutput, truncate } from './utils.mjs'

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const DEFAULT_WAIT_UNTIL = 'domcontentloaded'
const PROFILE_LOCK_RETRY_DELAYS_MS = [120, 250, 500, 1_000, 1_500]
const DEFAULT_BROWSER_SESSION_ID = 'default'
const BROWSER_REF_ATTRIBUTE = 'data-aura-ref'
const DEFAULT_SNAPSHOT_DEPTH = 3
const DEFAULT_SNAPSHOT_MAX_REFS = 40
const MAX_DEBUG_BUFFER_ENTRIES = 200
const DEFAULT_TRACE_RELATIVE_PATH = `.aura/browser/trace-${Date.now()}.zip`
const DEFAULT_VIDEO_RELATIVE_DIR = '.aura/browser/videos'
const execFileAsync = promisify(execFile)

function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    return ''
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return normalized.replace(/^-+|-+$/g, '')
}

function resolveBrowserSessionId(value) {
  return normalizeSessionId(value) || DEFAULT_BROWSER_SESSION_ID
}

function resolveSessionProfilePath(settings, sessionId) {
  const baseProfilePath = resolveAuraProfilePath(settings)
  if (sessionId === DEFAULT_BROWSER_SESSION_ID) {
    return baseProfilePath
  }

  return path.join(
    path.dirname(baseProfilePath),
    `${path.basename(baseProfilePath)}-sessions`,
    sessionId,
  )
}

function pushRingBuffer(buffer, entry, maxEntries = MAX_DEBUG_BUFFER_ENTRIES) {
  buffer.push(entry)
  if (buffer.length > maxEntries) {
    buffer.splice(0, buffer.length - maxEntries)
  }
}

function normalizeSnapshotDepth(value) {
  const depth = Number(value)
  if (!Number.isFinite(depth)) {
    return DEFAULT_SNAPSHOT_DEPTH
  }
  return Math.max(0, Math.min(6, Math.trunc(depth)))
}

function normalizeMaxRefs(value) {
  const maxRefs = Number(value)
  if (!Number.isFinite(maxRefs)) {
    return DEFAULT_SNAPSHOT_MAX_REFS
  }
  return Math.max(1, Math.min(200, Math.trunc(maxRefs)))
}

function buildBrowserTarget(args = {}) {
  const ref = typeof args.ref === 'string' ? args.ref.trim() : ''
  if (ref) {
    return { kind: 'ref', value: ref }
  }

  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (selector) {
    return { kind: 'selector', value: selector }
  }

  return null
}

function browserRefSelector(ref) {
  return `[${BROWSER_REF_ATTRIBUTE}="${String(ref).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

function buildBrowserDebugArtifact(kind, sessionState, extra = {}) {
  return {
    kind,
    sessionId: sessionState?.id || DEFAULT_BROWSER_SESSION_ID,
    createdAt: Date.now(),
    ...extra,
  }
}

function normalizeStorageArea(value) {
  return value === 'cookies' || value === 'localStorage' || value === 'sessionStorage'
    ? value
    : 'cookies'
}

function buildSessionInputProperties({ includeLabel = false, includeVisible = false } = {}) {
  const properties = {
    sessionId: {
      type: 'string',
      description: 'Optional browser session id. Defaults to the active session.',
    },
    createIfMissing: {
      type: 'boolean',
      description: 'Create the session automatically when it does not exist. Defaults to true.',
    },
  }

  if (includeLabel) {
    properties.label = {
      type: 'string',
      description: 'Optional human-readable label for a newly created session.',
    }
  }

  if (includeVisible) {
    properties.visible = {
      type: 'boolean',
      description: 'Launch or relaunch this session in a visible window.',
    }
  }

  return properties
}

function buildSessionOptions(args = {}, extra = {}) {
  return {
    sessionId: args.sessionId,
    createIfMissing: args.createIfMissing !== false,
    label: typeof args.label === 'string' ? args.label.trim() : '',
    ...extra,
  }
}

function resolveBrowserArtifactPath(context, relativePath) {
  return resolveWorkspacePath(context.cwd, relativePath)
}

function resolveBrowserArtifactDir(context, relativePath) {
  return resolveBrowserArtifactPath(context, relativePath)
}

function normalizeStorageOrigin(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function normalizeStorageItems(items) {
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    return Object.entries(items).reduce((record, [key, value]) => {
      record[String(key)] = value == null ? '' : String(value)
      return record
    }, {})
  }
  return null
}

function resolveAuraBrowserRoot() {
  return path.join(os.homedir(), '.aura', 'browser')
}

function resolveAuraProfilePath(settings) {
  const configured = settings.browser?.auraProfilePath?.trim()
  if (configured) {
    return configured
  }
  return path.join(resolveAuraBrowserRoot(), 'profiles', 'default')
}

function resolvePendingCookieImportsPath() {
  return path.join(resolveAuraBrowserRoot(), 'pending-cookie-imports.json')
}

function systemChromeCandidates() {
  const home = os.homedir()
  return [
    '/Applications/Google Chrome.app',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications', 'Google Chrome.app'),
    path.join(home, 'Applications', 'Google Chrome.app', 'Contents/MacOS', 'Google Chrome'),
  ]
}

function managedChromeCandidates(settings) {
  const runtimeRoot = path.join(resolveAuraBrowserRoot(), 'runtimes', 'chrome')
  const configured = settings.browser?.managedExecutablePath?.trim()
  return [
    configured,
    path.join(runtimeRoot, 'Google Chrome.app'),
    path.join(runtimeRoot, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    path.join(runtimeRoot, 'Google Chrome for Testing.app'),
    path.join(
      runtimeRoot,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    path.join(runtimeRoot, 'chrome'),
    path.join(runtimeRoot, 'chrome-mac', 'Google Chrome for Testing.app'),
    path.join(runtimeRoot, 'chrome-mac', 'Google Chrome for Testing'),
  ].filter(Boolean)
}

async function fileExists(target) {
  if (!target) {
    return false
  }
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function resolveAppBundleExecutable(targetPath) {
  if (!targetPath.endsWith('.app')) {
    return null
  }

  const bundleName = path.basename(targetPath, '.app')
  const macosDir = path.join(targetPath, 'Contents', 'MacOS')
  const namedCandidate = path.join(macosDir, bundleName)
  if (await fileExists(namedCandidate)) {
    return namedCandidate
  }

  try {
    const entries = await fs.readdir(macosDir)
    const firstFile = entries[0]
    return firstFile ? path.join(macosDir, firstFile) : null
  } catch {
    return null
  }
}

async function resolveExecutableCandidate(targetPath) {
  if (!targetPath) {
    return null
  }

  const normalized = targetPath.trim()
  if (!normalized) {
    return null
  }

  if (await fileExists(normalized)) {
    const stats = await fs.stat(normalized)
    if (stats.isFile()) {
      return normalized
    }
    if (stats.isDirectory()) {
      return resolveAppBundleExecutable(normalized)
    }
  }

  return null
}

async function findFirstExecutable(candidates) {
  for (const candidate of candidates) {
    const resolved = await resolveExecutableCandidate(candidate)
    if (resolved) {
      return resolved
    }
  }
  return null
}

async function resolveBrowserExecutable(settings) {
  if (!settings.browser?.enabled) {
    throw createStructuredError('Aura 浏览器运行时当前未启用。', {
      source: 'tool',
      category: 'unsupported',
      code: 'BROWSER_RUNTIME_DISABLED',
      suggestedAction: settings.enableChromeAutomation && settings.browser?.allowChromeAutomationFallback
        ? '请先在设置页的“浏览器”页签中启用 Aura 浏览器运行时；如果你已经开启系统 Chrome 备用模式并允许自动降级，也可以改用 chrome_* 工具继续。'
        : '请先在设置页的“浏览器”页签中启用 Aura 浏览器运行时。',
    })
  }

  let executablePath = null
  switch (settings.browser.source) {
    case 'managed-chrome':
      executablePath = await findFirstExecutable(managedChromeCandidates(settings))
      break
    case 'custom-executable':
      executablePath = await resolveExecutableCandidate(settings.browser.executablePath || '')
      break
    case 'system-chrome':
    default:
      executablePath = await findFirstExecutable(systemChromeCandidates())
      break
  }

  if (!executablePath) {
    throw createStructuredError('没有找到可用的浏览器运行时。', {
      source: 'tool',
      category: 'missing_dependency',
      code: 'BROWSER_RUNTIME_NOT_FOUND',
      suggestedAction: settings.enableChromeAutomation && settings.browser?.allowChromeAutomationFallback
        ? '请前往设置 > 浏览器，重新检测环境，或切换到系统 Chrome / 自定义浏览器可执行文件；如果你已经开启系统 Chrome 备用模式并允许自动降级，也可以改用 chrome_* 工具继续。'
        : '请前往设置 > 浏览器，重新检测环境，或切换到系统 Chrome / 自定义浏览器可执行文件。',
    })
  }

  return executablePath
}

function normalizeWaitUntil(value) {
  return value === 'load' || value === 'domcontentloaded' || value === 'networkidle'
    ? value
    : DEFAULT_WAIT_UNTIL
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isBrowserProfileLockedDetail(detail) {
  return (
    detail.includes('ProcessSingleton') ||
    detail.includes('SingletonLock') ||
    detail.includes('SingletonSocket')
  )
}

function buildBrowserProfileLockedError(detail) {
  return createStructuredError('Aura 浏览器 Profile 当前正被另一个浏览器实例占用。', {
    source: 'tool',
    category: 'unavailable',
    code: 'BROWSER_PROFILE_LOCKED',
    detail,
    suggestedAction:
      '请先关闭正在使用同一 Aura Profile 的浏览器窗口，或等待当前浏览器任务结束后再试。',
  })
}

function isAuraManagedProfilePath(userDataDir) {
  const normalized = path.resolve(userDataDir)
  const auraProfilesRoot = path.resolve(resolveAuraBrowserRoot(), 'profiles')
  return normalized === auraProfilesRoot || normalized.startsWith(`${auraProfilesRoot}${path.sep}`)
}

async function listProcessesUsingUserDataDir(userDataDir) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return []
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      maxBuffer: 1024 * 1024,
    })

    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\d+)\s+(.*)$/u)
        if (!match) {
          return null
        }
        return {
          pid: Number(match[1]),
          command: match[2],
        }
      })
      .filter(entry => entry && entry.pid && entry.command.includes(userDataDir))
  } catch {
    return []
  }
}

async function forceCloseAuraProfileProcesses(userDataDir) {
  if (!isAuraManagedProfilePath(userDataDir)) {
    return 0
  }

  const matching = await listProcessesUsingUserDataDir(userDataDir)
  const pids = matching
    .map(entry => entry?.pid)
    .filter(pid => typeof pid === 'number' && Number.isFinite(pid) && pid !== process.pid)

  if (pids.length === 0) {
    return 0
  }

  try {
    await execFileAsync('kill', ['-TERM', ...pids.map(pid => String(pid))], {
      maxBuffer: 1024 * 1024,
    })
  } catch {
    // Some processes may already be exiting; continue with best-effort cleanup.
  }

  await wait(400)

  const survivors = await listProcessesUsingUserDataDir(userDataDir)
  const survivorPids = survivors
    .map(entry => entry?.pid)
    .filter(pid => typeof pid === 'number' && Number.isFinite(pid) && pid !== process.pid)

  if (survivorPids.length > 0) {
    try {
      await execFileAsync('kill', ['-KILL', ...survivorPids.map(pid => String(pid))], {
        maxBuffer: 1024 * 1024,
      })
    } catch {
      // Preserve the original locked error if force-close still fails.
    }
    await wait(250)
  }

  return pids.length
}

async function launchPersistentContextWithRetry(
  settings,
  executablePath,
  userDataDir,
  headless,
  { retryOnProfileLock = false, launchOptions = {} } = {},
) {
  const maxAttempts = retryOnProfileLock ? PROFILE_LOCK_RETRY_DELAYS_MS.length + 1 : 1
  let forceClosed = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(
        userDataDir,
        browserContextOptions(settings, executablePath, headless, launchOptions),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.stack || error.message : String(error)
      if (!isBrowserProfileLockedDetail(detail)) {
        throw error
      }
      if (attempt >= maxAttempts) {
        if (retryOnProfileLock && !forceClosed) {
          const closedCount = await forceCloseAuraProfileProcesses(userDataDir)
          forceClosed = closedCount > 0
          if (forceClosed) {
            attempt -= 1
            continue
          }
        }
        throw buildBrowserProfileLockedError(detail)
      }
      await wait(PROFILE_LOCK_RETRY_DELAYS_MS[attempt - 1] || 1_500)
    }
  }

  throw buildBrowserProfileLockedError('Browser profile remained locked after retrying.')
}

function browserContextOptions(settings, executablePath, headless, launchOptions = {}) {
  const behavior = settings.browser?.behavior || {}
  const search = settings.browser?.search || {}
  const extraHTTPHeaders = {}

  if (behavior.acceptLanguage && behavior.acceptLanguage !== 'auto') {
    extraHTTPHeaders['Accept-Language'] = behavior.acceptLanguage
  } else if (search.language && search.language !== 'auto') {
    extraHTTPHeaders['Accept-Language'] = search.language
  }

  return {
    executablePath,
    headless,
    viewport: DEFAULT_VIEWPORT,
    locale:
      behavior.locale && behavior.locale !== 'system'
        ? behavior.locale
        : search.language && search.language !== 'auto'
          ? search.language
          : undefined,
    timezoneId:
      behavior.timezone && behavior.timezone !== 'system' ? behavior.timezone : undefined,
    colorScheme:
      behavior.colorScheme === 'light'
        ? 'light'
        : behavior.colorScheme === 'dark'
          ? 'dark'
          : 'no-preference',
    userAgent:
      behavior.userAgentMode === 'desktop'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        : undefined,
    extraHTTPHeaders: Object.keys(extraHTTPHeaders).length > 0 ? extraHTTPHeaders : undefined,
    recordVideo:
      launchOptions.recordVideoDir
        ? {
            dir: launchOptions.recordVideoDir,
            size: DEFAULT_VIEWPORT,
          }
        : undefined,
    args: ['--no-default-browser-check', '--disable-dev-shm-usage'],
  }
}

async function buildPageSnapshot(page, sessionState, meta = {}) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  return {
    url,
    title,
    sessionId: sessionState?.id || DEFAULT_BROWSER_SESSION_ID,
    sessionLabel: sessionState?.label || undefined,
    headless: sessionState?.headless !== false,
    visible: sessionState?.headless === false,
    capturedAt: Date.now(),
    ...meta,
  }
}

async function detectBrowserBlocker(page) {
  const signals = await page
    .evaluate(() => {
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
      const sampledText = bodyText.slice(0, 5000)
      const passwordInput = Boolean(document.querySelector('input[type="password"]'))
      const otpInput = Boolean(
        document.querySelector(
          'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[name*="code" i]',
        ),
      )
      const challengeIframe = Array.from(document.querySelectorAll('iframe')).some(frame => {
        const source = `${frame.getAttribute('src') || ''} ${frame.getAttribute('title') || ''}`.toLowerCase()
        return (
          source.includes('captcha') ||
          source.includes('challenge') ||
          source.includes('turnstile') ||
          source.includes('recaptcha')
        )
      })
      return {
        title: document.title || '',
        bodyText: sampledText,
        passwordInput,
        otpInput,
        challengeIframe,
      }
    })
    .catch(() => null)

  if (!signals) {
    return {
      detected: false,
      kind: '',
      reason: '',
      signals: [],
    }
  }

  const combined = `${page.url()} ${signals.title} ${signals.bodyText}`.toLowerCase()
  const matchedSignals = []

  const challengeKeywords = [
    'captcha',
    'verify you are human',
    'human verification',
    'security check',
    'cf challenge',
    'cloudflare',
    'recaptcha',
    'turnstile',
    'challenge',
    '验证码',
    '人机验证',
  ]
  if (signals.challengeIframe || challengeKeywords.some(keyword => combined.includes(keyword))) {
    matchedSignals.push('challenge')
    return {
      detected: true,
      kind: 'verification',
      reason: '页面出现验证码、人机校验或安全挑战，通常需要你亲自接管浏览器继续。',
      signals: matchedSignals,
    }
  }

  const twoFactorKeywords = [
    '2fa',
    'two-factor',
    'two factor',
    'verification code',
    'one-time code',
    'authenticator',
    'sms code',
    'enter the code',
    'otp',
    '一次性验证码',
    '短信验证码',
    '验证码',
  ]
  if (signals.otpInput || twoFactorKeywords.some(keyword => combined.includes(keyword))) {
    matchedSignals.push('two-factor')
    return {
      detected: true,
      kind: 'two-factor',
      reason: '页面要求输入验证码、2FA 或一次性口令，通常需要你亲自接管浏览器继续。',
      signals: matchedSignals,
    }
  }

  const loginKeywords = [
    'sign in',
    'log in',
    'login',
    'sign on',
    'continue with',
    '登录',
    '请登录',
  ]
  if (signals.passwordInput && loginKeywords.some(keyword => combined.includes(keyword))) {
    matchedSignals.push('login')
    return {
      detected: true,
      kind: 'login',
      reason: '页面进入登录流程，可能需要你在 Aura 浏览器里完成登录后再继续。',
      signals: matchedSignals,
    }
  }

  return {
    detected: false,
    kind: '',
    reason: '',
    signals: [],
  }
}

async function serializePageSnapshot(page, options = {}) {
  const selector =
    typeof options.selector === 'string' && options.selector.trim() ? options.selector.trim() : ''
  const depth = normalizeSnapshotDepth(options.depth)
  const interactiveOnly = options.interactiveOnly !== false
  const maxRefs = normalizeMaxRefs(options.maxRefs)
  const sessionId = resolveBrowserSessionId(options.sessionId)
  const source = options.source === 'browser_get_page' ? 'browser_get_page' : 'browser_snapshot'

  const snapshot = await page.evaluate(
    ({ selector: rootSelector, depth: maxDepth, interactiveOnly: onlyInteractive, maxRefs: maxCount, sessionId: currentSessionId, refAttribute }) => {
      const refState = (globalThis.__auraBrowserRuntimeRefState ||= { nextSeq: 0 })
      const root = rootSelector ? document.querySelector(rootSelector) : document.body

      if (!root) {
        return {
          found: false,
          refs: [],
        }
      }

      const normalizeText = value =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220)

      const interactiveRoles = new Set([
        'button',
        'link',
        'textbox',
        'searchbox',
        'checkbox',
        'radio',
        'switch',
        'tab',
        'menuitem',
        'option',
        'combobox',
      ])

      const isVisible = element => {
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
          return false
        }
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }

      const isInteractive = element => {
        const tag = element.tagName.toLowerCase()
        const role = (element.getAttribute('role') || '').toLowerCase()
        if (interactiveRoles.has(role)) {
          return true
        }
        if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) {
          return true
        }
        if (element.hasAttribute('contenteditable')) {
          return true
        }
        if (element.hasAttribute('onclick')) {
          return true
        }
        const tabIndex = element.getAttribute('tabindex')
        return tabIndex !== null && Number(tabIndex) >= 0
      }

      const readLabel = element => {
        const ariaLabel = normalizeText(element.getAttribute('aria-label') || '')
        if (ariaLabel) {
          return ariaLabel
        }

        const labels = Array.from(element.labels || [])
          .map(label => normalizeText(label.textContent || ''))
          .filter(Boolean)
        if (labels.length > 0) {
          return labels.join(' | ')
        }

        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/u)
            .map(id => document.getElementById(id))
            .filter(Boolean)
            .map(node => normalizeText(node.textContent || ''))
            .filter(Boolean)
            .join(' | ')
          if (text) {
            return text
          }
        }

        return ''
      }

      const assignRef = element => {
        let ref = element.getAttribute(refAttribute) || element.__auraBrowserRef || ''
        if (!ref) {
          ref = `br-${currentSessionId}-${++refState.nextSeq}`
          element.setAttribute(refAttribute, ref)
          element.__auraBrowserRef = ref
        }
        return ref
      }

      const refs = []
      const queue = [{ node: root, depth: 0 }]

      while (queue.length > 0 && refs.length < maxCount) {
        const entry = queue.shift()
        const element = entry?.node
        if (!(element instanceof Element)) {
          continue
        }

        const currentDepth = entry.depth
        const visible = isVisible(element)
        const interactive = isInteractive(element)
        const tag = element.tagName.toLowerCase()
        const role = normalizeText(element.getAttribute('role') || '')
        const text = normalizeText(element.innerText || element.textContent || '')
        const shouldInclude =
          (interactive && visible) ||
          (!onlyInteractive && visible && text) ||
          (rootSelector && currentDepth === 0)

        if (shouldInclude) {
          refs.push({
            ref: assignRef(element),
            tag,
            role: role || undefined,
            text: text || undefined,
            testId:
              normalizeText(
                element.getAttribute('data-testid') ||
                  element.getAttribute('data-test-id') ||
                  element.getAttribute('testid') ||
                  '',
              ) || undefined,
            placeholder: normalizeText(element.getAttribute('placeholder') || '') || undefined,
            label: readLabel(element) || undefined,
            href: tag === 'a' ? normalizeText(element.getAttribute('href') || '') || undefined : undefined,
            visible,
            interactive,
          })
        }

        if (currentDepth >= maxDepth) {
          continue
        }

        for (const child of Array.from(element.children).slice(0, 80)) {
          queue.push({ node: child, depth: currentDepth + 1 })
        }
      }

      return {
        found: true,
        refs,
      }
    },
    {
      selector,
      depth,
      interactiveOnly,
      maxRefs,
      sessionId,
      refAttribute: BROWSER_REF_ATTRIBUTE,
    },
  )

  if (!snapshot?.found) {
    throw createStructuredError('没有找到可用于抓取 snapshot 的目标元素。', {
      source: 'tool',
      category: 'not_found',
      code: 'BROWSER_SNAPSHOT_TARGET_NOT_FOUND',
      suggestedAction: selector
        ? '请确认 selector 是否正确，或先读取页面内容后再缩小范围。'
        : '请先打开一个页面，再重新抓取 snapshot。',
    })
  }

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    capturedAt: Date.now(),
    mode: selector ? 'element' : interactiveOnly ? 'partial' : 'full',
    source,
    contentFormat: 'snapshot',
    selector: selector || undefined,
    interactiveOnly,
    depth,
    maxRefs,
    refs: Array.isArray(snapshot.refs) ? snapshot.refs : [],
  }
}

async function serializePageContent(page, format, maxLength, options = {}) {
  if (format === 'html') {
    const html = await page.content()
    return truncate(html, maxLength)
  }

  if (format === 'snapshot') {
    return serializePageSnapshot(page, options)
  }

  const text = await page.evaluate(() => document.body?.innerText || '')
  return truncate(text, maxLength)
}

async function capturePageObservation(page) {
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    textSample: await page
      .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800))
      .catch(() => ''),
  }
}

function didPageObservationChange(before, after) {
  return (
    before.url !== after.url ||
    before.title !== after.title ||
    before.textSample !== after.textSample
  )
}

async function resolveBrowserTarget(page, args = {}) {
  const target = buildBrowserTarget(args)
  if (!target) {
    throw createStructuredError('需要至少提供 ref 或 selector。', {
      source: 'tool',
      category: 'invalid_input',
      code: 'BROWSER_TARGET_REQUIRED',
      suggestedAction: '请先通过 browser_snapshot 获取 ref，或显式传入 selector。',
    })
  }

  const locator = page
    .locator(target.kind === 'ref' ? browserRefSelector(target.value) : target.value)
    .first()

  if (target.kind === 'ref') {
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      throw createStructuredError(`页面中没有找到 ref=${target.value} 对应的元素。`, {
        source: 'tool',
        category: 'not_found',
        code: 'BROWSER_REF_NOT_FOUND',
        suggestedAction: '请重新抓取 browser_snapshot，拿到最新的 ref 后再执行动作。',
      })
    }
  }

  return {
    target,
    locator,
  }
}

async function buildActionReceipt(page, action, target, before) {
  const after = await capturePageObservation(page)
  return {
    action,
    target,
    success: true,
    urlBefore: before.url,
    urlAfter: after.url,
    titleBefore: before.title,
    titleAfter: after.title,
    snapshotChanged: didPageObservationChange(before, after),
  }
}

async function inspectBrowserElement(locator) {
  await locator.waitFor({ state: 'attached', timeout: 5_000 })
  const box = await locator.boundingBox().catch(() => null)
  const details = await locator.evaluate((element, refAttribute) => {
    const normalizeText = value =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400)

    const visible = (() => {
      const style = window.getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
        return false
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })()

    return {
      ref: element.getAttribute(refAttribute) || element.__auraBrowserRef || undefined,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || undefined,
      id: element.id || undefined,
      name: element.getAttribute('name') || undefined,
      type: element.getAttribute('type') || undefined,
      text: normalizeText(element.innerText || element.textContent || '') || undefined,
      value:
        typeof element.value === 'string' ? normalizeText(element.value).slice(0, 200) || undefined : undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      href: element.getAttribute('href') || undefined,
      ariaLabel: element.getAttribute('aria-label') || undefined,
      visible,
      interactive:
        ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(element.tagName.toLowerCase()) ||
        element.hasAttribute('onclick') ||
        element.hasAttribute('contenteditable'),
      attributes: Array.from(element.attributes).reduce((record, attribute) => {
        record[attribute.name] = attribute.value
        return record
      }, {}),
    }
  }, BROWSER_REF_ATTRIBUTE)

  return {
    ...details,
    boundingBox: box
      ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      : null,
  }
}

async function readCurrentOriginStorage(page) {
  return page.evaluate(() => ({
    origin: window.location.origin,
    localStorage: Object.fromEntries(
      Array.from({ length: window.localStorage.length }, (_, index) => {
        const key = window.localStorage.key(index)
        return [key, key ? window.localStorage.getItem(key) : null]
      }),
    ),
    sessionStorage: Object.fromEntries(
      Array.from({ length: window.sessionStorage.length }, (_, index) => {
        const key = window.sessionStorage.key(index)
        return [key, key ? window.sessionStorage.getItem(key) : null]
      }),
    ),
  }))
}

async function applyStorageItems(page, area, items) {
  await page.evaluate(
    ({ storageArea, nextItems }) => {
      const target = storageArea === 'sessionStorage' ? window.sessionStorage : window.localStorage
      for (const [key, value] of Object.entries(nextItems || {})) {
        target.setItem(key, String(value))
      }
    },
    { storageArea: area, nextItems: items },
  )
}

async function clearStorageArea(page, area, key) {
  await page.evaluate(
    ({ storageArea, targetKey }) => {
      const target = storageArea === 'sessionStorage' ? window.sessionStorage : window.localStorage
      if (targetKey) {
        target.removeItem(targetKey)
        return
      }
      target.clear()
    },
    { storageArea: area, targetKey: key || '' },
  )
}

async function exportBrowserStorageState(page, sessionState) {
  const currentOriginStorage = await readCurrentOriginStorage(page)
  const storageState = sessionState?.context
    ? await sessionState.context.storageState()
    : { cookies: [], origins: [] }

  return {
    version: 1,
    exportedAt: Date.now(),
    sessionId: sessionState?.id || DEFAULT_BROWSER_SESSION_ID,
    currentPage: {
      url: page.url(),
      title: await page.title().catch(() => ''),
      origin: currentOriginStorage.origin,
      sessionStorage: currentOriginStorage.sessionStorage,
    },
    storageState,
  }
}

async function importBrowserStorageState(page, sessionState, payload) {
  const wrapper =
    payload && typeof payload === 'object' && payload.storageState && typeof payload.storageState === 'object'
      ? payload
      : { storageState: payload }
  const storageState =
    wrapper?.storageState && typeof wrapper.storageState === 'object'
      ? wrapper.storageState
      : { cookies: [], origins: [] }
  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : []
  const origins = Array.isArray(storageState.origins) ? storageState.origins : []

  if (sessionState?.context && cookies.length > 0) {
    await sessionState.context.addCookies(cookies)
  }

  const workingPage = page
  for (const originEntry of origins) {
    const origin = normalizeStorageOrigin(originEntry?.origin)
    if (!origin) {
      continue
    }

    const localStorageItems = Array.isArray(originEntry?.localStorage)
      ? originEntry.localStorage.reduce((record, item) => {
          if (item?.name) {
            record[item.name] = item.value == null ? '' : String(item.value)
          }
          return record
        }, {})
      : {}

    try {
      await workingPage.goto(origin, { waitUntil: DEFAULT_WAIT_UNTIL })
      await applyStorageItems(workingPage, 'localStorage', localStorageItems)
    } catch {
      // Best-effort import: keep going if a given origin cannot be opened.
    }
  }

  const sessionStorageItems =
    wrapper?.currentPage && typeof wrapper.currentPage === 'object' && wrapper.currentPage.sessionStorage
      ? normalizeStorageItems(wrapper.currentPage.sessionStorage)
      : null
  const pageOrigin =
    wrapper?.currentPage && typeof wrapper.currentPage === 'object'
      ? normalizeStorageOrigin(wrapper.currentPage.origin)
      : ''

  if (pageOrigin && sessionStorageItems) {
    try {
      await workingPage.goto(pageOrigin, { waitUntil: DEFAULT_WAIT_UNTIL })
      await applyStorageItems(workingPage, 'sessionStorage', sessionStorageItems)
    } catch {
      // Ignore individual sessionStorage restore failures.
    }
  }

  return {
    cookieCount: cookies.length,
    originCount: origins.length,
    restoredSessionStorageKeys: sessionStorageItems ? Object.keys(sessionStorageItems).length : 0,
  }
}

async function buildBrowserResult(page, settings, meta = {}) {
  const sessionState = browserSessionManager.getSessionStateByPage(page)
  const blocker = await detectBrowserBlocker(page)
  let takeoverTriggered = false
  let resultPage = page
  let resultSessionState = sessionState

  if (
    blocker.detected &&
    settings.browser?.takeoverMode === 'auto-visible-on-blocker' &&
    sessionState?.headless !== false
  ) {
    resultPage = await browserSessionManager.ensureSession(settings, {
      sessionId: sessionState?.id,
      label: sessionState?.label,
      visible: true,
    })
    resultSessionState = browserSessionManager.getSessionStateByPage(resultPage)
    takeoverTriggered = true
  }

  return buildPageSnapshot(resultPage, resultSessionState, {
    blocker,
    takeoverTriggered,
    ...meta,
  })
}

function buildSearchUrl(settings, query) {
  const search = settings.browser?.search || {}
  const encodedQuery = encodeURIComponent(query)
  const language = search.language && search.language !== 'auto' ? search.language : ''
  const region = search.region && search.region !== 'auto' ? search.region : ''

  if (search.engine === 'custom') {
    const template = search.customTemplate?.trim()
    if (!template || !template.includes('{query}') || !/^https?:\/\//i.test(template)) {
      throw createStructuredError('自定义搜索模板无效。', {
        source: 'tool',
        category: 'invalid_input',
        code: 'INVALID_BROWSER_SEARCH_TEMPLATE',
        suggestedAction: '请先在设置 > 浏览器 中填写一个包含 {query} 的有效模板。',
      })
    }
    return template.replaceAll('{query}', encodedQuery)
  }

  switch (search.engine) {
    case 'bing': {
      const params = new URLSearchParams({ q: query })
      if (language) params.set('setlang', language)
      if (region) params.set('cc', region)
      return `https://www.bing.com/search?${params.toString()}`
    }
    case 'duckduckgo': {
      const params = new URLSearchParams({ q: query })
      if (language) params.set('kl', language)
      return `https://duckduckgo.com/?${params.toString()}`
    }
    case 'baidu': {
      const params = new URLSearchParams({ wd: query })
      if (language) params.set('lang', language)
      return `https://www.baidu.com/s?${params.toString()}`
    }
    case 'google':
    default: {
      const params = new URLSearchParams({ q: query })
      if (language) params.set('hl', language)
      if (region) params.set('gl', region)
      if (search.safeSearch === 'strict') {
        params.set('safe', 'active')
      } else if (search.safeSearch === 'off') {
        params.set('safe', 'off')
      }
      return `https://www.google.com/search?${params.toString()}`
    }
  }
}

function normalizeTimeout(value, fallback = 10_000) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

async function safeEvaluate(page, script) {
  const result = await page.evaluate(async source => {
    try {
      const value = await globalThis.eval(source)
      if (value === undefined) {
        return { ok: true, value: 'undefined' }
      }
      if (typeof value === 'string') {
        return { ok: true, value }
      }
      return {
        ok: true,
        value: JSON.stringify(value, null, 2),
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, script)

  if (!result?.ok) {
    throw createStructuredError(`页面脚本执行失败：${result?.error || '未知错误'}`, {
      source: 'tool',
      category: 'execution_failed',
      code: 'BROWSER_SCRIPT_FAILED',
      detail: result?.error || 'Unknown browser evaluation failure',
    })
  }

  return result.value || ''
}

async function applyPendingCookieImports(context) {
  const pendingPath = resolvePendingCookieImportsPath()
  if (!(await fileExists(pendingPath))) {
    return 0
  }

  try {
    const content = await fs.readFile(pendingPath, 'utf8')
    const cookies = JSON.parse(content)
    if (!Array.isArray(cookies) || cookies.length === 0) {
      await fs.rm(pendingPath, { force: true })
      return 0
    }

    await context.addCookies(cookies)
    await fs.rm(pendingPath, { force: true })
    return cookies.length
  } catch (error) {
    throw createStructuredError('应用导入的 Chrome 登录态失败。', {
      source: 'tool',
      category: 'execution_failed',
      code: 'BROWSER_COOKIE_IMPORT_APPLY_FAILED',
      detail: error instanceof Error ? error.stack || error.message : String(error),
      suggestedAction: '请重新导入站点登录态，或检查 Aura 浏览器 Profile 目录是否可写。',
    })
  }
}

function cookieDomainMatches(domain, targetDomain) {
  const normalizedDomain = String(domain || '').replace(/^\./, '').toLowerCase()
  const normalizedTarget = String(targetDomain || '').replace(/^\./, '').toLowerCase()
  return (
    normalizedDomain === normalizedTarget ||
    normalizedDomain.endsWith(`.${normalizedTarget}`)
  )
}

export async function clearAuraProfileSiteCookies(settings, domain) {
  await browserSessionManager.close()
  const executablePath = await resolveBrowserExecutable(settings)
  const userDataDir = resolveAuraProfilePath(settings)
  await fs.mkdir(userDataDir, { recursive: true })

  const context = await chromium.launchPersistentContext(
    userDataDir,
    browserContextOptions(settings, executablePath, true),
  )

  try {
    const cookies = await context.cookies()
    const remaining = cookies.filter(cookie => !cookieDomainMatches(cookie.domain, domain))
    const removedCount = cookies.length - remaining.length

    await context.clearCookies()
    if (remaining.length > 0) {
      await context.addCookies(remaining)
    }

    return {
      removedCount,
      remainingCount: remaining.length,
    }
  } finally {
    await context.close().catch(() => {})
  }
}

export async function clearAuraProfileAllCookies(settings) {
  await browserSessionManager.close()
  const executablePath = await resolveBrowserExecutable(settings)
  const userDataDir = resolveAuraProfilePath(settings)
  await fs.mkdir(userDataDir, { recursive: true })

  const context = await chromium.launchPersistentContext(
    userDataDir,
    browserContextOptions(settings, executablePath, true),
  )

  try {
    const cookies = await context.cookies()
    await context.clearCookies()
    return {
      removedCount: cookies.length,
    }
  } finally {
    await context.close().catch(() => {})
  }
}

class BrowserSessionManager {
  constructor() {
    this.sessions = new Map()
    this.activeSessionId = DEFAULT_BROWSER_SESSION_ID
    this.globalClosingPromise = null
  }

  getRequestedSessionId(sessionId) {
    return resolveBrowserSessionId(sessionId || this.activeSessionId || DEFAULT_BROWSER_SESSION_ID)
  }

  getSessionState(sessionId) {
    return this.sessions.get(this.getRequestedSessionId(sessionId)) || null
  }

  getSessionStateByPage(page) {
    for (const state of this.sessions.values()) {
      if (state.page === page) {
        return state
      }
      if (state.context?.pages().includes(page)) {
        return state
      }
    }
    return this.getSessionState(this.activeSessionId)
  }

  createSessionState(sessionId, label = '') {
    return {
      id: sessionId,
      label: label || undefined,
      context: null,
      page: null,
      executablePath: '',
      userDataDir: '',
      headless: true,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      consoleBuffer: [],
      networkBuffer: [],
      observedPages: new WeakSet(),
      trace: {
        active: false,
        startedAt: 0,
      },
      video: {
        enabled: false,
        startedAt: 0,
        recordDir: '',
        activeRecordDir: '',
      },
      closingPromise: null,
    }
  }

  attachSessionPageListeners(state, page) {
    if (!page || state.observedPages.has(page)) {
      return
    }

    state.observedPages.add(page)
    page.on('console', message => {
      pushRingBuffer(state.consoleBuffer, {
        type: message.type(),
        text: truncate(message.text(), 1_200),
        location: message.location(),
        url: page.url(),
        createdAt: Date.now(),
      })
    })
    page.on('pageerror', error => {
      pushRingBuffer(state.consoleBuffer, {
        type: 'pageerror',
        text: truncate(error instanceof Error ? error.message : String(error), 1_200),
        url: page.url(),
        createdAt: Date.now(),
      })
    })
  }

  attachContextListeners(state) {
    if (!state.context) {
      return
    }

    const handlePage = nextPage => {
      this.attachSessionPageListeners(state, nextPage)
      state.page = nextPage
      state.lastUsedAt = Date.now()
    }

    for (const existingPage of state.context.pages()) {
      this.attachSessionPageListeners(state, existingPage)
    }

    state.context.on('page', handlePage)
    state.context.on('response', response => {
      pushRingBuffer(state.networkBuffer, {
        kind: 'response',
        url: response.url(),
        status: response.status(),
        ok: response.ok(),
        method: response.request().method(),
        resourceType: response.request().resourceType(),
        createdAt: Date.now(),
      })
    })
    state.context.on('requestfailed', request => {
      pushRingBuffer(state.networkBuffer, {
        kind: 'requestfailed',
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        failureText: request.failure()?.errorText || 'Request failed',
        createdAt: Date.now(),
      })
    })
  }

  async ensureSession(settings, options = {}) {
    const executablePath = await resolveBrowserExecutable(settings)
    const sessionId = this.getRequestedSessionId(options.sessionId)
    const label = typeof options.label === 'string' ? options.label.trim() : ''
    let state = this.sessions.get(sessionId)

    if (!state) {
      if (options.createIfMissing === false) {
        throw createStructuredError(`浏览器 session "${sessionId}" 不存在。`, {
          source: 'tool',
          category: 'not_found',
          code: 'BROWSER_SESSION_NOT_FOUND',
          suggestedAction: '请先创建这个 session，或省略 sessionId 使用当前默认 session。',
        })
      }
      state = this.createSessionState(sessionId, label)
      this.sessions.set(sessionId, state)
    } else if (label) {
      state.label = label
    }

    const userDataDir = resolveSessionProfilePath(settings, sessionId)
    const headless = options.visible ? false : settings.browser?.headlessByDefault !== false
    const shouldRestart =
      !state.context ||
      state.executablePath !== executablePath ||
      state.userDataDir !== userDataDir ||
      state.headless !== headless ||
      state.video.activeRecordDir !== (state.video.enabled ? state.video.recordDir : '')

    if (shouldRestart) {
      const hadContext = Boolean(state.context)
      const previousUrl =
        state.page && !state.page.isClosed() && state.page.url() !== 'about:blank'
          ? state.page.url()
          : ''

      await this.closeSession(sessionId)
      this.sessions.set(sessionId, state)
      await fs.mkdir(userDataDir, { recursive: true })
      state.context = await launchPersistentContextWithRetry(
        settings,
        executablePath,
        userDataDir,
        headless,
        {
          retryOnProfileLock: hadContext,
          launchOptions: {
            recordVideoDir: state.video.enabled ? state.video.recordDir : '',
          },
        },
      )
      state.executablePath = executablePath
      state.userDataDir = userDataDir
      state.headless = headless
      state.observedPages = new WeakSet()
      state.consoleBuffer = []
      state.networkBuffer = []
      state.video.activeRecordDir = state.video.enabled ? state.video.recordDir : ''
      this.attachContextListeners(state)
      state.page = state.context.pages().at(-1) || (await state.context.newPage())
      if (state.trace.active) {
        await state.context.tracing
          .start({
            screenshots: true,
            snapshots: true,
            sources: true,
          })
          .catch(() => {})
      }

      if (previousUrl) {
        await state.page.goto(previousUrl, { waitUntil: DEFAULT_WAIT_UNTIL }).catch(() => {})
      }
    }

    await applyPendingCookieImports(state.context)

    if (!state.page || state.page.isClosed()) {
      const openPages = state.context?.pages().filter(entry => !entry.isClosed()) || []
      state.page = openPages.at(-1) || (await state.context.newPage())
    }

    state.lastUsedAt = Date.now()
    this.activeSessionId = sessionId
    return state.page
  }

  async buildSessionDescriptor(state) {
    const pageCount = state.context?.pages().filter(entry => !entry.isClosed()).length || 0
    return {
      id: state.id,
      label: state.label,
      active: state.id === this.activeSessionId,
      visible: state.headless === false,
      headless: state.headless !== false,
      profilePath: state.userDataDir || undefined,
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt,
      pageCount,
      traceActive: state.trace.active,
      videoActive: state.video.enabled,
      activePageUrl:
        state.page && !state.page.isClosed() ? state.page.url() : undefined,
      activePageTitle:
        state.page && !state.page.isClosed() ? await state.page.title().catch(() => '') : undefined,
    }
  }

  async listSessions() {
    const descriptors = []
    for (const state of this.sessions.values()) {
      descriptors.push(await this.buildSessionDescriptor(state))
    }
    return descriptors.sort((left, right) => Number(right.active) - Number(left.active) || left.createdAt - right.createdAt)
  }

  async setActiveSession(sessionId, settings, options = {}) {
    const targetId = this.getRequestedSessionId(sessionId)
    const state = this.sessions.get(targetId)
    if (!state) {
      if (options.createIfMissing === false) {
        throw createStructuredError(`浏览器 session "${targetId}" 不存在。`, {
          source: 'tool',
          category: 'not_found',
          code: 'BROWSER_SESSION_NOT_FOUND',
        })
      }
      await this.ensureSession(settings, {
        sessionId: targetId,
        label: options.label,
        visible: options.visible,
        createIfMissing: true,
      })
      this.activeSessionId = targetId
      return
    }

    if (typeof options.label === 'string' && options.label.trim()) {
      state.label = options.label.trim()
    }

    if (typeof options.visible === 'boolean' && state.headless === options.visible) {
      await this.ensureSession(settings, {
        sessionId: targetId,
        label: options.label || state.label,
        visible: options.visible,
      })
    } else {
      this.activeSessionId = targetId
      state.lastUsedAt = Date.now()
    }
  }

  async closeSession(sessionId) {
    const targetId = this.getRequestedSessionId(sessionId)
    const state = this.sessions.get(targetId)
    if (!state) {
      return false
    }

    if (state.closingPromise) {
      await state.closingPromise
      return true
    }

    state.closingPromise = (async () => {
      if (state.context) {
        await state.context.close().catch(() => {})
      }
      state.context = null
      state.page = null
      state.executablePath = ''
      state.userDataDir = ''
      state.video.activeRecordDir = ''
    })()

    try {
      await state.closingPromise
    } finally {
      state.closingPromise = null
      this.sessions.delete(targetId)
      if (this.activeSessionId === targetId) {
        this.activeSessionId =
          this.sessions.keys().next().value || DEFAULT_BROWSER_SESSION_ID
      }
    }

    return true
  }

  async closeHeadlessSessions() {
    const headlessSessionIds = Array.from(this.sessions.values())
      .filter(state => state.headless !== false)
      .map(state => state.id)

    for (const sessionId of headlessSessionIds) {
      await this.closeSession(sessionId)
    }

    return headlessSessionIds.length
  }

  async close() {
    if (this.globalClosingPromise) {
      await this.globalClosingPromise
      return
    }

    this.globalClosingPromise = (async () => {
      const sessionIds = Array.from(this.sessions.keys())
      for (const sessionId of sessionIds) {
        await this.closeSession(sessionId)
      }
    })()

    try {
      await this.globalClosingPromise
    } finally {
      this.globalClosingPromise = null
    }
  }

  getDebugEntries(sessionId, kind, limit = 50) {
    const state = this.getSessionState(sessionId)
    if (!state) {
      return []
    }

    const entries = kind === 'network' ? state.networkBuffer : state.consoleBuffer
    return entries.slice(-Math.max(1, Math.min(200, limit)))
  }

  async enableVideoForSession(sessionId, settings, recordDir) {
    const targetId = this.getRequestedSessionId(sessionId)
    const state = this.sessions.get(targetId) || this.createSessionState(targetId)
    if (!this.sessions.has(targetId)) {
      this.sessions.set(targetId, state)
    }
    state.video.enabled = true
    state.video.recordDir = recordDir
    state.video.startedAt = Date.now()
    const wasVisible = state.headless === false
    return this.ensureSession(settings, {
      sessionId: targetId,
      label: state.label,
      visible: wasVisible,
      createIfMissing: true,
    })
  }
}

const browserSessionManager = new BrowserSessionManager()

export async function closeHeadlessBrowserSession() {
  const closedCount = await browserSessionManager.closeHeadlessSessions()
  if (closedCount === 0) {
    return false
  }
  return true
}

process.once('beforeExit', () => {
  return browserSessionManager.close()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void browserSessionManager.close().finally(() => {
      process.exit(0)
    })
  })
}

export function buildBrowserTools({ settings, context }) {
  if (!settings.browser?.enabled) {
    return []
  }

  async function ensureBrowserPage(args = {}, extra = {}) {
    return browserSessionManager.ensureSession(settings, buildSessionOptions(args, extra))
  }

  return [
    {
      source: 'builtin',
      name: 'browser_open',
      description: 'Open a URL in the Aura browser runtime without taking over the frontmost Chrome window.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true, includeVisible: true }),
          url: { type: 'string', description: 'Target URL.' },
          waitUntil: {
            type: 'string',
            description: 'Optional wait strategy: load, domcontentloaded, or networkidle.',
          },
          newPage: { type: 'boolean', description: 'Open in a new page before navigation.' },
          blockerReason: { type: 'string', description: 'Optional user-facing reason for why takeover may be needed.' },
        },
        required: ['url'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args, {
          visible: args.visible === true,
        })
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const targetPage =
          args.newPage && sessionState?.context ? await sessionState.context.newPage() : page
        if (sessionState) {
          sessionState.page = targetPage
        }
        await targetPage.goto(args.url, {
          waitUntil: normalizeWaitUntil(args.waitUntil),
        })
        return stringifyOutput(
          await buildBrowserResult(targetPage, settings, {
            blockerReason: typeof args.blockerReason === 'string' ? args.blockerReason : undefined,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_search',
      description: 'Search the web with the Aura browser runtime using the configured search engine.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true, includeVisible: true }),
          query: { type: 'string', description: 'Search query.' },
        },
        required: ['query'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const targetUrl = buildSearchUrl(settings, args.query)
        const page = await ensureBrowserPage(args, {
          visible: args.visible === true,
        })
        await page.goto(targetUrl, { waitUntil: DEFAULT_WAIT_UNTIL })
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            searchUrl: targetUrl,
            query: args.query,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_get_page',
      description: 'Read the current Aura browser page as text, HTML, or structured snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          format: { type: 'string', description: 'text, html, or snapshot. Defaults to text.' },
          maxLength: { type: 'number', description: 'Optional max output length.' },
          depth: { type: 'number', description: 'Snapshot depth when format=snapshot.' },
          selector: { type: 'string', description: 'Optional selector root when format=snapshot.' },
          interactiveOnly: {
            type: 'boolean',
            description: 'Only include interactive elements when format=snapshot. Defaults to true.',
          },
          maxRefs: { type: 'number', description: 'Maximum refs returned when format=snapshot.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const format =
          args.format === 'html' ? 'html' : args.format === 'snapshot' ? 'snapshot' : 'text'
        const content = await serializePageContent(
          page,
          format,
          normalizeTimeout(args.maxLength, 12_000),
          {
            source: 'browser_get_page',
            sessionId: sessionState?.id,
            depth: args.depth,
            selector: args.selector,
            interactiveOnly: args.interactiveOnly,
            maxRefs: args.maxRefs,
          },
        )
        const result = await buildBrowserResult(page, settings, {
          contentFormat: format,
          ...(format === 'snapshot'
            ? { snapshot: content }
            : { content, format }),
        })
        return stringifyOutput(result)
      },
    },
    {
      source: 'builtin',
      name: 'browser_snapshot',
      description: 'Capture a structured snapshot of the current Aura browser page and return stable refs.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          depth: { type: 'number', description: 'How deep to traverse the DOM tree. Defaults to 3.' },
          selector: { type: 'string', description: 'Optional selector root for a focused snapshot.' },
          interactiveOnly: {
            type: 'boolean',
            description: 'Only include interactive elements. Defaults to true.',
          },
          maxRefs: { type: 'number', description: 'Maximum refs to include. Defaults to 40.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const snapshot = await serializePageSnapshot(page, {
          source: 'browser_snapshot',
          sessionId: sessionState?.id,
          depth: args.depth,
          selector: args.selector,
          interactiveOnly: args.interactiveOnly,
          maxRefs: args.maxRefs,
        })
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            contentFormat: 'snapshot',
            snapshot,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_run_javascript',
      description: 'Execute JavaScript in the current Aura browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          script: { type: 'string', description: 'JavaScript source to evaluate.' },
        },
        required: ['script'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const result = await safeEvaluate(page, args.script)
        return stringifyOutput({
          ...(await buildBrowserResult(page, settings)),
          result: truncate(result, 12_000),
        })
      },
    },
    {
      source: 'builtin',
      name: 'browser_screenshot',
      description: 'Capture a screenshot from the current Aura browser page into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          relativePath: {
            type: 'string',
            description: 'Optional relative output path inside the workspace.',
          },
          fullPage: {
            type: 'boolean',
            description: 'Capture the full page instead of just the viewport.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const relativePath = args.relativePath || `.aura/browser/screenshot-${Date.now()}.png`
        const targetPath = resolveWorkspacePath(context.cwd, relativePath)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await page.screenshot({
          path: targetPath,
          fullPage: args.fullPage !== false,
        })
        return stringifyOutput({
          ...(await buildBrowserResult(page, settings)),
          savedTo: targetPath,
          artifacts: [
            buildBrowserDebugArtifact('screenshot', sessionState, {
              savedTo: targetPath,
              summary: path.basename(targetPath),
            }),
          ],
        })
      },
    },
    {
      source: 'builtin',
      name: 'browser_click',
      description: 'Click an element in the current Aura browser page by ref or CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          ref: { type: 'string', description: 'Stable element ref returned by browser_snapshot.' },
          selector: { type: 'string', description: 'Fallback CSS selector to click.' },
          timeoutMs: { type: 'number', description: 'Optional click timeout in milliseconds.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const before = await capturePageObservation(page)
        const { target, locator } = await resolveBrowserTarget(page, args)
        await locator.click({
          timeout: normalizeTimeout(args.timeoutMs),
        })
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            clicked: target,
            receipt: await buildActionReceipt(page, 'click', target, before),
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_type',
      description: 'Fill a text field in the current Aura browser page by ref or CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          ref: { type: 'string', description: 'Stable element ref returned by browser_snapshot.' },
          selector: { type: 'string', description: 'Fallback CSS selector to fill.' },
          text: { type: 'string', description: 'Text to enter.' },
          submit: { type: 'boolean', description: 'Press Enter after filling.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        },
        required: ['text'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const before = await capturePageObservation(page)
        const { target, locator } = await resolveBrowserTarget(page, args)
        await locator.fill(args.text, {
          timeout: normalizeTimeout(args.timeoutMs),
        })
        if (args.submit) {
          await locator.press('Enter')
        }
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            filled: target,
            textLength: args.text.length,
            receipt: await buildActionReceipt(page, 'type', target, before),
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_wait_for',
      description: 'Wait for a ref, selector, or piece of text on the current Aura browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          ref: { type: 'string', description: 'Stable element ref returned by browser_snapshot.' },
          selector: { type: 'string', description: 'Optional CSS selector to wait for.' },
          text: { type: 'string', description: 'Optional text to wait for in document.body.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        if (!args.ref && !args.selector && !args.text) {
          throw createStructuredError('browser_wait_for 需要至少提供 ref、selector 或 text。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'BROWSER_WAIT_FOR_INVALID_INPUT',
          })
        }
        const page = await ensureBrowserPage(args)
        const timeout = normalizeTimeout(args.timeoutMs)
        const target = buildBrowserTarget(args)

        if (target) {
          const { locator } = await resolveBrowserTarget(page, args)
          await locator.waitFor({
            state: 'visible',
            timeout,
          })
        }

        if (args.text) {
          await page.waitForFunction(
            needle => document.body?.innerText?.includes(needle),
            args.text,
            { timeout },
          )
        }

        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            waitedFor: target || args.text,
            receipt: {
              action: 'wait',
              target: target || { kind: 'text', value: args.text },
              success: true,
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_inspect_element',
      description: 'Inspect an element by ref or CSS selector and return its structure and visibility details.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          ref: { type: 'string', description: 'Stable element ref returned by browser_snapshot.' },
          selector: { type: 'string', description: 'Fallback CSS selector to inspect.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const { target, locator } = await resolveBrowserTarget(page, args)
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            inspectedElement: await inspectBrowserElement(locator),
            target,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_list_sessions',
      description: 'List active Aura browser sessions and their current pages.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async run(_args, runtime = {}) {
        runtime.throwIfAborted?.()
        return stringifyOutput({
          activeSessionId: browserSessionManager.activeSessionId,
          sessions: await browserSessionManager.listSessions(),
        })
      },
    },
    {
      source: 'builtin',
      name: 'browser_set_active_session',
      description: 'Switch the active Aura browser session, optionally creating it.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true, includeVisible: true }),
        },
        required: ['sessionId'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        await browserSessionManager.setActiveSession(args.sessionId, settings, {
          createIfMissing: args.createIfMissing !== false,
          label: args.label,
          visible: typeof args.visible === 'boolean' ? args.visible : undefined,
        })
        return stringifyOutput({
          activeSessionId: browserSessionManager.activeSessionId,
          sessions: await browserSessionManager.listSessions(),
        })
      },
    },
    {
      source: 'builtin',
      name: 'browser_close_session',
      description: 'Close an Aura browser session without affecting the others.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Browser session id to close.',
          },
        },
        required: ['sessionId'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const sessionId = resolveBrowserSessionId(args.sessionId)
        const closed = await browserSessionManager.closeSession(sessionId)
        return stringifyOutput({
          closed,
          closedSessionId: sessionId,
          activeSessionId: browserSessionManager.activeSessionId,
          sessions: await browserSessionManager.listSessions(),
        })
      },
    },
    {
      source: 'builtin',
      name: 'browser_storage_list',
      description: 'List the current page origin storage summary and cookie domains for a browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const currentOriginStorage = await readCurrentOriginStorage(page)
        const cookies = sessionState?.context
          ? await sessionState.context.cookies().catch(() => [])
          : []
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            storage: {
              origin: currentOriginStorage.origin,
              cookieCount: cookies.length,
              cookieDomains: Array.from(
                new Set(cookies.map(cookie => cookie.domain).filter(Boolean)),
              ).slice(0, 100),
              localStorageKeys: Object.keys(currentOriginStorage.localStorage || {}),
              sessionStorageKeys: Object.keys(currentOriginStorage.sessionStorage || {}),
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_storage_get',
      description: 'Read cookies, localStorage, or sessionStorage from the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          area: {
            type: 'string',
            description: 'cookies, localStorage, or sessionStorage. Defaults to cookies.',
          },
          origin: {
            type: 'string',
            description: 'Optional origin. localStorage/sessionStorage currently only support the current page origin.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const area = normalizeStorageArea(args.area)

        if (area === 'cookies') {
          const targetOrigin =
            typeof args.origin === 'string' && args.origin.trim() ? args.origin.trim() : page.url()
          const cookies = sessionState?.context
            ? await sessionState.context.cookies([targetOrigin]).catch(() => [])
            : []
          return stringifyOutput(
            await buildBrowserResult(page, settings, {
              storage: {
                area,
                origin: targetOrigin,
                items: cookies,
              },
            }),
          )
        }

        const currentOriginStorage = await readCurrentOriginStorage(page)
        if (args.origin && args.origin !== currentOriginStorage.origin) {
          throw createStructuredError('当前 localStorage/sessionStorage 只支持读取当前页面 origin。', {
            source: 'tool',
            category: 'unsupported',
            code: 'BROWSER_STORAGE_ORIGIN_NOT_ACTIVE',
            suggestedAction: '请先打开目标 origin 页面，再读取对应的 localStorage 或 sessionStorage。',
          })
        }

        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            storage: {
              area,
              origin: currentOriginStorage.origin,
              items: currentOriginStorage[area] || {},
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_storage_set',
      description: 'Write cookies, localStorage, or sessionStorage into the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          area: {
            type: 'string',
            description: 'cookies, localStorage, or sessionStorage.',
          },
          origin: {
            type: 'string',
            description: 'Optional origin for storage writes. localStorage/sessionStorage require the current page origin.',
          },
          key: {
            type: 'string',
            description: 'Single storage key for localStorage/sessionStorage.',
          },
          value: {
            type: ['string', 'number', 'boolean'],
            description: 'Single storage value for localStorage/sessionStorage.',
          },
          items: {
            type: 'object',
            description: 'Multiple key/value pairs for localStorage/sessionStorage.',
          },
          cookie: {
            type: 'object',
            description: 'Single cookie object for cookies area.',
          },
          cookies: {
            type: 'array',
            description: 'Multiple cookie objects for cookies area.',
          },
        },
        required: ['area'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const area = normalizeStorageArea(args.area)

        if (area === 'cookies') {
          const cookies = [
            ...(Array.isArray(args.cookies) ? args.cookies : []),
            ...(args.cookie && typeof args.cookie === 'object' ? [args.cookie] : []),
          ].filter(Boolean)

          if (cookies.length === 0) {
            throw createStructuredError('写入 cookies 时需要提供 cookie 或 cookies。', {
              source: 'tool',
              category: 'invalid_input',
              code: 'BROWSER_STORAGE_SET_COOKIES_REQUIRED',
            })
          }

          await sessionState?.context?.addCookies(cookies)
          return stringifyOutput(
            await buildBrowserResult(page, settings, {
              storage: {
                area,
                writtenCount: cookies.length,
              },
            }),
          )
        }

        const currentOriginStorage = await readCurrentOriginStorage(page)
        const targetOrigin = normalizeStorageOrigin(args.origin)
        if (targetOrigin && targetOrigin !== currentOriginStorage.origin) {
          throw createStructuredError('当前 localStorage/sessionStorage 只支持写入当前页面 origin。', {
            source: 'tool',
            category: 'unsupported',
            code: 'BROWSER_STORAGE_SET_ORIGIN_NOT_ACTIVE',
            suggestedAction: '请先打开目标 origin 页面，再写入对应的 localStorage 或 sessionStorage。',
          })
        }

        const items =
          normalizeStorageItems(args.items) ||
          (typeof args.key === 'string'
            ? { [args.key]: args.value == null ? '' : String(args.value) }
            : null)
        if (!items || Object.keys(items).length === 0) {
          throw createStructuredError('写入 localStorage/sessionStorage 时需要提供 key/value 或 items。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'BROWSER_STORAGE_SET_ITEMS_REQUIRED',
          })
        }

        await applyStorageItems(page, area, items)
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            storage: {
              area,
              origin: currentOriginStorage.origin,
              writtenKeys: Object.keys(items),
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_storage_clear',
      description: 'Clear cookies, localStorage, or sessionStorage in the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          area: {
            type: 'string',
            description: 'cookies, localStorage, or sessionStorage.',
          },
          key: {
            type: 'string',
            description: 'Optional single key to remove from localStorage/sessionStorage.',
          },
          cookieName: {
            type: 'string',
            description: 'Optional cookie name to remove from the current origin.',
          },
          origin: {
            type: 'string',
            description: 'Optional origin for targeted cookie cleanup.',
          },
        },
        required: ['area'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const area = normalizeStorageArea(args.area)

        if (area === 'cookies') {
          const targetOrigin = normalizeStorageOrigin(args.origin) || page.url()
          const allCookies = sessionState?.context
            ? await sessionState.context.cookies().catch(() => [])
            : []
          const targetName = typeof args.cookieName === 'string' ? args.cookieName.trim() : ''
          const targetHost = (() => {
            try {
              return new URL(targetOrigin).hostname
            } catch {
              return ''
            }
          })()

          const preservedCookies = allCookies.filter(cookie => {
            const sameDomain =
              !targetHost || cookieDomainMatches(cookie.domain, targetHost)
            if (!sameDomain) {
              return true
            }
            if (!targetName) {
              return false
            }
            return cookie.name !== targetName
          })

          await sessionState?.context?.clearCookies()

          if (preservedCookies.length > 0) {
            await sessionState?.context?.addCookies(preservedCookies)
          }

          return stringifyOutput(
            await buildBrowserResult(page, settings, {
              storage: {
                area,
                cleared: targetName ? [targetName] : 'all',
              },
            }),
          )
        }

        await clearStorageArea(page, area, typeof args.key === 'string' ? args.key : '')
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            storage: {
              area,
              cleared: typeof args.key === 'string' && args.key ? [args.key] : 'all',
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_storage_export_state',
      description: 'Export the current browser session storage state into a workspace JSON file.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          relativePath: {
            type: 'string',
            description: 'Optional relative output path inside the workspace.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const relativePath = args.relativePath || `.aura/browser/storage-state-${Date.now()}.json`
        const targetPath = resolveBrowserArtifactPath(context, relativePath)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(
          targetPath,
          JSON.stringify(await exportBrowserStorageState(page, sessionState), null, 2),
          'utf8',
        )
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            savedTo: targetPath,
            storageStateExported: true,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_storage_import_state',
      description: 'Import a browser storage state JSON file from the workspace into the current session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          relativePath: {
            type: 'string',
            description: 'Relative path to the exported storage state JSON file.',
          },
        },
        required: ['relativePath'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const targetPath = resolveBrowserArtifactPath(context, args.relativePath)
        const previousUrl = page.url()
        const payload = JSON.parse(await fs.readFile(targetPath, 'utf8'))
        const imported = await importBrowserStorageState(page, sessionState, payload)
        if (previousUrl && previousUrl !== 'about:blank') {
          await page.goto(previousUrl, { waitUntil: DEFAULT_WAIT_UNTIL }).catch(() => {})
        }
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            importedFrom: targetPath,
            storage: imported,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_console_get',
      description: 'Read recent console and pageerror events from the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          limit: { type: 'number', description: 'Maximum number of entries to return. Defaults to 50.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const entries = browserSessionManager.getDebugEntries(sessionState?.id, 'console', args.limit || 50)
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            console: entries,
            artifacts: [
              buildBrowserDebugArtifact('console', sessionState, {
                summary: `${entries.length} console entries`,
              }),
            ],
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_network_get',
      description: 'Read recent network responses and failed requests from the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          limit: { type: 'number', description: 'Maximum number of entries to return. Defaults to 50.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        const entries = browserSessionManager.getDebugEntries(sessionState?.id, 'network', args.limit || 50)
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            network: entries,
            artifacts: [
              buildBrowserDebugArtifact('network', sessionState, {
                summary: `${entries.length} network entries`,
              }),
            ],
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_trace_start',
      description: 'Start Playwright trace capture for the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        if (!sessionState?.context) {
          throw createStructuredError('当前没有可用的浏览器 session 可以开始 trace。', {
            source: 'tool',
            category: 'unavailable',
            code: 'BROWSER_TRACE_SESSION_UNAVAILABLE',
          })
        }
        if (!sessionState.trace.active) {
          await sessionState.context.tracing.start({
            screenshots: true,
            snapshots: true,
            sources: true,
          })
          sessionState.trace.active = true
          sessionState.trace.startedAt = Date.now()
        }
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            trace: {
              active: true,
              startedAt: sessionState.trace.startedAt,
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_trace_stop',
      description: 'Stop Playwright trace capture and save the trace zip into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties(),
          relativePath: {
            type: 'string',
            description: 'Optional relative output path for the trace zip.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        if (!sessionState?.context || !sessionState.trace.active) {
          throw createStructuredError('当前 session 没有正在进行的 trace。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'BROWSER_TRACE_NOT_ACTIVE',
          })
        }
        const relativePath = args.relativePath || `.aura/browser/trace-${Date.now()}.zip`
        const targetPath = resolveBrowserArtifactPath(context, relativePath)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await sessionState.context.tracing.stop({ path: targetPath })
        sessionState.trace.active = false
        sessionState.trace.startedAt = 0
        const artifact = buildBrowserDebugArtifact('trace', sessionState, {
          savedTo: targetPath,
          summary: path.basename(targetPath),
        })
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            trace: {
              active: false,
              savedTo: targetPath,
            },
            artifacts: [artifact],
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_video_start',
      description: 'Start page video recording for the current Aura browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true }),
          relativeDir: {
            type: 'string',
            description: 'Optional relative output directory for video files.',
          },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const sessionId = resolveBrowserSessionId(args.sessionId)
        const relativeDir = args.relativeDir || '.aura/browser/videos'
        const targetDir = resolveBrowserArtifactDir(context, relativeDir)
        await fs.mkdir(targetDir, { recursive: true })
        const page = await browserSessionManager.enableVideoForSession(
          sessionId,
          settings,
          targetDir,
        )
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            video: {
              active: true,
              recordDir: targetDir,
              startedAt: sessionState?.video.startedAt,
            },
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_video_stop',
      description: 'Stop page video recording and save the resulting files into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true }),
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args)
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        if (!sessionState?.context || !sessionState.video.enabled) {
          throw createStructuredError('当前 session 没有正在进行的视频录制。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'BROWSER_VIDEO_NOT_ACTIVE',
          })
        }

        const previousUrl = page.url()
        const previousTitle = await page.title().catch(() => '')
        const wasVisible = sessionState.headless === false
        const videoHandles = sessionState.context
          .pages()
          .map(entry => entry.video())
          .filter(Boolean)

        await sessionState.context.close().catch(() => {})
        const savedTo = []
        for (const handle of videoHandles) {
          const videoPath = await handle.path().catch(() => '')
          if (videoPath) {
            savedTo.push(videoPath)
          }
        }

        sessionState.context = null
        sessionState.page = null
        sessionState.executablePath = ''
        sessionState.userDataDir = ''
        sessionState.video.enabled = false
        sessionState.video.startedAt = 0
        sessionState.video.activeRecordDir = ''

        const relaunchedPage = await browserSessionManager.ensureSession(settings, {
          sessionId: sessionState.id,
          label: sessionState.label,
          visible: wasVisible,
          createIfMissing: true,
        })
        if (previousUrl && previousUrl !== 'about:blank') {
          await relaunchedPage.goto(previousUrl, { waitUntil: DEFAULT_WAIT_UNTIL }).catch(() => {})
        }

        const artifacts = savedTo.map(targetPath =>
          buildBrowserDebugArtifact('video', sessionState, {
            savedTo: targetPath,
            summary: path.basename(targetPath),
          }),
        )
        return stringifyOutput(
          await buildBrowserResult(relaunchedPage, settings, {
            video: {
              active: false,
              previousTitle,
              files: savedTo,
            },
            artifacts,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_takeover_visible',
      description: 'Relaunch the Aura browser in a visible window using the same Aura profile.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true }),
          url: { type: 'string', description: 'Optional URL to open after switching to visible mode.' },
          blockerReason: { type: 'string', description: 'Optional blocker reason shown in the tool output.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args, { visible: true })
        if (args.url) {
          await page.goto(args.url, { waitUntil: DEFAULT_WAIT_UNTIL })
        }
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            mode: 'visible',
            blockerReason: typeof args.blockerReason === 'string' ? args.blockerReason : undefined,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_resume_after_takeover',
      description: 'Return the Aura browser runtime to the default headless/visible mode from settings.',
      inputSchema: {
        type: 'object',
        properties: {
          ...buildSessionInputProperties({ includeLabel: true }),
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await ensureBrowserPage(args, { visible: false })
        const sessionState = browserSessionManager.getSessionStateByPage(page)
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            mode: sessionState?.headless === false ? 'visible' : 'headless',
          }),
        )
      },
    },
  ]
}
