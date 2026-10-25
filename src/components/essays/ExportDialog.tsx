import { useState } from 'preact/hooks'
import JSZip from 'jszip'
import { Modal } from '../Modal'
import { listSources } from '../../models/sourcesRepo'
import {
  addAuthorAttribution,
  addPrintChrome,
  applyMathlikeHeadings,
  ensureCitationSpacing,
  citedSources,
  collectUsedSourceIds,
  essayToLatex,
  essayToMarkdown,
  floatPrintFootnotes,
  markdownToHtml,
  moveFootnoteCitationsPastPeriod,
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

/**
 * The print/PDF view's own overall styling — distinct from
 * `PrintCitationStyle`/`PrintCitationPlacement` (how a citation itself
 * reads), which each mode below just picks a starting default for; the
 * citation selects right under the mode picker stay live and override
 * it same as before. See `exportPdf`'s own doc comment for exactly what
 * each one changes in the generated CSS/HTML.
 */
type PrintMode = 'handout' | 'manuscript' | 'mathlike' | 'substack'

const PRINT_MODE_DEFAULT_CITATIONS: Record<PrintMode, { placement: PrintCitationPlacement; style: PrintCitationStyle }> = {
  handout: { placement: 'inline', style: 'author-year' },
  manuscript: { placement: 'footnote', style: 'author-year' },
  mathlike: { placement: 'inline', style: 'author-year' },
  substack: { placement: 'inline', style: 'numbered' },
}

export function ExportDialog({ essay, nodeMap, onClose }: { essay: Essay; nodeMap: Map<string, EssayNode>; onClose: () => void }) {
  const [citeCommand, setCiteCommand] = useState<'\\cite' | '\\footcite'>('\\cite')
  const [bibliographyStyle, setBibliographyStyle] = useState<BibliographyStyle>('chicago')
  const [includeUrlWhenDoi, setIncludeUrlWhenDoi] = useState(true)
  const [printMode, setPrintMode] = useState<PrintMode>('handout')
  const [citationStyle, setCitationStyle] = useState<PrintCitationStyle>('author-year')
  const [citationPlacement, setCitationPlacement] = useState<PrintCitationPlacement>('inline')
  const [busy, setBusy] = useState<'md' | 'pdf' | 'tex' | null>(null)

  /** Switching print style resets the citation selects to that style's own default — still freely overridable afterward, same as picking either of them by hand always was. */
  function handlePrintModeChange(mode: PrintMode) {
    setPrintMode(mode)
    const defaults = PRINT_MODE_DEFAULT_CITATIONS[mode]
    setCitationPlacement(defaults.placement)
    setCitationStyle(defaults.style)
  }

  async function exportMarkdown() {
    setBusy('md')
    try {
      const sources = new Map((await listSources()).map((s) => [s.id, s]))
      const md = essayToMarkdown(essay, nodeMap) + referencesMarkdown(nodeMap, sources, bibliographyStyle, { includeUrlWhenDoi })
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
   *
   * `printMode` (Handout/Manuscript/Mathlike/Substack — see the type's
   * own doc comment) changes several things below together:
   * - Mathlike runs `applyMathlikeHeadings` on the body (after
   *   `addPrintChrome` has already numbered everything) and centers/
   *   small-caps the root-level section headings via CSS alone.
   * - Manuscript doubles `line-height`; Handout tightens it (and paragraph
   *   spacing) below the 1.6/1em every other mode shares.
   * - Substack is the one real structural fork: no pagination at all
   *   (Paged.js never runs, so no header/footer margin boxes and no
   *   `window.print()` either — the window is left open for copying out
   *   of, not printed), a sans-serif font, and every `<hr>` (the title/
   *   section rules `addPrintChrome` adds, and the plain footnote-list
   *   separator `markdownToHtml` adds) hidden via one shared CSS rule —
   *   `floatPrintFootnotes` is skipped too, since Paged.js's own
   *   per-page floating is meaningless without real pages; the footnotes
   *   just stay as that same plain end-of-document list instead.
   */
  async function exportPdf() {
    setBusy('pdf')
    try {
      const substack = printMode === 'substack'
      const doubleSpaced = printMode === 'manuscript'
      const mathlikeMode = printMode === 'mathlike'
      // Handout's own line-height/paragraph-spacing — tighter than every
      // other mode's shared 1.6/1em (Manuscript wants its own, deliberately
      // loose, double-spacing; Mathlike and Substack keep the original
      // 1.6/1em look) — 1.6 read as noticeably airier than a normal printed
      // document once compared side by side; 1.35 is much closer to a
      // typical book/manuscript's own leading while staying comfortably
      // readable.
      const handoutCompact = printMode === 'handout'
      const lineHeight = doubleSpaced ? 2 : handoutCompact ? 1.35 : 1.6
      const paragraphMargin = handoutCompact ? '0.75em' : '1em'

      const authorName = getAuthorName()
      const sources = new Map((await listSources()).map((s) => [s.id, s]))
      const orderedSourceIds = citedSources(nodeMap, sources).map((s) => s.id)
      const md = essayToMarkdown(essay, nodeMap, { citationOptions: { sources, style: citationStyle, placement: citationPlacement, orderedSourceIds, bibliographyStyle } })
      const numberedReferences = citationPlacement === 'inline' && citationStyle === 'numbered'
      let rawBodyHtml = addPrintChrome(markdownToHtml(md))
      if (citationPlacement === 'footnote') rawBodyHtml = moveFootnoteCitationsPastPeriod(rawBodyHtml)
      rawBodyHtml = ensureCitationSpacing(rawBodyHtml)
      if (!substack && authorName) rawBodyHtml = addAuthorAttribution(rawBodyHtml, authorName, essay.authorNote)
      rawBodyHtml += referencesHtml(nodeMap, sources, bibliographyStyle, numberedReferences, { includeUrlWhenDoi })
      if (mathlikeMode) rawBodyHtml = applyMathlikeHeadings(rawBodyHtml)
      const bodyHtml = substack ? rawBodyHtml : floatPrintFootnotes(rawBodyHtml)

      const win = window.open('', '_blank')
      if (!win) {
        alert('Your browser blocked the print preview pop-up — allow pop-ups for this page and try again.')
        return
      }
      const titleText = cssStringEscape(essay.title)
      const authorText = cssStringEscape(authorName ?? '')
      const bodyFontFamily = substack ? `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif` : `'EB Garamond', Georgia, 'Times New Roman', serif`

      // Shared by every mode, paginated or not — fonts, base typography,
      // the abstract/references/footnote-list styling, and the two
      // mode-specific tweaks (mathlike's centered small-caps h2, and
      // substack's hidden rules) that don't depend on actual pagination.
      const sharedCss = `
        ${katexCss}
        /* EB Garamond (SIL OFL 1.1 — see src/assets/fonts/OFL.txt) is a
           real variable font (weight 400-800 in one file per style), so
           one @font-face per style, not one per weight, correctly
           covers both the body text and every bold heading below. Loaded
           even in Substack mode's sans-serif body — harmless, since a
           browser only ever actually fetches an @font-face it finds
           used — on the chance an equation or something else still
           wants it. */
        @font-face { font-family: 'EB Garamond'; font-style: normal; font-weight: 400 800; src: url(${garamondRegularUrl}) format('woff2'); font-display: swap; }
        @font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 400 800; src: url(${garamondItalicUrl}) format('woff2'); font-display: swap; }
        body { font-family: ${bodyFontFamily}; line-height: ${lineHeight}; color: #1a1a1a; }
        h1, h2, h3, h4, h5, h6 { font-family: ${bodyFontFamily}; font-weight: 700; margin-bottom: 0; }
        /* Single-direction paragraph spacing (margin-top always 0) so a
           heading's own margin-bottom is what actually controls the gap
           below it, rather than being swallowed by the usual CSS
           margin-collapsing between a heading's bottom margin and the
           next paragraph's own top one. */
        p { margin: 0 0 ${paragraphMargin}; }
        h3, h4, h5, h6 { margin-top: 1.4em; margin-bottom: 0.3em; }
        /* The author line addAuthorAttribution() (lib/export.ts) inserts
           right beneath the title, above its own rule — its own margin
           here (not the shared p rule above) keeps it snug against the
           title and the rule on either side rather than taking on a
           whole paragraph's own spacing. */
        .print-author { margin: 2px 0 20px; font-style: italic; color: #444; }
        .print-title-rule { border: none; border-top: 4px solid #1a1a1a; margin: 0 0 32px; }
        .print-section-rule { border: none; border-top: 1px solid #bbb; margin: 0 0 28px; }
        blockquote { border-left: 3px solid #999; margin: 1em 0; padding-left: 1em; color: #444; }
        .katex-display { margin: 1em 0; }
        /* The abstract (see addPrintChrome's own doc comment) — smaller
           type, indented in from both sides, same treatment in every
           print mode regardless of how that mode styles everything else. */
        .print-abstract { font-size: 0.92em; margin: 0 8% 28px; }
        /* Deliberately outside addPrintChrome's own numbering/rule pass
           (see referencesHtml's own doc comment) — a plain heading and a
           hanging-indent list, the conventional bibliography layout.
           Deliberately compact — tighter than the document's own
           body-text line-height/paragraph spacing (even Manuscript's
           double-spacing) regardless of print mode, the same way a real
           bibliography is typeset more densely than the prose above it. */
        .print-references-heading { margin-top: 2.4em; }
        .print-references-list { margin: 0.6em 0 0; line-height: 1.25; }
        ul.print-references-list { list-style: none; padding: 0; }
        ul.print-references-list li { margin: 0 0 0.35em 1.6em; text-indent: -1.6em; }
        ol.print-references-list { padding-left: 1.8em; }
        ol.print-references-list li { margin: 0 0 0.35em; }
        ${mathlikeMode ? "h2 { text-align: center; font-variant: small-caps; letter-spacing: 0.04em; }" : ''}
        ${substack ? 'hr { display: none; }' : ''}
      `

      if (substack) {
        // No Paged.js at all — a single continuous, unpaginated document,
        // meant to be read top to bottom (or copied straight into a
        // Substack post), not printed.
        win.document.write(
          `<!doctype html><html><head><title>${escapeHtml(essay.title)}</title><meta charset="utf-8">
          <style>
            ${sharedCss}
            html, body { margin: 0; background: #fff; }
            .substack-column { max-width: 700px; margin: 0 auto; padding: 48px 24px 72px; }
          </style>
          </head><body><div class="substack-column">${bodyHtml}</div></body></html>`,
        )
        win.document.close()
        win.focus()
        return
      }

      const printCss = `
        ${sharedCss}
        @page {
          size: letter;
          margin: 1in;
          @top-left { content: "${titleText}"; font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; letter-spacing: 0.03em; font-size: 11px; color: #666; }
          ${authorName ? `@top-right { content: "${authorText}"; font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; letter-spacing: 0.03em; font-size: 11px; color: #666; }` : ''}
        }
        /* A book's own running folio: the page number sits in the outer
           bottom corner — left on a verso (left-hand) page, right on a
           recto (right-hand) one — rather than centered, so it's always
           the corner nearest the edge of the open book. */
        @page :left { @bottom-left { content: counter(page); font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; font-size: 10px; color: #666; } }
        @page :right { @bottom-right { content: counter(page); font-family: 'EB Garamond', Georgia, serif; font-variant: small-caps; font-size: 10px; color: #666; } }
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
        /* A short rule above the footnote area, the conventional visual
           break between a page's own body text and its footnotes — a
           separate ::before element sized to just ~35% of the column
           width, rather than a border-top (or a width) on the footnote
           content itself, which would cap the footnote *text* to that
           same narrow width and wrap it pointlessly instead of letting it
           use the full page margin-to-margin width like the body text
           above it. Skipped on a page with no footnotes at all via
           Paged.js's own "pagedjs_footnote_empty" class
           (chunker/chunker.js), which it keeps on
           .pagedjs_footnote_content until the first footnote actually
           lands there, so an otherwise-empty footnote area never shows a
           stray rule floating above nothing. */
        .pagedjs_footnote_content::before {
          content: '';
          display: block;
          width: 35%;
          border-top: 1px solid #999;
          margin-bottom: 6px;
        }
        .pagedjs_footnote_content.pagedjs_footnote_empty::before {
          display: none;
        }
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
          <option value="apa">APA</option>
          <option value="mla">MLA</option>
          <option value="chicago">Chicago</option>
        </select>
      </label>
      <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <input type="checkbox" checked={includeUrlWhenDoi} onChange={(e) => setIncludeUrlWhenDoi((e.target as HTMLInputElement).checked)} />
        Include the URL even when a DOI is also present (uncheck to show the URL only when there's no DOI)
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
              Print style
              <select value={printMode} onChange={(e) => handlePrintModeChange((e.target as HTMLSelectElement).value as PrintMode)}>
                <option value="handout">Handout</option>
                <option value="manuscript">Manuscript (double-spaced, footnote citations)</option>
                <option value="mathlike">Mathlike (amsart-style headings)</option>
                <option value="substack">Substack (unpaginated, for pasting into a post)</option>
              </select>
            </label>
            <label className="field-inline" style={{ marginTop: 6 }}>
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
            {busy === 'pdf' ? 'Opening…' : printMode === 'substack' ? 'Open view' : 'Open print view'}
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
