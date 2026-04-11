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
        return stringifyOutput(await buildPageSnapshot(targetPage, { headless: browserSessionManager.headless }))
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
          await buildPageSnapshot(page, {
            searchUrl: targetUrl,
            query: args.query,
            headless: browserSessionManager.headless,
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
        const snapshot = await buildPageSnapshot(page, {
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
          ...(await buildPageSnapshot(page)),
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
          ...(await buildPageSnapshot(page)),
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
        return stringifyOutput(await buildPageSnapshot(page, { clicked: args.selector }))
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
          await buildPageSnapshot(page, {
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
          await buildPageSnapshot(page, {
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
        },
      },
      async run(args, runtime = {}) {
        runtime.throwIfAborted?.()
        const page = await browserSessionManager.ensureSession(settings, { visible: true })
        if (args.url) {
          await page.goto(args.url, { waitUntil: DEFAULT_WAIT_UNTIL })
        }
        return stringifyOutput(
          await buildPageSnapshot(page, {
            headless: false,
            mode: 'visible',
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
          await buildPageSnapshot(page, {
            headless: browserSessionManager.headless,
            mode: browserSessionManager.headless ? 'headless' : 'visible',
          }),
        )
      },
    },
  ]
}
