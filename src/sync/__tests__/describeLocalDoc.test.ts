/**
 * `describeValue`/`describeLocalDoc` exist purely to make a Firestore
 * rejection ("Property _enc contains an invalid nested entity") locatable
 * — which local document, and (ideally) which field — without ever
 * logging the document's actual content to the console. These tests check
 * the shape reporting itself, not any specific bug: see syncEngine.ts's
 * own doc comment on the push loop for the real incident this was added
 * to investigate.
 */
import { describe, expect, it } from 'vitest'
import { describeLocalDoc, describeValue } from '../syncEngine'

describe('describeValue', () => {
  it('describes primitives without leaking their content', () => {
    expect(describeValue('hello world')).toBe('string(11 chars)')
    expect(describeValue(42)).toBe('number')
    expect(describeValue(true)).toBe('boolean')
    expect(describeValue(undefined)).toBe('undefined')
    expect(describeValue(null)).toBe('null')
  })

  it('describes a Uint8Array by byte length, not content', () => {
    expect(describeValue(new Uint8Array([1, 2, 3, 4]))).toBe('Uint8Array(4 bytes)')
  })

  it('describes an array recursively, one level of nesting', () => {
    expect(describeValue(['a', 'bb', 'ccc'])).toBe('Array(3)[string(1 chars), string(2 chars), string(3 chars)]')
  })

  it('describes a plain object by its own key shapes', () => {
    expect(describeValue({ title: 'x', year: '2020' })).toBe('{title: string(1 chars), year: string(4 chars)}')
  })

  it('flags a non-plain object (class instance, Map, Date) as suspicious', () => {
    expect(describeValue(new Map([['a', 1]]))).toContain('NOT A PLAIN OBJECT')
    expect(describeValue(new Map([['a', 1]]))).toContain('Map')
    expect(describeValue(new Date())).toContain('NOT A PLAIN OBJECT')
    class Foo {
      x = 1
    }
    expect(describeValue(new Foo())).toContain('Foo')
    expect(describeValue(new Foo())).toContain('NOT A PLAIN OBJECT')
  })

  it('caps recursion depth rather than reporting an unbounded nested structure', () => {
    const deep = { a: { b: { c: { d: 'x' } } } }
    const result = describeValue(deep)
    expect(result).not.toContain('unexpected')
    // Depth 2 and beyond collapse to a plain key-count summary.
    expect(result).toContain('keys')
  })
})

describe('describeLocalDoc', () => {
  it('identifies a source by its BibTeX title', () => {
    const source = {
      id: 's1',
      bibtex: { type: 'article', key: 'x', fields: { title: 'A Great Paper', author: 'Someone' } },
      comment: '',
      pageHtml: [],
      createdAt: 0,
      updatedAt: 0,
    }
    const result = describeLocalDoc('sources', source)
    expect(result.identify).toBe('A Great Paper')
    expect(result.fields.bibtex).toContain('title: string')
  })

  it('falls back to the PDF filename, then the comment, when a source has no BibTeX title', () => {
    const withFilename = { id: 's1', bibtex: { type: 'article', key: 'x', fields: {} }, pdfFileName: 'paper.pdf', comment: '', pageHtml: [], createdAt: 0, updatedAt: 0 }
    expect(describeLocalDoc('sources', withFilename).identify).toBe('paper.pdf')

    const withComment = { id: 's1', bibtex: { type: 'article', key: 'x', fields: {} }, comment: 'a note about this one', pageHtml: [], createdAt: 0, updatedAt: 0 }
    expect(describeLocalDoc('sources', withComment).identify).toBe('a note about this one')
  })

  it('leaves identify undefined rather than an empty string when nothing usable is found', () => {
    const blank = { id: 's1', bibtex: { type: 'article', key: 'x', fields: {} }, comment: '', pageHtml: [], createdAt: 0, updatedAt: 0 }
    expect(describeLocalDoc('sources', blank).identify).toBeUndefined()
  })

  it('identifies an essay/node by its own title', () => {
    expect(describeLocalDoc('essays', { id: 'e1', title: 'My Essay', rootNodeId: 'n1', createdAt: 0, updatedAt: 0 }).identify).toBe('My Essay')
    expect(describeLocalDoc('nodes', { id: 'n1', title: 'A Section', essayId: 'e1', createdAt: 0, updatedAt: 0 }).identify).toBe('A Section')
  })

  it('reports every top-level field, not just the identifying one', () => {
    const source = { id: 's1', bibtex: { type: 'article', key: 'x', fields: {} }, comment: 'x', pageHtml: [], pdfBlobId: 'b1', createdAt: 0, updatedAt: 0 }
    const result = describeLocalDoc('sources', source)
    expect(Object.keys(result.fields).sort()).toEqual(['bibtex', 'comment', 'createdAt', 'id', 'pageHtml', 'pdfBlobId', 'updatedAt'].sort())
  })
})
