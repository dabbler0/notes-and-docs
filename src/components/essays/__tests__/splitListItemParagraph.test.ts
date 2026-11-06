import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import { essaySchema } from '../../../lib/pmSchema'
import { splitListItemParagraph } from '../pmCommands'

function paragraph(text: string) {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: [{ type: 'text', text: title }] }, ...children] }
}

function parse(json: unknown): PMNode {
  return PMNode.fromJSON(essaySchema, json)
}

function apply(doc: PMNode, selectionPos: number): { handled: boolean; doc: PMNode } {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, selectionPos, selectionPos) })
  let tr: Transaction | null = null
  const handled = splitListItemParagraph(state, (t) => {
    tr = t
  })
  return { handled, doc: tr ? state.apply(tr).doc : doc }
}

describe('splitListItemParagraph', () => {
  it('splits a list item paragraph into a second paragraph within the same list item', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', 'Essay', [{ type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('first part')] }] }])],
    })
    // Cursor right after "first" (before " part").
    let pos = -1
    doc.descendants((node, nodePos) => {
      if (pos === -1 && node.type.name === 'paragraph' && node.textContent === 'first part') pos = nodePos + 1 + 'first'.length
    })
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(true)

    let listItem: PMNode | null = null
    result.descendants((node) => {
      if (!listItem && node.type.name === 'list_item') listItem = node
    })
    expect(listItem!.childCount).toBe(2)
    expect(listItem!.child(0).type.name).toBe('paragraph')
    expect(listItem!.child(0).textContent).toBe('first')
    expect(listItem!.child(1).type.name).toBe('paragraph')
    expect(listItem!.child(1).textContent).toBe(' part')

    // Still exactly one list item — this isn't a new bullet.
    let listItemCount = 0
    result.descendants((node) => {
      if (node.type.name === 'list_item') listItemCount++
    })
    expect(listItemCount).toBe(1)
  })

  it('declines outside a list item, leaving an ordinary paragraph alone', () => {
    const doc = parse({ type: 'doc', content: [section('root', 'Essay', [paragraph('plain text')])] })
    let pos = -1
    doc.descendants((node, nodePos) => {
      if (pos === -1 && node.type.name === 'paragraph' && node.textContent === 'plain text') pos = nodePos + 1 + 'plain'.length
    })
    const { handled, doc: result } = apply(doc, pos)
    expect(handled).toBe(false)
    expect(result).toBe(doc)
  })
})
