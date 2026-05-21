import crypto from 'node:crypto'

function normalizeBlockContent(content) {
  return String(content || '').replace(/\r\n/g, '\n').trim()
}

export function createPromptBlock({
  id,
  role = 'developer',
  kind,
  priority = 0,
  stable = false,
  content,
}) {
  const normalizedContent = normalizeBlockContent(content)
  return {
    id,
    role,
    kind,
    priority,
    stable,
    content: normalizedContent,
    hash: crypto
      .createHash('sha256')
      .update(`${id}\n${role}\n${kind}\n${normalizedContent}`)
      .digest('hex')
      .slice(0, 16),
  }
}

export function renderPromptBlocks(blocks = []) {
  return [...blocks]
    .filter(block => block?.content)
    .sort((left, right) => {
      const leftPriority = Number.isFinite(left.priority) ? left.priority : 0
      const rightPriority = Number.isFinite(right.priority) ? right.priority : 0
      return leftPriority - rightPriority
    })
    .map(block => block.content)
    .join('\n\n')
}

export function promptBlockSnapshot(blocks = []) {
  return [...blocks]
    .filter(block => block?.id)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map(block => ({
      id: block.id,
      role: block.role,
      kind: block.kind,
      hash: block.hash,
      stable: block.stable === true,
    }))
}

export function diffPromptBlockSnapshots(previous = [], next = []) {
  const previousById = new Map(
    (Array.isArray(previous) ? previous : [])
      .filter(block => block?.id)
      .map(block => [block.id, block]),
  )
  const nextById = new Map(
    (Array.isArray(next) ? next : [])
      .filter(block => block?.id)
      .map(block => [block.id, block]),
  )

  const added = []
  const changed = []
  const removed = []

  for (const block of nextById.values()) {
    const prior = previousById.get(block.id)
    if (!prior) {
      added.push(block.id)
    } else if (prior.hash !== block.hash) {
      changed.push(block.id)
    }
  }

  for (const block of previousById.values()) {
    if (!nextById.has(block.id)) {
      removed.push(block.id)
    }
  }

  return { added, changed, removed }
}
