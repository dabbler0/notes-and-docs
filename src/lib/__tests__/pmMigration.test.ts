import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema as schema } from '../pmSchema'
import { buildLegacyNodeMap, foldCommentsIntoDoc, migrateEssay, migrateEssayHistory, migrateGraveyardFragment, pmSnapshotText, refoldEssayHistoryComments } from '../pmMigration'
import { diffSnapshots, reconstructSnapshotText } from '../essayHistory'
import { id } from '../id'
import type { Comment, Essay, EssayCommitEntry, EssayNode, GraveyardFragment, Source } from '../../models/types'

function essay(rootNodeId: string, title = 'Test Essay'): Pick<Essay, 'title' | 'rootNodeId'> {
  return { title, rootNodeId }
}

function node(overrides: Partial<EssayNode> & { id: string; draftContent: string }): EssayNode {
  return { essayId: 'e1', title: 'Untitled section', versions: [], headVersionId: '', createdAt: 0, updatedAt: 0, ...overrides }
}

function fragment(overrides: Partial<GraveyardFragment> & { id: string; nodeId: string; nodeTitle: string; html: string }): GraveyardFragment {
  return { essayId: 'e1', createdAt: 0, updatedAt: 0, ...overrides }
}

/** Round-trips `doc` through the real schema — throws if pmMigration.ts ever produces something structurally invalid. Every test calls this at least once; it's the real safety net here, more than any individual assertion. */
function assertValidDoc(doc: unknown): PMNode {
  return PMNode.fromJSON(schema, doc)
}

const smith: Source = { id: 'smith', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper' } }, comment: '', pageHtml: [], pageCount: 0, contentBytes: 0, createdAt: 0, updatedAt: 0 }
const sources = new Map([['smith', smith]])

describe('buildLegacyNodeMap', () => {
  it('walks from the root via child markers, in document order of discovery', () => {
    const root = node({ id: 'root', draftContent: '<p>intro</p><div class="child-embed" data-child-id="a" contenteditable="false"></div>' })
    const a = node({ id: 'a', draftContent: '<p>a text</p>' })
    const map = buildLegacyNodeMap(essay('root'), [root, a])
    expect([...map.keys()]).toEqual(['root', 'a'])
  })

  it('skips a deleted node and anything only reachable through it', () => {
    const root = node({ id: 'root', draftContent: '<div class="child-embed" data-child-id="a" contenteditable="false"></div>' })
    const a = node({ id: 'a', draftContent: '<div class="child-embed" data-child-id="a1" contenteditable="false"></div>', deleted: true })
    const a1 = node({ id: 'a1', draftContent: '<p>orphaned</p>' })
    const map = buildLegacyNodeMap(essay('root'), [root, a, a1])
    expect([...map.keys()]).toEqual(['root'])
  })
})

describe('migrateEssay: basic structure', () => {
  it('produces a schema-valid doc with a single root section for a node with no subsections', () => {
    const root = node({ id: 'root', draftContent: '<p>Just a paragraph.</p>' })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    expect(pm.firstChild!.type.name).toBe('section')
    expect(pm.firstChild!.attrs.id).toBe('root')
    expect(pm.textContent).toContain('Just a paragraph.')
    expect(warnings).toEqual([])
  })

  it("renders the essay's own title, not the root node's own (possibly stale) title, as the document's visible heading", () => {
    // `EssayWorkspace.tsx`'s own rename flow (`saveEssayTitle`) only ever
    // writes `essay.title`, never the root `EssayNode`'s own `.title` —
    // which stays frozen at whatever `createEssay` first seeded it to, so
    // the two diverge the moment an essay gets renamed after creation.
    // Matches `essayToMarkdown`/`essayToLatex`, which already use
    // `essay.title` for exactly this reason.
    const root = node({ id: 'root', title: 'Stale Node Title From Creation', draftContent: '<p>Body.</p>' })
    const { doc } = migrateEssay(essay('root', 'Renamed Essay Title'), [root], sources)
    const pm = assertValidDoc(doc)
    const sectionTitle = pm.firstChild!.firstChild!
    expect(sectionTitle.type.name).toBe('section_title')
    expect(sectionTitle.textContent).toBe('Renamed Essay Title')
  })

  it('nests a child section at the position its marker actually sits, interleaved with surrounding text — not reordered to "all text then all children"', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>Before.</p><div class="child-embed" data-child-id="a" contenteditable="false"></div><p>Between.</p><div class="child-embed" data-child-id="b" contenteditable="false"></div><p>After.</p>',
    })
    const a = node({ id: 'a', title: 'A', draftContent: '<p>a body</p>' })
    const b = node({ id: 'b', title: 'B', draftContent: '<p>b body</p>' })
    const { doc } = migrateEssay(essay('root'), [root, a, b], sources)
    const pm = assertValidDoc(doc)
    const types = pm.firstChild!.content.content.map((n) => (n.type.name === 'section' ? `section:${n.attrs.id}` : n.type.name === 'paragraph' ? n.textContent : n.type.name))
    expect(types).toEqual(['section_title', 'Before.', 'section:a', 'Between.', 'section:b', 'After.'])
  })

  it('nests sections to unlimited depth', () => {
    const root = node({ id: 'root', draftContent: '<div class="child-embed" data-child-id="a" contenteditable="false"></div>' })
    const a = node({ id: 'a', title: 'A', draftContent: '<div class="child-embed" data-child-id="a1" contenteditable="false"></div>' })
    const a1 = node({ id: 'a1', title: 'A1', draftContent: '<p>deep</p>' })
    const { doc } = migrateEssay(essay('root'), [root, a, a1], sources)
    const pm = assertValidDoc(doc)
    const sectionA = pm.firstChild!.content.content[1]
    expect(sectionA.type.name).toBe('section')
    const sectionA1 = sectionA.content.content[1]
    expect(sectionA1.type.name).toBe('section')
    expect(sectionA1.textContent).toContain('deep')
  })

  it('appends an empty paragraph for a node with no content and no children at all (section requires block+)', () => {
    const root = node({ id: 'root', draftContent: '' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    expect(pm.firstChild!.childCount).toBe(2) // title + one empty paragraph
    expect(pm.firstChild!.lastChild!.type.name).toBe('paragraph')
  })

  it('produces an empty document with a warning when the root node is missing', () => {
    const { doc, warnings } = migrateEssay(essay('gone'), [], sources)
    assertValidDoc(doc)
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('root')
  })

  it('skips a subsection marker pointing at a missing/deleted node, with a warning, rather than failing the whole migration', () => {
    const root = node({ id: 'root', draftContent: '<p>text</p><div class="child-embed" data-child-id="gone" contenteditable="false"></div>' })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    expect(pm.firstChild!.content.content.map((n) => n.type.name)).toEqual(['section_title', 'paragraph'])
    expect(warnings.some((w) => w.includes('gone'))).toBe(true)
  })

  it('detects a cycle and stops recursing rather than hanging, with a warning', () => {
    const root = node({ id: 'root', draftContent: '<div class="child-embed" data-child-id="a" contenteditable="false"></div>' })
    const a = node({ id: 'a', title: 'A', draftContent: '<div class="child-embed" data-child-id="root" contenteditable="false"></div>' })
    const { doc, warnings } = migrateEssay(essay('root'), [root, a], sources)
    assertValidDoc(doc)
    expect(warnings.some((w) => w.toLowerCase().includes('cycle'))).toBe(true)
  })
})

describe('migrateEssay: inline marks', () => {
  it('converts bold/italic/underline/link to real marks', () => {
    const root = node({
      id: 'root',
      draftContent: '<p><strong>bold</strong> <em>italic</em> <u>under</u> <a href="https://example.com">linked</a></p>',
    })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    const markNames = (i: number) => para.content.content[i].marks.map((m) => m.type.name)
    expect(markNames(0)).toEqual(['strong'])
    expect(para.textContent).toContain('bold italic under linked')
    const linkNode = para.content.content.find((n) => n.marks.some((m) => m.type.name === 'link'))
    expect(linkNode!.marks[0].attrs.href).toBe('https://example.com')
  })

  it('combines nested marks (bold inside italic) correctly', () => {
    const root = node({ id: 'root', draftContent: '<p><em>italic <strong>and bold</strong></em></p>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    const boldRun = para.content.content.find((n) => n.text === 'and bold')
    expect(boldRun!.marks.map((m) => m.type.name).sort()).toEqual(['em', 'strong'])
  })

  it('converts a literal <br> to a hard_break node', () => {
    const root = node({ id: 'root', draftContent: '<p>line one<br>line two</p>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    expect(para.content.content.some((n) => n.type.name === 'hard_break')).toBe(true)
  })
})

describe('migrateEssay: citations', () => {
  it('converts a modern (data-cite-v) citation chip to a citation atom with sourceId/note', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>As argued<cite class="citation" data-source-id="smith" data-cite-v="2" data-note="p. 5">(Smith, 2020, p. 5)</cite>.</p>',
    })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found: PMNode | null = null
    pm.descendants((n) => {
      if (n.type.name === 'citation') found = n
    })
    expect(found).not.toBeNull()
    expect(found!.attrs.sourceId).toBe('smith')
    expect(found!.attrs.note).toBe('p. 5')
    expect(warnings).toEqual([])
  })

  it('recovers a page note from a legacy citation chip\'s own old label text (no data-cite-v)', () => {
    const root = node({ id: 'root', draftContent: '<p>As argued<cite class="citation" data-source-id="smith">(Smith, 2020, p. 12)</cite>.</p>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found: PMNode | null = null
    pm.descendants((n) => {
      if (n.type.name === 'citation') found = n
    })
    expect(found!.attrs.sourceId).toBe('smith')
    expect(found!.attrs.note).toBe('p12')
  })

  it("flattens a citation whose source no longer exists to plain text, with a warning — never a broken citation atom", () => {
    const root = node({ id: 'root', draftContent: '<p><cite class="citation" data-source-id="gone" data-cite-v="2">(Someone, 1999)</cite></p>' })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let foundCitation = false
    pm.descendants((n) => {
      if (n.type.name === 'citation') foundCitation = true
    })
    expect(foundCitation).toBe(false)
    expect(pm.textContent).toContain('(Someone, 1999)')
    expect(warnings.some((w) => w.includes('gone'))).toBe(true)
  })

  it('preserves marks (e.g. a citation sitting inside a comment anchor) on a citation atom', () => {
    const root = node({
      id: 'root',
      draftContent: '<p><mark class="comment-anchor" data-comment-id="c1"><cite class="citation" data-source-id="smith" data-cite-v="2">(Smith, 2020)</cite></mark></p>',
    })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found: PMNode | null = null
    pm.descendants((n) => {
      if (n.type.name === 'citation') found = n
    })
    expect(found!.marks.some((m) => m.type.name === 'comment_anchor')).toBe(true)
  })
})

describe('migrateEssay: footnotes', () => {
  it("becomes real inline document content inside a footnote node, no separate record needed", () => {
    const root = node({
      id: 'root',
      draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup>.</p>',
      footnotes: [{ id: 'f1', content: '<p>The <strong>footnote</strong> body.</p>' }],
    })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found: PMNode | null = null
    pm.descendants((n) => {
      if (n.type.name === 'footnote') found = n
    })
    expect(found).not.toBeNull()
    expect(found!.textContent).toBe('The footnote body.')
    expect(warnings).toEqual([])
  })

  it('flattens a multi-paragraph footnote body into inline content joined by hard_break, with no warning (not "complex" structure)', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>claim<sup class="footnote-ref" data-footnote-id="f1"></sup></p>',
      footnotes: [{ id: 'f1', content: '<p>First.</p><p>Second.</p>' }],
    })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found: PMNode | null = null
    pm.descendants((n) => {
      if (n.type.name === 'footnote') found = n
    })
    expect(found!.content.content.some((n) => n.type.name === 'hard_break')).toBe(true)
    expect(found!.textContent).toBe('First.Second.')
    expect(warnings).toEqual([])
  })

  it('flattens a list inside a footnote to plain text with markers, and warns about the degradation', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>claim<sup class="footnote-ref" data-footnote-id="f1"></sup></p>',
      footnotes: [{ id: 'f1', content: '<ul><li>one</li><li>two</li></ul>' }],
    })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found: PMNode | null = null
    pm.descendants((n) => {
      if (n.type.name === 'footnote') found = n
    })
    expect(found!.textContent).toContain('one')
    expect(found!.textContent).toContain('two')
    expect(warnings.some((w) => w.includes('block-level structure'))).toBe(true)
  })

  it('drops a footnote-ref with no matching footnote body, with a warning', () => {
    const root = node({ id: 'root', draftContent: '<p>claim<sup class="footnote-ref" data-footnote-id="missing"></sup></p>' })
    const { doc, warnings } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found = false
    pm.descendants((n) => {
      if (n.type.name === 'footnote') found = true
    })
    expect(found).toBe(false)
    expect(warnings.some((w) => w.includes('footnote reference'))).toBe(true)
  })

  it("resolves a footnote only against its own node's footnotes, never a different node's", () => {
    const root = node({
      id: 'root',
      draftContent: '<p>root<sup class="footnote-ref" data-footnote-id="f1"></sup></p><div class="child-embed" data-child-id="a" contenteditable="false"></div>',
      footnotes: [{ id: 'f1', content: '<p>Root footnote.</p>' }],
    })
    const a = node({
      id: 'a',
      title: 'A',
      draftContent: '<p>child<sup class="footnote-ref" data-footnote-id="f1"></sup></p>',
      footnotes: [{ id: 'f1', content: '<p>Child footnote (same local id, different content).</p>' }],
    })
    const { doc, warnings } = migrateEssay(essay('root'), [root, a], sources)
    const pm = assertValidDoc(doc)
    const footnoteTexts: string[] = []
    pm.descendants((n) => {
      if (n.type.name === 'footnote') footnoteTexts.push(n.textContent)
    })
    expect(footnoteTexts).toEqual(['Root footnote.', 'Child footnote (same local id, different content).'])
    expect(warnings).toEqual([])
  })
})

describe('migrateEssay: comments', () => {
  it("collects a top-level 'text' comment with its anchor mark applied and sectionId set to the owning section", () => {
    const root = node({
      id: 'root',
      draftContent: '<p>A <mark class="comment-anchor" data-comment-id="c1">highlighted phrase</mark>.</p>',
      comments: [{ id: 'c1', parentId: null, anchorKind: 'text', anchorText: 'highlighted phrase', body: '<p>Nice point.</p>', resolved: false, createdAt: 1, updatedAt: 1 }],
    })
    const { doc, comments } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let foundMark = false
    pm.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'comment_anchor' && m.attrs.commentId === 'c1')) foundMark = true
    })
    expect(foundMark).toBe(true)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ id: 'c1', sectionId: 'root', parentId: null, body: '<p>Nice point.</p>' })
  })

  it("collects a 'node'-anchored comment (no mark anywhere) with sectionId still set, since it's the only way to know which section it belongs to now", () => {
    const root = node({
      id: 'root',
      draftContent: '<p>No highlight here.</p>',
      comments: [{ id: 'c1', parentId: null, anchorKind: 'node', anchorText: '', body: '<p>About this whole section.</p>', resolved: false, createdAt: 1, updatedAt: 1 }],
    })
    const { comments } = migrateEssay(essay('root'), [root], sources)
    expect(comments[0]).toMatchObject({ sectionId: 'root', anchorKind: 'node' })
  })

  it('anchors a comment with nothing selected to a zero-width-space text node carrying the mark, since a mark can\'t exist on zero content', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>Text<mark class="comment-anchor" data-comment-id="c1"></mark> more text.</p>',
      comments: [{ id: 'c1', parentId: null, anchorKind: 'text', anchorText: '', body: '<p>A note.</p>', resolved: false, createdAt: 1, updatedAt: 1 }],
    })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let found = false
    pm.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment_anchor')) found = true
    })
    expect(found).toBe(true)
  })

  it('sets sectionId to null and keeps parentId for a nested reply/comment-on-a-comment', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>text</p>',
      comments: [
        { id: 'c1', parentId: null, anchorKind: 'text', anchorText: '', body: '<p>Top-level.</p>', resolved: false, createdAt: 1, updatedAt: 1 },
        { id: 'c2', parentId: 'c1', anchorKind: 'inline', anchorText: '', body: '<p>A reply.</p>', resolved: false, createdAt: 2, updatedAt: 2 },
      ],
    })
    const { comments } = migrateEssay(essay('root'), [root], sources)
    const reply = comments.find((c) => c.id === 'c2')!
    expect(reply.sectionId).toBeNull()
    expect(reply.parentId).toBe('c1')
  })

  it('collects comments from every section in the essay, not just the root', () => {
    const root = node({
      id: 'root',
      draftContent: '<div class="child-embed" data-child-id="a" contenteditable="false"></div>',
      comments: [{ id: 'c-root', parentId: null, anchorKind: 'node', anchorText: '', body: '', resolved: false, createdAt: 1, updatedAt: 1 }],
    })
    const a = node({
      id: 'a',
      title: 'A',
      draftContent: '<p>text</p>',
      comments: [{ id: 'c-a', parentId: null, anchorKind: 'node', anchorText: '', body: '', resolved: false, createdAt: 1, updatedAt: 1 }],
    })
    const { comments } = migrateEssay(essay('root'), [root, a], sources)
    expect(comments.map((c) => c.id).sort()).toEqual(['c-a', 'c-root'])
    expect(comments.find((c) => c.id === 'c-a')!.sectionId).toBe('a')
  })
})

describe('migrateEssay: lists, blockquotes, math', () => {
  it('converts a nested bullet list, each item\'s own text and its nested list separately', () => {
    const root = node({ id: 'root', draftContent: '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const list = pm.firstChild!.content.content[1]
    expect(list.type.name).toBe('bullet_list')
    expect(list.content.content[1].content.content[1].type.name).toBe('bullet_list') // second <li>'s own nested list
  })

  it('converts an ordered list', () => {
    const root = node({ id: 'root', draftContent: '<ol><li>first</li><li>second</li></ol>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    expect(pm.firstChild!.content.content[1].type.name).toBe('ordered_list')
  })

  it('converts a single-paragraph blockquote to one paragraph', () => {
    const root = node({ id: 'root', draftContent: '<blockquote>A quote.</blockquote>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const bq = pm.firstChild!.content.content[1]
    expect(bq.type.name).toBe('blockquote')
    expect(bq.childCount).toBe(1)
    expect(bq.textContent).toBe('A quote.')
  })

  it('keeps a multi-paragraph blockquote as real separate paragraphs (an improvement over the old Markdown export\'s own flattening)', () => {
    const root = node({ id: 'root', draftContent: '<blockquote><p>First.</p><p>Second.</p></blockquote>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const bq = pm.firstChild!.content.content[1]
    expect(bq.childCount).toBe(2)
    expect(bq.content.content.map((p) => p.textContent)).toEqual(['First.', 'Second.'])
  })

  it('converts inline and display math with their LaTeX intact', () => {
    const root = node({
      id: 'root',
      draftContent: '<p>eq <span class="math-inline" data-latex="x^2"></span></p><span class="math-block" data-latex="\\int x"></span>',
    })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    let inlineLatex: string | undefined
    let blockLatex: string | undefined
    pm.descendants((n) => {
      if (n.type.name === 'math_inline') inlineLatex = n.attrs.latex
      if (n.type.name === 'math_block') blockLatex = n.attrs.latex
    })
    expect(inlineLatex).toBe('x^2')
    expect(blockLatex).toBe('\\int x')
  })

  it('finds a blockquote nested inside a wrapping <div> (an older-document shape), not just a direct child', () => {
    const root = node({ id: 'root', draftContent: '<div><blockquote>Nested quote.</blockquote></div>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const bq = pm.firstChild!.content.content[1]
    expect(bq.type.name).toBe('blockquote')
    expect(bq.textContent).toBe('Nested quote.')
  })

  it('finds a list nested inside a wrapping <div> too', () => {
    const root = node({ id: 'root', draftContent: '<div><ul><li>one</li></ul></div>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    expect(pm.firstChild!.content.content[1].type.name).toBe('bullet_list')
  })
})

describe('migrateEssay: whitespace and paragraph breaks', () => {
  it('collapses a literal newline embedded in a text node to a single space, instead of rendering it as a visible line break under this editor\'s own white-space: pre-wrap', () => {
    const root = node({ id: 'root', draftContent: '<p>Line one\nline two, same paragraph.</p>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    expect(para.textContent).toBe('Line one line two, same paragraph.')
  })

  it('collapses a run of several literal newlines (e.g. from a paste) to one space, not several visible blank lines', () => {
    const root = node({ id: 'root', draftContent: '<p>Para text\n\n\nstill one paragraph.</p>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    expect(para.textContent).toBe('Para text still one paragraph.')
  })

  it('does not insert a spurious empty paragraph for a whitespace-only text node sitting between two sibling <div>s (pretty-printed/pasted HTML)', () => {
    const root = node({ id: 'root', draftContent: '<div>First.</div>\n  <div>Second.</div>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const blocks = pm.firstChild!.content.content.slice(1)
    expect(blocks.map((b) => b.textContent)).toEqual(['First.', 'Second.'])
  })

  it('keeps two sibling <div>s as two separate paragraphs (real spacing), not merged into one via a hard break', () => {
    const root = node({ id: 'root', draftContent: '<div>Paragraph one.</div><div>Paragraph two.</div>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const blocks = pm.firstChild!.content.content.slice(1)
    expect(blocks.length).toBe(2)
    expect(blocks.every((b) => b.type.name === 'paragraph')).toBe(true)
    expect(blocks.map((b) => b.textContent)).toEqual(['Paragraph one.', 'Paragraph two.'])
  })

  it('drops a purely cosmetic trailing <br> a browser leaves at the end of a paragraph <div>, rather than keeping it as a visible extra line break', () => {
    const root = node({ id: 'root', draftContent: '<div>Some text.<br></div>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    expect(para.childCount).toBe(1)
    expect(para.firstChild!.type.name).toBe('text')
    expect(para.textContent).toBe('Some text.')
  })

  it('keeps a real internal <br> (an intentional soft line break) as a hard_break, not dropped', () => {
    const root = node({ id: 'root', draftContent: '<div>Line one.<br>Line two.</div>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const para = pm.firstChild!.content.content[1]
    const typeNames = para.content.content.map((n) => n.type.name)
    expect(typeNames).toEqual(['text', 'hard_break', 'text'])
  })
})

describe('migrateGraveyardFragment', () => {
  it("converts a cut fragment's own HTML into a standalone one-section document", () => {
    const originNode = node({ id: 'origin', draftContent: '<p>unused</p>' })
    const frag = fragment({ id: 'frag1', nodeId: 'origin', nodeTitle: 'Cut From Here', html: '<p>Some <b>bold</b> cut text.</p>' })
    const { doc, title, warnings } = migrateGraveyardFragment(frag, [originNode], sources)
    expect(title).toBe('Cut From Here')
    const pm = assertValidDoc(doc)
    expect(pm.firstChild!.type.name).toBe('section')
    expect(pm.firstChild!.firstChild!.textContent).toBe('Cut From Here')
    expect(pm.firstChild!.content.content[1].textContent).toBe('Some bold cut text.')
    expect(warnings).toEqual([])
  })

  it('warns, but still produces a document, when the fragment\'s own origin node no longer exists', () => {
    const frag = fragment({ id: 'frag1', nodeId: 'missing', nodeTitle: 'Orphaned Fragment', html: '<p>text</p>' })
    const { doc, warnings } = migrateGraveyardFragment(frag, [], sources)
    assertValidDoc(doc)
    expect(warnings.some((w) => w.includes('no longer exists'))).toBe(true)
  })

  it('warns and drops a child-embed marker caught inside a cut fragment, rather than silently losing the subtree it pointed at with no trace', () => {
    const originNode = node({ id: 'origin', draftContent: '<p>unused</p>' })
    const frag = fragment({
      id: 'frag1',
      nodeId: 'origin',
      nodeTitle: 'Had A Child',
      html: '<p>Before.</p><div class="child-embed" data-child-id="a" contenteditable="false"></div>',
    })
    const { warnings } = migrateGraveyardFragment(frag, [originNode], sources)
    expect(warnings.some((w) => w.includes('subsection marker'))).toBe(true)
  })
})

describe('migrateEssayHistory', () => {
  /** Builds one old-format commit on top of `prevNodes`' own reconstructed text, the same shape `commitEssay`/`essaysMigrations.ts` already produce. */
  function legacyCommit(seq: number, title: string, rootNodeId: string, nodes: EssayNode[], prevText: string, kind: EssayCommitEntry['kind'] = 'commit'): { commit: EssayCommitEntry; text: string } {
    const snapshot = { title, rootNodeId, nodes: nodes.map((n) => ({ id: n.id, title: n.title, draftContent: n.draftContent, footnotes: n.footnotes ?? [], comments: n.comments ?? [] })) }
    const text = JSON.stringify(snapshot, null, 2)
    const commit: EssayCommitEntry = { id: id(), essayId: 'e1', seq, createdAt: seq, kind, patch: diffSnapshots(prevText, text) }
    return { commit, text }
  }

  it('converts a multi-commit old-format chain so every seq reconstructs to the same content a fresh migrateEssay call against that historical point would independently produce', () => {
    const v1 = node({ id: 'root', draftContent: '<p>Version one.</p>' })
    const { commit: c0, text: t0 } = legacyCommit(0, 'My Essay', 'root', [v1], '')
    const v2 = node({ id: 'root', draftContent: '<p>Version two.</p>' })
    const { commit: c1 } = legacyCommit(1, 'My Essay', 'root', [v2], t0)

    const { commits, warnings } = migrateEssayHistory('My Essay', [c0, c1], sources)
    expect(warnings).toEqual([])
    expect(commits.map((c) => c.seq)).toEqual([0, 1])
    expect(commits.map((c) => c.id)).toEqual([c0.id, c1.id])
    expect(commits.map((c) => c.kind)).toEqual(['commit', 'commit'])

    for (const [seq, expectedNode] of [[0, v1] as const, [1, v2] as const]) {
      const text = reconstructSnapshotText(commits, seq)
      const newFormatSnapshot = JSON.parse(text)
      const fresh = migrateEssay(essay('root', 'My Essay'), [expectedNode], sources)
      expect(newFormatSnapshot.doc).toEqual(fresh.doc)
      expect(newFormatSnapshot.title).toBe('My Essay')
    }
  })

  it('preserves each original commit\'s own id/seq/kind/label — only patch changes', () => {
    const v1 = node({ id: 'root', draftContent: '<p>Text.</p>' })
    const { commit: c0 } = legacyCommit(0, 'Essay', 'root', [v1], '', 'migrated')
    c0.label = 'A custom label'
    const { commits } = migrateEssayHistory('Essay', [c0], sources)
    expect(commits[0]).toMatchObject({ id: c0.id, seq: 0, kind: 'migrated', label: 'A custom label' })
    expect(commits[0].patch).not.toBe(c0.patch)
  })

  it('collects migration warnings across every historical point, not just the latest', () => {
    const withMissingSource = node({ id: 'root', draftContent: '<p><cite class="citation" data-source-id="gone" data-cite-v="2">(x)</cite></p>' })
    const { commit: c0 } = legacyCommit(0, 'Essay', 'root', [withMissingSource], '')
    const { warnings } = migrateEssayHistory('Essay', [c0], sources)
    expect(warnings.some((w) => w.includes('gone'))).toBe(true)
  })

  it('works regardless of input commit order — sorts by seq before processing', () => {
    const v1 = node({ id: 'root', draftContent: '<p>One.</p>' })
    const { commit: c0, text: t0 } = legacyCommit(0, 'Essay', 'root', [v1], '')
    const v2 = node({ id: 'root', draftContent: '<p>Two.</p>' })
    const { commit: c1 } = legacyCommit(1, 'Essay', 'root', [v2], t0)
    const { commits } = migrateEssayHistory('Essay', [c1, c0], sources)
    expect(commits.map((c) => c.seq)).toEqual([0, 1])
  })
})

function comment(overrides: Partial<Comment> & { id: string }): Comment {
  return { parentId: null, anchorKind: 'text', anchorText: '', body: '', resolved: false, createdAt: 0, updatedAt: 0, ...overrides }
}

function docWithAnchor(commentId: string, text = 'Some text.'): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'section',
        attrs: { id: 'root' },
        content: [
          { type: 'section_title', content: [{ type: 'text', text: 'Essay' }] },
          { type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'comment_anchor', attrs: { commentId } }] }] },
        ],
      },
    ],
  }
}

describe('foldCommentsIntoDoc', () => {
  it('is a no-op (same doc, no warnings) when there are no comments', () => {
    const doc = assertValidDoc(docWithAnchor('ignored'))
    const { doc: result, warnings } = foldCommentsIntoDoc(doc, [])
    expect(result).toBe(doc)
    expect(warnings).toEqual([])
  })

  it('splices a top-level text-anchored comment right after its own anchor mark', () => {
    const doc = assertValidDoc(docWithAnchor('c1'))
    const { doc: result, warnings } = foldCommentsIntoDoc(doc, [comment({ id: 'c1', anchorKind: 'text', body: '<p>A note.</p>', resolved: true, createdAt: 5, updatedAt: 9 })])
    expect(warnings).toEqual([])
    let found: PMNode | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread' && n.attrs.id === 'c1') found = n
    })
    expect(found).not.toBeNull()
    expect(found!.attrs).toMatchObject({ resolved: true, createdAt: 5, updatedAt: 9, displayMode: 'margin' })
    expect(found!.textContent).toBe('A note.')
    // Right after the anchor mark, not somewhere else in the document.
    let anchorEnd = -1
    let threadPos = -1
    result.descendants((n, pos) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment_anchor')) anchorEnd = pos + n.nodeSize
      if (n.type.name === 'comment_thread') threadPos = pos
    })
    expect(threadPos).toBe(anchorEnd)
  })

  it('respects a comment\'s own displayMode', () => {
    const doc = assertValidDoc(docWithAnchor('c1'))
    const { doc: result } = foldCommentsIntoDoc(doc, [comment({ id: 'c1', displayMode: 'inline' })])
    let found: PMNode | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread') found = n
    })
    expect(found!.attrs.displayMode).toBe('inline')
  })

  it('wraps a legacy whole-section (anchorKind "node") comment in a paragraph as the first body block of its own section', () => {
    const doc = assertValidDoc({
      type: 'doc',
      content: [{ type: 'section', attrs: { id: 'root' }, content: [{ type: 'section_title' }, { type: 'paragraph', content: [{ type: 'text', text: 'Existing body.' }] }] }],
    })
    const { doc: result, warnings } = foldCommentsIntoDoc(doc, [comment({ id: 'c1', anchorKind: 'node', sectionId: 'root', body: 'Whole-section note.' })])
    expect(warnings).toEqual([])
    const rootSection = result.firstChild!
    expect(rootSection.child(1).type.name).toBe('paragraph')
    expect(rootSection.child(1).textContent).toBe('Whole-section note.')
    expect(rootSection.child(2).textContent).toBe('Existing body.')
  })

  it('appends an orphaned comment (anchor no longer in the document) to the end of the root section, with a warning, rather than dropping it', () => {
    const doc = assertValidDoc(docWithAnchor('some-other-id'))
    const { doc: result, warnings } = foldCommentsIntoDoc(doc, [comment({ id: 'c1', anchorKind: 'text', body: 'Orphaned.' })])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('c1')
    let found: PMNode | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread') found = n
    })
    expect(found!.textContent).toBe('Orphaned.')
  })

  it('appends a whole-section comment whose own section no longer exists, with a warning, rather than dropping it', () => {
    const doc = assertValidDoc({ type: 'doc', content: [{ type: 'section', attrs: { id: 'root' }, content: [{ type: 'section_title' }, { type: 'paragraph' }] }] })
    const { warnings } = foldCommentsIntoDoc(doc, [comment({ id: 'c1', anchorKind: 'node', sectionId: 'gone', body: 'Note.' })])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('gone')
  })

  it('nests a reply inside its own parent comment\'s content, matching the order of its own anchor markers in the parent\'s body, not as a second top-level thread', () => {
    const doc = assertValidDoc(docWithAnchor('c1'))
    // A plain reply's own anchor, in real stored data, is an *empty* `comment-anchor` mark appended at the very end of the parent's body (see `Comment`'s own doc comment in `models/types.ts`) — not a bare, mark-less body.
    const parent = comment({ id: 'c1', anchorKind: 'text', body: 'Parent body.<mark class="comment-anchor" data-comment-id="r1"></mark><mark class="comment-anchor" data-comment-id="r2"></mark>' })
    const reply1 = comment({ id: 'r1', parentId: 'c1', anchorKind: 'inline', body: 'First reply.', createdAt: 2 })
    const reply2 = comment({ id: 'r2', parentId: 'c1', anchorKind: 'inline', body: 'Second reply.', createdAt: 1 })
    const { doc: result, warnings } = foldCommentsIntoDoc(doc, [parent, reply1, reply2])
    expect(warnings).toEqual([])
    let topLevelCount = 0
    let found: PMNode | null = null
    result.descendants((n, _pos, parent) => {
      if (n.type.name === 'comment_thread' && parent?.type.name !== 'comment_thread') {
        topLevelCount++
        found = n
      }
    })
    expect(topLevelCount).toBe(1) // the replies are nested, not separate top-level threads
    const nestedIds: string[] = []
    found!.content.forEach((n) => {
      if (n.type.name === 'comment_thread') nestedIds.push(n.attrs.id)
    })
    expect(nestedIds).toEqual(['r1', 'r2']) // in the order their own anchor markers appear in the parent's body
  })

  it('nests "comment on a span within this comment" right after the matching comment_anchor mark inside the parent\'s own body', () => {
    const doc = assertValidDoc(docWithAnchor('c1'))
    const parent = comment({ id: 'c1', anchorKind: 'text', body: 'Before <mark class="comment-anchor" data-comment-id="r1">highlighted span</mark> after.' })
    const nested = comment({ id: 'r1', parentId: 'c1', anchorKind: 'inline', body: 'A note on that span.' })
    const { doc: result, warnings } = foldCommentsIntoDoc(doc, [parent, nested])
    expect(warnings).toEqual([])
    let parentThread: PMNode | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread' && n.attrs.id === 'c1') parentThread = n
    })
    expect(parentThread).not.toBeNull()
    expect(parentThread!.textContent).toBe('Before highlighted spanA note on that span. after.')
    let anchorFound = false
    parentThread!.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'comment_anchor' && m.attrs.commentId === 'r1')) anchorFound = true
    })
    expect(anchorFound).toBe(true)
  })

  it('bold/italic/underline formatting inside a comment body survives the fold', () => {
    const doc = assertValidDoc(docWithAnchor('c1'))
    const { doc: result } = foldCommentsIntoDoc(doc, [comment({ id: 'c1', body: 'plain <b>bold</b> <i>italic</i> <u>underline</u>.' })])
    let found: PMNode | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread') found = n
    })
    expect(found!.textContent).toBe('plain bold italic underline.')
    const markNames: string[][] = []
    found!.descendants((n) => {
      if (n.isText) markNames.push(n.marks.map((m) => m.type.name))
    })
    expect(markNames).toContainEqual(['strong'])
    expect(markNames).toContainEqual(['em'])
    expect(markNames).toContainEqual(['underline'])
  })
})

describe('refoldEssayHistoryComments', () => {
  function makeCommit(seq: number, text: string, prevText: string, extra: Partial<EssayCommitEntry> = {}): EssayCommitEntry {
    return { id: id(), essayId: 'e1', seq, createdAt: seq, kind: 'migrated', patch: diffSnapshots(prevText, text), ...extra }
  }

  it('folds each historical snapshot\'s own pre-fold comments array into its own doc, producing a chain with no comments field left anywhere', () => {
    const doc1 = docWithAnchor('c1')
    const text1 = pmSnapshotText({ title: 'Essay', doc: doc1, comments: [comment({ id: 'c1', body: 'Note v1.' })] } as never)
    const c0 = makeCommit(0, text1, '')

    const { commits, warnings } = refoldEssayHistoryComments([c0])
    expect(warnings).toEqual([])
    expect(commits).toHaveLength(1)

    const newText = reconstructSnapshotText(commits, 0)
    expect(newText).not.toContain('"comments"')
    const snapshot = JSON.parse(newText)
    const result = assertValidDoc(snapshot.doc)
    let found: PMNode | null = null
    result.descendants((n) => {
      if (n.type.name === 'comment_thread' && n.attrs.id === 'c1') found = n
    })
    expect(found!.textContent).toBe('Note v1.')
  })

  it('re-diffs incrementally against the previous already-folded snapshot, not the original pre-fold text, across multiple commits', () => {
    const doc1 = docWithAnchor('c1', 'First.')
    const text1 = pmSnapshotText({ title: 'Essay', doc: doc1, comments: [comment({ id: 'c1', body: 'Note.' })] } as never)
    const c0 = makeCommit(0, text1, '')

    const doc2 = docWithAnchor('c1', 'Second.')
    const text2 = pmSnapshotText({ title: 'Essay', doc: doc2, comments: [comment({ id: 'c1', body: 'Note.' })] } as never)
    const c1 = makeCommit(1, text2, text1)

    const { commits } = refoldEssayHistoryComments([c0, c1])
    expect(commits).toHaveLength(2)

    for (const [seq, expectedText] of [[0, 'First.'] as const, [1, 'Second.'] as const]) {
      const text = reconstructSnapshotText(commits, seq)
      const snapshot = JSON.parse(text)
      const result = assertValidDoc(snapshot.doc)
      expect(result.textContent).toContain(expectedText)
    }
  })

  it('preserves each original commit\'s own id/seq/kind/label — only patch changes', () => {
    const doc1 = docWithAnchor('c1')
    const text1 = pmSnapshotText({ title: 'Essay', doc: doc1, comments: [comment({ id: 'c1', body: 'Note.' })] } as never)
    const c0 = makeCommit(0, text1, '', { label: 'A custom label' })

    const { commits } = refoldEssayHistoryComments([c0])
    expect(commits[0]).toMatchObject({ id: c0.id, seq: 0, kind: 'migrated', label: 'A custom label' })
    expect(commits[0].patch).not.toBe(c0.patch)
  })

  it('leaves a commit with no comments at all untouched in substance (same doc, just re-serialized without a comments key)', () => {
    const doc1 = docWithAnchor('ignored')
    const text1 = pmSnapshotText({ title: 'Essay', doc: doc1 })
    const c0 = makeCommit(0, text1, '')

    const { commits, warnings } = refoldEssayHistoryComments([c0])
    expect(warnings).toEqual([])
    const text = reconstructSnapshotText(commits, 0)
    const snapshot = JSON.parse(text)
    expect(assertValidDoc(snapshot.doc).textContent).toContain('Some text.')
  })
})
