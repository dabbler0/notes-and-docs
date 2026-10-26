import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { toggleMark, lift } from 'prosemirror-commands'
import { wrapInList, liftListItem } from 'prosemirror-schema-list'
import type { EditorState, Transaction } from 'prosemirror-state'
import { cloneEssay, getEssay, saveEssay } from '../../models/essaysRepo'
import { groupEssays } from '../../models/projectsRepo'
import { listSources } from '../../models/sourcesRepo'
import { addToGraveyard } from '../../models/graveyardRepo'
import { addEssayComment, findEssayCommentById } from '../../models/essayCommentsRepo'
import { deleteEssayComment, promoteEssayComment, toggleEssayCommentDisplayMode } from './essayCommentActions'
import { essaySchema } from '../../lib/pmSchema'
import { displayTitle } from '../../lib/bibtex'
import { confirmDialog } from '../../lib/confirm'
import { promptDialog } from '../../lib/prompt'
import { commitPmEssay } from '../../models/essayHistoryRepo'
import type { Essay, Source } from '../../models/types'
import { Icon } from '../Icon'
import { PMEssayEditor } from './PMEssayEditor'
import { NodeTree } from './NodeTree'
import { AuthorNoteDialog } from './AuthorNoteDialog'
import { SplitPickerDialog } from './SplitPickerDialog'
import { CitationPickerDialog } from './CitationPickerDialog'
import { QuoteInsertDialog } from './QuoteInsertDialog'
import { CommentsPanel, CommentCard } from './CommentsPanel'
import { GraveyardPanel } from './GraveyardPanel'
import { ExportDialog } from './ExportDialog'
import { WordCountDialog } from './WordCountDialog'
import { EssayHistoryPanel } from './EssayHistoryPanel'
import {
  insertCitation,
  insertQuoteBlock,
  insertQuoteInline,
  insertSourceLink,
  splitIntoSection,
  demoteSection,
  sliceToHtml,
  toggleSectionCollapsed,
  findEnclosingSection,
  insertCommentAnchorMark,
  removeCommentAnchorMark,
  insertFootnote,
} from './pmCommands'
import { Modal } from '../Modal'
import { useIsMobile } from '../../lib/useIsMobile'
import { id } from '../../lib/id'

/**
 * The whole essay as one continuous, real ProseMirror document — see
 * `PMEssayEditor.tsx`'s own doc comment for the editing surface itself.
 *
 * **Stage B2 of the ProseMirror migration's UI swap**: citations, quotes,
 * source links, and structural editing (split into subsection / demote)
 * are back, via `pmCommands.ts`'s own PM-native transactions rather than
 * the old DOM-surgery those used to need. Still deliberately missing:
 * footnotes, comments (margin and inline), export, word count, commit/
 * history — later stages of the same migration (see the
 * `claude/prosemirror-migration` branch's own plan). Nothing here is a
 * permanent regression; it's staged work on this branch.
 *
 * Split-screen works the same way it always has: nesting this same
 * component inside itself (see `splitEssayId`) rather than a separate
 * stripped-down renderer.
 */
export function EssayWorkspace({ essayId, onBack, embedded = false }: { essayId: string; onBack: () => void; embedded?: boolean }) {
  const [essay, setEssay] = useState<Essay | null>(null)
  const [essayTitle, setEssayTitle] = useState('')
  const [doc, setDoc] = useState<PMNode | null>(null)
  // A stable Map *instance*, never replaced — `PMEssayEditor`'s `citation`
  // NodeView (`pmNodeViews.ts`'s `createCitationView`) closes over this
  // exact object once, when its `EditorView` mounts (keyed only on
  // `essay.id`, not on this prop), so a fresh `new Map(...)` here would
  // leave every citation's NodeView looking at a stale, often-empty
  // snapshot forever after. `reload()` and the insert-citation/quote/link
  // handlers below all mutate it in place for exactly this reason.
  const sources = useRef<Map<string, Source>>(new Map()).current
  // Same "stable container, never replaced" shape as `sources` above —
  // `pmCommentPlugin.ts`'s own inline-preview decorations close over this
  // once, at `EditorView` mount, and need `essay.comments` fresh on every
  // rebuild rather than whatever it was back then. Kept in sync below
  // (plain assignment during render, not an effect — see that line's own
  // comment).
  const commentsHolder = useRef<Essay | null>(null)
  commentsHolder.current = essay
  const [splitEssayId, setSplitEssayId] = useState<string | null>(null)
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  const [showTree, setShowTree] = useState(true)
  const isMobile = useIsMobile()
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false)
  const [showAuthorNote, setShowAuthorNote] = useState(false)
  const [showCitation, setShowCitation] = useState(false)
  const [showQuoteDialog, setShowQuoteDialog] = useState(false)
  const [showLink, setShowLink] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showWordCount, setShowWordCount] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  /** Bumped only by a revert (`EssayHistoryPanel`'s own `onReverted`) — passed as `PMEssayEditor`'s own `key` so a revert's rewrite of `essay.doc` (done directly in storage, never through a transaction on the *live* `EditorView`) actually forces a fresh mount reading the new content, instead of leaving the live editor silently showing its own stale, pre-revert in-memory document. Ordinary typing already updates the live doc through the editor's own transactions, so nothing there needs this — only an external rewrite does. */
  const [docGeneration, setDocGeneration] = useState(0)
  /** Both captured by the Word Count button's own `onMouseDown` (before its `onClick` would otherwise collapse the live selection, or move focus away from wherever the cursor actually was) — see `WordCountDialog.tsx`'s own doc comment. */
  const [selectedTextForWordCount, setSelectedTextForWordCount] = useState('')
  const [activeSectionForWordCount, setActiveSectionForWordCount] = useState<PMNode | null>(null)
  const [commentMode, setCommentMode] = useState(false)
  const [rightPanel, setRightPanel] = useState<'comments' | 'graveyard' | null>('comments')
  const [mobilePanel, setMobilePanel] = useState<'comments' | 'graveyard' | null>(null)
  /** The toolbar's "Comment" button, or selecting text while comment mode is on, opened a composer right here — not yet a real `Comment` until `submitComment` records it; see `beginComment`'s own doc comment. */
  const [pendingComment, setPendingComment] = useState<{
    commentId: string
    sectionId: string | null
    text: string
    displayMode: 'margin' | 'inline'
    anchorRect: { top: number; bottom: number; left: number; right: number }
  } | null>(null)
  /** Which inline-displayed top-level comment, if any, has its full `CommentCard` editor popped open as a floating popover right now — see `pmCommentPlugin.ts`'s own doc comment for why the editor lives here, in ordinary Preact state, rather than mounted inside the PM decoration itself. */
  const [openInlineComment, setOpenInlineComment] = useState<{ id: string; rect: { top: number; bottom: number; left: number; right: number } } | null>(null)
  const commentWidgetRef = useRef<HTMLDivElement>(null)

  const viewRef = useRef<EditorView | null>(null)
  const docScrollRef = useRef<HTMLDivElement>(null)

  async function reload() {
    const e = await getEssay(essayId)
    if (!e) return
    setEssay(e)
    setEssayTitle(e.title)
    const list = await listSources()
    sources.clear()
    for (const s of list) sources.set(s.id, s)
  }

  useEffect(() => {
    reload()
  }, [essayId])

  // Dismiss the pending comment composer on an outside click, same as any
  // other popover in this app.
  useEffect(() => {
    if (!pendingComment) return
    function onDocDown(e: MouseEvent) {
      if (commentWidgetRef.current && !commentWidgetRef.current.contains(e.target as Node)) {
        cancelPendingComment()
      }
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingComment])

  /**
   * Notifies everything that reads `essay.comments` — the margin panel
   * (ordinary Preact re-render, via `setEssay`) and the document's own
   * inline-preview chips (`pmCommentPlugin.ts`, which only rebuilds its
   * decorations in response to a PM transaction) — that a comment was
   * added, edited, resolved, or deleted. `essay` itself was already
   * mutated in place by whichever `essayCommentsRepo.ts` call just ran
   * (same "same object, new shallow clone to force a re-render" shape
   * `saveAuthorNote` already uses); the empty `view.dispatch(view.state.tr)`
   * is a no-op transaction whose only job is making the comment plugin's
   * own `apply` re-run (see that file's own doc comment).
   */
  function notifyCommentsChanged() {
    setEssay((e) => (e ? { ...e } : e))
    const view = viewRef.current
    if (view) view.dispatch(view.state.tr)
  }

  /**
   * The toolbar's "Comment" button — the primary way to add a comment,
   * usable whether or not comment mode is on (comment mode isn't the only
   * way to add one). Highlighted text opens the ordinary margin composer,
   * same as selecting text in comment mode does (`handleMouseUpForComments`
   * below, which just calls this once there's a real selection). Nothing
   * highlighted creates an *inline* comment instead, anchored to a
   * zero-width mark right at the cursor — see `Comment.displayMode`'s own
   * doc comment, and `insertCommentAnchorMark`'s own for why that needs a
   * placeholder character at all.
   */
  function beginComment() {
    const view = viewRef.current
    if (!view) {
      alert('Click into the document first.')
      return
    }
    const wasEmpty = view.state.selection.empty
    const commentId = id()
    const { anchorText, sectionId, pos } = insertCommentAnchorMark(view, commentId)
    const displayMode: 'margin' | 'inline' = wasEmpty ? 'inline' : 'margin'
    const coords = view.coordsAtPos(pos)
    setPendingComment({ commentId, sectionId, text: anchorText, displayMode, anchorRect: coords })
  }

  /** Selecting text while in comment mode opens the same comment composer the toolbar's own "Comment" button does — this is just the mouseup-triggered shortcut for it that only applies while comment mode is on, and only for a real (non-collapsed) selection. */
  function handleMouseUpForComments() {
    if (!commentMode) return
    const view = viewRef.current
    if (!view || view.state.selection.empty) return
    beginComment()
  }

  /**
   * Undoes `beginComment`'s own `insertCommentAnchorMark` without ever
   * saving anything — the mark (and, for a zero-width anchor, its
   * placeholder character) only ever lived in the live, uncommitted
   * document, so removing it here is enough; there's nothing persisted
   * yet for a cancel to need to clean up in storage. Shared by the
   * composer's own Cancel button and a click outside the widget.
   */
  function cancelPendingComment() {
    if (pendingComment) {
      const view = viewRef.current
      if (view) removeCommentAnchorMark(view, pendingComment.commentId)
    }
    setPendingComment(null)
  }

  async function submitComment(body: string) {
    if (!pendingComment || !essay) return
    await addEssayComment(essay, {
      anchorKind: 'text',
      anchorText: pendingComment.text,
      body,
      commentId: pendingComment.commentId,
      displayMode: pendingComment.displayMode,
      sectionId: pendingComment.sectionId,
    })
    setPendingComment(null)
    notifyCommentsChanged()
  }

  /**
   * Routes a click on either kind of comment anchor in the document — a
   * margin comment's own `comment-anchor` highlight, or an inline
   * comment's small preview chip (both via `pmCommentPlugin.ts`'s one
   * shared `handleClick`). An inline-displayed top-level comment toggles
   * its own floating popover open/closed, positioned off the chip that
   * was actually clicked; anything else (a margin comment's highlight)
   * just scrolls its card into view — there's no separate "open" state
   * for a margin card, since it's already visible in the panel.
   */
  function handleAnchorClick(commentId: string) {
    if (!essay) return
    const comment = findEssayCommentById(essay, commentId)
    if (comment && comment.parentId === null && comment.anchorKind === 'text' && comment.displayMode === 'inline') {
      if (openInlineComment?.id === commentId) {
        setOpenInlineComment(null)
        return
      }
      const el = document.querySelector(`.inline-comment-preview[data-comment-id="${cssEscape(commentId)}"]`) as HTMLElement | null
      const rect = el?.getBoundingClientRect()
      setOpenInlineComment({ id: commentId, rect: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : { top: 100, bottom: 100, left: 100, right: 100 } })
      return
    }
    document.querySelector(`comment-anchor[data-comment-id="${cssEscape(commentId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  async function handleDeleteOpenInlineComment(commentId: string) {
    if (!essay) return
    if (!(await confirmDialog('Delete this comment, and everything replied or commented on it?', { confirmLabel: 'Delete', danger: true }))) return
    await deleteEssayComment(essay, viewRef.current, commentId)
    setOpenInlineComment(null)
    notifyCommentsChanged()
  }

  async function handleToggleOpenInlineDisplayMode(commentId: string, target: 'margin' | 'inline') {
    if (!essay) return
    await toggleEssayCommentDisplayMode(essay, commentId, target)
    setOpenInlineComment(null)
    notifyCommentsChanged()
  }

  async function handlePromoteOpenInlineComment(commentId: string) {
    if (!essay) return
    await promoteEssayComment(essay, viewRef.current, commentId)
    setOpenInlineComment(null)
    notifyCommentsChanged()
  }

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

  function handleInsertCitation(source: Source, note?: string) {
    setShowCitation(false)
    sources.set(source.id, source)
    const view = viewRef.current
    if (view) insertCitation(view, source, note)
  }

  function handleInsertQuoteBlock(source: Source, quote: string, page: number) {
    setShowQuoteDialog(false)
    sources.set(source.id, source)
    const view = viewRef.current
    if (view) insertQuoteBlock(view, source, quote, page)
  }

  function handleInsertQuoteInline(source: Source, quote: string, page: number) {
    setShowQuoteDialog(false)
    sources.set(source.id, source)
    const view = viewRef.current
    if (view) insertQuoteInline(view, source, quote, page)
  }

  function handleInsertSourceLink(source: Source) {
    setShowLink(false)
    const view = viewRef.current
    if (!view) return
    if (!source.bibtex.fields.url) {
      alert('This source has no URL — add one from the Sources tab, or pick a different source.')
      return
    }
    sources.set(source.id, source)
    const { selection } = view.state
    const linkText = selection.empty ? displayTitle(source.bibtex) : view.state.doc.textBetween(selection.from, selection.to)
    insertSourceLink(view, source, linkText)
  }

  /**
   * "Send to graveyard": cuts the current selection out of the document —
   * same as a delete — but keeps it, serialized to HTML via the schema's
   * own `toDOM` (`sliceToHtml`), in a fragment attached to this essay
   * instead of discarding it. `GraveyardFragment`'s own `nodeId`/
   * `nodeTitle` are a best-effort "where this came from" reference (never
   * dereferenced structurally — see that type's own doc comment) — the
   * enclosing `section`'s own id/title stand in for the old per-node
   * reference now that there's no node tree to point into.
   */
  async function sendSelectionToGraveyard() {
    const view = viewRef.current
    if (!view || !essay) return
    const { from, to, empty, $from } = view.state.selection
    if (empty) {
      alert('Select some text in the document first.')
      return
    }
    const slice = view.state.doc.slice(from, to)
    const html = sliceToHtml(slice)
    if (!html.trim()) return
    const section = findEnclosingSection($from)
    view.dispatch(view.state.tr.deleteSelection())
    await addToGraveyard(essay.id, section?.id ?? essay.rootNodeId, section?.title ?? essayTitle, html)
  }

  /**
   * Freezes the essay's current full state (`essay.doc`/`essay.comments` —
   * see `buildPmSnapshot` in `essayHistoryRepo.ts`) as a new entry in its
   * commit history, prompting for an optional label first. A no-op commit
   * (nothing's changed since the last one) is reported rather than
   * silently added as a pointless empty diff — see `commitPmEssay`'s own
   * doc comment. Opens the History panel afterward so a successful commit
   * is immediately visible.
   */
  async function handleCommit() {
    if (!essay) return
    const label = await promptDialog('Label for this commit? (optional)', { placeholder: 'e.g. "First full draft"' })
    if (label === null) return
    const commit = await commitPmEssay(essay, label.trim() || undefined)
    if (!commit) {
      alert('Nothing to commit — no changes since the last commit.')
      return
    }
    setShowHistory(true)
  }

  /** "Split view" → `SplitPickerDialog`'s "pick an existing project-mate" option: just opens it side by side, no data touched at all. */
  function handleSelectExistingForSplit(other: Essay) {
    setSplitEssayId(other.id)
    setShowSplitPicker(false)
  }

  /** "Split view" → `SplitPickerDialog`'s "Clone this essay" option — `cloneEssay` now branches on `essay.doc` presence itself (see its own doc comment in `essaysRepo.ts`), so this needs no PM-specific handling of its own beyond what the old model's version already did. */
  async function handleCloneForSplit() {
    if (!essay) return
    const clone = await cloneEssay(essay.id)
    if (!clone) return
    await groupEssays(essay, clone)
    setSplitEssayId(clone.id)
    setShowSplitPicker(false)
  }

  function scrollToNode(sectionId: string) {
    document.querySelector(`[data-section-id="${sectionId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function toggleCollapse(id: string) {
    const view = viewRef.current
    if (view) toggleSectionCollapsed(view, id)
  }

  if (!essay || !essay.doc) return <div className="page-pad">Loading…</div>

  const openInlineCommentRecord = openInlineComment ? findEssayCommentById(essay, openInlineComment.id) : undefined

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
        <button
          className={`btn btn-ghost btn-sm toolbar-toggle${commentMode ? ' active' : ''}`}
          title="Comment mode: a closer-to-print reading view, with editing off but selecting text to comment on still on"
          onClick={() => setCommentMode((v) => !v)}
        >
          <Icon name="comment" /> <span className="btn-label">{commentMode ? 'Commenting…' : 'Comment mode'}</span>
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowExport(true)}>
          <Icon name="export" /> <span className="btn-label">Export</span>
        </button>
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
              {doc && <NodeTree doc={doc} essayTitle={essayTitle} onToggleCollapse={toggleCollapse} onScrollTo={scrollToNode} />}
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
              <>
                <button className="btn btn-sm icon-btn-toolbar" title="Outline" onClick={() => setMobileTreeOpen(true)}>
                  <Icon name="outline" /> <span className="btn-label">Outline</span>
                </button>
                <button className="btn btn-sm icon-btn-toolbar" title="Comments" onClick={() => setMobilePanel('comments')}>
                  <Icon name="comment" /> <span className="btn-label">Comments</span>
                </button>
                <button className="btn btn-sm icon-btn-toolbar" title="Graveyard" onClick={() => setMobilePanel('graveyard')}>
                  <Icon name="graveyard" /> <span className="btn-label">Graveyard</span>
                </button>
              </>
            )}
            {/* Unlike every button below, this one works whether or not
                comment mode is on — comment mode isn't the only way to add
                a comment (see `beginComment`'s own doc comment). */}
            <button className="btn btn-sm icon-btn-toolbar" title="Add a comment on the current selection, or an inline one at the cursor if nothing's selected" onMouseDown={(e) => e.preventDefault()} onClick={beginComment}>
              <Icon name="comment" />
            </button>
            {/* Comment mode reads close to a print view — nearly every
                text-editing affordance below only applies to a live draft,
                so they're hidden rather than just disabled while
                commenting (selecting text to comment on still works fully
                — see PMEssayEditor's own dynamic `editable`). */}
            {!commentMode && (
              <>
                <span className="toolbar-divider" />
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
                  className="btn btn-sm icon-btn-toolbar"
                  title="Outdent list item / block"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const view = viewRef.current
                    if (!view) return
                    const liftItem = liftListItem(essaySchema.nodes.list_item)
                    run(liftItem(view.state) ? liftItem : lift)
                  }}
                >
                  <Icon name="outdent" />
                </button>
                <span className="toolbar-divider" />
                <button className="btn btn-sm icon-btn-toolbar" title="Cite a source" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowCitation(true)}>
                  <Icon name="cite" />
                </button>
                <button className="btn btn-sm icon-btn-toolbar" title="Insert a quote from a source" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowQuoteDialog(true)}>
                  <Icon name="quote" />
                </button>
                <button className="btn btn-sm icon-btn-toolbar" title="Link to a source" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowLink(true)}>
                  <Icon name="link" />
                </button>
                <span className="toolbar-divider" />
                <button className="btn btn-sm icon-btn-toolbar" title="Split selection into subsection" onMouseDown={(e) => e.preventDefault()} onClick={() => run(splitIntoSection)}>
                  <Icon name="subsection" />
                </button>
                <button className="btn btn-sm icon-btn-toolbar" title="Demote: fold the current section back into its parent" onMouseDown={(e) => e.preventDefault()} onClick={() => run(demoteSection)}>
                  <Icon name="demote" />
                </button>
                <button
                  className="btn btn-sm icon-btn-toolbar"
                  title="Insert footnote"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const view = viewRef.current
                    if (view) insertFootnote(view)
                  }}
                >
                  <Icon name="footnote" />
                </button>
                <span className="toolbar-divider" />
                <button className="btn btn-sm icon-btn-toolbar" title="Send selection to the graveyard" onMouseDown={(e) => e.preventDefault()} onClick={sendSelectionToGraveyard}>
                  <Icon name="graveyard" />
                </button>
              </>
            )}
            <div className="spacer" />
            <button
              className="btn btn-sm icon-btn-toolbar"
              title="Word count"
              onMouseDown={(e) => {
                e.preventDefault()
                const view = viewRef.current
                setSelectedTextForWordCount(view && !view.state.selection.empty ? view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, ' ') : '')
                setActiveSectionForWordCount(view ? (findEnclosingSection(view.state.selection.$from)?.node ?? null) : null)
              }}
              onClick={() => setShowWordCount(true)}
            >
              <Icon name="word-count" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Commit: save the current state as a point you can come back to later" onClick={handleCommit}>
              <Icon name="commit" />
            </button>
            <div style={{ position: 'relative' }}>
              <button className={`btn btn-sm icon-btn-toolbar toolbar-toggle${showHistory ? ' active' : ''}`} title="Commit history" onClick={() => setShowHistory((v) => !v)}>
                <Icon name="history" />
              </button>
              {showHistory && essay && (
                <EssayHistoryPanel
                  essay={essay}
                  doc={doc}
                  sources={sources}
                  onReverted={() => {
                    setShowHistory(false)
                    setDocGeneration((g) => g + 1)
                    reload()
                  }}
                  onClose={() => setShowHistory(false)}
                />
              )}
            </div>
          </div>

          <div className={`editor-scroll doc-scroll${commentMode ? ' comment-mode' : ''}`} ref={docScrollRef} onMouseUp={handleMouseUpForComments}>
            <PMEssayEditor
              key={docGeneration}
              essay={essay}
              sources={sources}
              commentsHolder={commentsHolder}
              onAnchorClick={handleAnchorClick}
              editable={!commentMode}
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

        {!isMobile &&
          !embedded &&
          !splitEssayId &&
          (rightPanel ? (
            <div className="comments-panel-shell">
              <div className="right-panel-tabs">
                <button className={`right-panel-tab${rightPanel === 'comments' ? ' active' : ''}`} title="Comments" onClick={() => setRightPanel('comments')}>
                  <Icon name="comment" />
                </button>
                <button className={`right-panel-tab${rightPanel === 'graveyard' ? ' active' : ''}`} title="Graveyard" onClick={() => setRightPanel('graveyard')}>
                  <Icon name="graveyard" />
                </button>
                <div className="spacer" />
                <button className="btn btn-ghost btn-sm" onClick={() => setRightPanel(null)} title="Collapse panel">
                  ›
                </button>
              </div>
              {rightPanel === 'comments' ? (
                doc && <CommentsPanel doc={doc} essay={essay} essayTitle={essayTitle} view={viewRef.current} onChanged={notifyCommentsChanged} scrollRef={docScrollRef} />
              ) : (
                <GraveyardPanel essayId={essay.id} />
              )}
            </div>
          ) : (
            <button className="panel-edge-tab right" onClick={() => setRightPanel('comments')} title="Show panel">
              ‹
            </button>
          ))}
      </div>

      {mobileTreeOpen && (
        <Modal onClose={() => setMobileTreeOpen(false)}>
          <h2 style={{ marginTop: 0 }}>Outline</h2>
          {doc && (
            <NodeTree
              doc={doc}
              essayTitle={essayTitle}
              onToggleCollapse={toggleCollapse}
              onScrollTo={(sectionId) => {
                setMobileTreeOpen(false)
                requestAnimationFrame(() => scrollToNode(sectionId))
              }}
            />
          )}
        </Modal>
      )}

      {mobilePanel && (
        <Modal onClose={() => setMobilePanel(null)}>
          <div className="tab-row">
            <button className={`btn btn-sm${mobilePanel === 'comments' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setMobilePanel('comments')}>
              <Icon name="comment" /> Comments
            </button>
            <button className={`btn btn-sm${mobilePanel === 'graveyard' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setMobilePanel('graveyard')}>
              <Icon name="graveyard" /> Graveyard
            </button>
          </div>
          {mobilePanel === 'comments' ? (
            doc && (
              <CommentsPanel
                doc={doc}
                essay={essay}
                essayTitle={essayTitle}
                view={viewRef.current}
                onChanged={notifyCommentsChanged}
                scrollRef={docScrollRef}
                mode="list"
                onJumpTo={(sectionId) => {
                  setMobilePanel(null)
                  requestAnimationFrame(() => scrollToNode(sectionId))
                }}
              />
            )
          ) : (
            <GraveyardPanel essayId={essay.id} mode="list" />
          )}
        </Modal>
      )}

      {pendingComment && (
        <div ref={commentWidgetRef} className="comment-widget" style={commentWidgetStyle(pendingComment.anchorRect)}>
          <p className="comment-widget-quote">{pendingComment.text ? `“${pendingComment.text}”` : 'New inline comment, right here'}</p>
          <CommentComposer onCancel={cancelPendingComment} onSubmit={submitComment} />
        </div>
      )}

      {openInlineComment && openInlineCommentRecord && (
        <div className="inline-comment-editor inline-comment-popover" style={commentWidgetStyle(openInlineComment.rect)}>
          <CommentCard
            essay={essay}
            comment={openInlineCommentRecord}
            depth={0}
            onChanged={notifyCommentsChanged}
            onDelete={handleDeleteOpenInlineComment}
            onToggleDisplayMode={handleToggleOpenInlineDisplayMode}
            onPromote={handlePromoteOpenInlineComment}
          />
          <div className="inline-comment-collapse">
            <button className="btn btn-ghost btn-sm" onClick={() => setOpenInlineComment(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {showAuthorNote && <AuthorNoteDialog initialValue={essay.authorNote ?? ''} onSave={saveAuthorNote} onClose={() => setShowAuthorNote(false)} />}
      {showSplitPicker && <SplitPickerDialog essay={essay} onClose={() => setShowSplitPicker(false)} onSelectExisting={handleSelectExistingForSplit} onClone={handleCloneForSplit} />}
      {showCitation && <CitationPickerDialog onClose={() => setShowCitation(false)} onSelect={handleInsertCitation} />}
      {showQuoteDialog && <QuoteInsertDialog onClose={() => setShowQuoteDialog(false)} onInsertBlock={handleInsertQuoteBlock} onInsertInline={handleInsertQuoteInline} />}
      {showLink && <CitationPickerDialog title="Link to a source" requireUrl onClose={() => setShowLink(false)} onSelect={handleInsertSourceLink} />}
      {showExport && <ExportDialog essay={essay} doc={doc} onClose={() => setShowExport(false)} />}
      {showWordCount && doc && (
        <WordCountDialog doc={doc} activeSection={activeSectionForWordCount} selectedText={selectedTextForWordCount} onClose={() => setShowWordCount(false)} />
      )}
    </div>
  )
}

function CommentComposer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  // The `autoFocus` attribute alone isn't reliable here — this textarea
  // mounts in response to a click on a toolbar button that itself just
  // took focus, and the dynamic-autofocus path browsers support for an
  // element inserted after initial page load doesn't always win that race.
  // An explicit focus() on mount, the same fix PromptDialog.tsx already
  // uses for its own input, works regardless.
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])
  return (
    <>
      <div className="field">
        <textarea
          ref={textareaRef}
          rows={3}
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
          }}
        />
      </div>
      <div className="comment-widget-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>
          Add comment
        </button>
      </div>
    </>
  )
}

/**
 * Positions a comment widget (the pending-comment composer, or an open
 * inline comment's own popover) just below the anchor it belongs to,
 * clamped so it never runs off the right or bottom edge of the viewport —
 * `anchorRect` is already in viewport (not document) coordinates (either
 * `view.coordsAtPos`'s own return shape, or a plain `getBoundingClientRect()`),
 * so `position: fixed` is what we want here.
 */
function commentWidgetStyle(rect: { top: number; bottom: number; left: number; right: number }) {
  const margin = 12
  const width = Math.min(320, window.innerWidth - margin * 2)
  const maxLeft = Math.max(margin, window.innerWidth - width - margin)
  const left = Math.min(Math.max(rect.left, margin), maxLeft)
  const spaceBelow = window.innerHeight - rect.bottom
  const openUpward = spaceBelow < 220 && rect.top > 220
  const style: Record<string, string> = {
    position: 'fixed',
    left: `${left}px`,
    width: `${width}px`,
  }
  if (openUpward) {
    style.bottom = `${window.innerHeight - rect.top + 8}px`
  } else {
    style.top = `${rect.bottom + 8}px`
  }
  return style
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}
