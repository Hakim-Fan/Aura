import { useState } from 'react'
import { Pencil, Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type { Session } from '../types'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  width: number
  sessionFilter: string
  onSessionFilterChange: (value: string) => void
  sessions: Session[]
  runningSessionIds: string[]
  activeSessionId: string | null
  onOpenSession: (sessionId: string) => void
  onCreateSession: () => void
  onDeleteSession: (sessionId: string, deleteWorkspace: boolean) => void
  onRenameSession: (sessionId: string, title: string) => void
  onOpenSettings: () => void
  settingsOpen: boolean
}

export function AppSidebar({
  width,
  sessionFilter,
  onSessionFilterChange,
  sessions,
  runningSessionIds,
  activeSessionId,
  onOpenSession,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  onOpenSettings,
  settingsOpen,
}: Props) {
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    id: string
    title: string
    workspacePath: string
  } | null>(null)
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [renameSession, setRenameSession] = useState<{ id: string; title: string } | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const runningSessionIdSet = new Set(runningSessionIds)

  function startRename(session: Session) {
    setRenameSession({ id: session.id, title: session.title })
    setEditingTitle(session.title)
  }

  function cancelRename() {
    setRenameSession(null)
    setEditingTitle('')
  }

  function confirmRename(sessionId: string) {
    const nextTitle = editingTitle.trim()
    if (!nextTitle) {
      cancelRename()
      return
    }
    onRenameSession(sessionId, nextTitle)
    cancelRename()
  }

  return (
    <aside
      className="relative h-screen flex flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] shrink-0"
      style={{ width, minWidth: width, maxWidth: width }}
    >
      {/* Top spacer: macOS traffic lights area + drag region */}
      <div className="relative h-10 w-full shrink-0" data-tauri-drag-region />

      <div className="relative px-4 mb-6 flex-between shrink-0 z-10">
        <div className="text-11px font-700 text-[var(--text-secondary)] tracking-0.1em uppercase pointer-events-none">
          Aura
        </div>
        <button
          className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
          onClick={onCreateSession}
          title="新建会话"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="px-4 mb-4 relative group">
        <div className="absolute left-7 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] opacity-50 group-focus-within:opacity-100 group-focus-within:text-[var(--bg-user-bubble)] transition-all pointer-events-none">
          <Search size={14} />
        </div>
        <input
          className="w-full bg-[rgba(0,0,0,0.03)] border-none rounded-lg py-1.5 pl-9 pr-3 text-13px placeholder:text-[rgba(0,0,0,0.3)] focus:bg-white focus:shadow-[0_0_0_3px_rgba(79,123,116,0.15)] focus:ring-1 focus:ring-[var(--bg-user-bubble)] outline-none transition-all"
          value={sessionFilter}
          onChange={event => onSessionFilterChange(event.target.value)}
          placeholder="搜索会话..."
        />
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {sessions.map(session => (
          <div
            key={session.id}
            className={`group relative flex items-center w-full transition-colors ${session.id === activeSessionId ? 'bg-[var(--bg-sidebar-active)]' : 'hover:bg-[rgba(0,0,0,0.03)]'
              }`}
          >
            {session.id === activeSessionId && (
              <div className="absolute left-0 w-1 h-full bg-[var(--bg-user-bubble)]" />
            )}
            <button
              className="flex-1 flex flex-col items-start py-3 px-4 pr-18 text-left overflow-hidden"
              onClick={() => onOpenSession(session.id)}
              title={session.title}
            >
              <div className="w-full truncate text-14px font-500 text-[var(--text-primary)] mb-0.5">
                {session.title}
              </div>
              <div className="flex w-full items-center justify-between gap-2 text-11px text-[var(--text-secondary)] opacity-70">
                <span>{new Date(session.updatedAt).toLocaleDateString()}</span>
                {runningSessionIdSet.has(session.id) ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent-soft-strong)] animate-pulse"
                    title="当前会话正在执行任务"
                  />
                ) : null}
              </div>
            </button>

            <div className="absolute right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
              <button
                className="p-1.5 rounded-md hover:bg-[rgba(0,0,0,0.05)] text-[var(--text-secondary)]"
                aria-label={`重命名会话 ${session.title}`}
                title="重命名会话"
                onClick={e => {
                  e.stopPropagation()
                  startRename(session)
                }}
                type="button"
              >
                <Pencil size={14} />
              </button>
              <button
                className="p-1.5 rounded-md hover:bg-[rgba(255,0,0,0.05)] hover:text-red-500 text-[var(--text-secondary)]"
                aria-label={`删除会话 ${session.title}`}
                title="删除会话"
                onClick={e => {
                  e.stopPropagation()
                  setDeleteWorkspace(false)
                  setDeleteConfirmation({
                    id: session.id,
                    title: session.title,
                    workspacePath: session.workspacePath || '',
                  })
                }}
                type="button"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-[var(--border-subtle)]">
        <button
          className={`p-2 rounded-lg text-[var(--text-secondary)] transition-colors ${settingsOpen ? 'bg-[var(--bg-sidebar-active)] text-[var(--text-primary)]' : 'hover:bg-[rgba(0,0,0,0.05)]'
            }`}
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings2 size={16} />
        </button>
      </div>

      <ConfirmModal
        isOpen={!!renameSession}
        title="编辑会话名称"
        description="修改后会立即应用到当前会话列表。"
        confirmText="保存"
        cancelText="取消"
        variant="info"
        onConfirm={() => {
          if (renameSession) {
            confirmRename(renameSession.id)
          }
        }}
        onCancel={cancelRename}
      >
        <textarea
          autoFocus
          value={editingTitle}
          onChange={event => setEditingTitle(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && renameSession) {
              event.preventDefault()
              confirmRename(renameSession.id)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelRename()
            }
          }}
          rows={3}
          className="w-full resize-none rounded-2xl border border-solid border-[#4f7b7466] bg-white px-4 py-3 text-15px leading-relaxed text-[var(--text-primary)] shadow-[rgba(15,23,42,0.05)] outline-none ring-4 ring-[rgba(79,123,116,0.08)] transition-all focus:ring-[rgba(79,123,116,0.14)]"
          placeholder="输入会话名称"
        />
      </ConfirmModal>

      <ConfirmModal
        isOpen={!!deleteConfirmation}
        title="确认删除会话？"
        description={`确定要删除“${deleteConfirmation?.title}”吗？此操作不可撤销。`}
        confirmText="彻底删除"
        cancelText="不删了"
        variant="danger"
        onConfirm={() => {
          if (deleteConfirmation) {
            onDeleteSession(deleteConfirmation.id, deleteWorkspace);
            setDeleteConfirmation(null);
            setDeleteWorkspace(false)
          }
        }}
        onCancel={() => {
          setDeleteConfirmation(null)
          setDeleteWorkspace(false)
        }}
      >
        {deleteConfirmation?.workspacePath.trim() ? (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[rgba(15,23,42,0.08)] bg-[rgba(15,23,42,0.02)] px-3 py-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-red-500 focus:ring-red-200"
              checked={deleteWorkspace}
              onChange={event => setDeleteWorkspace(event.target.checked)}
            />
            <div className="min-w-0">
              <div className="text-13px font-600 text-[var(--text-primary)]">
                同时删除工作区
              </div>
              <div className="mt-1 break-all text-12px leading-relaxed text-[var(--text-secondary)] opacity-80">
                {deleteConfirmation.workspacePath}
              </div>
            </div>
          </label>
        ) : null}
      </ConfirmModal>
    </aside>
  )
}
