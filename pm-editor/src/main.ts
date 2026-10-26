import { EditorState, Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark, wrapIn, lift } from 'prosemirror-commands'
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
  pmEssayToLatex,
  pmEssayToMarkdown,
  referencesHtml,
  referencesMarkdown,
  type PrintCitationOptions,
} from './export'
import { fakeSourcesMap } from './sources'
import { activeSources, setActiveSources } from './activeSources'
import { migrateEssay, type MigratedEssay } from './migrate'
import { loadBackupZip } from './backupLoader'
import type { LegacyEssay } from './types'

setActiveSources(fakeSourcesMap)

const appEl = document.querySelector<HTMLDivElement>('#app')!
appEl.innerHTML = `
  <div class="app-shell" id="appShell">
    <h1 class="page-title">Marginal — ProseMirror migration demo</h1>
    <p class="page-subtitle">Upload your own backup <code>.zip</code> (made from the real app's own "Export backup" feature) to run every essay in it through the migration script and click around the results here — nothing here touches the real app's storage or Firebase. Or just try the hand-written sample document below.</p>
    <div class="landing" id="landing">
      <div>
        <label for="backupFile"><strong>Load a backup .zip:</strong></label><br/>
        <input type="file" id="backupFile" accept=".zip" />
      </div>
      <div class="error" id="backupError" style="display:none"></div>
      <div id="backupStatus" style="margin-top:8px;color:#666;font-size:12px"></div>
      <button class="secondary" id="useSampleBtn" style="margin-top:12px">Use the sample document instead</button>
    </div>
    <div class="workspace" id="workspace" style="display:none">
      <div class="essay-sidebar" id="essaySidebar"></div>
      <div class="main-col">
        <div class="toolbar" id="toolbar"></div>
        <div id="editor"></div>
        <div class="meta-panel" id="metaPanel"></div>
      </div>
    </div>
  </div>
`

const landingEl = document.querySelector<HTMLDivElement>('#landing')!
const workspaceEl = document.querySelector<HTMLDivElement>('#workspace')!
const appShellEl = document.querySelector<HTMLDivElement>('#appShell')!
const sidebarEl = document.querySelector<HTMLDivElement>('#essaySidebar')!
const toolbarEl = document.querySelector<HTMLDivElement>('#toolbar')!
const editorEl = document.querySelector<HTMLDivElement>('#editor')!
const metaPanelEl = document.querySelector<HTMLDivElement>('#metaPanel')!
const backupFileInput = document.querySelector<HTMLInputElement>('#backupFile')!
const backupErrorEl = document.querySelector<HTMLDivElement>('#backupError')!
const backupStatusEl = document.querySelector<HTMLDivElement>('#backupStatus')!
const useSampleBtn = document.querySelector<HTMLButtonElement>('#useSampleBtn')!

interface EssayEntry {
  essay: LegacyEssay
  migrated: MigratedEssay
}

let essayEntries: EssayEntry[] = []
let activeEssayId: string | null = null
let view: EditorView

backupFileInput.addEventListener('change', async () => {
  const file = backupFileInput.files?.[0]
  if (!file) return
  backupErrorEl.style.display = 'none'
  backupStatusEl.textContent = 'Reading backup…'
  try {
    const backup = await loadBackupZip(file)
    backupStatusEl.textContent = `Loaded ${backup.essays.length} essay(s), ${backup.nodes.length} node(s), ${backup.sources.size} source(s). Migrating…`
    const liveEssays = backup.essays.filter((e) => !e.deleted)
    essayEntries = liveEssays
      .map((essay) => ({ essay, migrated: migrateEssay(essay, backup.nodes, backup.sources) }))
      .sort((a, b) => a.essay.title.localeCompare(b.essay.title))
    setActiveSources(backup.sources)
    backupStatusEl.textContent = `Migrated ${essayEntries.length} essay(s). Click one on the left to load it.`
    enterWorkspace()
    renderSidebar()
    if (essayEntries.length > 0) loadEssay(essayEntries[0].essay.id)
  } catch (err) {
    backupErrorEl.textContent = err instanceof Error ? err.message : String(err)
    backupErrorEl.style.display = 'block'
    backupStatusEl.textContent = ''
  }
})

useSampleBtn.addEventListener('click', () => {
  essayEntries = []
  activeEssayId = null
  setActiveSources(fakeSourcesMap)
  enterWorkspace()
  renderSidebar()
  mountEditor(sampleDocJson, [], [])
})

function enterWorkspace() {
  landingEl.style.display = 'none'
  workspaceEl.style.display = 'flex'
  appShellEl.classList.add('with-sidebar')
  buildToolbar()
}

function renderSidebar() {
  sidebarEl.innerHTML = ''
  if (essayEntries.length === 0) {
    sidebarEl.innerHTML = '<p style="color:#888;margin:0">Sample document — reload the page to load a backup instead.</p>'
    return
  }
  const heading = document.createElement('h3')
  heading.textContent = `Essays (${essayEntries.length})`
  sidebarEl.append(heading)
  for (const entry of essayEntries) {
    const item = document.createElement('div')
    item.className = 'essay-item' + (entry.essay.id === activeEssayId ? ' active' : '')
    const label = document.createElement('span')
    label.textContent = entry.essay.title || 'Untitled'
    item.append(label)
    if (entry.migrated.warnings.length > 0) {
      const badge = document.createElement('span')
      badge.className = 'warn-badge'
      badge.textContent = `⚠ ${entry.migrated.warnings.length}`
      item.append(badge)
    }
    item.addEventListener('click', () => loadEssay(entry.essay.id))
    sidebarEl.append(item)
  }
  const reloadBtn = document.createElement('button')
  reloadBtn.className = 'secondary'
  reloadBtn.textContent = 'Load a different backup…'
  reloadBtn.style.marginTop = '12px'
  reloadBtn.addEventListener('click', () => {
    workspaceEl.style.display = 'none'
    landingEl.style.display = 'block'
    appShellEl.classList.remove('with-sidebar')
    backupFileInput.value = ''
    backupStatusEl.textContent = ''
  })
  sidebarEl.append(reloadBtn)
}

function loadEssay(essayId: string) {
  const entry = essayEntries.find((e) => e.essay.id === essayId)
  if (!entry) return
  activeEssayId = essayId
  renderSidebar()
  mountEditor(entry.migrated.doc, entry.migrated.comments, entry.migrated.warnings, entry.essay.title)
}

function mountEditor(docJson: unknown, comments: MigratedEssay['comments'], warnings: string[], title?: string) {
  editorEl.innerHTML = ''
  const doc = PMNode.fromJSON(schema, docJson)
  const state = EditorState.create({
    doc,
    plugins: [history(), customKeymap, keymap(baseKeymap)],
  })
  view = new EditorView(editorEl, {
    state,
    nodeViews: {
      citation: (node, v, getPos) => new CitationView(node, v, getPos as () => number | undefined),
      footnote: () => new FootnoteView(),
      math_inline: (node, v, getPos) => new MathInlineView(node, v, getPos as () => number | undefined),
      math_block: (node, v, getPos) => new MathBlockView(node, v, getPos as () => number | undefined),
    },
  })
  ;(window as unknown as { pmView: EditorView }).pmView = view // for Playwright/manual console poking
  renderMetaPanel(comments, warnings, title)
}

function renderMetaPanel(comments: MigratedEssay['comments'], warnings: string[], title?: string) {
  metaPanelEl.innerHTML = ''
  if (title) {
    const h = document.createElement('h3')
    h.textContent = title
    metaPanelEl.append(h)
  }
  if (warnings.length > 0) {
    const h = document.createElement('h3')
    h.textContent = `Migration warnings (${warnings.length})`
    const ul = document.createElement('ul')
    for (const w of warnings) {
      const li = document.createElement('li')
      li.className = 'warning'
      li.textContent = w
      ul.append(li)
    }
    metaPanelEl.append(h, ul)
  }
  const ch = document.createElement('h3')
  ch.textContent = `Comments (${comments.length})`
  metaPanelEl.append(ch)
  if (comments.length === 0) {
    const p = document.createElement('p')
    p.style.color = '#888'
    p.textContent = 'No comments on this essay.'
    metaPanelEl.append(p)
  } else {
    for (const c of comments) {
      const div = document.createElement('div')
      div.className = 'comment'
      const meta = document.createElement('div')
      meta.style.color = '#888'
      meta.style.fontSize = '11px'
      meta.textContent = `${c.anchorKind}${c.parentId ? ' · reply' : ''}${c.resolved ? ' · resolved' : ''}${c.anchorText ? ` · anchored to "${c.anchorText}"` : ''}`
      const body = document.createElement('div')
      body.innerHTML = c.body
      div.append(meta, body)
      metaPanelEl.append(div)
    }
  }
}

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

function buildToolbar() {
  if (toolbarEl.childElementCount > 0) return // built once, reused across essay switches — handlers close over the module-level `view`, which mountEditor reassigns
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
    button('Cite src1', 'Insert a citation to whatever source "src1" resolves to in the active source map (the fake sample sources, or your backup\'s real ones)', () => run(insertCitation('src1', null))),
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
    button('Export', 'Show Markdown, print-HTML, and LaTeX export, produced by walking this document directly (export.ts)', () => showExportPanel()),
  )
}

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
  const texPre = document.createElement('pre')
  texPre.style.cssText = 'background:#f6f5f2;padding:12px;border-radius:6px;white-space:pre-wrap;font-size:12px;max-height:280px;overflow:auto;'

  function rerender() {
    const sources = activeSources
    const citationOptions: PrintCitationOptions = {
      style: styleSel.value as PrintCitationOptions['style'],
      placement: placementSel.value as PrintCitationOptions['placement'],
      orderedSourceIds: pmCitedSources(view.state.doc, sources).map((s) => s.id),
      bibliographyStyle: biblioSel.value as PrintCitationOptions['bibliographyStyle'],
    }
    const cited = pmCitedSources(view.state.doc, sources)
    const essayTitle = essayEntries.find((e) => e.essay.id === activeEssayId)?.essay.title ?? 'Test Essay'
    const plainMd = pmEssayToMarkdown(essayTitle, view.state.doc, sources) + referencesMarkdown(cited, biblioSel.value as never)
    mdPre.textContent = plainMd

    const printMd = pmEssayToMarkdown(essayTitle, view.state.doc, sources, { citationOptions })
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

    texPre.textContent = pmEssayToLatex(essayTitle, view.state.doc, sources)
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
  const h3c = document.createElement('h3')
  h3c.textContent = 'LaTeX (.tex export)'
  panel.append(h3c, texPre)
  overlay.append(panel)
  document.body.append(overlay)
  rerender()
}
