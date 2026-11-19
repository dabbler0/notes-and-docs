import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import { essaySchema } from '../../../lib/pmSchema'
import { splitSectionIntoSiblings } from '../pmCommands'

function paragraph(text = '') {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: title ? [{ type: 'text', text: title }] : [] }, ...children] }
}

function parse(json: unknown): PMNode {
  return PMNode.fromJSON(essaySchema, json)
}

function apply(doc: PMNode, selectionPos: number): { handled: boolean; doc: PMNode; selectionFrom?: number } {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, selectionPos, selectionPos) })
  let tr: Transaction | null = null
  const handled = splitSectionIntoSiblings(state, (t) => {
    tr = t
  })
  if (!tr) return { handled, doc }
  const result = state.apply(tr)
  return { handled, doc: result.doc, selectionFrom: result.selection.from }
}

/** Position right inside the (empty) paragraph that is `doc`'s `n`th empty paragraph overall, 1-indexed — the obvious unambiguous way to target "this specific blank line" across these tests' otherwise-identical-looking empty paragraphs. */
function posOfEmptyParagraph(doc: PMNode, n: number): number {
  let count = 0
  let pos = -1
  doc.descendants((node, nodePos) => {
    if (pos !== -1) return false
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      count++
      if (count === n) pos = nodePos + 1
    }
    return true
  })
  if (pos === -1) throw new Error(`no ${n}th empty paragraph found`)
  return pos
}

describe('splitSectionIntoSiblings', () => {
  it('splits a middle section into two siblings at an empty line, moving the tail into the new one', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [{ type: 'section', attrs: { id: 'mid' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Middle' }] }, paragraph('before'), paragraph(), paragraph('after')] }])],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(true)

    const root = result.firstChild!
    // root: [root_title, original "Middle" section (shortened), new sibling section]
    expect(root.childCount).toBe(3)
    const original = root.child(1)
    expect(original.attrs.id).toBe('mid')
    expect(original.child(0).textContent).toBe('Middle') // title unchanged
    expect(original.childCount).toBe(2) // title + "before" only
    expect(original.child(1).textContent).toBe('before')

    const sibling = root.child(2)
    expect(sibling.type.name).toBe('section')
    expect(sibling.attrs.id).not.toBe('mid') // a real, distinct id
    expect(sibling.child(0).type.name).toBe('section_title')
    expect(sibling.child(0).textContent).toBe('') // empty, ready to be named
    expect(sibling.childCount).toBe(2)
    expect(sibling.child(1).textContent).toBe('after')
  })

  it('lands the selection inside the new sibling section’s own empty title', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [{ type: 'section', attrs: { id: 'mid' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Middle' }] }, paragraph('before'), paragraph(), paragraph('after')] }])],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { doc: result, selectionFrom } = apply(doc, pos)

    const root = result.firstChild!
    const sibling = root.child(2)
    let titlePos = -1
    result.descendants((node, nodePos) => {
      if (titlePos !== -1) return false
      if (node === sibling.firstChild) titlePos = nodePos
      return true
    })
    expect(selectionFrom).toBe(titlePos + 1)
  })

  it("escapes to the parent section instead of splitting, when the empty line is the section's own last block", () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [{ type: 'section', attrs: { id: 'mid' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Middle' }] }, paragraph('before'), paragraph()] }])],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(true)

    const root = result.firstChild!
    // No new section at all — still just [root_title, the "Middle" section], plus a new plain paragraph as root's own next block.
    expect(root.childCount).toBe(3)
    const mid = root.child(1)
    expect(mid.type.name).toBe('section')
    expect(mid.attrs.id).toBe('mid')
    expect(mid.childCount).toBe(2) // title + "before" — the trailing empty paragraph is gone, not kept
    expect(mid.child(1).textContent).toBe('before')
    const escaped = root.child(2)
    expect(escaped.type.name).toBe('paragraph')
    expect(escaped.content.size).toBe(0)
  })

  it('places the selection inside the newly-escaped paragraph', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [{ type: 'section', attrs: { id: 'mid' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Middle' }] }, paragraph('before'), paragraph()] }])],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { doc: result, selectionFrom } = apply(doc, pos)

    const root = result.firstChild!
    const escaped = root.child(2)
    let escapedPos = -1
    result.descendants((node, nodePos) => {
      if (escapedPos !== -1) return false
      if (node === escaped) escapedPos = nodePos
      return true
    })
    expect(selectionFrom).toBe(escapedPos + 1)
  })

  it('escapes to the nearest enclosing section specifically, not all the way out to the root, for a doubly-nested section', () => {
    const doc = parse({
      type: 'doc',
      content: [
        section('root', '', [
          {
            type: 'section',
            attrs: { id: 'outer' },
            content: [
              { type: 'section_title', content: [{ type: 'text', text: 'Outer' }] },
              paragraph('outer body'),
              { type: 'section', attrs: { id: 'inner' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Inner' }] }, paragraph('before'), paragraph()] },
            ],
          },
        ]),
      ],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { doc: result } = apply(doc, pos)

    const root = result.firstChild!
    const outer = root.child(1)
    expect(outer.attrs.id).toBe('outer')
    // outer: [title, "outer body", the (now-shortened) inner section, the escaped paragraph] — landed right after "inner," still inside "outer," not at the document root.
    expect(outer.childCount).toBe(4)
    const inner = outer.child(2)
    expect(inner.attrs.id).toBe('inner')
    expect(inner.childCount).toBe(2) // title + "before" only
    const escaped = outer.child(3)
    expect(escaped.type.name).toBe('paragraph')
    expect(escaped.content.size).toBe(0)
  })

  it("still splits into a new sibling section when something follows the empty line — even just a nested subsection with no plain-text body of its own", () => {
    const doc = parse({
      type: 'doc',
      content: [
        section('root', '', [
          {
            type: 'section',
            attrs: { id: 'mid' },
            content: [
              { type: 'section_title', content: [{ type: 'text', text: 'Middle' }] },
              paragraph('before'),
              paragraph(),
              { type: 'section', attrs: { id: 'nested' }, content: [{ type: 'section_title', content: [] }] },
            ],
          },
        ]),
      ],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { doc: result } = apply(doc, pos)

    const root = result.firstChild!
    expect(root.childCount).toBe(3) // unchanged — no escape happened
    const sibling = root.child(2)
    expect(sibling.type.name).toBe('section')
    expect(sibling.child(1).attrs.id).toBe('nested')
  })

  it("still produces a new child section for the document root's own trailing empty line — the root has no parent to escape to", () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph('before'), paragraph()])] })
    const pos = posOfEmptyParagraph(doc, 1)
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(true)

    expect(result.childCount).toBe(1) // still exactly one top-level doc child
    const root = result.firstChild!
    expect(root.childCount).toBe(3) // root_title + "before" + the new empty child section
    const child = root.child(2)
    expect(child.type.name).toBe('section')
    expect(child.childCount).toBe(2) // empty title + one fresh empty paragraph body
  })

  it('moves nested subsections that came after the split point wholesale into the new sibling', () => {
    const doc = parse({
      type: 'doc',
      content: [
        section('root', '', [
          {
            type: 'section',
            attrs: { id: 'mid' },
            content: [
              { type: 'section_title', content: [{ type: 'text', text: 'Middle' }] },
              paragraph('before'),
              paragraph(),
              { type: 'section', attrs: { id: 'nested' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Nested' }] }, paragraph('nested body')] },
            ],
          },
        ]),
      ],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { doc: result } = apply(doc, pos)

    const root = result.firstChild!
    const original = root.child(1)
    expect(original.childCount).toBe(2) // title + "before" — the nested subsection moved out
    const sibling = root.child(2)
    expect(sibling.childCount).toBe(2) // empty title + the moved nested section
    expect(sibling.child(1).type.name).toBe('section')
    expect(sibling.child(1).attrs.id).toBe('nested')
    expect(sibling.child(1).textContent).toContain('nested body')
  })

  it('splits the document root into a root + new top-level child, rather than an illegal root-level sibling', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [paragraph('before'), paragraph(), paragraph('after')])],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(true)

    // Still exactly one top-level doc child — the schema's own `doc: { content: "section" }` always holds.
    expect(result.childCount).toBe(1)
    const root = result.firstChild!
    expect(root.type.name).toBe('section')
    expect(root.childCount).toBe(3) // root_title + "before" + the new child section
    expect(root.child(1).textContent).toBe('before')
    const child = root.child(2)
    expect(child.type.name).toBe('section')
    expect(child.child(1).textContent).toBe('after')
  })

  it('declines when the selection is non-empty', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph('before'), paragraph(), paragraph('after')])] })
    const pos = posOfEmptyParagraph(doc, 1)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos, pos + 1) })
    expect(splitSectionIntoSiblings(state, undefined)).toBe(false)
  })

  it('declines when the paragraph at the cursor is not empty', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph('before'), paragraph('not empty'), paragraph('after')])] })
    let pos = -1
    doc.descendants((node, nodePos) => {
      if (pos === -1 && node.type.name === 'paragraph' && node.textContent === 'not empty') pos = nodePos + 1
    })
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(false)
    expect(result).toBe(doc)
  })

  it('declines when the empty paragraph is the first body block right after the title — nothing to keep before it', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph(), paragraph('after')])] })
    const pos = posOfEmptyParagraph(doc, 1)
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(false)
    expect(result).toBe(doc)
  })

  it('declines when the empty paragraph is nested inside a list item, not a direct child of the section', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [paragraph('before'), { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('item one')] }, { type: 'list_item', content: [paragraph()] }] }])],
    })
    const pos = posOfEmptyParagraph(doc, 1)
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(false)
    expect(result).toBe(doc)
  })

  it('returns true without a dispatch callback (dry-run check), same Command convention every other command here follows', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph('before'), paragraph(), paragraph('after')])] })
    const pos = posOfEmptyParagraph(doc, 1)
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos, pos) })
    expect(splitSectionIntoSiblings(state, undefined)).toBe(true)
  })
})
