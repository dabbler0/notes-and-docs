import { describe, expect, it } from 'vitest'
import { buildParentMap, isAbstractTitle, isPlaceholderTitle, isSelfOrDescendant, pathOf, placeholderTitle } from '../treeNumbering'
import { markerHtml } from '../childMarkers'
import type { EssayNode } from '../../models/types'

function makeNode(id: string, draftContent: string, title = 'Untitled'): EssayNode {
  return { id, essayId: 'e1', title, versions: [], headVersionId: '', draftContent, footnotes: [], comments: [], createdAt: 0, updatedAt: 0 }
}

describe('isAbstractTitle', () => {
  it('matches "Abstract" exactly, trimmed', () => {
    expect(isAbstractTitle('Abstract')).toBe(true)
    expect(isAbstractTitle('  Abstract  ')).toBe(true)
  })

  it('rejects anything else, case-sensitively and substring-wise', () => {
    expect(isAbstractTitle('abstract')).toBe(false)
    expect(isAbstractTitle('Abstracted')).toBe(false)
    expect(isAbstractTitle('An Abstract')).toBe(false)
    expect(isAbstractTitle(undefined)).toBe(false)
    expect(isAbstractTitle('')).toBe(false)
  })
})

describe('pathOf with an abstract as the root\'s first child', () => {
  it('gives the abstract itself no path at all', () => {
    const abstract = makeNode('abs', '', 'Abstract')
    const section = makeNode('s1', '', 'Intro')
    const root = makeNode('root', markerHtml('abs') + markerHtml('s1'))
    const nodeMap = new Map([['root', root], ['abs', abstract], ['s1', section]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(pathOf(nodeMap, parentMap, 'root', 'abs')).toEqual([])
  })

  it('numbers the section right after the abstract as [1], not [2]', () => {
    const abstract = makeNode('abs', '', 'Abstract')
    const section = makeNode('s1', '', 'Intro')
    const root = makeNode('root', markerHtml('abs') + markerHtml('s1'))
    const nodeMap = new Map([['root', root], ['abs', abstract], ['s1', section]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(pathOf(nodeMap, parentMap, 'root', 's1')).toEqual([1])
  })

  it('numbers a grandchild under the post-abstract section as [1, 1]', () => {
    const abstract = makeNode('abs', '', 'Abstract')
    const child = makeNode('c1', '', 'Sub')
    const section = makeNode('s1', markerHtml('c1'), 'Intro')
    const root = makeNode('root', markerHtml('abs') + markerHtml('s1'))
    const nodeMap = new Map([['root', root], ['abs', abstract], ['s1', section], ['c1', child]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(pathOf(nodeMap, parentMap, 'root', 'c1')).toEqual([1, 1])
  })

  it('numbers normally when there is no abstract at all', () => {
    const a = makeNode('a', '', 'A')
    const b = makeNode('b', '', 'B')
    const root = makeNode('root', markerHtml('a') + markerHtml('b'))
    const nodeMap = new Map([['root', root], ['a', a], ['b', b]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(pathOf(nodeMap, parentMap, 'root', 'a')).toEqual([1])
    expect(pathOf(nodeMap, parentMap, 'root', 'b')).toEqual([2])
  })

  it("doesn't treat a later section titled Abstract (not the root's first child) specially", () => {
    const a = makeNode('a', '', 'Intro')
    const b = makeNode('b', '', 'Abstract')
    const root = makeNode('root', markerHtml('a') + markerHtml('b'))
    const nodeMap = new Map([['root', root], ['a', a], ['b', b]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(pathOf(nodeMap, parentMap, 'root', 'a')).toEqual([1])
    expect(pathOf(nodeMap, parentMap, 'root', 'b')).toEqual([2])
  })
})

describe('placeholderTitle with an abstract as the root\'s first child', () => {
  it('numbers the second root-level child (index 1) as "Section 1", skipping the abstract slot', () => {
    const abstract = makeNode('abs', '', 'Abstract')
    const section = makeNode('s1', '', 'Section 1: Untitled')
    const root = makeNode('root', markerHtml('abs') + markerHtml('s1'))
    const nodeMap = new Map([['root', root], ['abs', abstract], ['s1', section]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(placeholderTitle(nodeMap, parentMap, 'root', 'root', 1)).toBe('Section 1: Untitled')
  })

  it('still numbers normally (no abstract) as "Section 1"/"Section 2"', () => {
    const a = makeNode('a', '', 'A')
    const b = makeNode('b', '', 'B')
    const root = makeNode('root', markerHtml('a') + markerHtml('b'))
    const nodeMap = new Map([['root', root], ['a', a], ['b', b]])
    const parentMap = buildParentMap(nodeMap, 'root')
    expect(placeholderTitle(nodeMap, parentMap, 'root', 'root', 0)).toBe('Section 1: Untitled')
    expect(placeholderTitle(nodeMap, parentMap, 'root', 'root', 1)).toBe('Section 2: Untitled')
  })
})

describe('isPlaceholderTitle / isSelfOrDescendant (sanity, unrelated to the abstract exception)', () => {
  it('matches a well-formed placeholder title', () => {
    expect(isPlaceholderTitle('Section 2.3: Untitled')).toBe(true)
    expect(isPlaceholderTitle('Abstract')).toBe(false)
  })

  it('finds a node inside its own subtree', () => {
    const child = makeNode('c', '')
    const root = makeNode('root', markerHtml('c'))
    const nodeMap = new Map([['root', root], ['c', child]])
    expect(isSelfOrDescendant(nodeMap, 'root', 'c')).toBe(true)
    expect(isSelfOrDescendant(nodeMap, 'c', 'root')).toBe(false)
  })
})
