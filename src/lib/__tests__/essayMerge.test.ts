import { describe, expect, it } from 'vitest'
import { mergeEssayContent, type EssayMergeSnapshot } from '../essayMerge'
import type { Comment } from '../../models/types'

const ROOT_ID = 'root-section'

function paragraph(text: string) {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id, collapsed: false }, content: [{ type: 'section_title', content: title ? [{ type: 'text', text: title }] : [] }, ...children] }
}

function doc(rootChildren: unknown[]) {
  return { type: 'doc', content: [section(ROOT_ID, 'Essay Title', rootChildren)] }
}

function snapshot(partial: Partial<EssayMergeSnapshot> & { updatedAt: number }): EssayMergeSnapshot & { updatedAt: number } {
  return { title: 'Essay Title', doc: doc([paragraph('base text')]), comments: [], ...partial }
}

function comment(partial: Partial<Comment> & { id: string; updatedAt: number }): Comment {
  return { parentId: null, anchorKind: 'node', anchorText: '', body: '', resolved: false, createdAt: partial.updatedAt, ...partial }
}

/** Pulls out the root section's own children (everything after its title) as a plain array, for assertions that don't care about the title node itself. */
function rootChildren(d: unknown): unknown[] {
  const root = (d as { content: { content: unknown[] }[] }).content[0]
  return root.content.slice(1)
}

describe('mergeEssayContent — doc (section-tree) merging', () => {
  it('keeps two independently-added sections from a shared base, from both sides, when each lands in a distinguishable gap', () => {
    // Each side's new section is anchored next to an *existing*, unchanged
    // section the other side can line up by content — local's goes right
    // after "First", remote's right after "Second" — so there's no
    // ambiguity about where either one belongs relative to the other.
    // (Two insertions at the exact *same* gap, with nothing distinguishing
    // their position, is a genuine ambiguity no three-way merge can
    // resolve for free — covered separately below.)
    const base = snapshot({ updatedAt: 100, doc: doc([section('first', 'First', [paragraph('f')]), section('second', 'Second', [paragraph('s')])]) })
    const local = snapshot({
      updatedAt: 200,
      doc: doc([
        section('first', 'First', [paragraph('f')]),
        section('s-local', 'Local section', [paragraph('added by local')]),
        section('second', 'Second', [paragraph('s')]),
      ]),
    })
    const remote = snapshot({
      updatedAt: 150,
      doc: doc([section('first', 'First', [paragraph('f')]), section('second', 'Second', [paragraph('s')]), section('s-remote', 'Remote section', [paragraph('added by remote')])]),
    })

    const result = mergeEssayContent(base, local, remote)
    expect(result.conflicts).toEqual([])
    const ids = rootChildren(result.doc)
      .filter((c): c is { type: string; attrs: { id: string } } => (c as { type: string }).type === 'section')
      .map((c) => c.attrs.id)
    expect(ids).toEqual(['first', 's-local', 'second', 's-remote'])
  })

  it('a brand-new section added by both sides at the exact same, otherwise-unanchored position is a genuine conflict — the newer one stays live, the other is preserved', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([paragraph('base text')]) })
    const local = snapshot({ updatedAt: 200, doc: doc([paragraph('base text'), section('s-local', 'Local section', [paragraph('added by local')])]) })
    const remote = snapshot({ updatedAt: 150, doc: doc([paragraph('base text'), section('s-remote', 'Remote section', [paragraph('added by remote')])]) })

    const result = mergeEssayContent(base, local, remote)
    const ids = rootChildren(result.doc)
      .filter((c): c is { type: string; attrs: { id: string } } => (c as { type: string }).type === 'section')
      .map((c) => c.attrs.id)
    expect(ids).toEqual(['s-local']) // local is newer
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].nodes).toEqual([section('s-remote', 'Remote section', [paragraph('added by remote')])])
  })

  it('keeps edits to two different sections, made on two different devices, without either clobbering the other', () => {
    const base = snapshot({
      updatedAt: 100,
      doc: doc([section('sec-a', 'Section A', [paragraph('original A')]), section('sec-b', 'Section B', [paragraph('original B')])]),
    })
    const local = snapshot({
      updatedAt: 200,
      doc: doc([section('sec-a', 'Section A', [paragraph('A edited locally')]), section('sec-b', 'Section B', [paragraph('original B')])]),
    })
    const remote = snapshot({
      updatedAt: 190,
      doc: doc([section('sec-a', 'Section A', [paragraph('original A')]), section('sec-b', 'Section B', [paragraph('B edited remotely')])]),
    })

    const result = mergeEssayContent(base, local, remote)
    expect(result.conflicts).toEqual([])
    const sections = rootChildren(result.doc) as { attrs: { id: string }; content: { content?: { text?: string }[] }[] }[]
    const a = sections.find((s) => s.attrs.id === 'sec-a')!
    const b = sections.find((s) => s.attrs.id === 'sec-b')!
    expect(a.content[1].content?.[0]?.text).toBe('A edited locally')
    expect(b.content[1].content?.[0]?.text).toBe('B edited remotely')
  })

  it('a genuine conflict (the same paragraph edited differently on both sides) keeps the newer side live and preserves the older side as a conflict fragment', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([paragraph('original')]) })
    const local = snapshot({ updatedAt: 300, doc: doc([paragraph('local version')]) })
    const remote = snapshot({ updatedAt: 200, doc: doc([paragraph('remote version')]) })

    const result = mergeEssayContent(base, local, remote)
    const children = rootChildren(result.doc) as { content?: { text?: string }[] }[]
    expect(children).toHaveLength(1)
    expect(children[0].content?.[0]?.text).toBe('local version') // local is newer

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].nodes).toEqual([paragraph('remote version')])
  })

  it('the older side wins the live document when it is actually newer, and the local edit is preserved instead', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([paragraph('original')]) })
    const local = snapshot({ updatedAt: 150, doc: doc([paragraph('local version')]) })
    const remote = snapshot({ updatedAt: 400, doc: doc([paragraph('remote version')]) })

    const result = mergeEssayContent(base, local, remote)
    const children = rootChildren(result.doc) as { content?: { text?: string }[] }[]
    expect(children[0].content?.[0]?.text).toBe('remote version')
    expect(result.conflicts[0].nodes).toEqual([paragraph('local version')])
  })

  it('a section only edited on one side (the other left it untouched) is not a conflict', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([paragraph('original')]) })
    const local = snapshot({ updatedAt: 200, doc: doc([paragraph('edited locally')]) })
    const remote = snapshot({ updatedAt: 150, doc: doc([paragraph('original')]) }) // unchanged

    const result = mergeEssayContent(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(rootChildren(result.doc)).toEqual([paragraph('edited locally')])
  })

  it('both sides independently making the exact same edit is not a conflict', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([paragraph('original')]) })
    const local = snapshot({ updatedAt: 200, doc: doc([paragraph('same new text')]) })
    const remote = snapshot({ updatedAt: 250, doc: doc([paragraph('same new text')]) })

    const result = mergeEssayContent(base, local, remote)
    expect(result.conflicts).toEqual([])
    expect(rootChildren(result.doc)).toEqual([paragraph('same new text')])
  })

  it('a section deleted on one side and untouched on the other is removed, without being reported as a conflict', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([section('keep', 'Keep', [paragraph('x')]), section('drop', 'Drop', [paragraph('y')])]) })
    const local = snapshot({ updatedAt: 200, doc: doc([section('keep', 'Keep', [paragraph('x')])]) }) // deleted "drop"
    const remote = snapshot({ updatedAt: 150, doc: doc([section('keep', 'Keep', [paragraph('x')]), section('drop', 'Drop', [paragraph('y')])]) })

    const result = mergeEssayContent(base, local, remote)
    expect(result.conflicts).toEqual([])
    const ids = (rootChildren(result.doc) as { attrs: { id: string } }[]).map((s) => s.attrs.id)
    expect(ids).toEqual(['keep'])
  })

  it('falls back to picking the newer whole essay, with no conflict bookkeeping, when there is no base to diff against (bootstrap case)', () => {
    const local = snapshot({ updatedAt: 500, doc: doc([paragraph('local content')]) })
    const remote = snapshot({ updatedAt: 100, doc: doc([paragraph('remote content')]) })

    const result = mergeEssayContent(null, local, remote)
    expect(result.conflicts).toEqual([])
    expect(rootChildren(result.doc)).toEqual([paragraph('local content')])
  })

  it('merges a nested (sub-sub-section) edit alongside a sibling edit', () => {
    const base = snapshot({
      updatedAt: 100,
      doc: doc([section('parent', 'Parent', [section('child', 'Child', [paragraph('child original')])]), section('sibling', 'Sibling', [paragraph('sibling original')])]),
    })
    const local = snapshot({
      updatedAt: 200,
      doc: doc([
        section('parent', 'Parent', [section('child', 'Child', [paragraph('child edited locally')])]),
        section('sibling', 'Sibling', [paragraph('sibling original')]),
      ]),
    })
    const remote = snapshot({
      updatedAt: 190,
      doc: doc([section('parent', 'Parent', [section('child', 'Child', [paragraph('child original')])]), section('sibling', 'Sibling', [paragraph('sibling edited remotely')])]),
    })

    const result = mergeEssayContent(base, local, remote)
    expect(result.conflicts).toEqual([])
    const top = rootChildren(result.doc) as { attrs: { id: string }; content: unknown[] }[]
    const parent = top.find((s) => s.attrs.id === 'parent')!
    const child = parent.content[1] as { content: { content?: { text?: string }[] }[] }
    expect(child.content[1].content?.[0]?.text).toBe('child edited locally')
    const sibling = top.find((s) => s.attrs.id === 'sibling')! as { content: { content?: { text?: string }[] }[] }
    expect(sibling.content[1].content?.[0]?.text).toBe('sibling edited remotely')
  })
})

describe('mergeEssayContent — comments', () => {
  it('keeps comments added independently on both sides', () => {
    const base = snapshot({ updatedAt: 100, comments: [] })
    const local = snapshot({ updatedAt: 200, comments: [comment({ id: 'c-local', updatedAt: 200, body: 'from local' })] })
    const remote = snapshot({ updatedAt: 150, comments: [comment({ id: 'c-remote', updatedAt: 150, body: 'from remote' })] })

    const result = mergeEssayContent(base, local, remote)
    expect(result.comments.map((c) => c.id).sort()).toEqual(['c-local', 'c-remote'])
  })

  it('a comment edited on only one side keeps that edit', () => {
    const shared = comment({ id: 'c1', updatedAt: 100, body: 'original' })
    const base = snapshot({ updatedAt: 100, comments: [shared] })
    const edited = { ...shared, body: 'edited locally', updatedAt: 200 }
    const local = snapshot({ updatedAt: 200, comments: [edited] })
    const remote = snapshot({ updatedAt: 150, comments: [shared] })

    const result = mergeEssayContent(base, local, remote)
    expect(result.comments).toEqual([edited])
  })

  it('an edit beats a concurrent delete of the same comment', () => {
    const shared = comment({ id: 'c1', updatedAt: 100, body: 'original' })
    const base = snapshot({ updatedAt: 100, comments: [shared] })
    const local = snapshot({ updatedAt: 200, comments: [] }) // deleted locally
    const remoteEdit = { ...shared, body: 'edited remotely', updatedAt: 150 }
    const remote = snapshot({ updatedAt: 150, comments: [remoteEdit] })

    const result = mergeEssayContent(base, local, remote)
    expect(result.comments).toEqual([remoteEdit])
  })

  it('a comment deleted on one side and left untouched on the other is removed', () => {
    const shared = comment({ id: 'c1', updatedAt: 100, body: 'original' })
    const base = snapshot({ updatedAt: 100, comments: [shared] })
    const local = snapshot({ updatedAt: 200, comments: [] })
    const remote = snapshot({ updatedAt: 150, comments: [shared] })

    const result = mergeEssayContent(base, local, remote)
    expect(result.comments).toEqual([])
  })

  it('a comment deleted on both sides stays gone', () => {
    const shared = comment({ id: 'c1', updatedAt: 100, body: 'original' })
    const base = snapshot({ updatedAt: 100, comments: [shared] })
    const local = snapshot({ updatedAt: 200, comments: [] })
    const remote = snapshot({ updatedAt: 150, comments: [] })

    const result = mergeEssayContent(base, local, remote)
    expect(result.comments).toEqual([])
  })

  it('a comment edited differently on both sides resolves to its own newer updatedAt, not the whole essay’s', () => {
    const shared = comment({ id: 'c1', updatedAt: 100, body: 'original' })
    const base = snapshot({ updatedAt: 100, comments: [shared] })
    // The whole *essay* is "older" on the local side, but this particular
    // comment's own edit is newer than the remote's — the comment's own
    // timestamp should win, not the essay-level one.
    const localCommentEdit = { ...shared, body: 'local edit (comment newer)', updatedAt: 500 }
    const local = snapshot({ updatedAt: 110, comments: [localCommentEdit] })
    const remoteCommentEdit = { ...shared, body: 'remote edit (comment older)', updatedAt: 300 }
    const remote = snapshot({ updatedAt: 900, comments: [remoteCommentEdit] })

    const result = mergeEssayContent(base, local, remote)
    expect(result.comments).toEqual([localCommentEdit])
  })
})

describe('mergeEssayContent — title/authorNote scalar fields', () => {
  it('propagates a title change made on only one side', () => {
    const base = snapshot({ updatedAt: 100, title: 'Original Title' })
    const local = snapshot({ updatedAt: 200, title: 'Original Title' })
    const remote = snapshot({ updatedAt: 150, title: 'Renamed Remotely' })

    const result = mergeEssayContent(base, local, remote)
    expect(result.title).toBe('Renamed Remotely')
  })

  it('a title changed differently on both sides resolves to the newer essay’s title', () => {
    const base = snapshot({ updatedAt: 100, title: 'Original Title' })
    const local = snapshot({ updatedAt: 300, title: 'Local Title' })
    const remote = snapshot({ updatedAt: 150, title: 'Remote Title' })

    const result = mergeEssayContent(base, local, remote)
    expect(result.title).toBe('Local Title')
  })

  it('merges an independent authorNote change alongside an independent title change', () => {
    const base = snapshot({ updatedAt: 100, title: 'T', authorNote: 'original note' })
    const local = snapshot({ updatedAt: 200, title: 'New Title', authorNote: 'original note' })
    const remote = snapshot({ updatedAt: 150, title: 'T', authorNote: 'new note' })

    const result = mergeEssayContent(base, local, remote)
    expect(result.title).toBe('New Title')
    expect(result.authorNote).toBe('new note')
  })
})

describe('mergeEssayContent — deleted ("edit beats delete")', () => {
  it('a delete on one side wins when the other side made no real edit', () => {
    const base = snapshot({ updatedAt: 100 })
    const local = snapshot({ updatedAt: 200, deleted: true })
    const remote = snapshot({ updatedAt: 150 }) // untouched

    const result = mergeEssayContent(base, local, remote)
    expect(result.deleted).toBe(true)
  })

  it('a concurrent real edit survives a delete on the other side (undeleted)', () => {
    const base = snapshot({ updatedAt: 100, doc: doc([paragraph('original')]) })
    const local = snapshot({ updatedAt: 500, deleted: true, doc: base.doc }) // deleted locally, made no other edit
    const remote = snapshot({ updatedAt: 200, doc: doc([paragraph('a real edit')]) }) // edited, not deleted

    const result = mergeEssayContent(base, local, remote)
    expect(result.deleted).toBe(false)
    expect(rootChildren(result.doc)).toEqual([paragraph('a real edit')])
  })

  it('deleted on both sides stays deleted', () => {
    const base = snapshot({ updatedAt: 100 })
    const local = snapshot({ updatedAt: 200, deleted: true })
    const remote = snapshot({ updatedAt: 150, deleted: true })

    const result = mergeEssayContent(base, local, remote)
    expect(result.deleted).toBe(true)
  })

  it('undeleted on both sides (after having been deleted in the base) stays undeleted', () => {
    const base = snapshot({ updatedAt: 100, deleted: true })
    const local = snapshot({ updatedAt: 200, deleted: false })
    const remote = snapshot({ updatedAt: 150, deleted: false })

    const result = mergeEssayContent(base, local, remote)
    expect(result.deleted).toBe(false)
  })
})
