import { invoke } from '@tauri-apps/api/core'

type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

const MAX_STRING_LENGTH = 4000
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 30

let rendererLogContext: Record<string, unknown> = {}

function trimString(value: string) {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}...`
    : value
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return trimString(value)
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: trimString(value.message),
      stack: value.stack ? trimString(value.stack) : undefined,
    }
  }
  if (depth >= 4) {
    return '[truncated]'
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, entry]) => [key, sanitizeLogValue(entry, depth + 1)]),
    )
  }
  return String(value)
}

export async function writeAppLog(
  level: AppLogLevel,
  event: string,
  details: Record<string, unknown> = {},
) {
  try {
    await invoke('write_app_log', {
      level,
      event,
      details: sanitizeLogValue({
        ...rendererLogContext,
        ...details,
      }),
    })
  } catch {
    // Logging must never break the app path it is trying to observe.
  }
}

export function setRendererLogContext(context: Record<string, unknown>) {
  rendererLogContext = Object.fromEntries(
    Object.entries(context).filter(
      ([, value]) => typeof value === 'string' && value.trim().length > 0,
    ),
  )
}

export function installRendererLogging() {
  void writeAppLog('info', 'renderer_started', {
    path: window.location.pathname,
    userAgent: navigator.userAgent,
  })

  window.addEventListener('error', (event) => {
    void writeAppLog('error', 'renderer_uncaught_error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    void writeAppLog('error', 'renderer_unhandled_rejection', {
      reason: event.reason,
    })
  })
}
