import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

import {
  collapseWhitespace,
  extractBasicHtmlContent,
} from './basicHtml.mjs'

function markdownToText(markdown) {
  let text = String(markdown || '')
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  text = text.replace(/```[\s\S]*?```/g, block =>
    block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''),
  )
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  return collapseWhitespace(text)
}

export async function extractReadableContent(html, mode = 'markdown') {
  const normalizedHtml = String(html || '')
  if (!normalizedHtml.trim()) {
    return null
  }

  try {
    const { document } = parseHTML(normalizedHtml)
    const article = new Readability(document).parse()
    if (!article?.content || !article?.textContent) {
      return null
    }

    const markdown = extractBasicHtmlContent(article.content)
    const text = markdownToText(markdown)
    const content = mode === 'text' ? text : markdown
    return {
      title: collapseWhitespace(article.title || ''),
      byline: collapseWhitespace(article.byline || ''),
      excerpt: collapseWhitespace(article.excerpt || ''),
      content: collapseWhitespace(content),
      text,
    }
  } catch {
    return null
  }
}
