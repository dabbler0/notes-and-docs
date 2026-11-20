import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'
import 'reveal.js/dist/reveal.css'
import './slideTheme.css'
import { cloneSlideshow, getSlideshow, saveSlideshow } from '../../models/slideshowsRepo'
import { listSources } from '../../models/sourcesRepo'
import { essaySchema } from '../../lib/pmSchema'
import { getAuthorAffiliation, getAuthorName } from '../../lib/authorPreference'
import { insertCitation, insertQuoteBlock, insertQuoteInline, insertSlideBreak, insertFragmentBreak, splitIntoSection } from '../essays/pmCommands'
import { PMEssayEditor } from '../essays/PMEssayEditor'
import { FindReplaceDialog } from '../essays/FindReplaceDialog'
import { AuthorNoteDialog } from '../essays/AuthorNoteDialog'
import { SplitPickerDialog } from '../essays/SplitPickerDialog'
import { EssayWorkspace } from '../essays/EssayWorkspace'
import { groupDrafts } from '../../models/projectsRepo'
import type { DraftRef } from '../../models/projectsRepo'
import { SlidePresenter } from './SlidePresenter'
import { exportSlideshowPdf } from './exportSlidesPdf'
import { CitationPickerDialog } from '../essays/CitationPickerDialog'
import { QuoteInsertDialog } from '../essays/QuoteInsertDialog'
import { Icon } from '../Icon'
import type { EditorView } from 'prosemirror-view'
import type { Slideshow, Source } from '../../models/types'

/**
 * The slideshow editing surface — literally the real essay editor
 * (`PMEssayEditor.tsx`) reused directly, per the "slideshow format is a
 * strict extension of the essay format" rewrite: a slideshow's own `doc` is
 * `essaySchema`-shaped, so the same editing surface that works for essays
 * already works for it, plus only two extra toolbar operations (insert
 * slide/fragment divider) that essay's own toolbar doesn't have. No comment
 * mode or history panel — a slideshow has no comment feature at all, and no
 * commit history either. Split view works the same way `EssayWorkspace`'s
 * own does: nesting a workspace (this one, or `EssayWorkspace` — either
 * kind can be the other side of the split) inside `.split-pane-shell`.
 */
export function SlideshowWorkspace({ slideshowId, onBack, embedded = false }: { slideshowId: string; onBack: () => void; embedded?: boolean }) {
  const [deck, setDeck] = useState<Slideshow | null>(null)
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [venue, setVenue] = useState('')
  const [date, setDate] = useState('')
  const [showAuthorNote, setShowAuthorNote] = useState(false)
  // Per-present/-export, not persisted on the deck itself — same "checked
  // fresh each time, not re-asked-for-every-essay" shape
  // `ExportDialog.tsx`'s own `includeAffiliation` state uses. Defaults on:
  // the common case is "yes, show whatever affiliation is configured,"
  // not "no."
  const [includeAffiliation, setIncludeAffiliation] = useState(true)
  // A stable Map *instance*, never replaced — same reason and same shape as
  // `EssayWorkspace.tsx`'s own `sources` ref: the `citation` NodeView closes
  // over this object once, at mount, and only ever re-renders a chip's own
  // label when the *document* changes, not when `sources` does.
  const sources = useRef<Map<string, Source>>(new Map())
  const [doc, setDoc] = useState<PMNode | null>(null)
  const [showCitation, setShowCitation] = useState(false)
  const [showQuoteDialog, setShowQuoteDialog] = useState(false)
  const [presenting, setPresenting] = useState(false)
  const [showFindReplace, setShowFindReplace] = useState(false)
  /** Which draft (essay or slideshow) is open in the split pane, if any — see `EssayWorkspace.tsx`'s own `splitTarget` doc comment. */
  const [splitTarget, setSplitTarget] = useState<{ kind: 'essay' | 'slideshow'; id: string } | null>(null)
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    async function load() {
      const list = await listSources()
      sources.current.clear()
      for (const s of list) sources.current.set(s.id, s)
      const d = await getSlideshow(slideshowId)
      if (!d) return
      setDeck(d)
      setTitle(d.title)
      setSubtitle(d.subtitle ?? '')
      setVenue(d.venue ?? '')
      setDate(d.date ?? '')
    }
    load()
  }, [slideshowId])

  async function saveTitle() {
    if (!deck) return
    deck.title = title
    await saveSlideshow(deck)
  }

  async function saveSubtitle() {
    if (!deck) return
    deck.subtitle = subtitle
    await saveSlideshow(deck)
  }

  /** Commits `venue`'s own current state on blur — same deferred shape `saveSubtitle` uses, rather than writing on every keystroke. */
  async function saveVenue() {
    if (!deck) return
    deck.venue = venue.trim() || undefined
    await saveSlideshow(deck)
  }

  /** `value`: an `<input type="date">`'s own "YYYY-MM-DD" value, or `''` to clear it back to "no specific date — default to the render date" (see `Slideshow.date`'s own doc comment). */
  async function saveDate(value: string) {
    if (!deck) return
    setDate(value)
    deck.date = value || undefined
    await saveSlideshow(deck)
  }

  async function saveAuthorNote(note: string) {
    if (!deck) return
    deck.authorNote = note || undefined
    await saveSlideshow(deck)
    setDeck({ ...deck })
  }

  /** For `view`-taking commands (`insertCitation`, `insertSlideBreak`, …), which already manage focus/selection themselves. */
  function runView(command: (view: EditorView) => void) {
    const view = viewRef.current
    if (!view) return
    command(view)
  }

  /** For plain PM `Command`s (`toggleMark`, `splitIntoSection`, …) — same shape as `EssayWorkspace.tsx`'s own `run`. */
  function runCommand(command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) {
    const view = viewRef.current
    if (!view) return
    command(view.state, view.dispatch)
    view.focus()
  }

  function handleInsertQuoteBlock(source: Source, quote: string, page: number, pageEnd?: number) {
    setShowQuoteDialog(false)
    sources.current.set(source.id, source)
    runView((view) => insertQuoteBlock(view, source, quote, page, pageEnd))
  }

  function handleInsertQuoteInline(source: Source, quote: string, page: number, pageEnd?: number) {
    setShowQuoteDialog(false)
    sources.current.set(source.id, source)
    runView((view) => insertQuoteInline(view, source, quote, page, pageEnd))
  }

  /** "Split view" → `SplitPickerDialog`'s "pick an existing project-mate" option: just opens it side by side, no data touched at all. */
  function handleSelectExistingForSplit(other: DraftRef) {
    setSplitTarget({ kind: other.kind, id: other.item.id })
    setShowSplitPicker(false)
  }

  /** "Split view" → `SplitPickerDialog`'s "Clone this slideshow" option — same shape as `EssayWorkspace.tsx`'s own `handleCloneForSplit`. */
  async function handleCloneForSplit() {
    if (!deck) return
    const clone = await cloneSlideshow(deck.id)
    if (!clone) return
    await groupDrafts({ kind: 'slideshow', item: deck }, { kind: 'slideshow', item: clone })
    setSplitTarget({ kind: 'slideshow', id: clone.id })
    setShowSplitPicker(false)
  }

  if (!deck) return <div className="page-pad">Loading…</div>

  return (
    <div className="essay-workspace-root">
      <div className="topbar essay-header" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          {embedded ? '×' : '←'} <span className="btn-label">{embedded ? 'Close' : 'All drafts'}</span>
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <input
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            onBlur={saveTitle}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: '100%' }}
          />
          <input
            value={subtitle}
            onInput={(e) => setSubtitle((e.target as HTMLInputElement).value)}
            onBlur={saveSubtitle}
            placeholder="Subtitle (optional) — shown under the title on the title slide"
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, color: 'var(--muted)', width: '100%' }}
          />
        </div>
        <button
          className="btn btn-sm"
          disabled={!doc}
          title="Open every slide as its own printable page in a new tab, then open the browser's print dialog — choose “Save as PDF.”"
          onClick={() => doc && exportSlideshowPdf(doc, sources.current, title, getAuthorName(), subtitle, { affiliation: includeAffiliation ? getAuthorAffiliation() : undefined, venue, date, authorNote: deck.authorNote })}
        >
          ⬇ <span className="btn-label">Export PDF</span>
        </button>
        <button className="btn btn-primary btn-sm" disabled={!doc} onClick={() => setPresenting(true)}>
          ▶ <span className="btn-label">Present</span>
        </button>
        {!embedded && (
          <button
            className={`btn btn-ghost btn-sm toolbar-toggle${splitTarget ? ' active' : ''}`}
            title="Edit a second essay or slideshow side by side with this one"
            onClick={() => (splitTarget ? setSplitTarget(null) : setShowSplitPicker(true))}
          >
            <Icon name="subsection" /> <span className="btn-label">{splitTarget ? 'Close split' : 'Split view'}</span>
          </button>
        )}
      </div>

      {/* The title slide's own author-line settings — a specific date
          (persisted on the deck, defaulting to the date of the render
          when left blank — see `Slideshow.date`'s own doc comment) and
          whether to include the globally-configured institutional
          affiliation at all (session-only, same as `ExportDialog.tsx`'s
          own identical checkbox for essays — not every deck by the same
          author necessarily wants it shown). Applies to both Present and
          Export PDF, since both render the exact same title slide. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '8px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {/* Shows the globally-configured author name (lib/authorPreference.ts)
            — not editable in place, just a launcher for the real editable
            field, this deck's own `authorNote` (AuthorNoteDialog). A
            non-blank note gets its own Acknowledgements slide, right before
            References (`slideSerializer.ts`'s own doc comment) — same chip,
            same launcher pattern `EssayWorkspace.tsx` already uses, just
            rendered differently once it actually reaches a slide. */}
        <button className="chip" style={{ border: 'none', cursor: 'pointer' }} title="Thanks/acknowledgements/disclosures — shown on their own Acknowledgements slide, right before References — click to edit" onClick={() => setShowAuthorNote(true)}>
          <Icon name="footnote" size={13} /> {getAuthorName() || 'No author name set'}
        </button>
        {/* Where this was/will be presented (a conference or workshop
            name) — shown right before the date on the title slide
            (Slideshow.venue's own doc comment). */}
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          Venue
          <input
            type="text"
            className="date-pill-input"
            style={{ width: 150 }}
            value={venue}
            onInput={(e) => setVenue((e.target as HTMLInputElement).value)}
            onBlur={saveVenue}
            placeholder="e.g. NeurIPS 2024"
            title="Venue shown right before the date on the title slide"
          />
        </label>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          Date
          <input
            type="date"
            className="date-pill-input"
            value={date}
            onChange={(e) => saveDate((e.target as HTMLInputElement).value)}
            title="Date shown beneath your name on the title slide — defaults to the render date if left blank"
          />
        </label>
        {date && (
          <button className="btn btn-ghost btn-sm" title="Clear — defaults back to the date of the render" onClick={() => saveDate('')}>
            ×
          </button>
        )}
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={includeAffiliation} onChange={(e) => setIncludeAffiliation((e.target as HTMLInputElement).checked)} />
          Include institutional affiliation
        </label>
      </div>

      <div className="workspace">
        <div className="editor-panel">
          <div className="editor-toolbar doc-toolbar">
            <button className="btn btn-sm icon-btn-toolbar" title="Bold (Mod-B)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(essaySchema.marks.strong))}>
              <Icon name="bold" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Italic (Mod-I)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(essaySchema.marks.em))}>
              <Icon name="italic" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Underline (Mod-U)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(essaySchema.marks.underline))}>
              <Icon name="underline" />
            </button>
            <span className="toolbar-divider" />
            <button className="btn btn-sm icon-btn-toolbar" title="Bulleted list" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(wrapInList(essaySchema.nodes.bullet_list))}>
              <Icon name="list-ul" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(wrapInList(essaySchema.nodes.ordered_list))}>
              <Icon name="list-ol" />
            </button>
            <span className="toolbar-divider" />
            <button className="btn btn-sm icon-btn-toolbar" title="Cite a source (Mod-Shift-K)" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowCitation(true)}>
              <Icon name="cite" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Insert a quote from a source" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowQuoteDialog(true)}>
              <Icon name="quote" />
            </button>
            <span className="toolbar-divider" />
            <button
              className="btn btn-sm icon-btn-toolbar"
              title="New (sub)section (Mod-Shift-Enter): with text selected, promotes it into a subsection; with nothing selected, inserts a new empty one at the cursor"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runCommand(splitIntoSection)}
            >
              <Icon name="outline" /> <span className="btn-label">Section</span>
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Slide change" onMouseDown={(e) => e.preventDefault()} onClick={() => runView((view) => insertSlideBreak(view))}>
              <Icon name="subsection" /> <span className="btn-label">Slide</span>
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Fragmented reveal" onMouseDown={(e) => e.preventDefault()} onClick={() => runView((view) => insertFragmentBreak(view))}>
              <span className="btn-label">⋯ Fragment</span>
            </button>
            <div className="spacer" />
            <button className="btn btn-sm icon-btn-toolbar" title="Find & replace" onClick={() => setShowFindReplace(true)}>
              <Icon name="search" />
            </button>
          </div>

          <div className="editor-scroll doc-scroll">
            <PMEssayEditor
              key={deck.id}
              record={deck}
              sources={sources.current}
              onCiteShortcut={() => setShowCitation(true)}
              onSave={(r) => saveSlideshow(r as Slideshow)}
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

        {splitTarget && (
          <div className="split-pane-shell">
            {splitTarget.kind === 'slideshow' ? (
              <SlideshowWorkspace slideshowId={splitTarget.id} embedded onBack={() => setSplitTarget(null)} />
            ) : (
              <EssayWorkspace essayId={splitTarget.id} embedded onBack={() => setSplitTarget(null)} />
            )}
          </div>
        )}
      </div>

      {showCitation && (
        <CitationPickerDialog
          onClose={() => setShowCitation(false)}
          onSelect={(source, note) => {
            setShowCitation(false)
            sources.current.set(source.id, source)
            runView((view) => insertCitation(view, source, note))
          }}
        />
      )}

      {showQuoteDialog && <QuoteInsertDialog onClose={() => setShowQuoteDialog(false)} onInsertBlock={handleInsertQuoteBlock} onInsertInline={handleInsertQuoteInline} />}

      {presenting && doc && (
        <SlidePresenter
          doc={doc}
          sources={sources.current}
          deckTitle={title}
          deckSubtitle={subtitle}
          authorName={getAuthorName()}
          deckAffiliation={includeAffiliation ? getAuthorAffiliation() : undefined}
          deckVenue={venue}
          deckDate={date}
          deckAuthorNote={deck.authorNote}
          onClose={() => setPresenting(false)}
        />
      )}
      {showFindReplace && viewRef.current && <FindReplaceDialog view={viewRef.current} onClose={() => setShowFindReplace(false)} />}
      {showSplitPicker && (
        <SplitPickerDialog draft={{ kind: 'slideshow', item: deck }} onClose={() => setShowSplitPicker(false)} onSelectExisting={handleSelectExistingForSplit} onClone={handleCloneForSplit} />
      )}
      {showAuthorNote && (
        <AuthorNoteDialog
          initialValue={deck.authorNote ?? ''}
          description="Thanks, acknowledgements, or disclosures for this deck — shown on their own Acknowledgements slide, right before References. Leave blank for no such slide."
          onSave={saveAuthorNote}
          onClose={() => setShowAuthorNote(false)}
        />
      )}
    </div>
  )
}
