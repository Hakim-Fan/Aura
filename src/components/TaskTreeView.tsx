import { memo } from 'react'
import { CheckCircle2, CircleDashed, Clock3, PauseCircle, XCircle } from 'lucide-react'
import type { TaskNode } from '../types'

function statusLabel(status?: string) {
  switch (status) {
    case 'queued':
      return '已排队'
    case 'running':
      return '执行中'
    case 'awaiting_approval':
      return '待审批'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return '空闲'
  }
}

function StatusIcon({ status }: { status?: string }) {
  switch (status) {
    case 'running':
      return <Clock3 size={15} />
    case 'awaiting_approval':
      return <PauseCircle size={15} />
    case 'completed':
      return <CheckCircle2 size={15} />
    case 'failed':
      return <XCircle size={15} />
    default:
      return <CircleDashed size={15} />
  }
}

export const TaskTreeView = memo(function TaskTreeView({
  nodes,
}: {
  nodes: TaskNode[]
}) {
  if (nodes.length === 0) {
    return <p className="text-12px text-[var(--text-secondary)] opacity-60 leading-relaxed">还没有执行步骤。</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {nodes.map(node => (
        <article key={node.id} className="grid grid-cols-[18px_1fr] gap-3">
          <div className="relative flex flex-col items-center">
            <div className="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[var(--text-secondary)] opacity-70">
              <StatusIcon status={node.status} />
            </div>
            <div className="mt-1 w-px flex-1 bg-[rgba(15,23,42,0.08)]" />
          </div>
          <div className="min-w-0 pb-1">
            <div className="mb-1 flex min-w-0 items-start justify-between gap-3">
              <strong className="min-w-0 text-13px font-600 leading-relaxed text-[var(--text-primary)]">{node.title}</strong>
              <span className="shrink-0 rounded-full bg-[rgba(15,23,42,0.05)] px-2 py-0.5 text-10px font-600 text-[var(--text-secondary)] opacity-70">
                {statusLabel(node.status)}
              </span>
            </div>
            <p className="text-12px leading-relaxed text-[var(--text-secondary)] opacity-75">{node.summary}</p>
            {node.children.length > 0 ? (
              <div className="mt-3 pl-1">
                <TaskTreeView nodes={node.children} />
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  )
})
