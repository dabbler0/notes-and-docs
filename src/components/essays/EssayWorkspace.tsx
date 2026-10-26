import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { toggleMark, lift } from 'prosemirror-commands'
import { wrapInList, liftListItem } from 'prosemirror-schema-list'
import type { EditorState, Transaction } from 'prosemirror-state'
import { getEssay, saveEssay } from '../../models/essaysRepo'
import { essaySchema } from '../../lib/pmSchema'
import type { Essay } from '../../models/types'
import { Icon } from '../Icon'
import { PMEssayEditor } from './PMEssayEditor'
import { NodeTree } from './NodeTree'
import { AuthorNoteDialog } from './AuthorNoteDialog'
import { SplitPickerDialog } from './SplitPickerDialog'
import { Modal } from '../Modal'
import { useIsMobile } from '../../lib/useIsMobile'

/**
 * The whole essay as one continuous, real ProseMirror document — see
 * `PMEssayEditor.tsx`'s own doc comment for the editing surface itself.
 *
 * **Stage B1 of the ProseMirror migration's UI swap**: this is a
 * deliberately trimmed-down version of the old, full-featured
 * `EssayWorkspace`. Everything the old per-node `contentEditable` UI
 * offered beyond basic text formatting and navigation — citations,
 * quotes, source links, footnotes, comments (margin and inline), split/
 * demote structural editing, "send to graveyard," export, word count,
 * commit/history — comes back in later stages of the same migration (see
 * the `claude/prosemirror-migration` branch's own plan), each restoring
 * one slice via PM's own idiomatic mechanisms (transactions, commands,
 * NodeViews) rather than the old DOM-surgery those features used to need.
 * Nothing here is a permanent regression; it's staged work on this branch,
 * not something shipped to production in this intermediate state.
 *
 * Split-screen works the same way it always has: nesting this same
 * component inside itself (see `splitEssayId`) rather than a separate
 * stripped-down renderer.
 */
export function EssayWorkspace({ essayId, onBack, embedded = false }: { essayId: string; onBack: () => void; embedded?: boolean }) {
  const [essay, setEssay] = useState<Essay | null>(null)
  const [essayTitle, setEssayTitle] = useState('')
  const [doc, setDoc] = useState<PMNode | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [splitEssayId, setSplitEssayId] = useState<string | null>(null)
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  const [showTree, setShowTree] = useState(true)
  const isMobile = useIsMobile()
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)
  const [showAuthorNote, setShowAuthorNote] = useState(false)

  const viewRef = useRef<EditorView | null>(null)
  const docScrollRef = useRef<HTMLDivElement>(null)

  async function reload() {
    const e = await getEssay(essayId)
    if (!e) return
    setEssay(e)
    setEssayTitle(e.title)
  }

  useEffect(() => {
    reload()
  }, [essayId])

  function run(command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) {
    const view = viewRef.current
    if (!view) return
    command(view.state, view.dispatch)
    view.focus()
  }

  /** PM has no single built-in "strip every mark" command the way `document.execCommand('removeFormat')` was — this removes every mark type the schema defines from the current selection. */
  function clearFormatting(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
    const { from, to, empty } = state.selection
    if (empty) return false
    if (dispatch) {
      let tr = state.tr
      for (const markType of Object.values(state.schema.marks)) tr = tr.removeMark(from, to, markType)
      dispatch(tr)
    }
    return true
  }

  async function saveEssayTitle() {
    if (!essay) return
    const title = essayTitle || 'Untitled essay'
    essay.title = title
    await saveEssay(essay)
    // The document's own root section_title mirrors essay.title (see
    // pmMigration.ts's own doc comment on why the root's displayed title
    // always comes from essay.title, never the section's own) — pushing
    // the rename into the live doc too keeps them from drifting apart
    // again, the exact staleness bug the migration itself had to fix.
    const view = viewRef.current
    if (view) {
      const root = view.state.doc.firstChild!
      const titleNode = root.firstChild!
      const contentStart = 2 // doc(0) -> section(1) -> section_title content starts at 2
      const contentEnd = contentStart + titleNode.content.size
      const trimmed = title.trim()
      const tr = trimmed ? view.state.tr.replaceWith(contentStart, contentEnd, essaySchema.text(trimmed)) : view.state.tr.delete(contentStart, contentEnd)
      view.dispatch(tr)
    }
  }

  async function saveAuthorNote(note: string) {
    if (!essay) return
    essay.authorNote = note || undefined
    await saveEssay(essay)
    setEssay({ ...essay })
  }

  /** "Split view" → `SplitPickerDialog`'s "pick an existing project-mate" option: just opens it side by side, no data touched at all. */
  function handleSelectExistingForSplit(other: Essay) {
    setSplitEssayId(other.id)
    setShowSplitPicker(false)
  }

  /**
   * "Split view" → `SplitPickerDialog`'s "Clone this essay" option. The
   * old `cloneEssay` still only knows how to deep-copy the pre-migration
   * `EssayNode` tree (its own `doc`-based rewrite is a later stage of
   * this same migration) — every essay reachable from here already has
   * `essay.doc` set, so cloning is disabled for now rather than silently
   * producing a broken copy.
   */
  async function handleCloneForSplit() {
    if (!essay) return
    window.alert("Cloning isn't available yet in the new editor — coming in a later update.")
  }

  function scrollToNode(sectionId: string) {
    document.querySelector(`[data-section-id="${sectionId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!essay || !essay.doc) return <div className="page-pad">Loading…</div>

  return (
    <div className="essay-workspace-root">
      <div className="topbar essay-header" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          {embedded ? '×' : '←'} <span className="btn-label">{embedded ? 'Close' : 'All drafts'}</span>
        </button>
        <input
          value={essayTitle}
          onInput={(e) => setEssayTitle((e.target as HTMLInputElement).value)}
          onBlur={saveEssayTitle}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, flex: 1, minWidth: 0 }}
        />
        <button className="btn btn-ghost btn-sm" title="Thanks/acknowledgements/disclosures for your author attribution in print exports" onClick={() => setShowAuthorNote(true)}>
          <Icon name="footnote" /> <span className="btn-label">Author note</span>
        </button>
        {!embedded && !isMobile && (
          <button
            className={`btn btn-ghost btn-sm toolbar-toggle${splitEssayId ? ' active' : ''}`}
            title="Edit a second essay side by side with this one"
            onClick={() => (splitEssayId ? setSplitEssayId(null) : setShowSplitPicker(true))}
          >
            <Icon name="subsection" /> <span className="btn-label">{splitEssayId ? 'Close split' : 'Split view'}</span>
          </button>
        )}
      </div>

      <div className="workspace">
        {!isMobile &&
          !embedded &&
          !splitEssayId &&
          (showTree ? (
            <div className="tree-panel-shell">
              {doc && <NodeTree doc={doc} essayTitle={essayTitle} collapsed={collapsed} onToggleCollapse={toggleCollapse} onScrollTo={scrollToNode} />}
              <button className="panel-edge-toggle left" onClick={() => setShowTree(false)} title="Collapse outline">
                ‹
              </button>
            </div>
          ) : (
            <button className="panel-edge-tab left" onClick={() => setShowTree(true)} title="Show outline">
              ›
            </button>
          ))}

        <div className="editor-panel">
          <div className="editor-toolbar doc-toolbar">
            {isMobile && (
              <button className="btn btn-sm" onClick={() => setMobileTreeOpen(true)}>
                ☰ Outline
              </button>
            )}
            <button className="btn btn-sm icon-btn-toolbar" title="Bold (Mod-B)" onMouseDown={(e) => e.preventDefault()} onClick={() => run(toggleMark(essaySchema.marks.strong))}>
              <Icon name="bold" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Italic (Mod-I)" onMouseDown={(e) => e.preventDefault()} onClick={() => run(toggleMark(essaySchema.marks.em))}>
              <Icon name="italic" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Underline (Mod-U)" onMouseDown={(e) => e.preventDefault()} onClick={() => run(toggleMark(essaySchema.marks.underline))}>
              <Icon name="underline" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Clear formatting" onMouseDown={(e) => e.preventDefault()} onClick={() => run(clearFormatting)}>
              <Icon name="clear-format" />
            </button>
            <span className="toolbar-divider" />
            <button className="btn btn-sm icon-btn-toolbar" title="Bulleted list" onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrapInList(essaySchema.nodes.bullet_list))}>
              <Icon name="list-ul" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => run(wrapInList(essaySchema.nodes.ordered_list))}>
              <Icon name="list-ol" />
            </button>
            <button
              className="btn btn-sm"
              title="Outdent list item / block"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const view = viewRef.current
                if (!view) return
                const liftItem = liftListItem(essaySchema.nodes.list_item)
                run(liftItem(view.state) ? liftItem : lift)
              }}
            >
              Outdent
            </button>
            <div className="spacer" />
          </div>

          <div className="editor-scroll doc-scroll" ref={docScrollRef}>
            <PMEssayEditor
              essay={essay}
              onViewReady={(view) => {
                viewRef.current = view
              }}
              onViewDestroyed={() => {
                viewRef.current = null
              }}
              onDocChanged={setDoc}
            />
          </div>
        </div>

        {splitEssayId && (
          <div className="split-pane-shell">
            <EssayWorkspace essayId={splitEssayId} embedded onBack={() => setSplitEssayId(null)} />
          </div>
        )}
      </div>

      {mobileTreeOpen && (
        <Modal onClose={() => setMobileTreeOpen(false)}>
          <h2 style={{ marginTop: 0 }}>Outline</h2>
          {doc && (
            <NodeTree
              doc={doc}
              essayTitle={essayTitle}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              onScrollTo={(sectionId) => {
                setMobileTreeOpen(false)
                requestAnimationFrame(() => scrollToNode(sectionId))
              }}
            />
          )}
        </Modal>
      )}

      {showAuthorNote && <AuthorNoteDialog initialValue={essay.authorNote ?? ''} onSave={saveAuthorNote} onClose={() => setShowAuthorNote(false)} />}
      {showSplitPicker && <SplitPickerDialog essay={essay} onClose={() => setShowSplitPicker(false)} onSelectExisting={handleSelectExistingForSplit} onClone={handleCloneForSplit} />}
    </div>
  )
}
