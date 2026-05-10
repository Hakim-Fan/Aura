import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Circle,
  Copy,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import {
  APP_LOG_ENTRY_EVENT,
  listAppLogFiles,
  readAppLogFile,
  type AppLogEntry,
  type AppLogFile,
  type AppLogLevel,
} from './lib/appLogs'
import { ensureAuraHome } from './lib/aura'
import { openPathInDefaultApp } from './lib/workspace'

type ViewerMode = 'live' | 'history'
type LevelFilter = 'all' | AppLogLevel

const MAX_LIVE_LOG_ENTRIES = 300
const LEVEL_FILTERS: LevelFilter[] = ['all', 'debug', 'info', 'warn', 'error']

function normalizeLevel(level: string): AppLogLevel {
  if (level === 'debug' || level === 'warn' || level === 'error') {
    return level
  }
  return 'info'
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) {
    return timestamp
  }
  const time = date.toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${value} B`
}

function valueToText(value: unknown) {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value == null) {
    return ''
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function findStringByKey(value: unknown, key: string, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 5) {
    return undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key, depth + 1)
      if (found) {
        return found
      }
    }
    return undefined
  }

  const record = value as Record<string, unknown>
  const directValue = record[key]
  if (typeof directValue === 'string' && directValue.trim()) {
    return directValue
  }
  if (typeof directValue === 'number' || typeof directValue === 'boolean') {
    return String(directValue)
  }

  for (const child of Object.values(record)) {
    const found = findStringByKey(child, key, depth + 1)
    if (found) {
      return found
    }
  }
  return undefined
}

function truncateMiddle(value: string, maxLength = 34) {
  if (value.length <= maxLength) {
    return value
  }
  const tailLength = Math.max(8, Math.floor(maxLength * 0.34))
  const headLength = Math.max(8, maxLength - tailLength - 1)
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return valueToText(value)
  }
}

function summarizeEntry(entry: AppLogEntry) {
  const details = entry.details || {}
  const fields = [
    'toolName',
    'status',
    'phase',
    'error',
    'message',
    'rawMessage',
    'summary',
    'line',
    'code',
    'provider',
    'model',
    'cwd',
  ]
  const parts = fields
    .map(key => {
      const value = findStringByKey(details, key)
      return value ? `${key}=${value}` : ''
    })
    .filter(Boolean)

  if (parts.length > 0) {
    return parts.join(' · ')
  }

  const fallback = valueToText(details)
  return fallback === '{}' ? '-' : fallback
}

function logSearchText(entry: AppLogEntry) {
  return [
    entry.timestamp,
    entry.level,
    entry.event,
    findStringByKey(entry.details, 'sessionId'),
    findStringByKey(entry.details, 'messageId'),
    findStringByKey(entry.details, 'taskId'),
    summarizeEntry(entry),
    valueToText(entry.details),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function logEntryKey(entry: AppLogEntry, index: number) {
  return `${entry.timestampMs}-${entry.event}-${index}`
}

function getCorrelationId(entry: AppLogEntry) {
  return (
    findStringByKey(entry.details, 'taskId') ||
    findStringByKey(entry.details, 'messageId') ||
    findStringByKey(entry.details, 'sessionId') ||
    ''
  )
}

function isTroubleshootingEntry(entry: AppLogEntry) {
  const level = normalizeLevel(entry.level)
  const event = entry.event.toLowerCase()
  const status = findStringByKey(entry.details, 'status')?.toLowerCase()
  return (
    level === 'warn' ||
    level === 'error' ||
    event.includes('failed') ||
    event.includes('error') ||
    status === 'error' ||
    status === 'failed' ||
    Boolean(findStringByKey(entry.details, 'error')) ||
    Boolean(findStringByKey(entry.details, 'errorInfo'))
  )
}

function LogEntryRow({
  entry,
  index,
  expanded,
  relatedEntries,
  onCopy,
  onToggle,
}: {
  entry: AppLogEntry
  index: number
  expanded: boolean
  relatedEntries: AppLogEntry[]
  onCopy: (value: string, label: string) => void
  onToggle: () => void
}) {
  const level = normalizeLevel(entry.level)
  const sessionId = findStringByKey(entry.details, 'sessionId')
  const messageId = findStringByKey(entry.details, 'messageId')
  const taskId = findStringByKey(entry.details, 'taskId')
  const summary = summarizeEntry(entry)
  const troubleshootingEntries = relatedEntries.filter(isTroubleshootingEntry)
  const contextEntries = troubleshootingEntries.length > 0
    ? troubleshootingEntries
    : relatedEntries.filter(item => item !== entry).slice(-8)
  const contextLabel = taskId ? '同任务排障上下文' : '相关日志上下文'

  return (
    <div
      className={`log-entry log-entry--${level}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
    >
      <div className="log-entry__main">
        <span className="log-entry__index">{index + 1}</span>
        <span className={`log-entry__level log-entry__level--${level}`}>
          {level.toUpperCase()}
        </span>
        <span className="log-entry__time">{formatTime(entry.timestamp)}</span>
        <span className="log-entry__event">{entry.event}</span>
        <span className="log-entry__ids">
          {sessionId ? <span title={sessionId}>session {truncateMiddle(sessionId, 28)}</span> : null}
          {messageId ? <span title={messageId}>msg {truncateMiddle(messageId, 28)}</span> : null}
          {taskId ? <span title={taskId}>task {truncateMiddle(taskId, 28)}</span> : null}
        </span>
      </div>
      <div className="log-entry__summary">{summary}</div>
      {expanded ? (
        <div className="log-entry__expanded" onClick={event => event.stopPropagation()}>
          <div className="log-entry__actions">
            <button
              onClick={() => onCopy(safeJson(entry), '整条日志')}
              type="button"
            >
              <Copy size={13} />
              <span>复制整条</span>
            </button>
            <button
              onClick={() => onCopy(safeJson(entry.details), 'details')}
              type="button"
            >
              <Copy size={13} />
              <span>复制 details</span>
            </button>
            {relatedEntries.length > 1 ? (
              <button
                onClick={() => onCopy(safeJson(relatedEntries), '排障上下文')}
                type="button"
              >
                <Copy size={13} />
                <span>复制上下文</span>
              </button>
            ) : null}
          </div>
          {relatedEntries.length > 1 ? (
            <div className="log-entry__context">
              <div className="log-entry__context-title">
                {contextLabel}
                <span>
                  {contextEntries.length} / {relatedEntries.length} 条
                </span>
              </div>
              {contextEntries.length > 0 ? (
                <div className="log-entry__context-list">
                  {contextEntries.map((contextEntry, contextIndex) => {
                    const contextLevel = normalizeLevel(contextEntry.level)
                    return (
                      <div
                        className={`log-entry__context-item log-entry__context-item--${contextLevel}`}
                        key={`${contextEntry.timestampMs}-${contextEntry.event}-${contextIndex}`}
                      >
                        <span className="log-entry__context-time">
                          {formatTime(contextEntry.timestamp)}
                        </span>
                        <span className={`log-entry__level log-entry__level--${contextLevel}`}>
                          {contextLevel.toUpperCase()}
                        </span>
                        <span className="log-entry__context-event">{contextEntry.event}</span>
                        <span className="log-entry__context-summary">
                          {summarizeEntry(contextEntry)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="log-entry__context-empty">同一上下文里暂时没有错误或警告。</div>
              )}
            </div>
          ) : null}
          <pre className="log-entry__details">{safeJson(entry)}</pre>
        </div>
      ) : null}
    </div>
  )
}

export function LogViewerWindowApp() {
  const [mode, setMode] = useState<ViewerMode>('live')
  const [liveEntries, setLiveEntries] = useState<AppLogEntry[]>([])
  const [historyEntries, setHistoryEntries] = useState<AppLogEntry[]>([])
  const [logFiles, setLogFiles] = useState<AppLogFile[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [search, setSearch] = useState('')
  const [expandedKey, setExpandedKey] = useState('')
  const [autoFollow, setAutoFollow] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const sourceEntries = mode === 'live' ? liveEntries : historyEntries
  const filteredEntries = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()
    return sourceEntries.filter(entry => {
      const level = normalizeLevel(entry.level)
      if (levelFilter !== 'all' && level !== levelFilter) {
        return false
      }
      if (!normalizedSearch) {
        return true
      }
      return logSearchText(entry).includes(normalizedSearch)
    })
  }, [levelFilter, search, sourceEntries])

  const relatedEntriesById = useMemo(() => {
    const groups = new Map<string, AppLogEntry[]>()
    for (const entry of sourceEntries) {
      const correlationId = getCorrelationId(entry)
      if (!correlationId) {
        continue
      }
      const group = groups.get(correlationId) || []
      group.push(entry)
      groups.set(correlationId, group)
    }
    return groups
  }, [sourceEntries])

  const rowVirtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 74,
    overscan: 8,
    getItemKey: index => logEntryKey(filteredEntries[index], index),
  })

  async function refreshLogFiles() {
    const files = await listAppLogFiles()
    setLogFiles(files)
    setSelectedDate(current => current || files[0]?.date || '')
  }

  async function loadHistory(date = selectedDate) {
    if (!date) {
      setStatus({
        tone: 'error',
        message: '没有可读取的日志文件。',
      })
      return
    }
    setMode('history')
    setLoadingHistory(true)
    setStatus(null)
    setExpandedKey('')
    try {
      const entries = await readAppLogFile(date)
      setHistoryEntries(entries)
      setStatus({
        tone: 'success',
        message: `已加载 ${date} 的 ${entries.length} 条日志。`,
      })
    } catch (caught) {
      setStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '读取日志文件失败。',
      })
    } finally {
      setLoadingHistory(false)
    }
  }

  async function openLogsFolder() {
    try {
      const aura = await ensureAuraHome()
      await openPathInDefaultApp(aura.logsDir)
    } catch (caught) {
      setStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '打开日志目录失败。',
      })
    }
  }

  async function copyLogText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setStatus({
        tone: 'success',
        message: `已复制${label}。`,
      })
    } catch {
      setStatus({
        tone: 'error',
        message: `复制${label}失败，请检查剪贴板权限。`,
      })
    }
  }

  useEffect(() => {
    void refreshLogFiles().catch(caught => {
      setStatus({
        tone: 'error',
        message: caught instanceof Error ? caught.message : '读取日志文件列表失败。',
      })
    })

    let unlistenLogEntry: (() => void) | undefined
    let unlistenResetLive: (() => void) | undefined
    void listen<AppLogEntry>(APP_LOG_ENTRY_EVENT, event => {
      setLiveEntries(current => [...current, event.payload].slice(-MAX_LIVE_LOG_ENTRIES))
    }).then(nextUnlisten => {
      unlistenLogEntry = nextUnlisten
    })
    void listen('log-viewer:reset-live', () => {
      setMode('live')
      setLiveEntries([])
      setExpandedKey('')
      setAutoFollow(true)
      void refreshLogFiles()
    }).then(nextUnlisten => {
      unlistenResetLive = nextUnlisten
    })

    ;(window as unknown as { __dismissSplash?: () => void }).__dismissSplash?.()

    return () => {
      unlistenLogEntry?.()
      unlistenResetLive?.()
    }
  }, [])

  useEffect(() => {
    if (mode !== 'live' || !autoFollow || filteredEntries.length === 0) {
      return
    }
    window.requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(filteredEntries.length - 1, {
        align: 'end',
      })
    })
  }, [autoFollow, filteredEntries.length, mode, rowVirtualizer])

  useEffect(() => {
    if (!status) {
      return
    }
    const timer = window.setTimeout(() => setStatus(null), 2600)
    return () => window.clearTimeout(timer)
  }, [status])

  const virtualItems = rowVirtualizer.getVirtualItems()

  return (
    <div className="log-viewer-shell">
      <header className="log-viewer-header">
        <div>
          <h1>日志看板</h1>
          <p>
            实时模式只显示本窗口打开后的日志，最多保留 {MAX_LIVE_LOG_ENTRIES} 条；历史模式按日期读取 JSONL 文件。
          </p>
        </div>
        <button className="secondary-button" onClick={() => void openLogsFolder()} type="button">
          <FolderOpen size={14} />
          <span>打开日志目录</span>
        </button>
      </header>

      <section className="log-viewer-toolbar">
        <div className="log-viewer-segment">
          <button
            className={mode === 'live' ? 'active' : ''}
            onClick={() => {
              setMode('live')
              setExpandedKey('')
            }}
            type="button"
          >
            实时
          </button>
          <button
            className={mode === 'history' ? 'active' : ''}
            onClick={() => {
              setExpandedKey('')
              if (historyEntries.length === 0 && selectedDate) {
                void loadHistory(selectedDate)
              } else {
                setMode('history')
              }
            }}
            type="button"
          >
            历史
          </button>
        </div>

        <div className="log-viewer-search">
          <Search size={14} />
          <input
            onChange={event => setSearch(event.target.value)}
            placeholder="搜索 event / sessionId / messageId / taskId / 内容"
            value={search}
          />
        </div>

        <div className="log-viewer-levels">
          {LEVEL_FILTERS.map(level => (
            <button
              className={levelFilter === level ? 'active' : ''}
              key={level}
              onClick={() => setLevelFilter(level)}
              type="button"
            >
              <Circle size={8} />
              <span>{level === 'all' ? 'All' : level.toUpperCase()}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="log-viewer-subtoolbar">
        {mode === 'live' ? (
          <>
            <button
              className="secondary-button"
              onClick={() => setAutoFollow(current => !current)}
              type="button"
            >
              {autoFollow ? <Pause size={14} /> : <Play size={14} />}
              <span>{autoFollow ? '暂停跟随' : '继续跟随'}</span>
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setLiveEntries([])
                setExpandedKey('')
              }}
              type="button"
            >
              <Trash2 size={14} />
              <span>清屏</span>
            </button>
            <span className="log-viewer-note">
              当前 {filteredEntries.length} / {liveEntries.length} 条
            </span>
          </>
        ) : (
          <>
            <select
              className="log-viewer-select"
              onChange={event => {
                const nextDate = event.target.value
                setSelectedDate(nextDate)
                if (mode === 'history' && nextDate) {
                  void loadHistory(nextDate)
                }
              }}
              value={selectedDate}
            >
              {logFiles.length === 0 ? (
                <option value="">暂无日志文件</option>
              ) : (
                logFiles.map(file => (
                  <option key={file.date} value={file.date}>
                    {file.date} · {formatBytes(file.size)}
                  </option>
                ))
              )}
            </select>
            <button
              className="secondary-button"
              disabled={loadingHistory || !selectedDate}
              onClick={() => void loadHistory()}
              type="button"
            >
              <RefreshCw className={loadingHistory ? 'animate-spin' : ''} size={14} />
              <span>{loadingHistory ? '加载中' : '加载文件'}</span>
            </button>
            <button className="secondary-button" onClick={() => void refreshLogFiles()} type="button">
              <RefreshCw size={14} />
              <span>刷新文件</span>
            </button>
            <span className="log-viewer-note">
              当前 {filteredEntries.length} / {historyEntries.length} 条
            </span>
          </>
        )}
      </section>

      {status ? (
        <div className={`log-viewer-status log-viewer-status--${status.tone}`}>
          {status.message}
        </div>
      ) : null}

      <section className="log-viewer-list-wrap">
        <div className="log-viewer-list-head">
          <span>#</span>
          <span>等级</span>
          <span>时间</span>
          <span>事件</span>
          <span>标识</span>
        </div>
        <div className="log-viewer-list custom-scrollbar" ref={scrollRef}>
          {filteredEntries.length === 0 ? (
            <div className="log-viewer-empty">
              {mode === 'live'
                ? '实时日志会从打开此窗口后开始显示。'
                : '请选择某一天的日志文件并加载。'}
            </div>
          ) : (
            <div
              className="log-viewer-virtual-space"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {virtualItems.map(virtualItem => {
                const entry = filteredEntries[virtualItem.index]
                const key = logEntryKey(entry, virtualItem.index)
                const relatedEntries = relatedEntriesById.get(getCorrelationId(entry)) || [entry]
                return (
                  <div
                    className="log-viewer-virtual-row"
                    data-index={virtualItem.index}
                    key={virtualItem.key}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <LogEntryRow
                      entry={entry}
                      expanded={expandedKey === key}
                      index={virtualItem.index}
                      relatedEntries={relatedEntries}
                      onCopy={(value, label) => void copyLogText(value, label)}
                      onToggle={() => setExpandedKey(current => (current === key ? '' : key))}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
