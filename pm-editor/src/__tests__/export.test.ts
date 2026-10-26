import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema as schema } from '../schema'
import {
  addPrintChrome,
  ensureCitationSpacing,
  markdownToHtml,
  moveFootnoteCitationsPastPeriod,
  pmCitedSources,
  pmEssayToLatex,
  pmEssayToMarkdown,
  referencesMarkdown,
  type PrintCitationOptions,
} from '../export'
import type { Source } from '../types'

function doc(sectionJson: object): PMNode {
  return PMNode.fromJSON(schema, { type: 'doc', content: [sectionJson] })
}

function section(id: string, title: string, content: object[]): object {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: title ? [{ type: 'text', text: title }] : [] }, ...content] }
}

function para(text: string): object {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

const smith: Source = { id: 'smith', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'An Early Paper', journal: 'Journal of Examples' } } }
const sources = new Map([['smith', smith]])

describe('pmEssayToMarkdown', () => {
  it('emits the title as an H1, never numbering the root section itself', () => {
    const d = doc(section('root', 'Root Title Unused In Export', [para('Hello.')]))
    const md = pmEssayToMarkdown('Test Essay', d, sources)
    expect(md).toContain('# Test Essay')
    expect(md).not.toContain('Root Title Unused In Export')
  })

  it('numbers a nested section at depth 1 as ##, depth 2 as ###', () => {
    const d = doc(section('root', '', [section('a', 'First Section', [para('a text'), section('a1', 'Nested', [para('a1 text')])])]))
    const md = pmEssayToMarkdown('Test Essay', d, sources)
    expect(md).toContain('## First Section')
    expect(md).toContain('### Nested')
  })

  it('renders bold/italic/underline/link marks', () => {
    const d = doc(
      section('root', '', [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'under', marks: [{ type: 'underline' }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'linked', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          ],
        },
      ]),
    )
    const md = pmEssayToMarkdown('T', d, sources)
    expect(md).toContain('**bold**')
    expect(md).toContain('*italic*')
    expect(md).toContain('<u>under</u>')
    expect(md).toContain('[linked](https://example.com)')
  })

  it('renders a blockquote, a bullet list, and math', () => {
    const d = doc(
      section('root', '', [
        { type: 'blockquote', content: [para('quoted text')] },
        { type: 'bullet_list', content: [{ type: 'list_item', content: [para('first')] }, { type: 'list_item', content: [para('second')] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'inline ' }, { type: 'math_inline', attrs: { latex: 'x^2' } }] },
        { type: 'math_block', attrs: { latex: '\\int x' } },
      ]),
    )
    const md = pmEssayToMarkdown('T', d, sources)
    expect(md).toContain('> quoted text')
    expect(md).toContain('- first')
    expect(md).toContain('- second')
    expect(md).toContain('$x^2$')
    expect(md).toContain('$$\n\\int x\n$$')
  })

  it("renders a footnote's own real document content inline, with no separate lookup needed", () => {
    const d = doc(
      section('root', '', [
        { type: 'paragraph', content: [{ type: 'text', text: 'A claim' }, { type: 'footnote', content: [{ type: 'text', text: 'The footnote text.' }] }, { type: 'text', text: ' continues.' }] },
      ]),
    )
    const md = pmEssayToMarkdown('T', d, sources)
    expect(md).toMatch(/A claim\[\^fn1\] continues\./)
    expect(md).toMatch(/\[\^fn1\]: The footnote text\./)
  })

  it('renders a citation fresh from the sources map — plain .md export (no citationOptions) always uses a simple author-year label, never a cached one, and never the print-pipeline-only <cite> scaffold', () => {
    const d = doc(section('root', '', [{ type: 'paragraph', content: [{ type: 'text', text: 'A claim' }, { type: 'citation', attrs: { sourceId: 'smith', note: null } }, { type: 'text', text: '.' }] }]))
    const md = pmEssayToMarkdown('T', d, sources)
    expect(md).toContain('(Smith, 2020)')
    expect(md).not.toContain('<cite')
  })

  it('falls back to a placeholder for a citation whose source no longer exists, with no <cite> scaffold on the plain .md path', () => {
    const d = doc(section('root', '', [{ type: 'paragraph', content: [{ type: 'citation', attrs: { sourceId: 'gone', note: null } }] }]))
    const md = pmEssayToMarkdown('T', d, new Map())
    expect(md).toContain('unknown source: gone')
    expect(md).not.toContain('<cite')
  })

  it('renders footnote-placed citations with the fnc<n> label prefix, sharing one counter with real footnotes', () => {
    const d = doc(
      section('root', '', [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A claim' },
            { type: 'footnote', content: [{ type: 'text', text: 'Real footnote.' }] },
            { type: 'text', text: ', as argued' },
            { type: 'citation', attrs: { sourceId: 'smith', note: null } },
            { type: 'text', text: '.' },
          ],
        },
      ]),
    )
    const citationOptions: PrintCitationOptions = { style: 'author-year', placement: 'footnote', orderedSourceIds: ['smith'] }
    const md = pmEssayToMarkdown('T', d, sources, { citationOptions })
    expect(md).toContain('[^fn1]')
    expect(md).toContain('[^fnc2]')
    expect(md).toContain('[^fn1]: Real footnote.')
    expect(md).toContain('[^fnc2]: Smith, An Early Paper.')
  })
})

describe('pmCitedSources', () => {
  it('collects every cited source id, deduplicated, sorted by author', () => {
    const adams: Source = { id: 'adams', bibtex: { type: 'article', key: 'adams2019', fields: { author: 'Adams, Bob', year: '2019', title: 'A Prior Paper' } } }
    const allSources = new Map([['smith', smith], ['adams', adams]])
    const d = doc(
      section('root', '', [
        {
          type: 'paragraph',
          content: [
            { type: 'citation', attrs: { sourceId: 'smith', note: null } },
            { type: 'citation', attrs: { sourceId: 'smith', note: 'p. 5' } },
            { type: 'citation', attrs: { sourceId: 'adams', note: null } },
          ],
        },
      ]),
    )
    const cited = pmCitedSources(d, allSources)
    expect(cited.map((s) => s.id)).toEqual(['adams', 'smith'])
  })

  it('returns an empty array for an essay that cites nothing', () => {
    const d = doc(section('root', '', [para('no citations here')]))
    expect(pmCitedSources(d, sources)).toEqual([])
  })
})

describe('end-to-end: pmEssayToMarkdown feeding the unchanged print pipeline', () => {
  it('produces a correctly numbered, correctly spaced print HTML body, including a footnote-placed citation moved past its sentence period', () => {
    const d = doc(
      section('root', '', [
        section('a', 'First Section', [
          { type: 'paragraph', content: [{ type: 'text', text: 'The sky is blue' }, { type: 'citation', attrs: { sourceId: 'smith', note: null } }, { type: 'text', text: '. Next sentence.' }] },
        ]),
      ]),
    )
    const citationOptions: PrintCitationOptions = { style: 'author-year', placement: 'footnote', orderedSourceIds: ['smith'] }
    const md = pmEssayToMarkdown('Test Essay', d, sources, { citationOptions })
    let html = addPrintChrome(markdownToHtml(md))
    html = moveFootnoteCitationsPastPeriod(html)
    html = ensureCitationSpacing(html)
    expect(html).toContain('<h1>Test Essay</h1>')
    expect(html).toContain('<h2>1 First Section</h2>')
    expect(html).toMatch(/is blue\.<sup class="print-footnote-ref print-citation-footnote-ref">.*?<\/sup> Next sentence\./)
  })

  it('appends a correctly styled References section from pmCitedSources', () => {
    const d = doc(section('root', '', [{ type: 'paragraph', content: [{ type: 'citation', attrs: { sourceId: 'smith', note: null } }] }]))
    const md = pmEssayToMarkdown('T', d, sources) + referencesMarkdown(pmCitedSources(d, sources), 'chicago')
    expect(md).toContain('## References')
    expect(md).toContain('Smith, Jane. "An Early Paper." *Journal of Examples* (2020).')
  })
})

describe('pmEssayToLatex', () => {
  it('emits a title, document shell, and \\section{} per nested section', () => {
    const d = doc(section('root', '', [section('a', 'First Section', [para('Body text.')])]))
    const tex = pmEssayToLatex('Test Essay', d, sources)
    expect(tex).toContain('\\title{Test Essay}')
    expect(tex).toContain('\\section{First Section}')
    expect(tex).toContain('Body text.')
    expect(tex).toContain('\\begin{document}')
    expect(tex).toContain('\\end{document}')
    expect(tex).not.toContain('Untitled') // root's own title is never rendered, same as Markdown/HTML
  })

  it('nests \\subsection{}/\\subsubsection{} correctly for depth 2/3', () => {
    const d = doc(section('root', '', [section('a', 'A', [section('a1', 'A1', [section('a1a', 'A1a', [para('deep')])])])]))
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\section{A}')
    expect(tex).toContain('\\subsection{A1}')
    expect(tex).toContain('\\subsubsection{A1a}')
  })

  it('renders marks as \\textbf/\\textit/\\underline/\\href', () => {
    const d = doc(
      section('root', '', [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' italic', marks: [{ type: 'em' }] },
            { type: 'text', text: ' under', marks: [{ type: 'underline' }] },
            { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          ],
        },
      ]),
    )
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\textbf{bold}')
    expect(tex).toContain('\\textit{ italic}')
    expect(tex).toContain('\\underline{ under}')
    expect(tex).toContain('\\href{https://example.com}{ link}')
  })

  it('renders a citation as \\cite{key} (or \\cite[note]{key}), using the real BibTeX key, not the internal sourceId', () => {
    const d = doc(
      section('root', '', [
        { type: 'paragraph', content: [{ type: 'citation', attrs: { sourceId: 'smith', note: null } }, { type: 'citation', attrs: { sourceId: 'smith', note: 'p. 5' } }] },
      ]),
    )
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\cite{smith2020}')
    expect(tex).toContain('\\cite[p. 5]{smith2020}')
  })

  it('uses \\footcite and biblatex when citeCommand is \\footcite', () => {
    const d = doc(section('root', '', [{ type: 'paragraph', content: [{ type: 'citation', attrs: { sourceId: 'smith', note: null } }] }]))
    const tex = pmEssayToLatex('T', d, sources, { citeCommand: '\\footcite' })
    expect(tex).toContain('\\footcite{smith2020}')
    expect(tex).toContain('\\usepackage{biblatex}')
    expect(tex).toContain('\\printbibliography')
    expect(tex).not.toContain('\\usepackage{natbib}')
  })

  it("renders a footnote as a real, inline \\footnote{} — the one format where it's a single construct, not a label plus a separate definition", () => {
    const d = doc(section('root', '', [{ type: 'paragraph', content: [{ type: 'text', text: 'A claim' }, { type: 'footnote', content: [{ type: 'text', text: 'The note.' }] }] }]))
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\footnote{The note.}')
  })

  it('renders a blockquote as \\begin{quote}, a list as \\begin{itemize}/\\begin{enumerate}, and math with $...$/\\[...\\]', () => {
    const d = doc(
      section('root', '', [
        { type: 'blockquote', content: [para('quoted')] },
        { type: 'bullet_list', content: [{ type: 'list_item', content: [para('one')] }] },
        { type: 'ordered_list', content: [{ type: 'list_item', content: [para('first')] }] },
        { type: 'paragraph', content: [{ type: 'math_inline', attrs: { latex: 'x^2' } }] },
        { type: 'math_block', attrs: { latex: '\\int x' } },
      ]),
    )
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\begin{quote}\nquoted\n\\end{quote}')
    expect(tex).toContain('\\begin{itemize}')
    expect(tex).toContain('\\begin{enumerate}')
    expect(tex).toContain('$x^2$')
    expect(tex).toContain('\\[\n\\int x\n\\]')
  })

  it('turns a root-level section titled exactly "Abstract" into a plain \\abstract{} macro, not a numbered \\section{}, and still renders its own nested sections normally afterward', () => {
    const d = doc(
      section('root', '', [
        section('abs', 'Abstract', [para('A short summary.'), section('nested-in-abstract', 'Nested In Abstract', [para('still a real section')])]),
        section('intro', 'Introduction', [para('Body.')]),
      ]),
    )
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\abstract{A short summary.}')
    expect(tex).not.toContain('\\section{Abstract}')
    // The abstract's own nested section still renders as a real, numbered
    // section — one level deeper than a normal root-level section, since
    // it still occupies the abstract's own (unnumbered) depth structurally.
    expect(tex).toContain('\\subsection{Nested In Abstract}')
    expect(tex).toContain('\\section{Introduction}')
  })

  it('does not treat a later root-level section named "Abstract" as the abstract — only the first child counts', () => {
    const d = doc(section('root', '', [section('intro', 'Introduction', [para('Body.')]), section('abs', 'Abstract', [para('Too late to count.')])]))
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('\\section{Abstract}')
    expect(tex).not.toContain('\\abstract{')
  })

  it('escapes LaTeX-special characters (%, $, #, _, {, }, &, ~, ^, \\\\) in plain text', () => {
    const d = doc(section('root', '', [para('100% $5 #1 a_b {x} y&z ~w ^v \\n')]))
    const tex = pmEssayToLatex('T', d, sources)
    expect(tex).toContain('100\\% \\$5 \\#1 a\\_b \\{x\\} y\\&z \\textasciitilde{}w \\textasciicircum{}v \\textbackslash{}n')
  })
})
