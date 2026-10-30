import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { essaySchema } from '../../../lib/pmSchema'
import {
  findCommentThread,
  insertCommentThreadNode,
  commentThreadContentEndPos,
  setCommentThreadResolvedNode,
  setCommentThreadDisplayModeNode,
  deleteCommentThreadNode,
  topLevelCommentThreads,
  commentAnchorText,
  beginCommentThread,
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
 * Unit coverage for the `comment_thread` mutators in `pmCommands.ts` — the
 * pure, headless-safe half of the fix for a comment (its own body, plus
 * every reply and comment-on-a-span nested inside it) living as real
 * document content instead of a separate side array (see `pmSchema.ts`'s
 * own doc comment). A reply is modeled as just another `comment_thread`
 * nested inside its parent's own content — there is no separate "entry"
 * concept, so these tests exercise that directly: inserting a reply is the
 * exact same `insertCommentThreadNode` call as inserting a top-level
 * comment, just targeting a position inside an existing thread.
 */
describe('comment_thread mutators', () => {
  it('insertCommentThreadNode splices a new top-level comment in at the given position', () => {
    const doc = parse(docJson([paragraph('hello world')]))
    const pos = doc.content.size - 1 // end of the paragraph's own text
    const result = insertCommentThreadNode(doc, pos, 'c1', 'margin', 1000, 'a real comment')

    const found = findCommentThread(result, 'c1')
    expect(found).not.toBeNull()
    expect(found!.node.attrs).toMatchObject({ id: 'c1', displayMode: 'margin', resolved: false, createdAt: 1000, updatedAt: 1000 })
    expect(found!.node.textContent).toBe('a real comment')
  })

  it('insertCommentThreadNode seeds an empty comment with a zero-width placeholder, not truly empty content', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const result = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'inline', 1000)
    const found = findCommentThread(result, 'c1')!
    expect(found.node.textContent.length).toBeGreaterThan(0)
  })

  it('findCommentThread returns null when no comment with that id exists', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(findCommentThread(doc, 'missing')).toBeNull()
  })

  it('a reply is just another comment_thread nested at the end of its parent\'s own content', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const replyPos = commentThreadContentEndPos(withComment, 'c1')!
    const result = insertCommentThreadNode(withComment, replyPos, 'reply-1', 'margin', 2000, 'a reply')

    const parent = findCommentThread(result, 'c1')!
    expect(parent.node.textContent).toBe('original' + 'a reply')
    const reply = findCommentThread(result, 'reply-1')
    expect(reply).not.toBeNull()
    expect(reply!.node.textContent).toBe('a reply')
  })

  it('"comment on a span within this comment" is the same operation, anchored partway through the parent\'s own text', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'some original text')
    const parent = findCommentThread(withComment, 'c1')!
    // Land the nested comment partway through the parent's own text, not
    // just at the very end — confirming nesting isn't limited to
    // append-only replies.
    const midPos = parent.pos + 1 + 4
    const result = insertCommentThreadNode(withComment, midPos, 'nested-1', 'margin', 2000, 'a note on that')

    expect(findCommentThread(result, 'c1')).not.toBeNull()
    const nested = findCommentThread(result, 'nested-1')
    expect(nested).not.toBeNull()
    expect(nested!.node.textContent).toBe('a note on that')
  })

  it('commentThreadContentEndPos returns null for a comment that no longer exists', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(commentThreadContentEndPos(doc, 'missing')).toBeNull()
  })

  it('setCommentThreadResolvedNode toggles resolved on one comment without touching a nested reply', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const replyPos = commentThreadContentEndPos(withComment, 'c1')!
    const withReply = insertCommentThreadNode(withComment, replyPos, 'reply-1', 'margin', 2000, 'a reply')
    const result = setCommentThreadResolvedNode(withReply, 'c1', true, 3000)!

    expect(findCommentThread(result, 'c1')!.node.attrs).toMatchObject({ resolved: true, updatedAt: 3000 })
    expect(findCommentThread(result, 'reply-1')!.node.attrs.resolved).toBe(false)
  })

  it('setCommentThreadResolvedNode can resolve a reply independently of its parent comment', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const replyPos = commentThreadContentEndPos(withComment, 'c1')!
    const withReply = insertCommentThreadNode(withComment, replyPos, 'reply-1', 'margin', 2000, 'a reply')
    const result = setCommentThreadResolvedNode(withReply, 'reply-1', true, 3000)!

    expect(findCommentThread(result, 'c1')!.node.attrs.resolved).toBe(false)
    expect(findCommentThread(result, 'reply-1')!.node.attrs.resolved).toBe(true)
  })

  it('setCommentThreadResolvedNode returns null for a comment that no longer exists', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(setCommentThreadResolvedNode(doc, 'missing', true, 1000)).toBeNull()
  })

  it('setCommentThreadDisplayModeNode toggles margin/inline on the matching comment only', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const result = setCommentThreadDisplayModeNode(withComment, 'c1', 'inline')!
    expect(findCommentThread(result, 'c1')!.node.attrs.displayMode).toBe('inline')
  })

  it('deleteCommentThreadNode removes a leaf comment with no replies', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const result = deleteCommentThreadNode(withComment, 'c1')!
    expect(findCommentThread(result, 'c1')).toBeNull()
  })

  it('deleteCommentThreadNode on a parent removes its nested replies too (subtree deletion, for free)', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const replyPos = commentThreadContentEndPos(withComment, 'c1')!
    const withReply = insertCommentThreadNode(withComment, replyPos, 'reply-1', 'margin', 2000, 'a reply')
    const result = deleteCommentThreadNode(withReply, 'c1')!

    expect(findCommentThread(result, 'c1')).toBeNull()
    expect(findCommentThread(result, 'reply-1')).toBeNull()
    expect(result.textContent).not.toContain('a reply')
  })

  it('deleteCommentThreadNode on a reply only removes that reply, leaving its parent and siblings intact', () => {
    const doc = parse(docJson([paragraph('hi')]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'original')
    const reply1Pos = commentThreadContentEndPos(withComment, 'c1')!
    const withReply1 = insertCommentThreadNode(withComment, reply1Pos, 'reply-1', 'margin', 2000, 'first reply')
    const reply2Pos = commentThreadContentEndPos(withReply1, 'c1')!
    const withReply2 = insertCommentThreadNode(withReply1, reply2Pos, 'reply-2', 'margin', 3000, 'second reply')

    const result = deleteCommentThreadNode(withReply2, 'reply-1')!

    expect(findCommentThread(result, 'c1')).not.toBeNull()
    expect(findCommentThread(result, 'reply-1')).toBeNull()
    expect(findCommentThread(result, 'reply-2')).not.toBeNull()
  })

  it('deleteCommentThreadNode returns null for a comment that no longer exists, rather than throwing', () => {
    const doc = parse(docJson([paragraph('hi')]))
    expect(deleteCommentThreadNode(doc, 'missing')).toBeNull()
  })

  it('deleteCommentThreadNode also strips the comment_anchor mark over the originally-commented-on text, keeping the text itself', () => {
    const doc = parse(docJson([paragraph('some highlighted text', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }])]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'a comment')
    const result = deleteCommentThreadNode(withComment, 'c1')!

    expect(findCommentThread(result, 'c1')).toBeNull()
    expect(result.textContent).toContain('some highlighted text')
    let stillMarked = false
    result.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'comment_anchor' && m.attrs.commentId === 'c1')) stillMarked = true
    })
    expect(stillMarked).toBe(false)
  })

  it('deleteCommentThreadNode removes the zero-width comment_anchor placeholder outright for an inline (nothing-selected) comment', () => {
    const doc = parse(docJson([paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }])]))
    const withComment = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'inline', 1000, 'a comment')
    const result = deleteCommentThreadNode(withComment, 'c1')!

    expect(findCommentThread(result, 'c1')).toBeNull()
    expect(result.textContent).not.toContain('​')
  })

  it('topLevelCommentThreads finds every top-level comment but excludes nested replies/comments-on-a-span', () => {
    const doc = parse(docJson([paragraph('hi'), paragraph('there')]))
    const withC1 = insertCommentThreadNode(doc, doc.content.size - 1, 'c1', 'margin', 1000, 'first')
    const withC2 = insertCommentThreadNode(withC1, withC1.content.size - 1, 'c2', 'margin', 1500, 'second')
    const replyPos = commentThreadContentEndPos(withC2, 'c1')!
    const withReply = insertCommentThreadNode(withC2, replyPos, 'reply-1', 'inline', 2000, 'a reply')

    const top = topLevelCommentThreads(withReply)
    const ids = top.map((t) => t.node.attrs.id).sort()
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('commentAnchorText returns the live, current text of a real (non-empty) anchor', () => {
    const doc = parse(docJson([paragraph('some highlighted text', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }])]))
    expect(commentAnchorText(doc, 'c1')).toBe('some highlighted text')
  })

  it('commentAnchorText returns empty string for a zero-width (nothing-selected) anchor, and null for no anchor at all', () => {
    const docWithEmptyAnchor = parse(docJson([paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }])]))
    expect(commentAnchorText(docWithEmptyAnchor, 'c1')).toBe('')
    const docWithNoAnchor = parse(docJson([paragraph('hi')]))
    expect(commentAnchorText(docWithNoAnchor, 'c1')).toBeNull()
  })
})

/**
 * A minimal stand-in for a real `EditorView` — `beginCommentThread` only
 * ever reads `view.state`, calls `view.dispatch(tr)` once, and calls
 * `view.focus()` — so a plain object with exactly those members, backed by
 * a real (DOM-free) `EditorState`, exercises the function's actual
 * position/selection math without needing a real mounted `EditorView`
 * (which this project's test suite doesn't otherwise construct at all).
 */
function fakeView(doc: PMNode, selectionFrom: number, selectionTo = selectionFrom): { view: EditorView; getTransaction: () => Transaction } {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, selectionFrom, selectionTo) })
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

describe('beginCommentThread — cursor placement', () => {
  it("lands the main editor's own selection right after the whole node for a margin comment, never inside its (hidden-in-the-main-document) content", () => {
    const doc = parse(docJson([paragraph('hello world')]))
    const pos = doc.content.size - 1
    const { view, getTransaction } = fakeView(doc, pos, pos)
    beginCommentThread(view, 'margin')
    const tr = getTransaction()
    // Find the real comment_thread node's position dynamically rather than hardcoding an id (beginCommentThread mints a fresh uuid).
    let threadId = ''
    let threadPos = -1
    let threadNodeSize = 0
    tr.doc.descendants((n, p) => {
      if (n.type.name === 'comment_thread') {
        threadId = n.attrs.id
        threadPos = p
        threadNodeSize = n.nodeSize
      }
    })
    expect(threadId).not.toBe('')
    expect(tr.selection.from).toBe(threadPos + threadNodeSize)
  })

  it("lands the selection *inside* the new node's own content for an inline (nothing-selected) comment with no seed text — ready to type directly, since its content is visible right there", () => {
    const doc = parse(docJson([paragraph('hello world')]))
    const pos = doc.content.size - 1
    const { view, getTransaction } = fakeView(doc, pos, pos)
    beginCommentThread(view, 'inline')
    const tr = getTransaction()
    let threadPos = -1
    tr.doc.descendants((n, p) => {
      if (n.type.name === 'comment_thread') threadPos = p
    })
    expect(tr.selection.from).toBe(threadPos + 1)
  })

  it('lands the selection right after the whole node for an inline comment too, when seed text is given', () => {
    const doc = parse(docJson([paragraph('hello world')]))
    const pos = doc.content.size - 1
    const { view, getTransaction } = fakeView(doc, pos, pos)
    beginCommentThread(view, 'inline', undefined, undefined, 'seeded text')
    const tr = getTransaction()
    let threadPos = -1
    let threadNodeSize = 0
    tr.doc.descendants((n, p) => {
      if (n.type.name === 'comment_thread') {
        threadPos = p
        threadNodeSize = n.nodeSize
      }
    })
    expect(tr.selection.from).toBe(threadPos + threadNodeSize)
  })
})
