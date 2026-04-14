import type { ChatMessage, Session } from '../types'

function padNumber(value: number) {
  return String(value).padStart(2, '0')
}

export function getMessageTimestamp(message: ChatMessage): number {
  return typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
    ? message.createdAt
    : 0
}

export function getSessionLastMessageTimestamp(session: Session): number {
  const lastMessage = session.messages.at(-1)
  return lastMessage ? getMessageTimestamp(lastMessage) : 0
}

export function getSessionSortTimestamp(session: Session): number {
  return getSessionLastMessageTimestamp(session) || session.updatedAt || 0
}

export function sortSessionsByRecentActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((left, right) => {
    const timestampDelta = getSessionSortTimestamp(right) - getSessionSortTimestamp(left)
    if (timestampDelta !== 0) {
      return timestampDelta
    }
    return right.updatedAt - left.updatedAt
  })
}

export function formatConversationTimestamp(
  timestamp?: number,
  referenceTimestamp = Date.now(),
): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return ''
  }

  const value = new Date(timestamp)
  const reference = new Date(referenceTimestamp)
  const isSameDay =
    value.getFullYear() === reference.getFullYear() &&
    value.getMonth() === reference.getMonth() &&
    value.getDate() === reference.getDate()

  const timeLabel = `${padNumber(value.getHours())}:${padNumber(value.getMinutes())}`
  if (isSameDay) {
    return timeLabel
  }

  return `${padNumber(value.getMonth() + 1)}-${padNumber(value.getDate())} ${timeLabel}`
}
