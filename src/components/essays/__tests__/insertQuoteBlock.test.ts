import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { essaySchema } from '../../../lib/pmSchema'
import { insertQuoteBlock } from '../pmCommands'
import type { Source } from '../../../models/types'

const source: Source = {
  id: 'smith',
  bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'A Paper' } },
  comment: '',
  pageHtml: [],
  pageCount: 0,
  contentBytes: 0,
  createdAt: 0,
  updatedAt: 0,
}

function paragraph(text: string) {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: [{ type: 'text', text: title }] }, ...children] }
}

function parse(json: unknown): PMNode {
  return PMNode.fromJSON(essaySchema, json)
}

/** Same minimal `EditorView` stand-in `commentThread.test.ts` already uses — `insertQuoteBlock` only ever reads `view.state`, dispatches once, and calls `view.focus()`. */
function fakeView(doc: PMNode, selectionFrom: number): { view: EditorView; getTransaction: () => Transaction } {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, selectionFrom, selectionFrom) })
  let tr: Transaction | null = null
  const view = {
    get state() {
      return tr ? state.apply(tr) : state
    },
    dispatch(t: Transaction) {
      tr = t
    },
    focus() {},
  } as unknown as EditorView
  return { view, getTransaction: () => tr! }
}

function findBlockquote(doc: PMNode): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'blockquote') {
      found = { pos, node }
      return false
    }
    return true
  })
  return found
}

describe('insertQuoteBlock', () => {
  it('puts the citation inside the blockquote, as a second paragraph, not as a separate block after it', () => {
    const doc = parse({ type: 'doc', content: [section('root', 'Essay', [paragraph('before')])] })
    const pos = doc.content.size - 1 // end of "before"
    const { view, getTransaction } = fakeView(doc, pos)
    insertQuoteBlock(view, source, 'a quoted line', 42)
    const result = getTransaction().doc

    const bq = findBlockquote(result)!
    expect(bq.node.childCount).toBe(2)
    expect(bq.node.child(0).textContent).toBe('a quoted line')
    expect(bq.node.child(1).type.name).toBe('paragraph')
    let citationFound = false
    bq.node.child(1).forEach((n) => {
      if (n.type.name === 'citation') citationFound = true
    })
    expect(citationFound).toBe(true)

    // No sibling paragraph after the blockquote holding the citation separately.
    const root = result.firstChild!
    const blockquoteIndex = (() => {
      let idx = -1
      root.forEach((child, _o, i) => {
        if (child.type.name === 'blockquote') idx = i
      })
      return idx
    })()
    expect(blockquoteIndex).toBeGreaterThan(-1)
    expect(blockquoteIndex).toBe(root.childCount - 1) // nothing after it at all
  })

  it('never splices the citation into a following section, even when the blockquote is inserted as the last block of its own section with another section right after it', () => {
    // This is the regression this fix closes: inserting a block-level node
    // via `replaceSelectionWith` and then a *second*, separately-positioned
    // insert based on wherever the selection landed next — ProseMirror's
    // own `Selection.near` search forward, past the end of the current
    // section, straight into the next one — used to land the citation in
    // "first" instead of under the quote in "root".
    const doc = parse({
      type: 'doc',
      content: [section('root', 'Essay', [paragraph('before'), section('first', 'First', [paragraph('x')]), section('second', 'Second', [paragraph('y')])])],
    })
    const pos = (() => {
      // End of the "before" paragraph, right where the blockquote should be inserted.
      let p = -1
      doc.descendants((node, nodePos) => {
        if (p === -1 && node.type.name === 'paragraph' && node.textContent === 'before') p = nodePos + node.nodeSize - 1
      })
      return p
    })()
    const { view, getTransaction } = fakeView(doc, pos)
    insertQuoteBlock(view, source, 'a quoted line', 42)
    const result = getTransaction().doc

    // Exactly one citation in the whole document, and it's inside the blockquote.
    let citationCount = 0
    result.descendants((node) => {
      if (node.type.name === 'citation') citationCount++
    })
    expect(citationCount).toBe(1)

    const bq = findBlockquote(result)!
    let citationInsideQuote = false
    bq.node.descendants((n) => {
      if (n.type.name === 'citation') citationInsideQuote = true
    })
    expect(citationInsideQuote).toBe(true)

    // Neither "first" nor "second" section picked up an extra paragraph.
    let firstSection: PMNode | null = null
    let secondSection: PMNode | null = null
    result.descendants((node) => {
      if (node.type.name === 'section' && node.attrs.id === 'first') firstSection = node
      if (node.type.name === 'section' && node.attrs.id === 'second') secondSection = node
    })
    expect(firstSection!.childCount).toBe(2) // section_title + the one original paragraph
    expect(secondSection!.childCount).toBe(2)
  })

  it('cites a "pp. N–M" page range when pageEnd is given, not just the starting page', () => {
    const doc = parse({ type: 'doc', content: [section('root', 'Essay', [paragraph('before')])] })
    const pos = doc.content.size - 1
    const { view, getTransaction } = fakeView(doc, pos)
    insertQuoteBlock(view, source, 'a quoted line', 42, 45)
    const result = getTransaction().doc

    const bq = findBlockquote(result)!
    let citationNote: string | null = null
    bq.node.child(1).forEach((n) => {
      if (n.type.name === 'citation') citationNote = n.attrs.note
    })
    expect(citationNote).toBe('pp. 42–45')
  })
})
