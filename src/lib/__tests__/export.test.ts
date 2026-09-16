import { describe, expect, it } from 'vitest'
import { essayToLatex, essayToMarkdown, markdownToHtml } from '../export'
import type { Essay, EssayNode } from '../../models/types'

function makeEssay(rootNodeId: string): Essay {
  return { id: 'e1', title: 'Test Essay', rootNodeId, createdAt: 0, updatedAt: 0 }
}

function makeNode(overrides: Partial<EssayNode> & { id: string; draftContent: string }): EssayNode {
  return {
    essayId: 'e1',
    title: 'Untitled section',
    versions: [{ id: 'v1', content: overrides.draftContent, comments: [], createdAt: 0 }],
    headVersionId: 'v1',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('footnotes in Markdown export', () => {
  it('emits a [^label] reference plus a definition at the end of the document', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup> worth footnoting.</p>',
      footnotes: [{ id: 'f1', content: '<p>The footnote itself.</p>' }],
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toMatch(/A claim\[\^fn1\] worth footnoting\./)
    expect(md).toMatch(/\[\^fn1\]: The footnote itself\./)
  })

  it('gives every footnote a unique label, even across sections that each start their own local numbering in the editor', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>Root text<sup class="footnote-ref" data-footnote-id="f1"></sup>.</p><div class="child-embed" data-child-id="child"></div>',
      footnotes: [{ id: 'f1', content: '<p>Root footnote.</p>' }],
    })
    const child = makeNode({
      id: 'child',
      title: 'Child',
      draftContent: '<p>Child text<sup class="footnote-ref" data-footnote-id="f1"></sup>.</p>',
      footnotes: [{ id: 'f1', content: '<p>Child footnote (different content, same local id).</p>' }],
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root], ['child', child]]))
    // Both footnotes happen to share the id "f1" locally (each node has its
    // own footnotes array) — the exported labels must still not collide.
    const labels = [...md.matchAll(/\[\^(fn\d+)\]:/g)].map((m) => m[1])
    expect(new Set(labels).size).toBe(2)
    expect(md).toContain('Root footnote.')
    expect(md).toContain('Child footnote (different content, same local id).')
  })

  it('produces the exact same output as before when there are no footnotes at all', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Plain text, nothing fancy.</p>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).not.toContain('[^')
    expect(md).not.toContain('---')
  })

  it('tolerates a node with no footnotes field at all (old-format data)', () => {
    const root: EssayNode = {
      id: 'root',
      essayId: 'e1',
      title: 'Untitled',
      versions: [{ id: 'v1', content: '', comments: [], createdAt: 0 }],
      headVersionId: 'v1',
      draftContent: '<p>Old content from before footnotes existed.</p>',
      createdAt: 0,
      updatedAt: 0,
    }
    expect(() => essayToMarkdown(makeEssay('root'), new Map([['root', root]]))).not.toThrow()
  })
})

describe('footnotes in LaTeX export', () => {
  it('converts a footnote-ref marker back into an inline \\footnote{}', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup> worth footnoting.</p>',
      footnotes: [{ id: 'f1', content: '<p>The <b>footnote</b> itself.</p>' }],
    })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('\\footnote{The \\textbf{footnote} itself.}')
  })
})

describe('footnotes in the printable HTML rendering (PDF export path)', () => {
  it('round-trips essayToMarkdown output into a numbered footnote list', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup>.</p>',
      footnotes: [{ id: 'f1', content: '<p>The footnote text.</p>' }],
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toContain('<sup class="print-footnote-ref"><a href="#fn-fn1">1</a></sup>')
    expect(html).toContain('<ol class="print-footnotes">')
    expect(html).toContain('<li id="fn-fn1">The footnote text.</li>')
  })
})
