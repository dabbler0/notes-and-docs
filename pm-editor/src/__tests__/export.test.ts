import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema as schema } from '../schema'
import {
  addPrintChrome,
  ensureCitationSpacing,
  markdownToHtml,
  moveFootnoteCitationsPastPeriod,
  pmCitedSources,
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
