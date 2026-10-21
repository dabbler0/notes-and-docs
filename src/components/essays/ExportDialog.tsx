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
  floatPrintFootnotes,
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
// Raw CSS/JS text / a base64 data: URI (Vite's `?raw`/`?inline` query
// suffixes — forced regardless of the normal multi-file build's own
// size-based inlining threshold, see vite.config.ts's
// `assetsInlineLimit`), not the ordinary side-effect import `main.tsx`
// uses — the print-preview window below is a whole separate document
// (`win.document.write(...)`), which has no access to this page's own
// stylesheets, scripts, *or* same-origin asset URLs at all (a plain
// `/assets/...woff2` or `/assets/....js` reference can't be relied on to
// resolve from a `window.open('', ...)` blank document across every
// browser), so everything the print view needs — KaTeX's own CSS (for an
// equation rendered into it by `markdownToHtml`'s `renderMathHtml`), this
// serif face's two font files, and Paged.js itself (see `exportPdf`'s own
// doc comment on why it's needed at all) — gets inlined directly into
// that document's own `<style>`/`<script>`, same "nothing loaded at
// runtime from anywhere else" reasoning the rest of this app's own build
// already follows.
import katexCss from 'katex/dist/katex.min.css?inline'
import garamondRegularUrl from '../../assets/fonts/EBGaramond-Regular.woff2?inline'
import garamondItalicUrl from '../../assets/fonts/EBGaramond-Italic.woff2?inline'
// pagedjs's own package.json `exports` map only declares its root entry
// (`.` -> src/index.js, a dev/Node build) — no subpath for
// `dist/paged.js`, the pre-bundled browser build actually needed here as
// raw text (see this function's own doc comment on why Paged.js is
// needed at all). A bare `'pagedjs/dist/paged.js?raw'` specifier fails
// Node's own exports-map validation during the production build for
// exactly that reason — this direct relative path into node_modules
// reads the same file straight off disk instead, bypassing that map
// entirely, the same way reaching any other vendored file outside a
// package's declared exports would.
import pagedJsSource from '../../../node_modules/pagedjs/dist/paged.js?raw'

/** CSS `@page` margin-box `content` strings are ordinary CSS string literals — backslashes and double quotes need the same escaping any other hand-built CSS string value would. */
function cssStringEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Defensive escaping for anything spliced into the print-preview window's
 * own inline `<script>` block (see `exportPdf`): the HTML parser looks for
 * a literal `</script` substring to end that element *before* any JS
 * syntax is ever considered, so a stray occurrence inside Paged.js's own
 * source or a JSON-stringified CSS string would otherwise truncate the
 * script early. Checked empirically that neither ever actually contains
 * one today, but this is a one-line guard against a future Paged.js
 * version (or essay title/author text folded into the CSS string) that
 * does, same precaution any other inline-`<script>`-templating code needs.
 */
function scriptSafe(s: string): string {
  return s.replace(/<\/script/gi, '<\\/script')
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

  /**
   * Renders the print view through Paged.js (bundled locally, see the
   * `?raw` import above) rather than handing the browser's native print
   * engine a single flowing document the way earlier versions of this
   * export did. Two things neither Chromium's own print engine nor plain
   * CSS `@page` margin boxes can do at all, confirmed directly against
   * this app's actual target before committing to this approach:
   *
   * - Real per-page footnotes. CSS Paged Media's own `float: footnote`
   *   (what `floatPrintFootnotes` marks each footnote up for) has no
   *   native Chromium support — a `float: footnote` element just renders
   *   inline, exactly where it sits in the flow, which is why footnotes
   *   used to be collected into one list at the very end of the document
   *   instead. Paged.js's own Footnotes module reimplements the real
   *   layout algorithm in JS: each footnote floats to the bottom of
   *   whichever physical page its own reference actually lands on, with
   *   its call number auto-generated from a page-scoped CSS counter.
   * - Alternating recto/verso page numbers. `@page :left`/`:right` are
   *   real standard CSS pseudo-classes, but only Paged.js's own
   *   from-scratch pagination actually resolves them against which
   *   physical page a given one of its own page boxes ends up as —
   *   Chromium's print engine doesn't implement them at all.
   *
   * Paged.js also replaces the native print engine's own `@page` margin
   * boxes for the header and "Page N" footer from here on — same CSS
   * mechanism as before, just resolved by Paged.js's own layout pass
   * instead of the browser's, so it can stay consistent with the
   * recto/verso footer positioning above. `window.print()` fires once
   * Paged.js's own `preview()` promise resolves (pagination has actually
   * finished), rather than the fixed timeout the old plain-print flow
   * needed to guess how long native layout might take.
   */
  async function exportPdf() {
    setBusy('pdf')
    try {
      const sources = new Map((await listSources()).map((s) => [s.id, s]))
      const orderedSourceIds = citedSources(nodeMap, sources).map((s) => s.id)
      const md = essayToMarkdown(essay, nodeMap, { citationOptions: { sources, style: citationStyle, placement: citationPlacement, orderedSourceIds } })
      const numberedReferences = citationPlacement === 'inline' && citationStyle === 'numbered'
      const rawBodyHtml = addPrintChrome(markdownToHtml(md)) + referencesHtml(nodeMap, sources, bibliographyStyle, numberedReferences)
      const bodyHtml = floatPrintFootnotes(rawBodyHtml)
      const win = window.open('', '_blank')
      if (!win) {
        alert('Your browser blocked the print preview pop-up — allow pop-ups for this page and try again.')
        return
      }
      const authorName = getAuthorName()
      const titleText = cssStringEscape(essay.title)
      const authorText = cssStringEscape(authorName ?? '')
      const printCss = `
        ${katexCss}
        @page {
          size: letter;
          margin: 85px 50px 65px;
          @top-left { content: "${titleText}"; font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; letter-spacing: 0.03em; font-size: 11px; color: #666; }
          ${authorName ? `@top-right { content: "${authorText}"; font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; letter-spacing: 0.03em; font-size: 11px; color: #666; }` : ''}
        }
        /* A book's own running folio: the page number sits in the outer
           bottom corner — left on a verso (left-hand) page, right on a
           recto (right-hand) one — rather than centered, so it's always
           the corner nearest the edge of the open book. */
        @page :left { @bottom-left { content: counter(page); font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; font-size: 10px; color: #666; } }
        @page :right { @bottom-right { content: counter(page); font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; font-size: 10px; color: #666; } }
        /* EB Garamond (SIL OFL 1.1 — see src/assets/fonts/OFL.txt) is a
           real variable font (weight 400-800 in one file per style), so
           one @font-face per style, not one per weight, correctly
           covers both the body text and every bold heading below. */
        @font-face { font-family: 'EB Garamond'; font-style: normal; font-weight: 400 800; src: url(${garamondRegularUrl}) format('woff2'); font-display: swap; }
        @font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 400 800; src: url(${garamondItalicUrl}) format('woff2'); font-display: swap; }
        body { font-family: 'EB Garamond', Georgia, 'Times New Roman', serif; line-height: 1.6; color: #1a1a1a; }
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
        /* floatPrintFootnotes() (lib/export.ts) marks each footnote up as
           one of these — Paged.js's own Footnotes module (see this
           function's own doc comment) recognizes the bare float: footnote
           declaration and does the rest: floating it to the bottom of
           whichever page its call ends up on, and driving the
           ::footnote-marker/::footnote-call counters below. */
        .pagedjs-footnote { float: footnote; font-size: 0.85em; line-height: 1.4; }
        /* Two distinct counters, same as Paged.js's own default stylesheet
           uses internally (confirmed by reading its Footnotes module
           directly): ::footnote-call increments/reads "footnote" at each
           inline reference, but ::footnote-marker's own counter-increment
           is "footnote-marker", not "footnote" — reading counter(footnote)
           here too (an easy mix-up, since both are named so similarly) made
           every footnote's own marker number read the page's final call
           count instead of its own position, so with 2+ footnotes on one
           page every single marker showed the same (highest) number. */
        ::footnote-marker { content: counter(footnote-marker) ". "; }
        ::footnote-call { content: counter(footnote); vertical-align: super; font-size: 0.7em; }
      `
      win.document.write(
        `<!doctype html><html><head><title>${escapeHtml(essay.title)}</title><meta charset="utf-8">
        <style>html, body { margin: 0; } #pagedjs-loading { font-family: Georgia, serif; color: #888; padding: 48px; }</style>
        <script>${scriptSafe(pagedJsSource)}</script>
        </head><body>
        <p id="pagedjs-loading">Preparing print layout…</p>
        <div id="print-source" style="display:none">${bodyHtml}</div>
        <script>${scriptSafe(`
          (function () {
            var sourceEl = document.getElementById('print-source')
            var html = sourceEl.innerHTML
            sourceEl.remove()
            var css = ${JSON.stringify(printCss)}
            var previewer = new Paged.Previewer()
            previewer.preview(html, [{ _text: css }], document.body).then(function () {
              var loading = document.getElementById('pagedjs-loading')
              if (loading) loading.remove()
              window.print()
            })
          })()
        `)}</script>
        </body></html>`,
      )
      win.document.close()
      win.focus()
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
            <p className="muted">
              Renders that same Markdown (References section included) as a printable page in a new tab, then opens your browser's print dialog — choose “Save as PDF.” Adds a small-caps page header
              (title, and your name if set under Sync → Your name) and a running page number in the bottom outer corner, alternating sides like a printed book. Footnotes print at the bottom of the
              page they're referenced on.
            </p>
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
