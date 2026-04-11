import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createStructuredError } from './runtimeErrors.mjs'
import { resolveWorkspacePath, stringifyOutput, truncate } from './utils.mjs'

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const DEFAULT_WAIT_UNTIL = 'domcontentloaded'

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
      suggestedAction: '请先在设置页的“浏览器”页签中启用 Aura 浏览器运行时。',
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
      suggestedAction:
        '请前往设置 > 浏览器，重新检测环境，或切换到系统 Chrome / 自定义浏览器可执行文件。',
    })
  }

  return executablePath
}

function normalizeWaitUntil(value) {
  return value === 'load' || value === 'domcontentloaded' || value === 'networkidle'
    ? value
    : DEFAULT_WAIT_UNTIL
}

function browserContextOptions(settings, executablePath, headless) {
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
    args: ['--no-default-browser-check', '--disable-dev-shm-usage'],
  }
}

async function buildPageSnapshot(page, meta = {}) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  return {
    url,
    title,
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

async function buildBrowserResult(page, settings, meta = {}) {
  const blocker = await detectBrowserBlocker(page)
  let takeoverTriggered = false
  let resultPage = page

  if (blocker.detected && settings.browser?.takeoverMode === 'auto-visible-on-blocker') {
    resultPage = await browserSessionManager.ensureSession(settings, { visible: true })
    takeoverTriggered = true
  }

  return buildPageSnapshot(resultPage, {
    blocker,
    takeoverTriggered,
    headless: browserSessionManager.headless,
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

async function serializePageContent(page, format, maxLength) {
  if (format === 'html') {
    const html = await page.content()
    return truncate(html, maxLength)
  }

  const text = await page.evaluate(() => document.body?.innerText || '')
  return truncate(text, maxLength)
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

class BrowserSessionManager {
  constructor() {
    this.context = null
    this.page = null
    this.executablePath = ''
    this.userDataDir = ''
    this.headless = true
    this.closingPromise = null
  }

  async ensureSession(settings, options = {}) {
    const executablePath = await resolveBrowserExecutable(settings)
    const userDataDir = resolveAuraProfilePath(settings)
    const headless = options.visible ? false : settings.browser?.headlessByDefault !== false
    const shouldRestart =
      !this.context ||
      this.executablePath !== executablePath ||
      this.userDataDir !== userDataDir ||
      this.headless !== headless

    if (shouldRestart) {
      const previousUrl =
        this.page && !this.page.isClosed() && this.page.url() !== 'about:blank'
          ? this.page.url()
          : ''

      await this.close()
      await fs.mkdir(userDataDir, { recursive: true })
      try {
        this.context = await chromium.launchPersistentContext(
          userDataDir,
          browserContextOptions(settings, executablePath, headless),
        )
      } catch (error) {
        const detail = error instanceof Error ? error.stack || error.message : String(error)
        if (detail.includes('ProcessSingleton') || detail.includes('SingletonLock')) {
          throw createStructuredError('Aura 浏览器 Profile 当前正被另一个浏览器实例占用。', {
            source: 'tool',
            category: 'unavailable',
            code: 'BROWSER_PROFILE_LOCKED',
            detail,
            suggestedAction:
              '请先关闭正在使用同一 Aura Profile 的浏览器窗口，或等待当前浏览器任务结束后再试。',
          })
        }
        throw error
      }
      this.context.on('page', nextPage => {
        this.page = nextPage
      })
      this.executablePath = executablePath
      this.userDataDir = userDataDir
      this.headless = headless
      this.page = this.context.pages().at(-1) || (await this.context.newPage())

      if (previousUrl) {
        await this.page.goto(previousUrl, { waitUntil: DEFAULT_WAIT_UNTIL }).catch(() => {})
      }
    }

    await applyPendingCookieImports(this.context)

    if (!this.page || this.page.isClosed()) {
      const openPages = this.context?.pages().filter(entry => !entry.isClosed()) || []
      this.page = openPages.at(-1) || (await this.context.newPage())
    }

    return this.page
  }

  async close() {
    if (this.closingPromise) {
      await this.closingPromise
      return
    }

    this.closingPromise = (async () => {
      if (this.context) {
        await this.context.close().catch(() => {})
      }
      this.context = null
      this.page = null
      this.executablePath = ''
      this.userDataDir = ''
    })()

    try {
      await this.closingPromise
    } finally {
      this.closingPromise = null
    }
  }
}

const browserSessionManager = new BrowserSessionManager()

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

  return [
    {
      source: 'builtin',
      name: 'browser_open',
      description: 'Open a URL in the Aura browser runtime without taking over the frontmost Chrome window.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL.' },
          waitUntil: {
            type: 'string',
            description: 'Optional wait strategy: load, domcontentloaded, or networkidle.',
          },
          newPage: { type: 'boolean', description: 'Open in a new page before navigation.' },
          visible: { type: 'boolean', description: 'Launch or relaunch the Aura browser in a visible window.' },
          blockerReason: { type: 'string', description: 'Optional user-facing reason for why takeover may be needed.' },
        },
        required: ['url'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings, {
          visible: args.visible === true,
        })
        const targetPage = args.newPage && browserSessionManager.context
          ? await browserSessionManager.context.newPage()
          : page
        browserSessionManager.page = targetPage
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
          query: { type: 'string', description: 'Search query.' },
          visible: { type: 'boolean', description: 'Launch or relaunch the Aura browser in a visible window.' },
        },
        required: ['query'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const targetUrl = buildSearchUrl(settings, args.query)
        const page = await browserSessionManager.ensureSession(settings, {
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
      description: 'Read the current Aura browser page as text or HTML.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', description: 'text or html. Defaults to text.' },
          maxLength: { type: 'number', description: 'Optional max output length.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings)
        const content = await serializePageContent(
          page,
          args.format === 'html' ? 'html' : 'text',
          normalizeTimeout(args.maxLength, 12_000),
        )
        const snapshot = await buildBrowserResult(page, settings, {
          content,
          format: args.format === 'html' ? 'html' : 'text',
        })
        return stringifyOutput(snapshot)
      },
    },
    {
      source: 'builtin',
      name: 'browser_run_javascript',
      description: 'Execute JavaScript in the current Aura browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript source to evaluate.' },
        },
        required: ['script'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings)
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
        const page = await browserSessionManager.ensureSession(settings)
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
        })
      },
    },
    {
      source: 'builtin',
      name: 'browser_click',
      description: 'Click an element in the current Aura browser page by CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to click.' },
          timeoutMs: { type: 'number', description: 'Optional click timeout in milliseconds.' },
        },
        required: ['selector'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings)
        await page.locator(args.selector).click({
          timeout: normalizeTimeout(args.timeoutMs),
        })
        return stringifyOutput(await buildBrowserResult(page, settings, { clicked: args.selector }))
      },
    },
    {
      source: 'builtin',
      name: 'browser_type',
      description: 'Fill a text field in the current Aura browser page by CSS selector.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to fill.' },
          text: { type: 'string', description: 'Text to enter.' },
          submit: { type: 'boolean', description: 'Press Enter after filling.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        },
        required: ['selector', 'text'],
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings)
        const locator = page.locator(args.selector)
        await locator.fill(args.text, {
          timeout: normalizeTimeout(args.timeoutMs),
        })
        if (args.submit) {
          await locator.press('Enter')
        }
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            filled: args.selector,
            textLength: args.text.length,
          }),
        )
      },
    },
    {
      source: 'builtin',
      name: 'browser_wait_for',
      description: 'Wait for a selector or piece of text on the current Aura browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to wait for.' },
          text: { type: 'string', description: 'Optional text to wait for in document.body.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        if (!args.selector && !args.text) {
          throw createStructuredError('browser_wait_for 需要至少提供 selector 或 text。', {
            source: 'tool',
            category: 'invalid_input',
            code: 'BROWSER_WAIT_FOR_INVALID_INPUT',
          })
        }
        const page = await browserSessionManager.ensureSession(settings)
        const timeout = normalizeTimeout(args.timeoutMs)

        if (args.selector) {
          await page.locator(args.selector).waitFor({
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
            waitedFor: args.selector || args.text,
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
          url: { type: 'string', description: 'Optional URL to open after switching to visible mode.' },
          blockerReason: { type: 'string', description: 'Optional blocker reason shown in the tool output.' },
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings, { visible: true })
        if (args.url) {
          await page.goto(args.url, { waitUntil: DEFAULT_WAIT_UNTIL })
        }
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            headless: false,
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
        properties: {},
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings, { visible: false })
        return stringifyOutput(
          await buildBrowserResult(page, settings, {
            headless: browserSessionManager.headless,
            mode: browserSessionManager.headless ? 'headless' : 'visible',
          }),
        )
      },
    },
  ]
}
