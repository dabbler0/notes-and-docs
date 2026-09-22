import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildEpub } from '../buildEpub'
import type { DocBlock } from '../types'

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const error = doc.querySelector('parsererror')
  if (error) throw new Error(`XML failed to parse: ${error.textContent}`)
  return doc
}

const sampleBlocks: DocBlock[] = [
  { type: 'heading', text: 'Introduction', level: 1, page: 1 },
  { type: 'paragraph', text: 'This is the first paragraph of the introduction.', page: 1 },
  { type: 'footnote', text: '1. An explanatory note.', page: 1 },
  { type: 'break', text: '', page: 1 },
  { type: 'paragraph', text: 'A paragraph after a scene break.', page: 2 },
  { type: 'heading', text: 'Chapter Two', level: 1, page: 3 },
  { type: 'paragraph', text: 'The second chapter begins here.', page: 3 },
]

describe('buildEpub', () => {
  it('produces a zip whose first entry is an uncompressed mimetype file', async () => {
    const blob = await buildEpub({ title: 'Test Book', author: 'Jane Author' }, sampleBlocks)
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    // A zip local file header starts with PK\x03\x04; right after the fixed
    // 30-byte header + the 8-byte filename "mimetype", the raw stored bytes
    // of the mimetype content should appear immediately, uncompressed —
    // this is the actual byte-level requirement EPUB readers may check
    // before even unzipping properly.
    const text = new TextDecoder('latin1').decode(bytes.slice(0, 200))
    expect(text.startsWith('PK')).toBe(true)
    expect(text).toContain('mimetype')
    expect(text).toContain('application/epub+zip')

    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    expect(names[0]).toBe('mimetype')
    const mimetypeEntry = zip.files['mimetype']
    // @ts-expect-error -- JSZip's internal compression metadata, not part of its public typings.
    expect(mimetypeEntry._data?.compressedSize ?? mimetypeEntry.options?.compression).toBeDefined()
    expect(await mimetypeEntry.async('string')).toBe('application/epub+zip')
  })

  it('includes the required OCF files', async () => {
    const blob = await buildEpub({ title: 'Test Book' }, sampleBlocks)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(zip.file('META-INF/container.xml')).toBeTruthy()
    expect(zip.file('OEBPS/content.opf')).toBeTruthy()
    expect(zip.file('OEBPS/nav.xhtml')).toBeTruthy()
    expect(zip.file('OEBPS/toc.ncx')).toBeTruthy()
    expect(zip.file('OEBPS/styles.css')).toBeTruthy()
  })

  it('writes one well-formed XHTML chapter per detected heading', async () => {
    const blob = await buildEpub({ title: 'Test Book' }, sampleBlocks)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const chapterFiles = Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/chapters/') && !zip.files[n].dir)
    expect(chapterFiles).toHaveLength(2) // "Introduction" and "Chapter Two"

    const ch1 = await zip.file('OEBPS/chapters/chapter-001.xhtml')!.async('string')
    const doc1 = parseXml(ch1)
    expect(doc1.querySelector('h1')?.textContent).toBe('Introduction')
    expect(doc1.querySelector('p')?.textContent).toContain('first paragraph')
    expect(doc1.querySelector('aside[epub\\:type="footnote"]') ?? doc1.querySelector('aside')).toBeTruthy()
    expect(doc1.querySelector('hr.section-break')).toBeTruthy()

    const ch2 = await zip.file('OEBPS/chapters/chapter-002.xhtml')!.async('string')
    const doc2 = parseXml(ch2)
    expect(doc2.querySelector('h1')?.textContent).toBe('Chapter Two')
  })

  it('produces well-formed content.opf, nav.xhtml, and toc.ncx that reference every chapter', async () => {
    const blob = await buildEpub({ title: 'Test Book', author: 'Jane Author' }, sampleBlocks)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())

    const opf = parseXml(await zip.file('OEBPS/content.opf')!.async('string'))
    expect(opf.querySelector('dc\\:title, title')?.textContent).toBe('Test Book')
    expect(opf.querySelector('dc\\:creator, creator')?.textContent).toBe('Jane Author')
    expect(opf.querySelectorAll('manifest item, item')).toHaveLength(5) // nav + ncx + css + 2 chapters
    expect(opf.querySelectorAll('spine itemref, itemref')).toHaveLength(2)

    const nav = parseXml(await zip.file('OEBPS/nav.xhtml')!.async('string'))
    const navLinks = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)
    expect(navLinks).toEqual(['Introduction', 'Chapter Two'])

    const ncx = parseXml(await zip.file('OEBPS/toc.ncx')!.async('string'))
    expect(ncx.querySelectorAll('navPoint, navpoint')).toHaveLength(2)
  })

  it('falls back to a single section titled after the source when no heading was detected', async () => {
    const blocks: DocBlock[] = [{ type: 'paragraph', text: 'Just one paragraph, no headings anywhere.', page: 1 }]
    const blob = await buildEpub({ title: 'Untitled Source' }, blocks)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const chapterFiles = Object.keys(zip.files).filter((n) => n.startsWith('OEBPS/chapters/') && !zip.files[n].dir)
    expect(chapterFiles).toHaveLength(1)
    const doc = parseXml(await zip.file(chapterFiles[0])!.async('string'))
    expect(doc.querySelector('h1')?.textContent).toBe('Untitled Source')
    expect(doc.querySelector('p')?.textContent).toContain('Just one paragraph')
  })

  it('escapes HTML-significant characters in titles and body text', async () => {
    const blocks: DocBlock[] = [
      { type: 'heading', text: 'A & B <Section>', level: 1, page: 1 },
      { type: 'paragraph', text: 'Text with <tags> & "quotes".', page: 1 },
    ]
    const blob = await buildEpub({ title: 'Book <Title> & More' }, blocks)
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const chapter = await zip.file('OEBPS/chapters/chapter-001.xhtml')!.async('string')
    const doc = parseXml(chapter) // throws if not well-formed, i.e. if escaping was wrong
    expect(doc.querySelector('h1')?.textContent).toBe('A & B <Section>')
    expect(doc.querySelector('p')?.textContent).toBe('Text with <tags> & "quotes".')

    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    parseXml(opf)
  })
})
