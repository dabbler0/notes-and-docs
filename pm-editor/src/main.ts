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
)
