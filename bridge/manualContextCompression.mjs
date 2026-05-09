import {
  compactMessagesWithProvider,
} from './providers.mjs'
import {
  buildContextCompressionBudget,
  estimateMessagesTokens,
} from './contextCompression.mjs'

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function normalizeKeepRecentCount(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 6
  }
  return Math.max(1, Math.min(24, Math.round(parsed)))
}

async function runManualContextCompression(payload = {}) {
  const settings = payload.settings || {}
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const keepRecentCount = normalizeKeepRecentCount(payload.keepRecentCount)

  if (messages.length <= keepRecentCount + 1) {
    throw new Error('当前会话中可压缩的历史消息太少。')
  }

  const originalTokens = estimateMessagesTokens(messages, settings)
  const budget = buildContextCompressionBudget(settings)
  const compactedMessages = await compactMessagesWithProvider({
    settings,
    messages,
    keepRecentCount,
    targetTokens: budget.targetConversationTokens,
  })
  const summary = compactedMessages[0]?.content?.trim() || ''
  if (!summary) {
    throw new Error('模型没有返回可用的上下文压缩摘要。')
  }

  const compressedTokens = estimateMessagesTokens(compactedMessages, settings)
  return {
    ok: true,
    message: `已压缩背景上下文，估算从 ${originalTokens} tokens 降至 ${compressedTokens} tokens。`,
    summary,
    originalTokens,
    compressedTokens,
    originalMessageCount: messages.length,
    compressedMessageCount: compactedMessages.length,
    keptRecentCount: keepRecentCount,
  }
}

try {
  const rawPayload = await readStdin()
  if (!rawPayload.trim()) {
    throw new Error('Missing context compression payload.')
  }
  const payload = JSON.parse(rawPayload)
  const result = await runManualContextCompression(payload)
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
