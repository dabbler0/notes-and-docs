import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { essaySchema } from '../../../lib/pmSchema'
import { insertQuoteInline } from '../pmCommands'
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

/** Same minimal `EditorView` stand-in `insertQuoteBlock.test.ts` already uses. */
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

describe('insertQuoteInline', () => {
  it('wraps the quoted text in a plain straight double quote, the same character on both sides, as ordinary unmarked text', () => {
    const doc = parse({ type: 'doc', content: [section('root', 'Essay', [paragraph('before ')])] })
    const pos = doc.content.size - 1 // end of "before "
    const { view, getTransaction } = fakeView(doc, pos)
    insertQuoteInline(view, source, 'a quoted phrase', 42)
    const result = getTransaction().doc

    expect(result.textContent).toContain('"a quoted phrase"')
    // Not a mismatched curly open/close pair — the whole point of the fix.
    expect(result.textContent).not.toContain('“')
    expect(result.textContent).not.toContain('”')
    // No special mark at all any more — the quote characters themselves
    // are enough to set it apart; see `insertQuoteInline`'s own doc comment.
    let anyMarked = false
    result.descendants((node) => {
      if (node.isText && node.marks.length > 0) anyMarked = true
    })
    expect(anyMarked).toBe(false)
  })

  it('still adds the trailing citation right after the quoted text', () => {
    const doc = parse({ type: 'doc', content: [section('root', 'Essay', [paragraph('')])] })
    const { view, getTransaction } = fakeView(doc, doc.content.size - 1)
    insertQuoteInline(view, source, 'excerpt', 7)
    const result = getTransaction().doc

    let citationFound = false
    result.descendants((node) => {
      if (node.type.name === 'citation') citationFound = true
    })
    expect(citationFound).toBe(true)
  })
})
