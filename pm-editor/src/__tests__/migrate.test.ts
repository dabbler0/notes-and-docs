import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema as schema } from '../schema'
import { buildLegacyNodeMap, migrateEssay } from '../migrate'
import type { LegacyEssay, LegacyEssayNode, Source } from '../types'

function essay(rootNodeId: string, title = 'Test Essay'): LegacyEssay {
  return { id: 'e1', title, rootNodeId }
}

function node(overrides: Partial<LegacyEssayNode> & { id: string; draftContent: string }): LegacyEssayNode {
  return { essayId: 'e1', title: 'Untitled section', ...overrides }
}

/** Round-trips `doc` through the real schema — throws if migrate.ts ever produces something structurally invalid. Every test calls this at least once; it's the real safety net here, more than any individual assertion. */
function assertValidDoc(doc: unknown): PMNode {
  return PMNode.fromJSON(schema, doc)
}

const smith: Source = { id: 'smith', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper' } } }
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

  it("never renders the root node's own title as visible text (matching the old export pipeline's own depth-0 exception)", () => {
    const root = node({ id: 'root', title: 'Root Title Never Shown', draftContent: '<p>Body.</p>' })
    const { doc } = migrateEssay(essay('root'), [root], sources)
    const pm = assertValidDoc(doc)
    const sectionTitle = pm.firstChild!.firstChild!
    expect(sectionTitle.type.name).toBe('section_title')
    expect(sectionTitle.textContent).toBe('Root Title Never Shown')
    // It's still *stored* (unlike the Markdown/print export, which never
    // keeps it at all) — just never the essay's own displayed title. The
    // demo app is responsible for using Essay.title, not this, as the H1.
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
})
