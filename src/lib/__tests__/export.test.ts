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
    versions: [{ id: 'v1', content: overrides.draftContent, createdAt: 0 }],
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
      versions: [{ id: 'v1', content: '', createdAt: 0 }],
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

describe('LaTeX equations in Markdown export', () => {
  it('exports an inline equation as $...$ and a block one as a $$ fence', () => {
    const root = makeNode({
      id: 'root',
      draftContent:
        '<p>The formula <span class="math-inline" data-math-id="m1" data-latex="E=mc^2"></span> is famous.</p>' +
        '<div><span class="math-block" data-math-id="m2" data-latex="\\int_0^1 x\\,dx"></span></div>',
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('The formula $E=mc^2$ is famous.')
    expect(md).toContain('$$\n\\int_0^1 x\\,dx\n$$')
  })

  it('escapes a literal dollar sign in ordinary prose so it round-trips as plain text', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Price is $5 today.</p>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('Price is \\$5 today.')
    const html = markdownToHtml(md)
    expect(html).toContain('Price is $5 today.')
  })
})

describe('LaTeX equations in the printable HTML rendering (PDF export path)', () => {
  it('renders both an inline and a block equation through KaTeX', () => {
    const root = makeNode({
      id: 'root',
      draftContent:
        '<p>The formula <span class="math-inline" data-math-id="m1" data-latex="E=mc^2"></span> is famous.</p>' +
        '<div><span class="math-block" data-math-id="m2" data-latex="x^2"></span></div>',
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toContain('class="katex"')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('$E=mc^2$')
  })
})

describe('LaTeX equations in the LaTeX export', () => {
  it('exports an inline equation as $...$ and a block one as \\[...\\]', () => {
    const root = makeNode({
      id: 'root',
      draftContent:
        '<p>The formula <span class="math-inline" data-math-id="m1" data-latex="E=mc^2"></span> is famous.</p>' +
        '<div><span class="math-block" data-math-id="m2" data-latex="x^2"></span></div>',
    })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('The formula $E=mc^2$ is famous.')
    expect(tex).toContain('\\[\nx^2\n\\]')
  })
})

describe('lists in Markdown export', () => {
  it('exports a bulleted list as one - line per item', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>First</li><li>Second</li></ul>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('- First\n- Second')
  })

  it('exports a numbered list as sequential 1. 2. 3. lines', () => {
    const root = makeNode({ id: 'root', draftContent: '<ol><li>First</li><li>Second</li><li>Third</li></ol>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('1. First\n2. Second\n3. Third')
  })
})

describe('lists in the printable HTML rendering (PDF export path)', () => {
  it('round-trips a bulleted list back into a real <ul><li> structure', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>First</li><li>Second</li></ul>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toContain('<ul>\n<li>First</li>\n<li>Second</li>\n</ul>')
  })

  it('round-trips a numbered list back into a real <ol><li> structure', () => {
    const root = makeNode({ id: 'root', draftContent: '<ol><li>First</li><li>Second</li></ol>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toContain('<ol>\n<li>First</li>\n<li>Second</li>\n</ol>')
  })

  it('ends a list when a plain paragraph follows it', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>Item</li></ul><p>After.</p>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toMatch(/<\/ul>\s*<p>After\.<\/p>/)
  })
})

describe('lists in the LaTeX export', () => {
  it('exports a bulleted list as an itemize environment', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>First</li><li>Second</li></ul>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('\\begin{itemize}\n\\item First\n\\item Second\n\\end{itemize}')
  })

  it('exports a numbered list as an enumerate environment', () => {
    const root = makeNode({ id: 'root', draftContent: '<ol><li>First</li><li>Second</li></ol>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('\\begin{enumerate}\n\\item First\n\\item Second\n\\end{enumerate}')
  })
})

describe('underline in export', () => {
  it('passes underline through as raw <u> in Markdown and renders it back in print HTML', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Some <u>underlined</u> text.</p>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('Some <u>underlined</u> text.')
    const html = markdownToHtml(md)
    expect(html).toContain('<u>underlined</u>')
  })

  it('exports underline as \\underline{} in LaTeX', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Some <u>underlined</u> text.</p>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('Some \\underline{underlined} text.')
  })
})

describe('list edge cases in export', () => {
  it('keeps bold/italic/citations working inside a list item', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>A <strong>bold</strong> and <em>italic</em> item.</li></ul>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('- A **bold** and *italic* item.')
  })

  it('closes a list immediately before a blockquote with no blank line between them', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>Item</li></ul><blockquote>Quoted.</blockquote>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toMatch(/<\/ul>\s*<blockquote>Quoted\.<\/blockquote>/)
  })

  it('does not crash on a nested list', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>Outer<ul><li>Inner</li></ul></li></ul>' })
    expect(() => essayToMarkdown(makeEssay('root'), new Map([['root', root]]))).not.toThrow()
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(() => markdownToHtml(md)).not.toThrow()
    expect(() => essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())).not.toThrow()
    expect(md).toContain('Outer')
    expect(md).toContain('Inner')
  })

  it('ends a list that is the very last thing in the document', () => {
    const root = makeNode({ id: 'root', draftContent: '<ul><li>Only item</li></ul>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html.trim().endsWith('</ul>')).toBe(true)
  })
})

describe('a blockquote whose text has invisible-in-the-editor line breaks', () => {
  // A quote pulled from a PDF (reflowTextItems/separatorForGap in
  // lib/pdf.ts) has a literal "\n" wherever the original page happened to
  // wrap a line — never shown as a break in the live editor, since the
  // browser collapses it under ordinary white-space: normal, same as any
  // other run of whitespace in flowing text. A real <br> the user actually
  // inserted is a separate element entirely, not part of this text node.
  const draftContent = '<blockquote class="quote">First line of the quote\nsecond line of the same quote.</blockquote>'

  it('collapses it to a single flowing line in Markdown, not one "> " line per embedded newline', () => {
    const root = makeNode({ id: 'root', draftContent })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('> First line of the quote second line of the same quote.')
    expect(md).not.toMatch(/>.*\n>.*second line/)
  })

  it('renders as one continuous blockquote in the printable HTML, not a line break mid-quote', () => {
    const root = makeNode({ id: 'root', draftContent })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    const html = markdownToHtml(md)
    expect(html).toContain('First line of the quote second line of the same quote.')
    expect(html).not.toContain('<br>')
  })

  it('does not turn into a LaTeX paragraph break inside the quote environment', () => {
    const root = makeNode({ id: 'root', draftContent: '<blockquote class="quote">First paragraph of the quote\n\nsecond paragraph, same quote.</blockquote>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('First paragraph of the quote second paragraph, same quote.')
  })

  it('still honors a real <br> the user actually inserted as a hard break', () => {
    const root = makeNode({ id: 'root', draftContent: '<blockquote class="quote">First line<br>second line</blockquote>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('> First line  \n> second line')
  })
})
