/**
 * Assembles a real, minimal EPUB 3 file (a zip with a fixed internal
 * structure — see the EPUB Open Container Format spec) out of `classify.ts`'s
 * `DocBlock[]`. One chapter per detected top-level section, so an e-reader's
 * own table of contents can jump straight to any of them — the whole point
 * of classifying the text into sections in the first place, rather than
 * just handing back one giant undifferentiated flow.
 */
import JSZip from 'jszip'
import { escapeAttr, escapeHtml } from '../html'
import { id } from '../id'
import type { DocBlock } from './types'

export interface EpubMetadata {
  title: string
  author?: string
}

interface Section {
  title: string
  blocks: DocBlock[]
}

/**
 * Splits the flat block stream at every heading — each heading starts a new
 * chapter, titled from its own text, and everything up to the next heading
 * (paragraphs, footnotes, breaks) belongs to it. Anything *before* the
 * document's first heading (or the entire document, if no heading was ever
 * detected at all — see `classify.ts`'s own doc comment on how unreliable
 * that detection can be for an unusually-typeset document) becomes a
 * leading section titled after the source itself, rather than silently
 * dropped or crammed into whatever the first real heading turns out to be.
 */
function groupIntoSections(blocks: DocBlock[], fallbackTitle: string): Section[] {
  const sections: Section[] = []
  let current: Section | null = null
  for (const block of blocks) {
    if (block.type === 'heading') {
      current = { title: block.text || fallbackTitle, blocks: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      current = { title: fallbackTitle, blocks: [] }
      sections.push(current)
    }
    current.blocks.push(block)
  }
  if (sections.length === 0) sections.push({ title: fallbackTitle, blocks: [] })
  return sections
}

function headingTag(level: number | undefined): string {
  const l = Math.min(6, Math.max(1, level ?? 2))
  return `h${l}`
}

/** One section's own content as XHTML body content (no `<html>`/`<body>`
 * wrapper — `chapterDocument` adds that). A `break` block becomes a plain
 * `<hr>` (the closest real HTML equivalent of the typographic scene-break
 * convention it was detected from — see `classify.ts`); a `footnote` block
 * is marked `epub:type="footnote"` and visually set off, kept in the same
 * reading-order position it was found rather than moved to the section's
 * end, but *not* cross-linked to an inline marker in its paragraph — see
 * this module's own doc comment for why that's left undone. */
function sectionBodyHtml(section: Section, headingLevel: number): string {
  const parts: string[] = [`<${headingTag(headingLevel)}>${escapeHtml(section.title)}</${headingTag(headingLevel)}>`]
  let footnoteCounter = 0
  for (const block of section.blocks) {
    if (block.type === 'paragraph') {
      parts.push(`<p>${escapeHtml(block.text)}</p>`)
    } else if (block.type === 'footnote') {
      footnoteCounter++
      parts.push(`<aside epub:type="footnote" id="fn-${footnoteCounter}" class="footnote"><p>${escapeHtml(block.text)}</p></aside>`)
    } else if (block.type === 'break') {
      // XHTML (unlike HTML) is XML, so a void element must be self-closed.
      parts.push('<hr class="section-break"/>')
    }
  }
  return parts.join('\n')
}

function chapterDocument(title: string, bodyHtml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
<title>${escapeHtml(title)}</title>
<meta charset="utf-8"/>
<link rel="stylesheet" type="text/css" href="../styles.css"/>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

const STYLESHEET = `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1, h2, h3, h4, h5, h6 { font-family: sans-serif; line-height: 1.2; }
p { margin: 0 0 1em; text-indent: 0; }
.footnote { font-size: 0.85em; border-top: 1px solid #999; margin-top: 1.2em; padding-top: 0.6em; color: #333; }
hr.section-break { width: 3em; margin: 2em auto; border: none; border-top: 1px solid #999; }
`

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
}

function contentOpf(uid: string, metadata: EpubMetadata, chapterFiles: string[]): string {
  const manifestItems = chapterFiles
    .map((f, i) => `<item id="chapter${i + 1}" href="chapters/${f}" media-type="application/xhtml+xml"/>`)
    .join('\n    ')
  const spineItems = chapterFiles.map((_, i) => `<itemref idref="chapter${i + 1}"/>`).join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${uid}</dc:identifier>
    <dc:title>${escapeHtml(metadata.title)}</dc:title>
    <dc:language>en</dc:language>
    ${metadata.author ? `<dc:creator>${escapeHtml(metadata.author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`
}

function navXhtml(metadata: EpubMetadata, sections: Section[], chapterFiles: string[]): string {
  const items = sections.map((s, i) => `<li><a href="chapters/${chapterFiles[i]}">${escapeHtml(s.title)}</a></li>`).join('\n      ')
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeHtml(metadata.title)}</title><meta charset="utf-8"/></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      ${items}
    </ol>
  </nav>
</body>
</html>`
}

function tocNcx(uid: string, metadata: EpubMetadata, sections: Section[], chapterFiles: string[]): string {
  const navPoints = sections
    .map(
      (s, i) => `<navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeHtml(s.title)}</text></navLabel>
      <content src="chapters/${chapterFiles[i]}"/>
    </navPoint>`,
    )
    .join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uid}"/>
  </head>
  <docTitle><text>${escapeHtml(metadata.title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`
}

function chapterFilename(index: number): string {
  return `chapter-${String(index + 1).padStart(3, '0')}.xhtml`
}

/** Section titles alone drive nesting depth for the nav — every section is
 * flat (no sub-lists) since `classify.ts`'s heading levels describe font
 * size, not necessarily a strict hierarchy an unfamiliar document actually
 * intends; a flat, always-correct list of every detected section beats a
 * nested one that might misrepresent the document's real structure. */
export async function buildEpub(metadata: EpubMetadata, blocks: DocBlock[]): Promise<Blob> {
  const sections = groupIntoSections(blocks, metadata.title)
  const chapterFiles = sections.map((_, i) => chapterFilename(i))
  const uid = id()

  const zip = new JSZip()
  // Must be the first entry, stored uncompressed — the one hard requirement
  // EPUB inherits from the plain zip format (a reader is allowed to check
  // this before even looking at the rest of the file).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', containerXml())
  zip.file('OEBPS/content.opf', contentOpf(uid, metadata, chapterFiles))
  zip.file('OEBPS/nav.xhtml', navXhtml(metadata, sections, chapterFiles))
  zip.file('OEBPS/toc.ncx', tocNcx(uid, metadata, sections, chapterFiles))
  zip.file('OEBPS/styles.css', STYLESHEET)
  sections.forEach((section, i) => {
    // Every section's own heading is rendered as an `<h1>` in its own
    // chapter file, whatever level `classify.ts` originally assigned it —
    // level only matters for *deciding* something is a chapter break, not
    // for how prominent its own title looks once it's the first thing in a
    // brand new file.
    zip.file(`OEBPS/chapters/${chapterFiles[i]}`, chapterDocument(section.title, sectionBodyHtml(section, 1)))
  })

  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip', compression: 'DEFLATE' })
}
