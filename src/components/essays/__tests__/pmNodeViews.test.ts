import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { essaySchema } from '../../../lib/pmSchema'
import { CommentThreadView, findCommentThreadMarker } from '../pmNodeViews'

function commentThreadNode(id: string): PMNode {
  return essaySchema.nodes.comment_thread.create({ id, resolved: false, createdAt: 0, updatedAt: 0, displayMode: 'margin' }, essaySchema.text('a comment'))
}

/**
 * Builds a real, minimal top-level-containing doc around `node` (a
 * section with just a title and one paragraph holding `node`), and a
 * stand-in `EditorView` good enough for `CommentThreadView`'s own
 * constructor — which reads `view.state.doc.resolve(getPos())` once, via
 * `isTopLevel()`, to decide the marker's initial visibility, but never
 * anything else while just building its DOM (every button handler that
 * reads more of `view` only runs on a later click, which none of these
 * tests trigger).
 */
function wrapTopLevel(node: PMNode): { view: EditorView; getPos: () => number } {
  const doc = essaySchema.nodes.doc.create(null, essaySchema.nodes.section.create({ id: 'r' }, [essaySchema.nodes.section_title.create(), essaySchema.nodes.paragraph.create(null, node)]))
  let pos = -1
  doc.descendants((n, p) => {
    if (n === node) pos = p
  })
  const view = { state: { doc } } as unknown as EditorView
  return { view, getPos: () => pos }
}

describe('findCommentThreadMarker', () => {
  it("finds a comment_thread's own marker by id, inside an arbitrary ancestor element", () => {
    const node = commentThreadNode('c1')
    const { view, getPos } = wrapTopLevel(node)
    const commentView = new CommentThreadView(node, view, getPos)
    const container = document.createElement('div')
    container.appendChild(commentView.dom)

    const found = findCommentThreadMarker(container, 'c1')
    expect(found).not.toBeNull()
    expect(found!.className).toBe('pm-comment-thread-marker')
  })

  it('returns null for an id that has no comment_thread marker at all', () => {
    const node = commentThreadNode('c1')
    const { view, getPos } = wrapTopLevel(node)
    const commentView = new CommentThreadView(node, view, getPos)
    const container = document.createElement('div')
    container.appendChild(commentView.dom)

    expect(findCommentThreadMarker(container, 'nonexistent')).toBeNull()
  })

  it("the data-comment-id attribute lives on the marker span itself, never on the outer <comment-thread> tag — a selector written as if it sat on the outer tag (the exact regression this guards) would silently match nothing", () => {
    const node = commentThreadNode('c1')
    const { view, getPos } = wrapTopLevel(node)
    const commentView = new CommentThreadView(node, view, getPos)
    const container = document.createElement('div')
    container.appendChild(commentView.dom)

    expect(commentView.dom.getAttribute('data-comment-id')).toBeNull()
    expect(container.querySelector('comment-thread[data-comment-id="c1"] > .pm-comment-thread-marker')).toBeNull()
    expect(findCommentThreadMarker(container, 'c1')).not.toBeNull()
  })

  it('distinguishes two different comments by id, even when both markers sit under the same ancestor', () => {
    const nodeA = commentThreadNode('c1')
    const nodeB = commentThreadNode('c2')
    const viewA = new CommentThreadView(nodeA, wrapTopLevel(nodeA).view, wrapTopLevel(nodeA).getPos)
    const viewB = new CommentThreadView(nodeB, wrapTopLevel(nodeB).view, wrapTopLevel(nodeB).getPos)
    const container = document.createElement('div')
    container.appendChild(viewA.dom)
    container.appendChild(viewB.dom)

    expect(findCommentThreadMarker(container, 'c1')).not.toBe(findCommentThreadMarker(container, 'c2'))
    expect(findCommentThreadMarker(container, 'c1')?.dataset.commentId).toBe('c1')
    expect(findCommentThreadMarker(container, 'c2')?.dataset.commentId).toBe('c2')
  })
})
