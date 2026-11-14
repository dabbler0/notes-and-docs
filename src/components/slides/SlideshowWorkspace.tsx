import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import 'reveal.js/dist/reveal.css'
import './slideTheme.css'
import { getSlideshow, saveSlideshow } from '../../models/slideshowsRepo'
import { listSources } from '../../models/sourcesRepo'
import { essaySchema } from '../../lib/pmSchema'
import { getAuthorAffiliation, getAuthorName } from '../../lib/authorPreference'
import { insertCitation, insertQuoteBlock, insertQuoteInline, insertSlideBreak, insertFragmentBreak, splitIntoSection } from '../essays/pmCommands'
import { PMEssayEditor } from '../essays/PMEssayEditor'
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
 * mode, history panel, or split view — a slideshow has no comment feature at
 * all, and this first pass has no history/split-view support either.
 */
export function SlideshowWorkspace({ slideshowId, onBack }: { slideshowId: string; onBack: () => void }) {
  const [deck, setDeck] = useState<Slideshow | null>(null)
  const [title, setTitle] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [date, setDate] = useState('')
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

  /** `value`: an `<input type="date">`'s own "YYYY-MM-DD" value, or `''` to clear it back to "no specific date — default to the render date" (see `Slideshow.date`'s own doc comment). */
  async function saveDate(value: string) {
    if (!deck) return
    setDate(value)
    deck.date = value || undefined
    await saveSlideshow(deck)
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

  if (!deck) return <div className="page-pad">Loading…</div>

  return (
    <div className="essay-workspace-root">
      <div className="topbar essay-header" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← <span className="btn-label">All drafts</span>
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
          onClick={() => doc && exportSlideshowPdf(doc, sources.current, title, getAuthorName(), subtitle, { affiliation: includeAffiliation ? getAuthorAffiliation() : undefined, date })}
        >
          ⬇ <span className="btn-label">Export PDF</span>
        </button>
        <button className="btn btn-primary btn-sm" disabled={!doc} onClick={() => setPresenting(true)}>
          ▶ <span className="btn-label">Present</span>
        </button>
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
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          Date
          <input type="date" value={date} onChange={(e) => saveDate((e.target as HTMLInputElement).value)} title="Date shown beneath your name on the title slide — defaults to the render date if left blank" />
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
          deckDate={date}
          onClose={() => setPresenting(false)}
        />
      )}
    </div>
  )
}
