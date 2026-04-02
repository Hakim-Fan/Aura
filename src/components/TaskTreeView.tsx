import { memo } from 'react'
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

export const TaskTreeView = memo(function TaskTreeView({
  nodes,
}: {
  nodes: TaskNode[]
}) {
  if (nodes.length === 0) {
    return <p className="muted">还没有任务树。</p>
  }

  return (
    <div className="task-tree">
      {nodes.map(node => (
        <article key={node.id} className="task-node">
          <div className="inline-between">
            <strong>{node.title}</strong>
            <span className="micro-pill">{statusLabel(node.status)}</span>
          </div>
          <p>{node.summary}</p>
          {node.children.length > 0 ? (
            <div className="task-children">
              <TaskTreeView nodes={node.children} />
            </div>
          ) : null}
        </article>
      ))}
    </div>
  )
})
