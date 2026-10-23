import { describe, expect, it } from 'vitest'
import { addPrintChrome, applyMathlikeHeadings, ensureCitationSpacing, essayToLatex, essayToMarkdown, floatPrintFootnotes, markdownToHtml, referencesHtml, referencesMarkdown, renderBibliographyEntry } from '../export'
import { citationHtml } from '../bibtex'
import { markerHtml } from '../childMarkers'
import type { BibtexEntry, Essay, EssayNode, Source } from '../../models/types'

function makeSource(overrides: Partial<Source> & { id: string } = { id: 's1' }): Source {
  return {
    bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } },
    comment: '',
    pageHtml: [],
    pageCount: 0,
    contentBytes: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

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

describe('a title wrapped in "**" renders as bold, not with the literal asterisks left showing', () => {
  it('consumes a balanced "**...**" wrapping the whole essay title into a real <strong>, in the printed output', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>body</p>' })
    const essay: Essay = { id: 'e1', title: '**My Essay**', rootNodeId: 'root', createdAt: 0, updatedAt: 0 }
    const html = markdownToHtml(essayToMarkdown(essay, new Map([['root', root]])))
    expect(html).toContain('<h1><strong>My Essay</strong></h1>')
    expect(html).not.toContain('*')
  })

  it('does the same for a section title', () => {
    const root = makeNode({ id: 'root', draftContent: `<p>intro</p>${markerHtml('a')}` })
    const a = makeNode({ id: 'a', title: '**Section One**', draftContent: '<p>text</p>' })
    const html = markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root], ['a', a]])))
    expect(html).toContain('<h2><strong>Section One</strong></h2>')
  })
})

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

describe('an empty <b>/<strong>/<i>/<em> left over from a formatting toggle with nothing typed', () => {
  it('drops an empty <strong> entirely instead of emitting "****", which markdownToHtml cannot round-trip as bold', () => {
    const root = makeNode({ id: 'root', draftContent: '<p><strong></strong>Real text right after it.</p>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).not.toContain('****')
    expect(md).toContain('Real text right after it.')
  })

  it('reproduces, and fixes, the real bug: an empty bold span as the very first content after the title no longer leaves two stray asterisks in the printed output', () => {
    const root = makeNode({ id: 'root', draftContent: '<p><strong></strong>Body text.</p>' })
    const html = markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root]])))
    expect(html).not.toContain('*')
    expect(html).toContain('<p>Body text.</p>')
  })

  it('does the same for an empty <i>/<em>', () => {
    const root = makeNode({ id: 'root', draftContent: '<p><em></em>Body text.</p>' })
    const html = markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root]])))
    expect(html).not.toContain('*')
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

describe('citations in the LaTeX export', () => {
  it('exports a plain citation (no note) as \\cite{key}, with no optional argument', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>As argued <cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite>.</p>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map([['s1', makeSource()]]))
    expect(tex).toContain('As argued \\cite{smith2020}.')
  })

  it('exports data-note as \\cite\'s own optional post-note argument', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>As argued <cite class="citation" data-source-id="s1" data-cite-v="2" data-note="p. 5">(Smith, 2020), p. 5</cite>.</p>',
    })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map([['s1', makeSource()]]))
    expect(tex).toContain('As argued \\cite[p. 5]{smith2020}.')
  })

  it('also works for \\footcite (biblatex)', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<cite class="citation" data-source-id="s1" data-cite-v="2" data-note="ch. 3">(Smith, 2020), ch. 3</cite>',
    })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map([['s1', makeSource()]]), { citeCommand: '\\footcite' })
    expect(tex).toContain('\\footcite[ch. 3]{smith2020}')
  })

  it('escapes LaTeX-special characters in the note', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<cite class="citation" data-source-id="s1" data-cite-v="2" data-note="p. 5 &amp; 6">(Smith, 2020), p. 5 &amp; 6</cite>',
    })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map([['s1', makeSource()]]))
    expect(tex).toContain('\\cite[p. 5 \\& 6]{smith2020}')
  })

  it('falls back to the raw source id when the source is not in the sources map', () => {
    const root = makeNode({ id: 'root', draftContent: '<cite class="citation" data-source-id="unknown-id" data-cite-v="2">(Someone, 2020)</cite>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map())
    expect(tex).toContain('\\cite{unknown-id}')
  })

  it('does not leak the note-less chip\'s own zero-width-space caret placeholder into the output', () => {
    // citationHtml (lib/bibtex.ts) plants a lone U+200B after a note-less
    // citation's base span so a click right after it has somewhere to
    // land — real markup, not a hand-crafted edge case.
    const root = makeNode({ id: 'root', draftContent: `<p>As argued ${citationHtml(makeSource())}.</p>` })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root]]), new Map([['s1', makeSource()]]))
    expect(tex).toContain('As argued \\cite{smith2020}.')
    expect(tex).not.toContain('​')
  })
})

describe('essayToLatex: abstract', () => {
  it('renders the root\'s first child, titled exactly "Abstract", as \\abstract{} instead of \\section{}', () => {
    const root = makeNode({ id: 'root', draftContent: `${markerHtml('abs')}${markerHtml('a')}` })
    const abs = makeNode({ id: 'abs', title: 'Abstract', draftContent: '<p>A short summary.</p>' })
    const a = makeNode({ id: 'a', title: 'Introduction', draftContent: '<p>Body.</p>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root], ['abs', abs], ['a', a]]), new Map())
    expect(tex).toContain('\\abstract{A short summary.}')
    expect(tex).not.toContain('\\section{Abstract}')
    expect(tex).toContain('\\section{Introduction}')
  })

  it("doesn't treat a later section titled \"Abstract\" (not the root's own first child) specially", () => {
    const root = makeNode({ id: 'root', draftContent: `${markerHtml('a')}${markerHtml('b')}` })
    const a = makeNode({ id: 'a', title: 'Introduction', draftContent: '<p>Body.</p>' })
    const b = makeNode({ id: 'b', title: 'Abstract', draftContent: '<p>Not really an abstract.</p>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root], ['a', a], ['b', b]]), new Map())
    expect(tex).toContain('\\section{Abstract}')
    expect(tex).not.toContain('\\abstract{')
  })

  it('renders any (unusual, but real) subsections of the abstract as normal \\subsection{}s right after it', () => {
    const root = makeNode({ id: 'root', draftContent: markerHtml('abs') })
    const abs = makeNode({ id: 'abs', title: 'Abstract', draftContent: `<p>Summary.</p>${markerHtml('sub')}` })
    const sub = makeNode({ id: 'sub', title: 'A Subpoint', draftContent: '<p>Detail.</p>' })
    const tex = essayToLatex(makeEssay('root'), new Map([['root', root], ['abs', abs], ['sub', sub]]), new Map())
    expect(tex).toContain('\\abstract{Summary.}')
    expect(tex).toContain('\\subsection{A Subpoint}')
  })
})

describe('citations in Markdown export', () => {
  it('exports a citation as its own rendered label text, note included — Markdown has no special-case for .citation at all', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>As argued <cite class="citation" data-source-id="s1" data-cite-v="2" data-note="p. 5">(Smith, 2020), p. 5</cite>.</p>',
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('As argued (Smith, 2020), p. 5.')
  })

  it('does not leak the note-less chip\'s own zero-width-space caret placeholder into the output', () => {
    const root = makeNode({ id: 'root', draftContent: `<p>As argued ${citationHtml(makeSource())}.</p>` })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]))
    expect(md).toContain('As argued (Smith, 2020).')
    expect(md).not.toContain('​')
  })
})

describe('print-mode citation styling (essayToMarkdown\'s citationOptions)', () => {
  function sourceAndCitation(note?: string): { nodeMap: Map<string, EssayNode>; sources: Map<string, Source>; sourceId: string } {
    const source = makeSource({
      id: 's1',
      bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper' } },
    })
    // A baked-in label deliberately different from what the source's
    // *current* bibtex would produce, the same way a real stale chip
    // looks — proves these options re-render fresh rather than reading
    // the chip's own frozen text.
    const root = makeNode({ id: 'root', draftContent: `<p>As argued <cite class="citation" data-source-id="s1" data-cite-v="2"${note ? ` data-note="${note}"` : ''}>(Stale, 1999)</cite>.</p>` })
    return { nodeMap: new Map([['root', root]]), sources: new Map([['s1', source]]), sourceId: 's1' }
  }

  it('re-renders author-year fresh from the current source, ignoring the chip\'s own stale baked-in text', () => {
    const { nodeMap, sources, sourceId } = sourceAndCitation()
    const md = essayToMarkdown(makeEssay('root'), nodeMap, { citationOptions: { sources, style: 'author-year', placement: 'inline', orderedSourceIds: [sourceId] } })
    expect(ensureCitationSpacing(markdownToHtml(md))).toContain('As argued (Smith, 2020).')
    expect(md).not.toContain('Stale')
  })

  it('renders author-title style', () => {
    const { nodeMap, sources, sourceId } = sourceAndCitation()
    const md = essayToMarkdown(makeEssay('root'), nodeMap, { citationOptions: { sources, style: 'author-title', placement: 'inline', orderedSourceIds: [sourceId] } })
    expect(ensureCitationSpacing(markdownToHtml(md))).toContain('As argued (Smith, "An Early Paper").')
  })

  it('renders numbered style using the bracket position from orderedSourceIds, not insertion order', () => {
    const { nodeMap, sources, sourceId } = sourceAndCitation()
    const md = essayToMarkdown(makeEssay('root'), nodeMap, { citationOptions: { sources, style: 'numbered', placement: 'inline', orderedSourceIds: ['other-source', sourceId] } })
    // The brackets are escaped in the raw Markdown (`\[2\]`) — same as any
    // other markdown-significant character a citation's own rendering
    // might produce — and correctly unescaped back to literal "[2]" by
    // the time markdownToHtml renders it, so that's what's checked here.
    expect(ensureCitationSpacing(markdownToHtml(md))).toContain('As argued [2].')
  })

  it('still includes the note for every style, folded inside the closing delimiter', () => {
    const { nodeMap, sources, sourceId } = sourceAndCitation('p. 5')
    const md = essayToMarkdown(makeEssay('root'), nodeMap, { citationOptions: { sources, style: 'author-year', placement: 'inline', orderedSourceIds: [sourceId] } })
    expect(md).toContain('(Smith, 2020, p. 5)')
  })

  it('folds the note inside the brackets for numbered style too', () => {
    const { nodeMap, sources, sourceId } = sourceAndCitation('p. 5')
    const md = essayToMarkdown(makeEssay('root'), nodeMap, { citationOptions: { sources, style: 'numbered', placement: 'inline', orderedSourceIds: [sourceId] } })
    expect(ensureCitationSpacing(markdownToHtml(md))).toContain('[1, p. 5]')
  })

  it('footnote placement replaces the citation with a numbered footnote reference whose body is the full citation', () => {
    const { nodeMap, sources, sourceId } = sourceAndCitation()
    const md = essayToMarkdown(makeEssay('root'), nodeMap, { citationOptions: { sources, style: 'author-year', placement: 'footnote', orderedSourceIds: [sourceId] } })
    expect(md).toContain('As argued [^fn1].')
    expect(md).toContain('[^fn1]: Smith, Jane (2020). An Early Paper.')
  })

  it('footnote placement shares one numbering sequence with the essay\'s own real footnotes', () => {
    const source = makeSource({ id: 's1', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper' } } })
    const root = makeNode({
      id: 'root',
      draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup>, as argued <cite class="citation" data-source-id="s1" data-cite-v="2">(Stale, 1999)</cite>.</p>',
      footnotes: [{ id: 'f1', content: '<p>A real footnote.</p>' }],
    })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]), { citationOptions: { sources: new Map([['s1', source]]), style: 'author-year', placement: 'footnote', orderedSourceIds: ['s1'] } })
    expect(md).toContain('A claim[^fn1]')
    expect(md).toContain('as argued [^fn2]')
    expect(md).toContain('[^fn1]: A real footnote.')
    expect(md).toContain('[^fn2]: Smith, Jane (2020). An Early Paper.')
  })

  it('falls back to the chip\'s own frozen text when its source no longer exists', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>As argued <cite class="citation" data-source-id="gone" data-cite-v="2">(Smith, 2020)</cite>.</p>' })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]), { citationOptions: { sources: new Map(), style: 'numbered', placement: 'inline', orderedSourceIds: [] } })
    expect(ensureCitationSpacing(markdownToHtml(md))).toContain('As argued (Smith, 2020).')
  })

  it('leaves the plain .md export (no citationOptions) completely unaffected', () => {
    const { nodeMap } = sourceAndCitation()
    const md = essayToMarkdown(makeEssay('root'), nodeMap)
    expect(md).toContain('As argued (Stale, 1999).')
  })
})

describe('ensureCitationSpacing', () => {
  function renderInline(draftContent: string, style: 'author-year' | 'numbered' = 'author-year'): string {
    const source = makeSource({ id: 's1', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020' } } })
    const root = makeNode({ id: 'root', draftContent })
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]), { citationOptions: { sources: new Map([['s1', source]]), style, placement: 'inline', orderedSourceIds: ['s1'] } })
    return ensureCitationSpacing(markdownToHtml(md))
  }

  it('inserts a leading and trailing space when a citation is glued directly to words on both sides', () => {
    const html = renderInline('<p>wordsbefore<cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite>wordsafter</p>')
    expect(html).toContain('wordsbefore (Smith, 2020) wordsafter')
  })

  it('does not duplicate whitespace that is already there', () => {
    const html = renderInline('<p>words before <cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite> words after</p>')
    expect(html).toContain('words before (Smith, 2020) words after')
    expect(html).not.toContain('  ')
  })

  it('does not insert a space next to punctuation', () => {
    const html = renderInline('<p>as argued<cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite>, rather than flattening</p>')
    expect(html).toContain('as argued (Smith, 2020), rather than flattening')
  })

  it('does not insert a space at the very start or end of a paragraph', () => {
    const html = renderInline('<p><cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite> starts the sentence.</p>')
    expect(html).toContain('<p>(Smith, 2020) starts the sentence.</p>')
  })

  it('separates two inline citations typed back to back with no space between them', () => {
    const source2 = makeSource({ id: 's2', bibtex: { type: 'article', key: 'doe2019', fields: { author: 'Doe, John', year: '2019' } } })
    const root = makeNode({
      id: 'root',
      draftContent:
        '<p>As argued<cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite><cite class="citation" data-source-id="s2" data-cite-v="2">(Doe, 2019)</cite>.</p>',
    })
    const sources = new Map([['s1', makeSource({ id: 's1', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020' } } })], ['s2', source2]])
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]), {
      citationOptions: { sources, style: 'author-year', placement: 'inline', orderedSourceIds: ['s1', 's2'] },
    })
    const html = ensureCitationSpacing(markdownToHtml(md))
    expect(html).toContain('As argued (Smith, 2020) (Doe, 2019).')
  })

  it('separates two footnote-placed citations typed back to back', () => {
    const source2 = makeSource({ id: 's2', bibtex: { type: 'article', key: 'doe2019', fields: { author: 'Doe, John', year: '2019' } } })
    const root = makeNode({
      id: 'root',
      draftContent:
        '<p>As argued<cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite><cite class="citation" data-source-id="s2" data-cite-v="2">(Doe, 2019)</cite>.</p>',
    })
    const sources = new Map([['s1', makeSource({ id: 's1', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020' } } })], ['s2', source2]])
    const md = essayToMarkdown(makeEssay('root'), new Map([['root', root]]), {
      citationOptions: { sources, style: 'author-year', placement: 'footnote', orderedSourceIds: ['s1', 's2'] },
    })
    const html = ensureCitationSpacing(markdownToHtml(md))
    const refs = html.match(/<sup class="print-footnote-ref">.*?<\/sup>/g) ?? []
    expect(refs).toHaveLength(2)
    // Exactly one space of real text sits between the two sup elements.
    expect(html).toMatch(/<\/sup> <sup/)
  })

  it('separates a real footnote from a word it is glued to, the same as a citation', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup>continues.</p>',
      footnotes: [{ id: 'f1', content: '<p>A note.</p>' }],
    })
    const html = ensureCitationSpacing(markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root]]))))
    expect(html).toContain('</sup> continues.')
  })

  it('removes the <cite class="print-citation"> scaffold from the final output', () => {
    const html = renderInline('<p>argued <cite class="citation" data-source-id="s1" data-cite-v="2">(Smith, 2020)</cite>.</p>')
    expect(html).not.toContain('print-citation')
    expect(html).toContain('argued (Smith, 2020).')
  })

  it('leaves text with no citations or footnotes completely untouched', () => {
    const html = markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', makeNode({ id: 'root', draftContent: '<p>Plain text.</p>' })]])))
    expect(ensureCitationSpacing(html)).toBe(html)
  })
})

describe('floatPrintFootnotes', () => {
  it('replaces an inline footnote-ref marker with a float:footnote span carrying the footnote body, and drops the end-of-document list', () => {
    const html = markdownToHtml(
      essayToMarkdown(makeEssay('root'), new Map([['root', makeNode({ id: 'root', draftContent: '<p>A claim<sup class="footnote-ref" data-footnote-id="f1"></sup>.</p>', footnotes: [{ id: 'f1', content: '<p>The footnote body.</p>' }] })]])),
    )
    const floated = floatPrintFootnotes(html)
    expect(floated).not.toContain('print-footnote-ref')
    expect(floated).not.toContain('print-footnotes')
    expect(floated).not.toContain('<ol')
    expect(floated).toContain('<span class="pagedjs-footnote" data-ref="fn1">The footnote body.</span>')
  })

  it('carries each footnote\'s own id through as data-ref, so multiple footnotes stay distinguishable', () => {
    const root = makeNode({
      id: 'root',
      draftContent: '<p>First<sup class="footnote-ref" data-footnote-id="f1"></sup> and second<sup class="footnote-ref" data-footnote-id="f2"></sup>.</p>',
      footnotes: [
        { id: 'f1', content: '<p>First note.</p>' },
        { id: 'f2', content: '<p>Second note.</p>' },
      ],
    })
    const html = markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root]])))
    const floated = floatPrintFootnotes(html)
    expect(floated).toContain('data-ref="fn1">First note.</span>')
    expect(floated).toContain('data-ref="fn2">Second note.</span>')
  })

  it('leaves html with no footnotes at all completely untouched', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>Plain text, nothing fancy.</p>' })
    const html = markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root]])))
    expect(floatPrintFootnotes(html)).toBe(html)
  })
})

describe('addPrintChrome', () => {
  function threeSectionEssay(): { essay: Essay; nodeMap: Map<string, EssayNode> } {
    const root = makeNode({ id: 'root', title: 'Essay Title', draftContent: `<p>intro</p>${markerHtml('a')}${markerHtml('b')}` })
    const a = makeNode({ id: 'a', title: 'First Section', draftContent: `<p>first</p>${markerHtml('a1')}` })
    const a1 = makeNode({ id: 'a1', title: 'First Subsection', draftContent: '<p>nested</p>' })
    const b = makeNode({ id: 'b', title: 'Second Section', draftContent: '<p>second</p>' })
    const nodeMap = new Map([
      ['root', root],
      ['a', a],
      ['a1', a1],
      ['b', b],
    ])
    return { essay: makeEssay('root'), nodeMap }
  }

  function render(): string {
    const { essay, nodeMap } = threeSectionEssay()
    return addPrintChrome(markdownToHtml(essayToMarkdown(essay, nodeMap)))
  }

  it('numbers root-level sections 1, 2, … and a subsection N.M, the same scheme the editor suggests for a new placeholder title', () => {
    const html = render()
    expect(html).toContain('<h2>1 First Section</h2>')
    expect(html).toContain('<h3>1.1 First Subsection</h3>')
    expect(html).toContain('<h2>2 Second Section</h2>')
  })

  it('never numbers the essay title itself', () => {
    const html = render()
    expect(html).toContain('<h1>Test Essay</h1>')
  })

  it('adds a thick rule right after the title', () => {
    const html = render()
    expect(html).toMatch(/<h1>Test Essay<\/h1>\s*<hr class="print-title-rule">/)
  })

  it('adds a thin rule right under every root-level section title, including the last one, but not under a subsection', () => {
    const html = render()
    const ruleCount = (html.match(/<hr class="print-section-rule">/g) ?? []).length
    expect(ruleCount).toBe(2) // one under "First Section", one under "Second Section"
    expect(html).toContain('<h2>1 First Section</h2><hr class="print-section-rule">')
    expect(html).toContain('<h2>2 Second Section</h2><hr class="print-section-rule">')
    // Right under the section's own heading, not under its subsection's.
    expect(html).not.toContain('<h3>1.1 First Subsection</h3><hr class="print-section-rule">')
  })

  it('adds no rules at all for an essay with no sections', () => {
    const root = makeNode({ id: 'root', title: 'Lonely Essay', draftContent: '<p>just text, no sections</p>' })
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root]]))))
    expect(html).not.toContain('print-section-rule')
    expect(html).toContain('print-title-rule') // the title itself still gets its own rule
  })

  function essayWithAbstract(): { essay: Essay; nodeMap: Map<string, EssayNode> } {
    const root = makeNode({ id: 'root', title: 'Essay Title', draftContent: `${markerHtml('abs')}${markerHtml('a')}` })
    const abs = makeNode({ id: 'abs', title: 'Abstract', draftContent: '<p>A short summary of the whole essay.</p>' })
    const a = makeNode({ id: 'a', title: 'Introduction', draftContent: '<p>Body text.</p>' })
    return { essay: makeEssay('root'), nodeMap: new Map([['root', root], ['abs', abs], ['a', a]]) }
  }

  it('folds a leading "Abstract" section into a run-in bold lead inside a .print-abstract wrapper, with no number and no rule', () => {
    const { essay, nodeMap } = essayWithAbstract()
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(essay, nodeMap)))
    expect(html).not.toContain('<h2>Abstract</h2>')
    expect(html).not.toMatch(/<h2>\d[^<]*Abstract/)
    expect(html).toContain('<div class="print-abstract"><p><strong>Abstract. </strong>A short summary of the whole essay.</p></div>')
  })

  it("numbers the section right after the abstract 1, not 2, and the abstract itself isn't counted toward any rule", () => {
    const { essay, nodeMap } = essayWithAbstract()
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(essay, nodeMap)))
    expect(html).toContain('<h2>1 Introduction</h2>')
    expect((html.match(/<hr class="print-section-rule">/g) ?? []).length).toBe(1)
  })

  it('gives a contentless abstract a standalone bold "Abstract." lead', () => {
    const root = makeNode({ id: 'root', title: 'Essay Title', draftContent: markerHtml('abs') })
    const abs = makeNode({ id: 'abs', title: 'Abstract', draftContent: '' })
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root], ['abs', abs]]))))
    expect(html).toContain('<div class="print-abstract"><p><strong>Abstract. </strong></p></div>')
  })

  it("doesn't treat a later section titled \"Abstract\" (not the root's own first child) specially", () => {
    const root = makeNode({ id: 'root', title: 'Essay Title', draftContent: `${markerHtml('a')}${markerHtml('b')}` })
    const a = makeNode({ id: 'a', title: 'Introduction', draftContent: '<p>first</p>' })
    const b = makeNode({ id: 'b', title: 'Abstract', draftContent: '<p>second</p>' })
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root], ['a', a], ['b', b]]))))
    expect(html).toContain('<h2>1 Introduction</h2>')
    expect(html).toContain('<h2>2 Abstract</h2>')
    expect(html).not.toContain('print-abstract')
  })
})

describe('applyMathlikeHeadings', () => {
  it('folds a numbered subsection into a bold run-in lead inside its own first paragraph, removing the heading', () => {
    const root = makeNode({ id: 'root', draftContent: `${markerHtml('a')}` })
    const a = makeNode({ id: 'a', title: 'Background', draftContent: `${markerHtml('a1')}` })
    const a1 = makeNode({ id: 'a1', title: 'Prior Work', draftContent: '<p>Some discussion.</p>' })
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root], ['a', a], ['a1', a1]]))))
    const folded = applyMathlikeHeadings(html)
    expect(folded).not.toContain('<h3>')
    expect(folded).toContain('<p><strong>1.1 Prior Work. </strong>Some discussion.</p>')
    // The root-level section heading itself is left alone — that one's a pure-CSS treatment.
    expect(folded).toContain('<h2>1 Background</h2>')
  })

  it('gives a contentless subsection a standalone run-in paragraph', () => {
    const root = makeNode({ id: 'root', draftContent: `${markerHtml('a')}` })
    const a = makeNode({ id: 'a', title: 'Empty Subsection', draftContent: '' })
    const essayRoot = makeNode({ id: 'r2', draftContent: `${markerHtml('p')}` })
    const parent = makeNode({ id: 'p', title: 'Parent', draftContent: `${markerHtml('a')}` })
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(makeEssay('r2'), new Map([['r2', essayRoot], ['p', parent], ['a', a]]))))
    const folded = applyMathlikeHeadings(html)
    expect(folded).not.toContain('<h3>')
    expect(folded).toContain('<p><strong>1.1 Empty Subsection. </strong></p>')
  })

  it('leaves a title already ending in a period alone rather than doubling it', () => {
    const root = makeNode({ id: 'root', draftContent: `${markerHtml('a')}` })
    const a = makeNode({ id: 'a', title: 'Parent', draftContent: markerHtml('a1') })
    const a1 = makeNode({ id: 'a1', title: 'Already Ends.', draftContent: '<p>Text.</p>' })
    const html = addPrintChrome(markdownToHtml(essayToMarkdown(makeEssay('root'), new Map([['root', root], ['a', a], ['a1', a1]]))))
    const folded = applyMathlikeHeadings(html)
    expect(folded).toContain('1.1 Already Ends. ')
    expect(folded).not.toContain('Already Ends.. ')
  })
})

describe('referencesMarkdown / referencesHtml', () => {
  function essayWithTwoCitations(): { nodeMap: Map<string, EssayNode>; sources: Map<string, Source> } {
    const smith = makeSource({ id: 's-smith', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper', journal: 'Journal of Examples' } } })
    const adams = makeSource({ id: 's-adams', bibtex: { type: 'article', key: 'adams2019', fields: { author: 'Adams, Bob', year: '2019', title: 'A Prior Paper', journal: 'Journal of Priors' } } })
    const root = makeNode({
      id: 'root',
      draftContent: `<p>As argued by ${citationHtml(smith)} and ${citationHtml(adams)}, the sky is blue.</p>`,
    })
    return { nodeMap: new Map([['root', root]]), sources: new Map([['s-smith', smith], ['s-adams', adams]]) }
  }

  it('appends a "## References" section, one list item per cited source, sorted by author', () => {
    const { nodeMap, sources } = essayWithTwoCitations()
    const md = referencesMarkdown(nodeMap, sources)
    expect(md).toContain('## References')
    expect(md).toContain('- Adams, Bob (2019). A Prior Paper. Journal of Priors.')
    expect(md).toContain('- Smith, Jane (2020). An Early Paper. Journal of Examples.')
    // Adams (2019) sorts before Smith (2020).
    expect(md.indexOf('Adams')).toBeLessThan(md.indexOf('Smith'))
  })

  it('renders the same entries as an <h2>/<ul> for the print view, outside any numbering', () => {
    const { nodeMap, sources } = essayWithTwoCitations()
    const html = referencesHtml(nodeMap, sources)
    expect(html).toContain('<h2 class="print-references-heading">References</h2>')
    expect(html).toContain('<li>Adams, Bob (2019). A Prior Paper. Journal of Priors.</li>')
    expect(html).toContain('<li>Smith, Jane (2020). An Early Paper. Journal of Examples.</li>')
  })

  it("includes a cited source's own `pages` field (its page range within the journal/book) in the References entry", () => {
    const smith = makeSource({ id: 's-smith', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper', journal: 'Journal of Examples', pages: '45-67' } } })
    const root = makeNode({ id: 'root', draftContent: `<p>As argued by ${citationHtml(smith)}, the sky is blue.</p>` })
    const nodeMap = new Map([['root', root]])
    const sources = new Map([['s-smith', smith]])
    expect(referencesMarkdown(nodeMap, sources)).toContain('- Smith, Jane (2020). An Early Paper. Journal of Examples, pp. 45-67.')
    expect(referencesHtml(nodeMap, sources)).toContain('<li>Smith, Jane (2020). An Early Paper. Journal of Examples, pp. 45-67.</li>')
  })

  it('lists a source only once even if cited multiple times', () => {
    const smith = makeSource({ id: 's-smith' })
    const root = makeNode({ id: 'root', draftContent: `<p>${citationHtml(smith)} ... and again, ${citationHtml(smith, { page: 5 })}.</p>` })
    const md = referencesMarkdown(new Map([['root', root]]), new Map([['s-smith', smith]]))
    expect((md.match(/^- /gm) ?? []).length).toBe(1)
  })

  it('omits a cited source with no matching entry in the sources map (deleted since)', () => {
    const root = makeNode({ id: 'root', draftContent: '<p><cite class="citation" data-source-id="gone" data-cite-v="2">(Nobody, n.d.)</cite></p>' })
    const md = referencesMarkdown(new Map([['root', root]]), new Map())
    expect(md).toBe('')
  })

  it('is the empty string — nothing appended at all — for an essay that cites no sources', () => {
    const root = makeNode({ id: 'root', draftContent: '<p>No citations here.</p>' })
    expect(referencesMarkdown(new Map([['root', root]]), new Map())).toBe('')
    expect(referencesHtml(new Map([['root', root]]), new Map())).toBe('')
  })
})

describe('renderBibliographyEntry: apa/mla/chicago', () => {
  function articleEntry(overrides: Partial<Record<string, string>> = {}): BibtexEntry {
    return {
      type: 'article',
      key: 'smith2020',
      fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper', journal: 'Journal of Examples', volume: '12', number: '3', pages: '45-67', ...overrides },
    }
  }

  function bookEntry(overrides: Partial<Record<string, string>> = {}): BibtexEntry {
    return { type: 'book', key: 'smith2020book', fields: { author: 'Smith, Jane', year: '2020', title: 'A Whole Book', publisher: 'Example Press', ...overrides } }
  }

  it('renders an APA-style article entry: inverted initials, parenthesized year, italic journal, no title markup', () => {
    const md = renderBibliographyEntry(articleEntry(), 'apa')
    expect(md).toBe('Smith, J. (2020). An Early Paper. *Journal of Examples*, 12(3), 45-67.')
  })

  it('renders an APA-style book entry: italicized title, no quotes', () => {
    const md = renderBibliographyEntry(bookEntry(), 'apa')
    expect(md).toBe('Smith, J. (2020). *A Whole Book*. Example Press.')
  })

  it('joins two APA authors with an ampersand', () => {
    const md = renderBibliographyEntry(articleEntry({ author: 'Smith, Jane and Doe, John' }), 'apa')
    expect(md).toContain('Smith, J., & Doe, J. (2020)')
  })

  it('renders an MLA-style article entry: first author inverted, quoted title, italic journal with vol./no.', () => {
    const md = renderBibliographyEntry(articleEntry(), 'mla')
    expect(md).toBe('Smith, Jane. "An Early Paper." *Journal of Examples*, vol. 12, no. 3, 2020, pp. 45-67.')
  })

  it('renders an MLA-style book entry: italicized title, publisher and year', () => {
    const md = renderBibliographyEntry(bookEntry(), 'mla')
    expect(md).toBe('Smith, Jane. *A Whole Book*. Example Press, 2020.')
  })

  it('uses "et al." for 3+ MLA/Chicago authors', () => {
    const md = renderBibliographyEntry(articleEntry({ author: 'Smith, Jane and Doe, John and Lee, Kim' }), 'mla')
    expect(md).toContain('Smith, Jane, et al.')
  })

  it('keeps the second MLA author in natural (not inverted) order', () => {
    const md = renderBibliographyEntry(articleEntry({ author: 'Smith, Jane and Doe, John' }), 'mla')
    expect(md).toContain('Smith, Jane, and John Doe.')
  })

  it('renders a Chicago-style article entry: quoted title, italic journal, volume/no./year/pages', () => {
    const md = renderBibliographyEntry(articleEntry(), 'chicago')
    expect(md).toBe('Smith, Jane. "An Early Paper." *Journal of Examples* 12, no. 3 (2020): 45-67.')
  })

  it('renders a Chicago-style book entry the same shape as MLA (no stored place of publication)', () => {
    const md = renderBibliographyEntry(bookEntry(), 'chicago')
    expect(md).toBe('Smith, Jane. *A Whole Book*. Example Press, 2020.')
  })

  it('degrades gracefully with only a title, for every style', () => {
    const entry: BibtexEntry = { type: 'misc', key: 'untitled', fields: { title: 'Untitled Paper' } }
    expect(renderBibliographyEntry(entry, 'apa')).toBe('*Untitled Paper*.')
    expect(renderBibliographyEntry(entry, 'mla')).toBe('*Untitled Paper*.')
    expect(renderBibliographyEntry(entry, 'chicago')).toBe('*Untitled Paper*.')
  })

  it('falls back to an uninverted single name when the stored author has no comma to invert on', () => {
    const md = renderBibliographyEntry(articleEntry({ author: 'Acme Research Group' }), 'mla')
    expect(md).toContain('Acme Research Group.')
  })

  it('escapes a markdown-special character in the title so it never becomes stray emphasis once resolved to HTML', () => {
    const smith = makeSource({ id: 's-smith', bibtex: articleEntry({ title: 'A *Starred* Title' }) })
    const root = makeNode({ id: 'root', draftContent: `<p>As argued by ${citationHtml(smith)}, the sky is blue.</p>` })
    const html = referencesHtml(new Map([['root', root]]), new Map([['s-smith', smith]]), 'apa')
    expect(html).toContain('A *Starred* Title')
    expect(html).not.toContain('<em>Starred</em>')
  })

  it('italicizes the journal name as real <em> once run through the HTML references list', () => {
    const smith = makeSource({ id: 's-smith', bibtex: articleEntry() })
    const root = makeNode({ id: 'root', draftContent: `<p>As argued by ${citationHtml(smith)}, the sky is blue.</p>` })
    const html = referencesHtml(new Map([['root', root]]), new Map([['s-smith', smith]]), 'apa')
    expect(html).toContain('<em>Journal of Examples</em>')
  })

  it('keeps the *italic* markers as plain Markdown (not HTML) in the .md export', () => {
    const smith = makeSource({ id: 's-smith', bibtex: articleEntry() })
    const root = makeNode({ id: 'root', draftContent: `<p>As argued by ${citationHtml(smith)}, the sky is blue.</p>` })
    const md = referencesMarkdown(new Map([['root', root]]), new Map([['s-smith', smith]]), 'mla')
    expect(md).toContain('*Journal of Examples*')
    expect(md).not.toContain('<em>')
  })
})
