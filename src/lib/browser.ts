import { invoke } from '@tauri-apps/api/core'
import type {
  AgentSettings,
  ChromeImportSource,
  ImportedChromeSite,
  BrowserRuntimeSource,
  BrowserRuntimeStatusRecord,
} from '../types'
import type { AuraHomeState } from './aura'

type DetectBrowserRuntimeArgs = {
  customExecutablePath?: string
  managedExecutablePath?: string
}

export async function detectBrowserRuntime(
  args: DetectBrowserRuntimeArgs = {},
): Promise<BrowserRuntimeStatusRecord> {
  return invoke<BrowserRuntimeStatusRecord>('detect_browser_runtime', {
    customExecutablePath: args.customExecutablePath,
    managedExecutablePath: args.managedExecutablePath,
  })
}

export async function installManagedBrowser(): Promise<BrowserRuntimeStatusRecord> {
  return invoke<BrowserRuntimeStatusRecord>('install_managed_browser')
}

export async function uninstallManagedBrowser(): Promise<BrowserRuntimeStatusRecord> {
  return invoke<BrowserRuntimeStatusRecord>('uninstall_managed_browser')
}

export async function discoverChromeImportSources(): Promise<ChromeImportSource[]> {
  return invoke<ChromeImportSource[]>('discover_chrome_import_sources')
}

export async function importChromeSiteCookies(args: {
  sourceProfilePath: string
  domain: string
}): Promise<Pick<ImportedChromeSite, 'domain' | 'cookieCount' | 'importedAt'>> {
  return invoke('import_chrome_site_cookies', {
    sourceProfilePath: args.sourceProfilePath,
    domain: args.domain,
  })
}

export async function clearAuraSiteCookies(args: {
  domain: string
  settings: AgentSettings['browser']
}): Promise<{ removedCount: number; pendingRemovedCount: number }> {
  return invoke('clear_aura_site_cookies', {
    domain: args.domain,
    browserSource: args.settings.source,
    executablePath: args.settings.executablePath,
    managedExecutablePath: args.settings.managedExecutablePath,
    auraProfilePath: args.settings.auraProfilePath,
  })
}

export function isBrowserRuntimeSourceAvailable(
  status: BrowserRuntimeStatusRecord | undefined,
  source: BrowserRuntimeSource,
) {
  if (!status) {
    return false
  }

  switch (source) {
    case 'system-chrome':
      return status.systemChromeDetected
    case 'managed-chrome':
      return status.managedChromeInstalled
    case 'custom-executable':
      return status.customExecutableValid === true
    default:
      return false
  }
}

export function getBrowserRuntimeSourceLabel(source: BrowserRuntimeSource) {
  switch (source) {
    case 'managed-chrome':
      return 'Aura 托管浏览器'
    case 'custom-executable':
      return '自定义浏览器'
    case 'system-chrome':
    default:
      return '系统 Chrome'
  }
}

export function resolveAuraBrowserProfilePath(
  auraHome: AuraHomeState | null,
  settings: AgentSettings['browser'],
) {
  if (settings.auraProfilePath?.trim()) {
    return settings.auraProfilePath.trim()
  }
  if (!auraHome) {
    return ''
  }
  return `${auraHome.browserProfilesDir}/default`
}

export function validateCustomSearchTemplate(template: string) {
  const trimmed = template.trim()
  if (!trimmed) {
    return '自定义搜索模板不能为空。'
  }
  if (!trimmed.includes('{query}')) {
    return '自定义搜索模板必须包含 {query} 占位符。'
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return '自定义搜索模板必须以 http:// 或 https:// 开头。'
  }
  return ''
}
