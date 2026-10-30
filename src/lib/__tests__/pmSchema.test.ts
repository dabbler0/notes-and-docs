import { describe, expect, it } from 'vitest'
import { essayDocFromJSON, essaySchema } from '../pmSchema'

function docWith(content: unknown[]): unknown {
  return { type: 'doc', content: [{ type: 'section', attrs: { id: 'root' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'Essay' }] }, ...content] }] }
}

describe('essayDocFromJSON', () => {
  it('parses an ordinary document with no legacy marks exactly like Node.fromJSON would', () => {
    const doc = docWith([{ type: 'paragraph', content: [{ type: 'text', text: 'Plain prose.' }] }])
    const result = essayDocFromJSON(doc)
    expect(result.textContent).toContain('Plain prose.')
  })

  it('converts a legacy comment_text-marked span into a real comment_thread node, instead of throwing "no mark type comment_text"', () => {
    const doc = docWith([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Before. ' },
          { type: 'text', text: 'Comment body.', marks: [{ type: 'comment_text', attrs: { commentId: 'c1' } }] },
          { type: 'text', text: ' After.' },
        ],
      },
    ])
    // Node.fromJSON(essaySchema, doc) would throw here — that's the bug being fixed.
    const result = essayDocFromJSON(doc)
    let found: ReturnType<typeof essayDocFromJSON> | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread' && n.attrs.id === 'c1') found = n
    })
    expect(found).not.toBeNull()
    expect(found!.textContent).toBe('Comment body.')
    expect(result.textContent).toContain('Before. Comment body. After.')
  })

  it('merges adjacent comment_text runs sharing the same commentId (e.g. a partially-bolded body) into one comment_thread node', () => {
    const doc = docWith([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'plain ', marks: [{ type: 'comment_text', attrs: { commentId: 'c1' } }] },
          { type: 'text', text: 'bold', marks: [{ type: 'comment_text', attrs: { commentId: 'c1' } }, { type: 'strong' }] },
          { type: 'text', text: ' tail', marks: [{ type: 'comment_text', attrs: { commentId: 'c1' } }] },
        ],
      },
    ])
    const result = essayDocFromJSON(doc)
    let threadCount = 0
    let found: ReturnType<typeof essayDocFromJSON> | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread') {
        threadCount++
        found = n
      }
    })
    expect(threadCount).toBe(1)
    expect(found!.textContent).toBe('plain bold tail')
    // The strong mark on "bold" survives the conversion; comment_text itself is gone from the schema so it can't be checked for directly, but a successful parse at all proves it was stripped.
    let sawStrong = false
    found!.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strong')) sawStrong = true
    })
    expect(sawStrong).toBe(true)
  })

  it('keeps two different comment ids as two separate comment_thread nodes, even when adjacent', () => {
    const doc = docWith([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'first', marks: [{ type: 'comment_text', attrs: { commentId: 'c1' } }] },
          { type: 'text', text: 'second', marks: [{ type: 'comment_text', attrs: { commentId: 'c2' } }] },
        ],
      },
    ])
    const result = essayDocFromJSON(doc)
    const ids: string[] = []
    result.descendants((n) => {
      if (n.type.name === 'comment_thread') ids.push(n.attrs.id)
    })
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('round-trips the sanitized doc back to real schema-valid JSON', () => {
    const doc = docWith([{ type: 'paragraph', content: [{ type: 'text', text: 'body', marks: [{ type: 'comment_text', attrs: { commentId: 'c1' } }] }] }])
    const result = essayDocFromJSON(doc)
    const roundTripped = essaySchema.nodeFromJSON(result.toJSON())
    expect(roundTripped.eq(result)).toBe(true)
  })
})
