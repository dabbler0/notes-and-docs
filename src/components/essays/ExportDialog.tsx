import { useState } from 'preact/hooks'
import JSZip from 'jszip'
import { Modal } from '../Modal'
import { listSources } from '../../models/sourcesRepo'
import {
  addPrintChrome,
  citedSources,
  collectUsedSourceIds,
  essayToLatex,
  essayToMarkdown,
  markdownToHtml,
  referencesHtml,
  referencesMarkdown,
  sourcesToBibtex,
  type BibliographyStyle,
  type PrintCitationPlacement,
  type PrintCitationStyle,
} from '../../lib/export'
import { downloadBlob, filenameFor } from '../../lib/download'
import { escapeHtml } from '../../lib/html'
import { getAuthorName } from '../../lib/authorPreference'
import type { Essay, EssayNode } from '../../models/types'
// Raw CSS text / a base64 data: URI (Vite's `?inline` query — forced
// regardless of the normal multi-file build's own size-based inlining
// threshold, see vite.config.ts's `assetsInlineLimit`), not the ordinary
// side-effect import `main.tsx` uses — the print-preview window below is
// a whole separate document (`win.document.write(...)`), which has no
// access to this page's own stylesheets *or* same-origin asset URLs at
// all (a plain `/assets/...woff2` reference can't be relied on to
// resolve from a `window.open('', ...)` blank document across every
// browser), so everything the print view needs — KaTeX's own CSS (for an
// equation rendered into it by `markdownToHtml`'s `renderMathHtml`) and
// this serif face's two font files — gets inlined directly into that
// document's own `<style>`, same "nothing loaded at runtime from
// anywhere else" reasoning the rest of this app's own build already
// follows.
import katexCss from 'katex/dist/katex.min.css?inline'
import garamondRegularUrl from '../../assets/fonts/EBGaramond-Regular.woff2?inline'
import garamondItalicUrl from '../../assets/fonts/EBGaramond-Italic.woff2?inline'

/** CSS `@page` margin-box `content` strings are ordinary CSS string literals — backslashes and double quotes need the same escaping any other hand-built CSS string value would. */
function cssStringEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function ExportDialog({ essay, nodeMap, onClose }: { essay: Essay; nodeMap: Map<string, EssayNode>; onClose: () => void }) {
  const [citeCommand, setCiteCommand] = useState<'\\cite' | '\\footcite'>('\\cite')
  const [bibliographyStyle, setBibliographyStyle] = useState<BibliographyStyle>('plain')
  const [citationStyle, setCitationStyle] = useState<PrintCitationStyle>('author-year')
  const [citationPlacement, setCitationPlacement] = useState<PrintCitationPlacement>('inline')
  const [busy, setBusy] = useState<'md' | 'pdf' | 'tex' | null>(null)

  async function exportMarkdown() {
    setBusy('md')
    try {
      const sources = new Map((await listSources()).map((s) => [s.id, s]))
      const md = essayToMarkdown(essay, nodeMap) + referencesMarkdown(nodeMap, sources, bibliographyStyle)
      downloadBlob(new Blob([md], { type: 'text/markdown' }), `${filenameFor(essay.title)}.md`)
    } finally {
      setBusy(null)
    }
  }

  async function exportPdf() {
    setBusy('pdf')
    try {
      const sources = new Map((await listSources()).map((s) => [s.id, s]))
      const orderedSourceIds = citedSources(nodeMap, sources).map((s) => s.id)
      const md = essayToMarkdown(essay, nodeMap, { citationOptions: { sources, style: citationStyle, placement: citationPlacement, orderedSourceIds } })
      const numberedReferences = citationPlacement === 'inline' && citationStyle === 'numbered'
      const bodyHtml = addPrintChrome(markdownToHtml(md)) + referencesHtml(nodeMap, sources, bibliographyStyle, numberedReferences)
      const win = window.open('', '_blank')
      if (!win) {
        alert('Your browser blocked the print preview pop-up — allow pop-ups for this page and try again.')
        return
      }
      const authorName = getAuthorName()
      // The browser's own print engine — not the on-screen preview, which
      // never shows a `@page` margin box at all — repeats these on every
      // physical page: a real, standards-based header/footer (confirmed
      // directly against this app's actual target, Chromium's print-to-PDF
      // path), not a `position: fixed` approximation, which is why a real
      // "Page N of M" is even possible here at all (`counter(pages)` only
      // has a meaningful value once the browser has actually paginated the
      // content, something no script running in the page itself can ever
      // observe — there's no DOM-level "how many pages will this be").
      const headerText = cssStringEscape(authorName ? `${essay.title} — ${authorName}` : essay.title)
      win.document.write(
        `<!doctype html><html><head><title>${escapeHtml(essay.title)}</title><meta charset="utf-8"><style>${katexCss}</style><style>
          @page {
            margin: 85px 50px 65px;
            @top-center { content: "${headerText}"; font-family: Georgia, 'Times New Roman', serif; font-size: 10px; color: #666; }
            @bottom-center { content: "Page " counter(page) " of " counter(pages); font-family: Georgia, 'Times New Roman', serif; font-size: 10px; color: #666; }
          }
          /* EB Garamond (SIL OFL 1.1 — see src/assets/fonts/OFL.txt) is a
             real variable font (weight 400-800 in one file per style), so
             one @font-face per style, not one per weight, correctly
             covers both the body text and every bold heading below. */
          @font-face { font-family: 'EB Garamond'; font-style: normal; font-weight: 400 800; src: url(${garamondRegularUrl}) format('woff2'); font-display: swap; }
          @font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 400 800; src: url(${garamondItalicUrl}) format('woff2'); font-display: swap; }
          body { font-family: 'EB Garamond', Georgia, 'Times New Roman', serif; max-width: 720px; margin: 40px auto; line-height: 1.6; color: #1a1a1a; padding: 0 20px; }
          h1, h2, h3, h4, h5, h6 { font-family: 'EB Garamond', Georgia, 'Times New Roman', serif; font-weight: 700; margin-bottom: 0; }
          /* Single-direction paragraph spacing (margin-top always 0) so a
             heading's own margin-bottom is what actually controls the gap
             below it, rather than being swallowed by the usual CSS
             margin-collapsing between a heading's bottom margin and the
             next paragraph's own top one. */
          p { margin: 0 0 1em; }
          h3, h4, h5, h6 { margin-top: 1.4em; margin-bottom: 0.3em; }
          .print-title-rule { border: none; border-top: 4px solid #1a1a1a; margin: 0 0 32px; }
          .print-section-rule { border: none; border-top: 1px solid #bbb; margin: 0 0 28px; }
          blockquote { border-left: 3px solid #999; margin: 1em 0; padding-left: 1em; color: #444; }
          .katex-display { margin: 1em 0; }
          /* Deliberately outside addPrintChrome's own numbering/rule pass
             (see referencesHtml's own doc comment) — a plain heading and a
             hanging-indent list, the conventional bibliography layout. */
          .print-references-heading { margin-top: 2.4em; }
          .print-references-list { margin: 0.6em 0 0; }
          ul.print-references-list { list-style: none; padding: 0; }
          ul.print-references-list li { margin: 0 0 0.8em 1.6em; text-indent: -1.6em; }
          ol.print-references-list { padding-left: 1.8em; }
          ol.print-references-list li { margin: 0 0 0.8em; }
          @media print { body { margin: 0; max-width: none; } }
        </style></head><body>${bodyHtml}</body></html>`,
      )
      win.document.close()
      win.focus()
      // Give the new document a moment to lay out before the print dialog
      // (which is itself the "export to PDF" step — most browsers' print
      // dialogs offer "Save as PDF" as a destination) pops up over it.
      setTimeout(() => win.print(), 300)
    } finally {
      setBusy(null)
    }
  }

  async function exportLatex() {
    setBusy('tex')
    try {
      const all = await listSources()
      const sourceMap = new Map(all.map((s) => [s.id, s]))
      const usedIds = collectUsedSourceIds(nodeMap)
      const usedSources = all.filter((s) => usedIds.has(s.id))
      const tex = essayToLatex(essay, nodeMap, sourceMap, { citeCommand })
      const bib = sourcesToBibtex(usedSources)
      const zip = new JSZip()
      zip.file('main.tex', tex)
      zip.file('references.bib', bib)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${filenameFor(essay.title)}-latex.zip`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Export “{essay.title}”</h2>
      <label className="field-inline" style={{ marginBottom: 14 }}>
        Bibliography style
        <select value={bibliographyStyle} onChange={(e) => setBibliographyStyle((e.target as HTMLSelectElement).value as BibliographyStyle)}>
          <option value="plain">Plain (author, year, title, venue)</option>
        </select>
      </label>
      <div className="export-options">
        <div className="export-option">
          <div className="export-option-body">
            <div className="export-option-title">Markdown</div>
            <p className="muted">A plain .md file — headings, bold/italic, links, and quotes, with citations kept as their visible text, plus a References section for every source you've cited.</p>
          </div>
          <button className="btn btn-primary" disabled={!!busy} onClick={exportMarkdown}>
            {busy === 'md' ? 'Preparing…' : 'Download .md'}
          </button>
        </div>

        <div className="export-option">
          <div className="export-option-body">
            <div className="export-option-title">PDF</div>
            <p className="muted">Renders that same Markdown (References section included) as a printable page in a new tab, then opens your browser's print dialog — choose “Save as PDF.” Adds a page header (title, and your name if set under Sync → Your name) and a “Page N of M” footer.</p>
            <label className="field-inline">
              Citations
              <select value={citationPlacement} onChange={(e) => setCitationPlacement((e.target as HTMLSelectElement).value as PrintCitationPlacement)}>
                <option value="inline">Inline</option>
                <option value="footnote">Footnote</option>
              </select>
            </label>
            <label className="field-inline" style={{ marginTop: 6 }}>
              Citation style
              <select
                value={citationStyle}
                disabled={citationPlacement === 'footnote'}
                title={citationPlacement === 'footnote' ? 'Not used for footnote citations — the footnote itself always shows the full reference.' : undefined}
                onChange={(e) => setCitationStyle((e.target as HTMLSelectElement).value as PrintCitationStyle)}
              >
                <option value="author-year">Author, year — (Smith, 2020)</option>
                <option value="author-title">Author, title — (Smith, “A Paper”)</option>
                <option value="numbered">Numbered — [3], matching the References list</option>
              </select>
            </label>
          </div>
          <button className="btn btn-primary" disabled={!!busy} onClick={exportPdf}>
            {busy === 'pdf' ? 'Opening…' : 'Open print view'}
          </button>
        </div>

        <div className="export-option">
          <div className="export-option-body">
            <div className="export-option-title">LaTeX project</div>
            <p className="muted">
              main.tex — <code>\section</code>/<code>\subsection</code>/<code>\subsubsection</code> and deeper — plus a references.bib built from every source you've cited, zipped together.
            </p>
            <label className="field-inline">
              Citation command
              <select value={citeCommand} onChange={(e) => setCiteCommand((e.target as HTMLSelectElement).value as '\\cite' | '\\footcite')}>
                <option value="\cite">\cite (natbib)</option>
                <option value="\footcite">\footcite (biblatex)</option>
              </select>
            </label>
          </div>
          <button className="btn btn-primary" disabled={!!busy} onClick={exportLatex}>
            {busy === 'tex' ? 'Zipping…' : 'Download .zip'}
          </button>
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
