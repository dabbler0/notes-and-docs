import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema } from '../../../lib/pmSchema'
import { repairMissingInlineCommentBodies, commentTextRange } from '../pmCommands'
import type { Comment } from '../../../models/types'

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

function comment(partial: Partial<Comment> & { id: string }): Comment {
  return { parentId: null, anchorKind: 'text', anchorText: '', body: '', displayMode: 'inline', resolved: false, createdAt: 1, updatedAt: 1, ...partial }
}

/**
 * Regression coverage for a real, confirmed-live bug: every inline
 * top-level comment created before live in-document comment bodies
 * existed has its own body sitting inertly in `Comment.body`, with no
 * `comment_text` span ever inserted for it — its own anchor still renders
 * fine, but its written content is reachable nowhere at all (not in the
 * document, not in the margin, since `CommentsPanel.tsx`'s own row filter
 * trusts an inline comment's body to already be live in the document).
 * `PMEssayEditor.tsx` calls `repairMissingInlineCommentBodies` once, right
 * after opening a record, to fix this going forward.
 */
describe('repairMissingInlineCommentBodies', () => {
  it('inserts a live comment_text span from a legacy comment’s own body, right after its anchor, and clears the now-redundant body', () => {
    // A legacy inline comment's own body was always plain text — typed
    // into the old composer's plain `<textarea>`, never rich HTML (that's
    // only ever true of a *margin* comment's own contentEditable body).
    const doc = parse(
      docJson([paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'legacy-1' } }]), paragraph('the rest of the paragraph')]),
    )
    const comments = [comment({ id: 'legacy-1', sectionId: ROOT_ID, body: 'An old comment, never migrated.' })]

    const result = repairMissingInlineCommentBodies(doc, comments)

    expect(result.changed).toBe(true)
    expect(commentTextRange(result.doc, 'legacy-1')).not.toBeNull()
    expect(result.doc.textContent).toContain('An old comment, never migrated.')
    expect(result.comments[0].body).toBe('')
  })

  it('leaves a comment unrepaired, without crashing the rest of the essay, if its body contains block-level HTML a comment_text mark cannot wrap', () => {
    const doc = parse(docJson([paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'odd-1' } }])]))
    const comments = [comment({ id: 'odd-1', sectionId: ROOT_ID, body: '<p>Somehow a block-level body ended up here.</p>' })]

    const result = repairMissingInlineCommentBodies(doc, comments)

    expect(result.changed).toBe(false)
    expect(result.comments[0].body).toBe('<p>Somehow a block-level body ended up here.</p>')
  })

  it('does nothing for a comment that already has a live comment_text span', () => {
    const doc = parse(
      docJson([
        paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }]),
        paragraph('already migrated', [{ type: 'comment_text', attrs: { commentId: 'c1' } }]),
      ]),
    )
    const comments = [comment({ id: 'c1', sectionId: ROOT_ID, body: 'stale leftover text that should be ignored' })]

    const result = repairMissingInlineCommentBodies(doc, comments)

    expect(result.changed).toBe(false)
    expect(result.doc).toBe(doc)
    expect(result.comments).toBe(comments)
    // The stale body is left alone too — not this function's job to erase
    // it once a real comment_text span already exists; it only ever acts
    // when there's genuinely nothing live to find instead.
    expect(result.comments[0].body).toBe('stale leftover text that should be ignored')
  })

  it('does nothing for a comment with an empty body (nothing worth migrating)', () => {
    const doc = parse(docJson([paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }])]))
    const comments = [comment({ id: 'c1', sectionId: ROOT_ID, body: '' })]

    const result = repairMissingInlineCommentBodies(doc, comments)
    expect(result.changed).toBe(false)
    expect(commentTextRange(result.doc, 'c1')).toBeNull()
  })

  it('does nothing for a margin comment (only inline-displayed top-level comments are migrated this way)', () => {
    const doc = parse(docJson([paragraph('some text', [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }])]))
    const comments = [comment({ id: 'c1', sectionId: ROOT_ID, body: 'a margin comment body', displayMode: 'margin' })]

    const result = repairMissingInlineCommentBodies(doc, comments)
    expect(result.changed).toBe(false)
  })

  it('does nothing for a reply (parentId set) even if it looks otherwise eligible', () => {
    const doc = parse(docJson([paragraph('some text')]))
    const comments = [comment({ id: 'reply-1', parentId: 'parent-1', body: 'a reply body' })]

    const result = repairMissingInlineCommentBodies(doc, comments)
    expect(result.changed).toBe(false)
  })

  it('leaves a comment untouched (no crash) when its own anchor no longer exists in the document', () => {
    const doc = parse(docJson([paragraph('no anchor here at all')]))
    const comments = [comment({ id: 'orphaned', sectionId: ROOT_ID, body: 'orphaned comment body' })]

    const result = repairMissingInlineCommentBodies(doc, comments)
    expect(result.changed).toBe(false)
    expect(result.comments[0].body).toBe('orphaned comment body')
  })

  it('repairs more than one legacy comment in the same document, each landing after its own anchor', () => {
    const doc = parse(
      docJson([
        paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'first' } }]),
        paragraph('​', [{ type: 'comment_anchor', attrs: { commentId: 'second' } }]),
      ]),
    )
    const comments = [
      comment({ id: 'first', sectionId: ROOT_ID, body: 'first legacy body' }),
      comment({ id: 'second', sectionId: ROOT_ID, body: 'second legacy body' }),
    ]

    const result = repairMissingInlineCommentBodies(doc, comments)

    expect(result.changed).toBe(true)
    expect(commentTextRange(result.doc, 'first')).not.toBeNull()
    expect(commentTextRange(result.doc, 'second')).not.toBeNull()
    expect(result.doc.textContent).toContain('first legacy body')
    expect(result.doc.textContent).toContain('second legacy body')
    expect(result.comments.map((c) => c.body)).toEqual(['', ''])
  })
})
