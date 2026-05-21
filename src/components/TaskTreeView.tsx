import { memo } from 'react'
import { BadgeCheck, CheckCircle2, Circle, LoaderCircle, PauseCircle, XCircle } from 'lucide-react'
import type { TaskNode } from '../types'

const STRUCTURAL_STEP_KINDS = new Set(['main', 'plan'])
const MAX_VISIBLE_TASK_TITLE_CHARS = 20

function compactVisibleTaskTitle(value = '') {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_VISIBLE_TASK_TITLE_CHARS) {
    return normalized
  }
  return `${normalized.slice(0, Math.max(0, MAX_VISIBLE_TASK_TITLE_CHARS - 3))}...`
}

function collectStepNodes(nodes: TaskNode[] = []) {
  const steps: TaskNode[] = []

  function visit(node: TaskNode) {
    const children = node.children || []
    if (STRUCTURAL_STEP_KINDS.has(node.kind) && children.length > 0) {
      children.forEach(visit)
      return
    }

    steps.push(node)
    if (children.length > 0) {
      children.forEach(visit)
    }
  }

  nodes.forEach(visit)
  return steps
}

function statusLabel(status?: string) {
  switch (status) {
    case 'pending':
    case 'queued':
      return '已排队'
    case 'running':
      return '执行中'
    case 'awaiting_approval':
      return '待审批'
    case 'awaiting_user_input':
      return '待回复'
    case 'completed':
      return '已完成'
    case 'failed':
    case 'blocked':
      return '失败'
    default:
      return '等待中'
  }
}

function StatusIcon({ status }: { status?: string }) {
  switch (status) {
    case 'running':
      return <LoaderCircle size={14} className="animate-spin" />
    case 'awaiting_approval':
    case 'awaiting_user_input':
      return <PauseCircle size={14} />
    case 'completed':
      return <CheckCircle2 size={14} />
    case 'failed':
    case 'blocked':
      return <XCircle size={14} />
    default:
      return <Circle size={14} />
  }
}

function stepTone(status?: string) {
  switch (status) {
    case 'running':
      return 'border-[rgba(79,123,116,0.32)] bg-[rgba(79,123,116,0.08)] text-[var(--accent-soft-strong)]'
    case 'completed':
      return 'border-[rgba(34,197,94,0.28)] bg-[rgba(34,197,94,0.08)] text-green-600'
    case 'failed':
    case 'blocked':
      return 'border-red-200 bg-red-50 text-red-500'
    case 'awaiting_approval':
    case 'awaiting_user_input':
      return 'border-amber-200 bg-amber-50 text-amber-600'
    default:
      return 'border-[rgba(15,23,42,0.10)] bg-white text-[var(--text-secondary)]'
  }
}

function pickFocusedStep(steps: TaskNode[] = []) {
  return (
    steps.find(node =>
      ['running', 'awaiting_approval', 'awaiting_user_input'].includes(node.status || ''),
    ) ||
    steps.find(node => ['failed', 'blocked'].includes(node.status || '')) ||
    [...steps].reverse().find(node => node.status === 'completed') ||
    steps.find(node => ['pending', 'queued'].includes(node.status || '')) ||
    steps[0]
  )
}

function TaskStep({ node, compact = false }: { node: TaskNode; compact?: boolean }) {
  const verified = node.verificationStatus === 'verified'
  const displayTitle = compactVisibleTaskTitle(node.title)
  const titleTooltip = displayTitle === node.title ? undefined : node.title
  return (
    <li className={`flex min-w-0 ${compact ? 'items-center' : 'items-start'} gap-2.5`}>
      <span
        className={`${compact ? '' : 'mt-0.5'} flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${stepTone(node.status)}`}
        title={statusLabel(node.status)}
        aria-label={statusLabel(node.status)}
      >
        <StatusIcon status={node.status} />
      </span>
      <span
        className={`min-w-0 flex-1 break-words text-13px font-600 text-[var(--text-primary)] ${
          compact ? 'truncate leading-5' : 'leading-relaxed'
        }`}
        title={titleTooltip}
      >
        <span className="min-w-0">{displayTitle}</span>
        {verified ? (
          <span
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-full border border-green-200 bg-green-50 px-1.5 py-0.5 align-middle text-11px font-700 text-green-600"
            title={node.verification?.evidence || '验证通过'}
          >
            <BadgeCheck size={11} />
            {!compact ? '已验证' : null}
          </span>
        ) : null}
      </span>
    </li>
  )
}

export const TaskTreeView = memo(function TaskTreeView({
  nodes,
  collapsed = false,
}: {
  nodes: TaskNode[]
  collapsed?: boolean
}) {
  const steps = collectStepNodes(nodes)
  const displayedSteps = collapsed ? [pickFocusedStep(steps)].filter(Boolean) : steps

  if (displayedSteps.length === 0) {
    return null
  }

  return (
    <ol className={collapsed ? 'flex flex-col gap-0' : 'flex flex-col gap-2'}>
      {displayedSteps.map(node => (
        <TaskStep key={node.id} node={node} compact={collapsed} />
      ))}
    </ol>
  )
})
