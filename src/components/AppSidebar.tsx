import { useState } from 'react'
import { Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type { Session } from '../types'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  width: number
  sessionFilter: string
  onSessionFilterChange: (value: string) => void
  sessions: Session[]
  activeSessionId: string | null
  onOpenSession: (sessionId: string) => void
  onCreateSession: () => void
  onDeleteSession: (sessionId: string) => void
  onOpenSettings: () => void
  settingsOpen: boolean
}

export function AppSidebar({
  width,
  sessionFilter,
  onSessionFilterChange,
  sessions,
  activeSessionId,
  onOpenSession,
  onCreateSession,
  onDeleteSession,
  onOpenSettings,
  settingsOpen,
}: Props) {
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ id: string; title: string } | null>(null)

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
              className="flex-1 flex flex-col items-start py-3 px-4 text-left overflow-hidden"
              onClick={() => onOpenSession(session.id)}
              title={session.title}
            >
              <div className="w-full text-14px font-500 text-[var(--text-primary)] truncate mb-0.5">
                {session.title}
              </div>
              <div className="text-11px text-[var(--text-secondary)] opacity-70">
                {new Date(session.updatedAt).toLocaleDateString()}
              </div>
            </button>

            <button
              className="absolute right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-[rgba(255,0,0,0.05)] hover:text-red-500 text-[var(--text-secondary)] transition-all"
              aria-label={`删除会话 ${session.title}`}
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteConfirmation({ id: session.id, title: session.title });
              }}
            >
              <Trash2 size={14} />
            </button>
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
        isOpen={!!deleteConfirmation}
        title="确认删除会话？"
        description={`确定要删除“${deleteConfirmation?.title}”吗？此操作不可撤销。`}
        confirmText="彻底删除"
        cancelText="不删了"
        variant="danger"
        onConfirm={() => {
          if (deleteConfirmation) {
            onDeleteSession(deleteConfirmation.id);
            setDeleteConfirmation(null);
          }
        }}
        onCancel={() => setDeleteConfirmation(null)}
      />
    </aside>
  )
}
