import { describe, expect, it } from 'vitest'
import { nodeOwnText, subtreeText, wordCountStats } from '../wordCount'
import type { EssayNode } from '../../models/types'

function makeNode(overrides: Partial<EssayNode> & { id: string; draftContent: string }): EssayNode {
  return {
    essayId: 'e1',
    title: 'Untitled section',
    versions: [{ id: 'v1', content: overrides.draftContent, createdAt: 0 }],
    headVersionId: 'v1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('wordCountStats', () => {
  it('counts words separated by whitespace', () => {
    expect(wordCountStats('one two three')).toEqual({ words: 3, characters: 13 })
  })

  it('counts zero words for empty or whitespace-only text', () => {
    expect(wordCountStats('')).toEqual({ words: 0, characters: 0 })
    expect(wordCountStats('   \n\t  ')).toEqual({ words: 0, characters: 0 })
  })

  it('collapses runs of whitespace (including newlines) to a single character for the character count', () => {
    const stats = wordCountStats('one\n\n  two')
    expect(stats.words).toBe(2)
    expect(stats.characters).toBe('one two'.length)
  })
})

describe('nodeOwnText and subtreeText', () => {
  it('strips tags and counts only this node’s own text, not a child subsection’s', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Some <strong>bold</strong> words.</p><div class="child-embed" data-child-id="child"></div>' })
    const child = makeNode({ id: 'child', draftContent: '<p>Child text here.</p>' })
    const nodeMap = new Map([
      ['root', root],
      ['child', child],
    ])
    expect(wordCountStats(nodeOwnText(root)).words).toBe(3)
    expect(wordCountStats(subtreeText(root, nodeMap)).words).toBe(6)
  })

  it('does not count an equation’s own LaTeX source as words', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Formula <span class="math-inline" data-math-id="m1" data-latex="a+b+c"></span> here.</p>' })
    expect(wordCountStats(nodeOwnText(root)).words).toBe(2)
  })
})
