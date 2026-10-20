import { describe, expect, it } from 'vitest'
import { addPrintChrome, essayToLatex, essayToMarkdown, markdownToHtml, referencesHtml, referencesMarkdown } from '../export'
import { citationHtml } from '../bibtex'
import { markerHtml } from '../childMarkers'
import type { Essay, EssayNode, Source } from '../../models/types'

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
