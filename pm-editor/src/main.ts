import { EditorState, Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark, setBlockType, wrapIn, lift } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { wrapInList, splitListItem, liftListItem } from 'prosemirror-schema-list'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema as schema } from './schema'
import { sampleDocJson } from './sampleDoc'
import { CitationView, FootnoteView, MathInlineView, MathBlockView } from './nodeViews'
import { insertSiblingSection, insertChildSection, insertCitation, insertFootnote, addCommentAnchor } from './commands'
import {
  addPrintChrome,
  ensureCitationSpacing,
  markdownToHtml,
  moveFootnoteCitationsPastPeriod,
  pmCitedSources,
  pmEssayToMarkdown,
  referencesHtml,
  referencesMarkdown,
  type PrintCitationOptions,
} from './export'
import { fakeSourcesMap } from './sources'

const appEl = document.querySelector<HTMLDivElement>('#app')!
appEl.innerHTML = `
  <div class="app-shell">
    <h1 class="page-title">Marginal — ProseMirror prototype</h1>
    <p class="page-subtitle">Standalone single-file demo of the "maximal" migration: the whole essay is one real, schema-validated ProseMirror document — nested sections, footnotes, and citations are structural, not HTML-string conventions. Nothing here touches the real app's storage or Firebase.</p>
    <div class="toolbar" id="toolbar"></div>
    <div id="editor"></div>
  </div>
`

const toolbarEl = document.querySelector<HTMLDivElement>('#toolbar')!
const editorEl = document.querySelector<HTMLDivElement>('#editor')!

const doc = PMNode.fromJSON(schema, sampleDocJson)

function run(command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) {
  command(view.state, view.dispatch)
  view.focus()
}

const customKeymap = keymap({
  'Mod-z': undo,
  'Mod-y': redo,
  'Mod-Shift-z': redo,
  'Mod-b': toggleMark(schema.marks.strong),
  'Mod-i': toggleMark(schema.marks.em),
  'Mod-u': toggleMark(schema.marks.underline),
  Enter: splitListItem(schema.nodes.list_item),
  'Mod-Enter': insertSiblingSection,
})

const state = EditorState.create({
  doc,
  plugins: [history(), customKeymap, keymap(baseKeymap)],
})

const view = new EditorView(editorEl, {
  state,
  nodeViews: {
    citation: (node, v, getPos) => new CitationView(node, v, getPos as () => number | undefined),
    footnote: () => new FootnoteView(),
    math_inline: (node, v, getPos) => new MathInlineView(node, v, getPos as () => number | undefined),
    math_block: (node, v, getPos) => new MathBlockView(node, v, getPos as () => number | undefined),
  },
})
;(window as unknown as { pmView: EditorView }).pmView = view // for Playwright/manual console poking

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.title = title
  b.addEventListener('click', (e) => {
    e.preventDefault()
    onClick()
  })
  return b
}

function divider() {
  const d = document.createElement('div')
  d.className = 'divider'
  return d
}

toolbarEl.append(
  button('B', 'Bold (Mod-B)', () => run(toggleMark(schema.marks.strong))),
  button('I', 'Italic (Mod-I)', () => run(toggleMark(schema.marks.em))),
  button('U', 'Underline (Mod-U)', () => run(toggleMark(schema.marks.underline))),
  button('Link', 'Wrap selection in a link', () => {
    const href = window.prompt('URL:')
    if (!href) return
    run(toggleMark(schema.marks.link, { href }))
  }),
  divider(),
  button('• List', 'Bullet list', () => run(wrapInList(schema.nodes.bullet_list))),
  button('1. List', 'Ordered list', () => run(wrapInList(schema.nodes.ordered_list))),
  button('Outdent', 'Lift list item / block', () => {
    const liftItem = liftListItem(schema.nodes.list_item)
    run(liftItem(view.state) ? liftItem : lift)
  }),
  button('Quote', 'Blockquote', () => run(wrapIn(schema.nodes.blockquote))),
  divider(),
  button('Cite src1', 'Insert a citation to the fake "Smith (2020)" source', () => run(insertCitation('src1', null))),
  button('Cite src2', 'Insert a citation to the fake "Doe & Lee (2019)" source', () => run(insertCitation('src2', 'p. 3'))),
  button('Footnote', 'Insert a footnote (its own body is real document content)', () => run(insertFootnote)),
  button('Comment', 'Anchor a comment mark to the current selection', () => run(addCommentAnchor)),
  divider(),
  button('+ Section', 'New sibling section', () => run(insertSiblingSection)),
  button('+ Child section', 'New child section', () => run(insertChildSection)),
  divider(),
  button('Undo', 'Undo (Mod-Z)', () => run(undo)),
  button('Redo', 'Redo (Mod-Shift-Z)', () => run(redo)),
  divider(),
  button('Log doc JSON', 'Print the current document as JSON to the console — the literal storage shape', () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(view.state.doc.toJSON(), null, 2))
    window.alert('Document JSON logged to the browser console.')
  }),
  divider(),
  button('Export', 'Show Markdown and print-HTML export, produced by walking this document directly (export.ts)', () => showExportPanel()),
)

/**
 * A minimal stand-in for the real app's `ExportDialog.tsx` — proves the
 * ported `export.ts` pipeline end to end against whatever's actually in
 * the editor right now, rather than only against hand-written test
 * fixtures. No Paged.js here (this demo never paginates — see `export.ts`'s
 * own doc comment on what's deliberately not ported yet), so footnotes
 * render as a plain end-of-document list instead of floating to a page
 * bottom; everything upstream of that (numbering, citation styling,
 * period-movement, references) is the real, unmodified pipeline.
 */
function showExportPanel() {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:100;display:flex;align-items:center;justify-content:center;'
  const panel = document.createElement('div')
  panel.style.cssText = 'background:#fff;border-radius:8px;padding:20px;width:min(900px,92vw);max-height:88vh;overflow:auto;font-family:-apple-system,system-ui,sans-serif;'
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.remove()
  })

  const placementSel = document.createElement('select')
  placementSel.innerHTML = '<option value="inline">Inline citations</option><option value="footnote">Footnote citations</option>'
  const styleSel = document.createElement('select')
  styleSel.innerHTML = '<option value="author-year">author-year</option><option value="author-title">author-title</option><option value="numbered">numbered</option>'
  const biblioSel = document.createElement('select')
  biblioSel.innerHTML = '<option value="plain">Plain</option><option value="apa">APA</option><option value="mla">MLA</option><option value="chicago">Chicago</option>'

  const mdPre = document.createElement('pre')
  mdPre.style.cssText = 'background:#f6f5f2;padding:12px;border-radius:6px;white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto;'
  const htmlFrame = document.createElement('iframe')
  htmlFrame.style.cssText = 'width:100%;height:420px;border:1px solid #ddd;border-radius:6px;background:#fff;'

  function rerender() {
    const sources = fakeSourcesMap
    const citationOptions: PrintCitationOptions = {
      style: styleSel.value as PrintCitationOptions['style'],
      placement: placementSel.value as PrintCitationOptions['placement'],
      orderedSourceIds: pmCitedSources(view.state.doc, sources).map((s) => s.id),
      bibliographyStyle: biblioSel.value as PrintCitationOptions['bibliographyStyle'],
    }
    const cited = pmCitedSources(view.state.doc, sources)
    const plainMd = pmEssayToMarkdown('Test Essay', view.state.doc, sources) + referencesMarkdown(cited, biblioSel.value as never)
    mdPre.textContent = plainMd

    const printMd = pmEssayToMarkdown('Test Essay', view.state.doc, sources, { citationOptions })
    let html = addPrintChrome(markdownToHtml(printMd))
    if (citationOptions.placement === 'footnote') html = moveFootnoteCitationsPastPeriod(html)
    html = ensureCitationSpacing(html)
    html += referencesHtml(cited, biblioSel.value as never, citationOptions.style === 'numbered')
    htmlFrame.srcdoc = `<!doctype html><html><head><style>
      body { font-family: 'EB Garamond', Georgia, serif; max-width: 640px; margin: 24px auto; padding: 0 16px; line-height: 1.6; }
      .print-title-rule { border: none; border-top: 4px solid #1a1a1a; margin: 0 0 24px; }
      .print-section-rule { border: none; border-top: 1px solid #bbb; margin: 0 0 16px; }
      .print-references-heading { margin-top: 2em; }
      .print-references-list { line-height: 1.3; }
      .print-footnotes { font-size: 0.9em; }
    </style></head><body>${html}</body></html>`
  }

  for (const sel of [placementSel, styleSel, biblioSel]) sel.addEventListener('change', rerender)

  const closeBtn = document.createElement('button')
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', () => overlay.remove())

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;'
  row.append(placementSel, styleSel, biblioSel, closeBtn)

  panel.innerHTML = '<h2 style="margin-top:0">Export preview</h2>'
  panel.append(row, document.createElement('h3'), mdPre)
  panel.querySelector('h3')!.textContent = 'Markdown (plain .md export)'
  const h3b = document.createElement('h3')
  h3b.textContent = 'Print HTML (same pipeline, citation-styled)'
  panel.append(h3b, htmlFrame)
  overlay.append(panel)
  document.body.append(overlay)
  rerender()
}
