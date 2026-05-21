export const MAX_VISIBLE_TASK_TITLE_CHARS = 20

export function compactVisibleTaskTitle(value, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  const title = normalized || String(fallback || '').replace(/\s+/g, ' ').trim()
  if (!title) {
    return ''
  }
  if (title.length <= MAX_VISIBLE_TASK_TITLE_CHARS) {
    return title
  }
  return `${title.slice(0, Math.max(0, MAX_VISIBLE_TASK_TITLE_CHARS - 3))}...`
}
