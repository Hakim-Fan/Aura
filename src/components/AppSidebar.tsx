import { useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowUpCircle,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from 'lucide-react'
import type { Session, SessionFolder } from '../types'
import { formatConversationTimestamp } from '../lib/sessionMeta'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  width: number
  sessionFilter: string
  onSessionFilterChange: (value: string) => void
  sessions: Session[]
  sessionFolders: SessionFolder[]
  runningSessionIds: string[]
  activeSessionId: string | null
  onOpenSession: (sessionId: string) => void
  onCreateSession: () => void
  onCreateSessionFolder: (name: string) => void
  onRenameSession: (sessionId: string, title: string) => void
  onRenameSessionFolder: (folderId: string, title: string) => void
  onDeleteSession: (sessionId: string) => void
  onDeleteSessionFolder: (folderId: string) => void
  onToggleSessionFolder: (folderId: string) => void
  onMoveSessionToFolder: (sessionId: string, folderId?: string) => void
  onOpenSettings: () => void
  settingsOpen: boolean
  updateRelease?: { version: string } | null
  onShowUpdate?: () => void
}

function DroppableSection({
  id,
  className,
  activeClassName,
  children,
}: {
  id: string
  className: string
  activeClassName: string
  children: ReactNode
}) {
  const { isOver, setNodeRef } = useDroppable({ id })

  return (
    <section
      ref={setNodeRef}
      className={`${className} ${isOver ? activeClassName : ''}`.trim()}
    >
      {children}
    </section>
  )
}

function SessionRow({
  session,
  isActive,
  isRunning,
  onOpenSession,
  onStartRename,
  onRequestDelete,
  level = 0,
}: {
  session: Session
  isActive: boolean
  isRunning: boolean
  onOpenSession: (sessionId: string) => void
  onStartRename: (session: Session) => void
  onRequestDelete: (session: Session) => void
  level?: number
}) {
  const latestMessageTimestamp = session.messages.at(-1)?.createdAt || session.updatedAt
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `session:${session.id}`,
    data: {
      sessionId: session.id,
    },
  })

  // Level 0: top level (root), Level 1: inside folder
  const paddingLeft = level === 0 ? 'pl-3' : 'pl-6'

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
      }}
      {...attributes}
      {...listeners}
      className={`group relative flex cursor-grab items-center rounded-lg transition-colors active:cursor-grabbing ${isActive ? 'bg-[var(--bg-sidebar-active)]' : 'hover:bg-[rgba(0,0,0,0.04)]'
        } ${isDragging ? 'z-10 opacity-45 shadow-lg' : ''}`}
    >
      {/* {isActive ? (
        <div className="absolute left-0 h-4 w-[3px] rounded-r-full bg-[var(--bg-user-bubble)]" />
      ) : null} */}

      <div
        className={`flex w-full min-w-0 flex-1 items-center justify-between py-1.5 ${paddingLeft} pr-2`}
        onClick={() => onOpenSession(session.id)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate text-13px font-500 text-[var(--text-primary)]">
            {session.title}
          </span>
          {isRunning ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-soft-strong)] animate-pulse"
              title="当前会话正在执行任务"
            />
          ) : null}
        </div>

        {/* Pure Fluid Section: Dynamic width fits content, zero blank gaps */}
        <div className="ml-1.5 flex h-6 shrink-0 items-center justify-end">
          {/* Default view: Date */}
          <span className="text-[10px] tracking-wide text-[var(--text-secondary)] opacity-60 group-hover:hidden">
            {formatConversationTimestamp(latestMessageTimestamp)}
          </span>

          {/* Hover view: Action Buttons */}
          <div className="hidden items-center gap-0.5 group-hover:flex">
            <button
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[var(--text-primary)]"
              aria-label={`重命名会话`}
              onClick={event => {
                event.stopPropagation()
                onStartRename(session)
              }}
              type="button"
            >
              <Pencil size={13} />
            </button>
            <button
              className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[rgba(255,0,0,0.08)] hover:text-red-600"
              aria-label={`删除会话`}
              onClick={event => {
                event.stopPropagation()
                onRequestDelete(session)
              }}
              type="button"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AppSidebar({
  width,
  sessionFilter,
  onSessionFilterChange,
  sessions,
  sessionFolders,
  runningSessionIds,
  activeSessionId,
  onOpenSession,
  onCreateSession,
  onCreateSessionFolder,
  onRenameSession,
  onRenameSessionFolder,
  onDeleteSession,
  onDeleteSessionFolder,
  onToggleSessionFolder,
  onMoveSessionToFolder,
  onOpenSettings,
  settingsOpen,
  updateRelease,
  onShowUpdate,
}: Props) {
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    id: string
    title: string
    workspacePath: string
  } | null>(null)
  const [renameSession, setRenameSession] = useState<{ id: string; title: string } | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderDraft, setFolderDraft] = useState('')
  const [renameFolder, setRenameFolder] = useState<{ id: string; title: string } | null>(null)
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null)
  const runningSessionIdSet = new Set(runningSessionIds)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  )

  const sessionsByFolderId = useMemo(() => {
    const grouped = new Map<string, Session[]>()
    for (const folder of sessionFolders) {
      grouped.set(folder.id, [])
    }
    for (const session of sessions) {
      if (session.folderId && grouped.has(session.folderId)) {
        grouped.get(session.folderId)?.push(session)
      }
    }
    return grouped
  }, [sessionFolders, sessions])

  const ungroupedSessions = useMemo(
    () => sessions.filter(session => !session.folderId || !sessionsByFolderId.has(session.folderId)),
    [sessions, sessionsByFolderId],
  )

  const deletingFolder = sessionFolders.find(folder => folder.id === deleteFolderId) || null

  function startRename(session: Session) {
    setRenameSession({ id: session.id, title: session.title })
    setEditingTitle(session.title)
  }

  function startRenameFolder(folder: SessionFolder) {
    setRenameFolder({ id: folder.id, title: folder.name })
    setFolderDraft(folder.name)
  }

  function cancelRename() {
    setRenameSession(null)
    setEditingTitle('')
  }

  function cancelFolderEditor() {
    setCreateFolderOpen(false)
    setRenameFolder(null)
    setFolderDraft('')
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

  function confirmFolderSave() {
    const nextName = folderDraft.trim()
    if (!nextName) {
      cancelFolderEditor()
      return
    }

    if (renameFolder) {
      onRenameSessionFolder(renameFolder.id, nextName)
    } else {
      onCreateSessionFolder(nextName)
    }
    cancelFolderEditor()
  }

  function handleSessionDeleteRequest(session: Session) {
    setDeleteConfirmation({
      id: session.id,
      title: session.title,
      workspacePath: session.workspacePath || '',
    })
  }

  function handleDragStart(event: DragStartEvent) {
    const sessionId = event.active.data.current?.sessionId
    if (typeof sessionId === 'string') {
      document.body.style.cursor = 'grabbing'
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    document.body.style.cursor = ''
    const sessionId = event.active.data.current?.sessionId
    if (typeof sessionId !== 'string') {
      return
    }

    if (event.over?.id === 'ungrouped') {
      onMoveSessionToFolder(sessionId, undefined)
      return
    }

    if (typeof event.over?.id === 'string' && event.over.id.startsWith('folder:')) {
      onMoveSessionToFolder(sessionId, event.over.id.slice('folder:'.length))
    }
  }

  function handleDragCancel() {
    document.body.style.cursor = ''
  }

  return (
    <aside
      className="relative flex h-screen shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)]"
      style={{ width, minWidth: width, maxWidth: width }}
    >
      <div className="relative h-10 w-full shrink-0" data-tauri-drag-region />

      <div className="relative z-10 mb-6 flex items-center justify-between px-4">
        <div className="pointer-events-none text-11px font-700 uppercase tracking-0.1em text-[var(--text-secondary)]">
          Aura
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[rgba(0,0,0,0.05)]"
            onClick={() => {
              setCreateFolderOpen(true)
              setRenameFolder(null)
              setFolderDraft('')
            }}
            title="新建文件夹"
          >
            <FolderPlus size={16} />
          </button>
          <button
            className="rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-[rgba(0,0,0,0.05)]"
            onClick={onCreateSession}
            title="新建会话"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="group relative mb-4 px-4">
        <div className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] opacity-50 transition-all group-focus-within:opacity-100 group-focus-within:text-[var(--bg-user-bubble)]">
          <Search size={14} />
        </div>
        <input
          className="w-full rounded-lg border-none bg-[rgba(0,0,0,0.03)] py-1.5 pl-9 pr-3 text-13px outline-none transition-all placeholder:text-[rgba(0,0,0,0.3)] focus:bg-white focus:ring-1 focus:ring-[var(--bg-user-bubble)] focus:shadow-[0_0_0_3px_rgba(79,123,116,0.15)]"
          value={sessionFilter}
          onChange={event => onSessionFilterChange(event.target.value)}
          placeholder="搜索会话..."
        />
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="custom-scrollbar flex-1 overflow-y-auto px-2 pb-4">
          <DroppableSection
            id="ungrouped"
            className="rounded-xl transition-colors mb-0.5"
            activeClassName="bg-[rgba(79,123,116,0.08)]"
          >
            {/* <div className="px-3 py-1.5 text-[11px] font-600 text-[var(--text-secondary)] opacity-70 mb-1">
              未分组
            </div> */}
            <div className="flex flex-col gap-px">
              {ungroupedSessions.length > 0 ? (
                ungroupedSessions.map(session => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    isRunning={runningSessionIdSet.has(session.id)}
                    onOpenSession={onOpenSession}
                    onStartRename={startRename}
                    onRequestDelete={handleSessionDeleteRequest}
                    level={0}
                  />
                ))
              ) : null}
            </div>
          </DroppableSection>

          {sessionFolders.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {sessionFolders.map(folder => {
                const folderSessions = sessionsByFolderId.get(folder.id) || []

                return (
                  <DroppableSection
                    key={folder.id}
                    id={`folder:${folder.id}`}
                    className="rounded-xl transition-colors"
                    activeClassName="bg-[rgba(79,123,116,0.08)]"
                  >
                    <div className="group flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-[rgba(0,0,0,0.03)]">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => onToggleSessionFolder(folder.id)}
                        title={folder.name}
                      >
                        {folder.expanded ? (
                          <ChevronDown size={14} className="shrink-0 text-[var(--text-secondary)] opacity-60" />
                        ) : (
                          <ChevronRight size={14} className="shrink-0 text-[var(--text-secondary)] opacity-60" />
                        )}
                        <Folder size={14} className="shrink-0 text-[var(--accent-soft-strong)] opacity-80" />
                        <span className="truncate text-12px font-600 text-[var(--text-secondary)]">
                          {folder.name}
                        </span>
                        <span className="ml-1 shrink-0 text-[10px] font-600 text-[var(--text-secondary)] opacity-50">
                          {folderSessions.length}
                        </span>
                      </button>
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[var(--text-primary)]"
                          title="重命名文件夹"
                          onClick={() => startRenameFolder(folder)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="rounded-md p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[rgba(255,0,0,0.08)] hover:text-red-500"
                          title="删除文件夹"
                          onClick={() => setDeleteFolderId(folder.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {folder.expanded ? (
                      <div className="mt-px flex flex-col gap-px">
                        {folderSessions.length > 0 ? (
                          folderSessions.map(session => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              isActive={session.id === activeSessionId}
                              isRunning={runningSessionIdSet.has(session.id)}
                              onOpenSession={onOpenSession}
                              onStartRename={startRename}
                              onRequestDelete={handleSessionDeleteRequest}
                              level={1}
                            />
                          ))
                        ) : null}
                      </div>
                    ) : null}
                  </DroppableSection>
                )
              })}
            </div>
          ) : null}
        </div>
      </DndContext>

      <div className="flex items-center justify-between border-t border-[var(--border-subtle)] p-4">
        <button
          className={`rounded-lg p-2 text-[var(--text-secondary)] transition-colors ${settingsOpen
            ? 'bg-[var(--bg-sidebar-active)] text-[var(--text-primary)]'
            : 'hover:bg-[rgba(0,0,0,0.05)]'
            }`}
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings2 size={16} />
        </button>

        {updateRelease ? (
          <button
            onClick={onShowUpdate}
            className="group flex items-center gap-1.5 rounded-full bg-[#e2eeed] px-2.5 py-1.5 text-[#4f7b74] transition-all active:scale-95 hover:bg-[#d6e5e4]"
          >
            <ArrowUpCircle size={15} className="text-[#6da099] transition-transform group-hover:scale-110" />
            <span className="text-12px font-700 tracking-wide">更新</span>
          </button>
        ) : null}
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
        isOpen={createFolderOpen || !!renameFolder}
        title={renameFolder ? '编辑文件夹名称' : '新建文件夹'}
        description={renameFolder ? '修改后会立即更新侧栏分组。' : '文件夹仅用于会话分组，不会创建磁盘目录。'}
        confirmText={renameFolder ? '保存' : '创建'}
        cancelText="取消"
        variant="info"
        onConfirm={confirmFolderSave}
        onCancel={cancelFolderEditor}
      >
        <textarea
          autoFocus
          value={folderDraft}
          onChange={event => setFolderDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              confirmFolderSave()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelFolderEditor()
            }
          }}
          rows={3}
          className="w-full resize-none rounded-2xl border border-solid border-[#4f7b7466] bg-white px-4 py-3 text-15px leading-relaxed text-[var(--text-primary)] shadow-[rgba(15,23,42,0.05)] outline-none ring-4 ring-[rgba(79,123,116,0.08)] transition-all focus:ring-[rgba(79,123,116,0.14)]"
          placeholder="输入文件夹名称"
        />
      </ConfirmModal>

      <ConfirmModal
        isOpen={!!deleteFolderId}
        title="确认删除文件夹？"
        description={`确定要删除“${deletingFolder?.name || ''}”吗？其中的会话会被移回未分组。`}
        confirmText="删除文件夹"
        cancelText="取消"
        variant="danger"
        onConfirm={() => {
          if (deleteFolderId) {
            onDeleteSessionFolder(deleteFolderId)
            setDeleteFolderId(null)
          }
        }}
        onCancel={() => setDeleteFolderId(null)}
      />

      <ConfirmModal
        isOpen={!!deleteConfirmation}
        title="移入回收站？"
        description={`“${deleteConfirmation?.title}”会从当前列表移除，并可在回收站中找回。`}
        confirmText="移入回收站"
        cancelText="保留会话"
        variant="warning"
        onConfirm={() => {
          if (deleteConfirmation) {
            onDeleteSession(deleteConfirmation.id)
            setDeleteConfirmation(null)
          }
        }}
        onCancel={() => {
          setDeleteConfirmation(null)
        }}
      />
    </aside>
  )
}
