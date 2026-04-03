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
    return <p className="muted">还没有执行步骤。</p>
  }

  return (
    <div className="task-tree">
      {nodes.map(node => (
        <article key={node.id} className={`task-node ${node.status || 'idle'}`}>
          <div className="task-node-rail" />
          <div className="task-node-dot">
            <StatusIcon status={node.status} />
          </div>
          <div className="task-node-body">
            <div className="task-node-head">
              <strong>{node.title}</strong>
              <span className={`micro-pill ${node.status || 'idle'}`}>{statusLabel(node.status)}</span>
            </div>
            <p>{node.summary}</p>
            {node.children.length > 0 ? (
              <div className="task-children">
                <TaskTreeView nodes={node.children} />
              </div>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  )
})
