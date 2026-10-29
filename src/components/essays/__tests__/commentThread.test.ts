import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema } from '../../../lib/pmSchema'
import {
  findCommentThread,
  insertCommentThreadNode,
  addCommentThreadEntryNode,
  setCommentEntryResolvedNode,
  deleteCommentEntryNode,
  deleteCommentThreadNode,
} from '../pmCommands'

const ROOT_ID = 'root-section'

function paragraph(text?: string, marks?: unknown[]) {
  return { type: 'paragraph', content: text ? [{ type: 'text', text, ...(marks ? { marks } : {}) }] : [] }
}

function docJson(rootChildren: unknown[]) {
  return {
    type: 'doc',
    content: [{ type: 'section', attrs: { id: ROOT_ID, collapsed: false }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Essay' }] }, ...rootChildren] }],
  }
}

function parse(json: unknown): PMNode {
  return PMNode.fromJSON(essaySchema, json)
}

/**
 * Unit coverage for the `comment_thread`/`comment_entry` mutators in
 * `pmCommands.ts` — the pure, headless-safe half of the fix for a comment's
 * full thread (body + replies) living as real document content instead of
 * a separate side array (see `pmSchema.ts`'s own doc comment). Each test
 * exercises the plain `Node`-returning function directly, matching the
 * style already established by `repairMissingInlineCommentBodies`'s own
 * tests (`pmCommands.test.ts`) — no live `EditorView` needed.
 */
describe('comment_thread / comment_entry mutators', () => {
  it('insertCommentThreadNode splices a new thread (one entry) right at the given position', () => {
    const doc = parse(docJson([paragraph('hello world')]))
    const pos = doc.content.size - 1 // end of the paragraph's own text
    const result = insertCommentThreadNode(doc, pos, 'c1', 'margin', 1000, 'a real comment')

    const found = findCommentThread(result, 'c1')
    expect(found).not.toBeNull()
    expect(found!.node.attrs.displayMode).toBe('margin')
    expect(found!.node.childCount).toBe(1)
    expect(found!.node.firstChild!.attrs).toMatchObject({ id: 'c1', resolved: false, createdAt: 1000, updatedAt: 1000 })
    expect(found!.node.textContent).toBe('a real comment')
  })

  it('insertCommentThreadNode seeds an empty entry with a zero-width placeholder, not truly empty content', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const result = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'inline', 1000)
    const found = findCommentThread(result, 'c1')!
    expect(found.node.firstChild!.textContent.length).toBeGreaterThan(0)
  })

  it('findCommentThread returns null when no thread with that id exists', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(findCommentThread(doc, 'missing')).toBeNull()
  })

  it('addCommentThreadEntryNode appends a reply as the thread\'s second entry', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const result = addCommentThreadEntryNode(withThread, 'c1', 'reply-1', 2000, 'a reply')

    expect(result).not.toBeNull()
    const found = findCommentThread(result!, 'c1')!
    expect(found.node.childCount).toBe(2)
    expect(found.node.child(0).attrs.id).toBe('c1')
    expect(found.node.child(1)).toMatchObject({ attrs: expect.objectContaining({ id: 'reply-1', createdAt: 2000 }) })
    expect(found.node.child(1).textContent).toBe('a reply')
  })

  it('addCommentThreadEntryNode returns null for a thread that no longer exists', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(addCommentThreadEntryNode(doc, 'missing', 'reply-1', 2000)).toBeNull()
  })

  it('setCommentEntryResolvedNode toggles resolved on the top-level entry without touching others', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const withReply = addCommentThreadEntryNode(withThread, 'c1', 'reply-1', 2000, 'a reply')!
    const result = setCommentEntryResolvedNode(withReply, 'c1', true, 3000)!

    const found = findCommentThread(result, 'c1')!
    expect(found.node.child(0).attrs).toMatchObject({ resolved: true, updatedAt: 3000 })
    expect(found.node.child(1).attrs).toMatchObject({ resolved: false })
  })

  it('setCommentEntryResolvedNode can resolve a reply independently of its thread\'s top-level entry', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const withReply = addCommentThreadEntryNode(withThread, 'c1', 'reply-1', 2000, 'a reply')!
    const result = setCommentEntryResolvedNode(withReply, 'reply-1', true, 3000)!

    const found = findCommentThread(result, 'c1')!
    expect(found.node.child(0).attrs.resolved).toBe(false)
    expect(found.node.child(1).attrs.resolved).toBe(true)
  })

  it('deleteCommentEntryNode removes just the reply when the thread has others left', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const withReply = addCommentThreadEntryNode(withThread, 'c1', 'reply-1', 2000, 'a reply')!
    const result = deleteCommentEntryNode(withReply, 'reply-1')!

    const found = findCommentThread(result, 'c1')!
    expect(found.node.childCount).toBe(1)
    expect(found.node.child(0).attrs.id).toBe('c1')
  })

  it('deleteCommentEntryNode removes the whole thread when deleting its only (top-level) entry', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const result = deleteCommentEntryNode(withThread, 'c1')!

    expect(findCommentThread(result, 'c1')).toBeNull()
  })

  it('deleteCommentThreadNode removes every entry, replies included, in one go', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const withReply = addCommentThreadEntryNode(withThread, 'c1', 'reply-1', 2000, 'a reply')!
    const result = deleteCommentThreadNode(withReply, 'c1')!

    expect(findCommentThread(result, 'c1')).toBeNull()
    expect(result.textContent).not.toContain('a reply')
  })

  it('deleteCommentThreadNode/deleteCommentEntryNode return null for an id that no longer exists, rather than throwing', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(deleteCommentThreadNode(doc, 'missing')).toBeNull()
    expect(deleteCommentEntryNode(doc, 'missing')).toBeNull()
  })

  it('a comment_thread can nest inside another entry\'s own content (comment on a span within a comment)', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withThread = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original text')
    const entry = findCommentThread(withThread, 'c1')!.node.firstChild!
    // Position right at the end of the top-level entry's own text — a
    // stand-in for "right after a comment_anchor mark placed inside this
    // entry's body," which is how the real UI will reach this position.
    const entryTextEnd = findCommentThread(withThread, 'c1')!.pos + 1 + entry.nodeSize - 1
    const result = insertCommentThreadNode(withThread, entryTextEnd, 'nested-1', 'margin', 2000, 'a note on that comment')

    expect(findCommentThread(result, 'c1')).not.toBeNull()
    const nested = findCommentThread(result, 'nested-1')
    expect(nested).not.toBeNull()
    expect(nested!.node.textContent).toBe('a note on that comment')
  })
})
