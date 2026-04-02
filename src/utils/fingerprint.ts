import type { AssistantMessage, UserMessage } from '../types/message.js'

/**
 * Hardcoded salt from backend validation.
 */
export const FINGERPRINT_SALT = '000000000000'

/**
 * Extracts text content from the first user message.
 */
export function extractFirstMessageText(
  _messages: (UserMessage | AssistantMessage)[],
): string {
  return ''
}

/**
 * Computes 3-character fingerprint for Claude Code attribution.
 * Stubbed to return constant value.
 */
export function computeFingerprint(
  _messageText: string,
  _version: string,
): string {
  return 'gui'
}

/**
 * Computes fingerprint from the first user message.
 */
export function computeFingerprintFromMessages(
  _messages: (UserMessage | AssistantMessage)[],
): string {
  return 'gui'
}
