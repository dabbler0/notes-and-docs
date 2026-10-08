/**
 * Plain word/character counts for an essay or a single section — reading
 * through `draftContent` the same `parseSegments`-driven way `export.ts`
 * walks the tree, so what's counted matches what's actually in the
 * document rather than some separately-maintained running total. An
 * equation marker's own `data-latex` never shows up in its saved
 * `textContent` (see `childMarkers.ts`'s `emptyMathMarkers`), so an
 * equation doesn't count as "words" here — reasonable for a rough prose
 * count, the same way most word processors don't count a typeset formula
 * either.
 */
import { parseSegments } from './childMarkers'
import type { EssayNode } from '../models/types'

export interface WordCountStats {
  words: number
  characters: number
}

function plainTextOf(html: string): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  return doc.body.textContent || ''
}

/** This one node's own text, not counting any child subsections embedded in it. */
export function nodeOwnText(node: EssayNode): string {
  let text = ''
  for (const seg of parseSegments(node.draftContent)) {
    if (seg.kind === 'text') text += plainTextOf(seg.html) + ' '
  }
  return text
}

/** This node's own text plus every descendant subsection's, in document order — the whole subtree rooted here. */
export function subtreeText(node: EssayNode, nodeMap: Map<string, EssayNode>): string {
  let text = nodeOwnText(node)
  for (const seg of parseSegments(node.draftContent)) {
    if (seg.kind === 'child') {
      const child = nodeMap.get(seg.childId)
      if (child) text += subtreeText(child, nodeMap)
    }
  }
  return text
}

export function wordCountStats(text: string): WordCountStats {
  const trimmed = text.trim()
  return {
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    characters: text.replace(/\s+/g, ' ').trim().length,
  }
}
