/**
 * End-to-end test of the impure half of LaTeX import: build a real .zip
 * (via JSZip, same as the app itself will receive from a file input),
 * import it, and check what actually landed in the (fake) local database —
 * sources created, essay/node tree shape, footnotes attached to the right
 * node. `parseLatexDocument` itself is unit tested on its own in
 * `lib/__tests__/latexImport.test.ts`; this only needs to prove the
 * plumbing around it (unzip, bib parsing, source creation, persistence)
 * actually connects correctly.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { importLatexProject } from '../latexImportRepo'
import { getNode, loadNodeMap } from '../essaysRepo'
import { listSources } from '../sourcesRepo'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

const BIB = `
@article{smith2020, title = {A Study of Widgets}, author = {John Smith}, year = {2020}}
@article{jones2018, title = {Gadget Theory}, author = {Alice Jones}, year = {2018}}
`

const TEX = `
\\title{A Test Paper}
\\begin{document}
\\maketitle
Intro paragraph, citing \\cite{smith2020}.
\\section{Background}
As Jones (2018) explains in her footnote-worthy aside\\footnote{See Jones (2018) for the original claim.}, this matters.
Also worth noting\\footnote{This is not a citation at all, just a real aside.}.
\\begin{quote}
A quoted passage worth keeping.
\\end{quote}
\\end{document}
`

async function buildZip(): Promise<Blob> {
  const zip = new JSZip()
  zip.file('paper.bib', BIB)
  zip.file('main.tex', TEX)
  return zip.generateAsync({ type: 'blob' })
}

describe('importLatexProject', () => {
  it('creates one source per bib entry, and a matching essay/node tree', async () => {
    const zipBlob = await buildZip()
    const summary = await importLatexProject(zipBlob)

    expect(summary.sourcesInBib).toBe(2)
    expect(summary.sourcesAdded).toBe(2)
    expect(summary.essay.title).toBe('A Test Paper')

    const sources = await listSources()
    expect(sources.map((s) => s.bibtex.key).sort()).toEqual(['jones2018', 'smith2020'])

    const nodeMap = await loadNodeMap(summary.essay)
    const root = nodeMap.get(summary.essay.rootNodeId)!
    expect(root.draftContent).toContain('data-source-id')

    expect(nodeMap.size).toBe(2) // root + "Background"
    const background = [...nodeMap.values()].find((n) => n.title === 'Background')!
    expect(background).toBeTruthy()

    // The footnote that reads like a citation was converted; the other one
    // (with no author/year in it at all) was kept as a real footnote,
    // attached to the section it actually appeared in.
    expect(background.draftContent).toContain('data-source-id')
    expect(background.footnotes).toHaveLength(1)
    expect(background.footnotes![0].content).toContain('not a citation at all')
    expect(background.draftContent).toContain(`data-footnote-id="${background.footnotes![0].id}"`)

    expect(summary.footnotesConverted).toBe(1)
    expect(summary.footnotesKept).toBe(1)

    expect(background.draftContent).toContain('A quoted passage worth keeping.')
  })

  it('does not duplicate a source whose bibtex key already exists locally', async () => {
    const zipBlob = await buildZip()
    await importLatexProject(zipBlob)
    const second = await importLatexProject(zipBlob)

    expect(second.sourcesAdded).toBe(0) // both keys already exist from the first import
    expect(second.sourcesInBib).toBe(2)
    const sources = await listSources()
    expect(sources).toHaveLength(2) // not 4 — re-importing didn't duplicate them
  })

  it('throws a clear error when the zip has no .tex file', async () => {
    const zip = new JSZip()
    zip.file('paper.bib', BIB)
    const blob = await zip.generateAsync({ type: 'blob' })
    await expect(importLatexProject(blob)).rejects.toThrow(/\.tex/)
  })

  it('falls back to the file name for a title when the project has none', async () => {
    const zip = new JSZip()
    zip.file('my_cool_paper.tex', '\\begin{document}\nJust some text, no title command.\n\\end{document}')
    const blob = await zip.generateAsync({ type: 'blob' })
    const summary = await importLatexProject(blob)
    expect(summary.essay.title).toBe('my cool paper')
  })

  it('ignores __MACOSX junk and non-tex/bib files in the zip', async () => {
    const zip = new JSZip()
    zip.file('main.tex', '\\begin{document}\nHello.\n\\end{document}')
    zip.file('__MACOSX/._main.tex', 'garbage')
    zip.file('figure.png', 'not really a png')
    const blob = await zip.generateAsync({ type: 'blob' })
    const summary = await importLatexProject(blob)
    const node = await getNode(summary.essay.rootNodeId)
    expect(node?.draftContent).toContain('Hello.')
  })
})
