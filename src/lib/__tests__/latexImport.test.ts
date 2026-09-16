import { describe, expect, it } from 'vitest'
import { matchFootnoteToSource, parseLatexDocument, pickMainTexFile } from '../latexImport'
import type { Source } from '../../models/types'

function makeSource(id: string, key: string, fields: Record<string, string>): Source {
  return { id, bibtex: { type: 'article', key, fields }, comment: '', pageTexts: [], createdAt: 0, updatedAt: 0 }
}

describe('pickMainTexFile', () => {
  it('prefers the file that actually opens a document', () => {
    const files = [
      { path: 'sections/intro.tex', content: '\\section{Intro}\ntext' },
      { path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}' },
    ]
    expect(pickMainTexFile(files)?.path).toBe('main.tex')
  })

  it('falls back to sheer size when nothing contains \\begin{document}', () => {
    const files = [
      { path: 'a.tex', content: 'short' },
      { path: 'b.tex', content: 'a much longer file that should win on size alone' },
    ]
    expect(pickMainTexFile(files)?.path).toBe('b.tex')
  })

  it('returns null with no .tex files at all', () => {
    expect(pickMainTexFile([{ path: 'refs.bib', content: '@article{x,}' }])).toBeNull()
  })
})

describe('matchFootnoteToSource', () => {
  const smith = makeSource('s1', 'smith2020', { author: 'John Smith', year: '2020', title: 'A Study of Widgets' })
  const jones = makeSource('s2', 'jones2018', { author: 'Alice Jones and Bob Lee', year: '2018', title: 'Gadget Theory' })
  const byKey = new Map([
    ['smith2020', smith],
    ['jones2018', jones],
  ])

  it('matches on author + year mentioned together', () => {
    expect(matchFootnoteToSource('See Smith (2020) for details.', byKey)).toBe(smith)
  })

  it('matches a multi-author source by either last name plus the year', () => {
    expect(matchFootnoteToSource('This point is made by Lee in 2018.', byKey)).toBe(jones)
  })

  it('does not match a generic aside with no year or author', () => {
    expect(matchFootnoteToSource('This is an aside with no citation-like content at all.', byKey)).toBeNull()
  })

  it('does not match on title words alone, without a year or author', () => {
    expect(matchFootnoteToSource('Widgets and gadgets are both discussed at length elsewhere.', byKey)).toBeNull()
  })
})

describe('parseLatexDocument', () => {
  const empty = new Map<string, Source>()

  it('splits \\section/\\subsection/\\subsubsection into a nested tree', () => {
    const tex = `
\\begin{document}
Intro text.
\\section{Background}
Background text.
\\subsection{History}
History text.
\\subsubsection{Ancient history}
Ancient text.
\\section{Conclusion}
Conclusion text.
\\end{document}`
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.html).toContain('Intro text.')
    expect(result.root.children.map((c) => c.title)).toEqual(['Background', 'Conclusion'])
    const background = result.root.children[0]
    expect(background.html).toContain('Background text.')
    expect(background.children.map((c) => c.title)).toEqual(['History'])
    const history = background.children[0]
    expect(history.children.map((c) => c.title)).toEqual(['Ancient history'])
    expect(history.children[0].html).toContain('Ancient text.')
  })

  it('converts \\textbf/\\textit/\\emph, including nested commands', () => {
    const tex = '\\begin{document}\nThis is \\textbf{bold} and \\textit{italic} and \\emph{also italic} and \\textbf{\\emph{both}}.\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.html).toContain('<b>bold</b>')
    expect(result.root.html).toContain('<i>italic</i>')
    expect(result.root.html).toContain('<i>also italic</i>')
    expect(result.root.html).toContain('<b><i>both</i></b>')
  })

  it('converts a quote environment into a blockquote', () => {
    const tex = '\\begin{document}\nBefore.\n\\begin{quote}\nA quoted passage.\n\\end{quote}\nAfter.\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.html).toContain('<blockquote class="quote">A quoted passage.</blockquote>')
    expect(result.root.html).toContain('Before.')
    expect(result.root.html).toContain('After.')
  })

  it('resolves \\cite/\\citep/\\citet to a real citation chip when the key is known', () => {
    const smith = makeSource('s1', 'smith2020', { author: 'John Smith', year: '2020', title: 'A Study' })
    const byKey = new Map([['smith2020', smith]])
    const tex = '\\begin{document}\nAs shown by \\citet{smith2020}, this holds.\n\\end{document}'
    const result = parseLatexDocument(tex, byKey, 'fallback')
    expect(result.root.html).toContain('data-source-id="s1"')
    expect(result.warnings).toEqual([])
  })

  it('falls back to a bracketed key and a warning when a citation key is unknown', () => {
    const tex = '\\begin{document}\nSee \\cite{nobody2099}.\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.html).toContain('[nobody2099]')
    expect(result.warnings[0]).toMatch(/nobody2099/)
  })

  it('converts a footnote that reads like a citation into a real citation, not a footnote', () => {
    const smith = makeSource('s1', 'smith2020', { author: 'John Smith', year: '2020', title: 'A Study' })
    const byKey = new Map([['smith2020', smith]])
    const tex = '\\begin{document}\nThis claim needs support.\\footnote{See Smith (2020) for the original argument.}\n\\end{document}'
    const result = parseLatexDocument(tex, byKey, 'fallback')
    expect(result.root.html).toContain('data-source-id="s1"')
    expect(result.root.html).not.toContain('footnote-ref')
    expect(result.root.footnotes).toHaveLength(0)
    expect(result.stats.footnotesConverted).toBe(1)
    expect(result.stats.footnotesKept).toBe(0)
  })

  it('keeps an ordinary footnote as a real footnote when nothing matches', () => {
    const tex = '\\begin{document}\nA claim.\\footnote{This is just an aside with no citation in it.}\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.footnotes).toHaveLength(1)
    expect(result.root.footnotes[0].content).toContain('This is just an aside')
    expect(result.root.html).toContain(`data-footnote-id="${result.root.footnotes[0].id}"`)
    expect(result.stats.footnotesConverted).toBe(0)
    expect(result.stats.footnotesKept).toBe(1)
  })

  it('attaches a footnote to the section it actually appears in, not the root', () => {
    const tex = '\\begin{document}\n\\section{One}\nText.\\footnote{An aside with nothing citation-like.}\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.footnotes).toHaveLength(0)
    expect(result.root.children[0].footnotes).toHaveLength(1)
  })

  it('pulls out an \\begin{abstract} environment as a leading "Abstract" child', () => {
    const tex = '\\begin{document}\n\\begin{abstract}\nThis paper is about widgets.\n\\end{abstract}\n\\section{Intro}\nIntro text.\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.children[0].title).toBe('Abstract')
    expect(result.root.children[0].html).toContain('This paper is about widgets.')
    expect(result.root.children[1].title).toBe('Intro')
  })

  it('uses \\title{} for the essay title when present, and the fallback otherwise', () => {
    const withTitle = parseLatexDocument('\\title{My Real Title}\n\\begin{document}\nx\n\\end{document}', empty, 'fallback-name')
    expect(withTitle.title).toBe('My Real Title')
    const withoutTitle = parseLatexDocument('\\begin{document}\nx\n\\end{document}', empty, 'fallback-name')
    expect(withoutTitle.title).toBe('fallback-name')
  })

  it('strips comments and unescapes common literal sequences', () => {
    const tex = '\\begin{document}\n% this whole line is a comment\nCost was \\$5 --- not \\%100 as claimed.\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.html).not.toContain('this whole line is a comment')
    expect(result.root.html).toContain('$5')
    expect(result.root.html).toContain('—')
    expect(result.root.html).toContain('%100')
  })

  it('degrades an unrecognized command with a brace argument to its own inner text rather than dropping it', () => {
    const tex = '\\begin{document}\nSome \\unknowncmd{important} text.\n\\end{document}'
    const result = parseLatexDocument(tex, empty, 'fallback')
    expect(result.root.html).toContain('important')
  })
})
