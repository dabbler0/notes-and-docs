import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { commentIdsInContent, commitNewVersion, deleteFootnote, deleteNodeOnly, headVersion, nodeComments, nodeFootnotes, revertToVersion, saveNode, updateFootnoteContent } from '../../models/essaysRepo'
import { parseSegments, reconstructContent } from '../../lib/childMarkers'
import { FrozenPreview } from './FrozenPreview'
import type { EssayNode, Footnote, NodeVersion } from '../../models/types'

const HEADING_SIZES = [21, 18, 16.5, 15, 14.5]
function headingSize(depth: number) {
  return HEADING_SIZES[Math.min(depth, HEADING_SIZES.length - 1)]
}

export function SectionBlock({
  node,
  nodeMap,
  depth,
  isRoot,
  collapsed,
  onToggleCollapse,
  onActivate,
  onCaptureRange,
  onDemote,
  onTitleChanged,
  focusTitleId,
  onTitleFocused,
  focusFootnoteId,
  onFootnoteFocused,
  commentMode = false,
}: {
  node: EssayNode
  nodeMap: Map<string, EssayNode>
  depth: number
  isRoot: boolean
  collapsed: Set<string>
  onToggleCollapse: (id: string) => void
  onActivate: (nodeId: string, el: HTMLDivElement) => void
  onCaptureRange: () => void
  /** Present only when this block is someone's child — collapses it back into that parent's own text. */
  onDemote?: () => void
  onTitleChanged: () => void
  focusTitleId: string | null
  onTitleFocused: () => void
  /** Id of a footnote just created by the "Insert footnote" toolbar action, so its own (freshly empty) body can be focused for typing immediately — same idea as focusTitleId for a just-split subsection's title. */
  focusFootnoteId: string | null
  onFootnoteFocused: () => void
  /** True while the document-wide "Comment mode" toggle is on — see EssayWorkspace.tsx. Turns editing off (contentEditable, title renamed, per-section version/history/demote controls) so the document reads close to a print view; selecting text to comment on still works normally either way. */
  commentMode?: boolean
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const [title, setTitle] = useState(node.title)
  const head = headVersion(node)
  const [dirty, setDirty] = useState(node.draftContent !== head.content)
  // Set right after clicking the version number: the id of the version we
  // just froze the old content into, which the editor now shows side by
  // side with this node's (freshly emptied) live editing surface. Local UI
  // state only — closing it just stops showing the comparison, it doesn't
  // change any data.
  const [comparingVersionId, setComparingVersionId] = useState<string | null>(null)
  // Full version history list, opened from the 🕓 button — separate from
  // comparingVersionId itself, since browsing history shouldn't have to
  // also mean "freeze the current text and clear this section," the way
  // clicking the version pill does.
  const [showHistory, setShowHistory] = useState(false)

  // Recomputed whenever the node's own saved content changes (switching to
  // a different node, or an external mutation like a version revert). Not
  // recomputed on every keystroke — typing mutates the shard DOM directly,
  // and is only reflected back into node.draftContent by scheduleSave.
  const segments = useMemo(() => parseSegments(node.draftContent), [node.id, node.draftContent])

  // Tracks *which exact node object* (by reference, not just id/content) the
  // shard DOM was last written from. A reload() always hands SectionBlock a
  // freshly-fetched node object — even when its content string happens to
  // match one we already pushed to the DOM ourselves (e.g. right after a
  // demote, which reshapes segments and can leave freshly (re)mounted shard
  // elements empty) — so comparing object identity, not just the content
  // string, is what makes sure a real structural change always gets synced
  // while ordinary typing (same object, mutated in place) doesn't.
  const syncedContent = useRef<{ node: EssayNode | null; html: string }>({ node: null, html: '' })
  const isCollapsed = collapsed.has(node.id)

  useEffect(() => {
    setTitle(node.title)
  }, [node.id, node.title])

  useEffect(() => {
    setComparingVersionId(null)
    setShowHistory(false)
  }, [node.id])

  // Comparing/reverting versions is itself an editing action, out of place
  // once the document is meant to read like a print view — close out of
  // it automatically rather than leaving a stale compare view up.
  useEffect(() => {
    if (commentMode) setComparingVersionId(null)
  }, [commentMode])

  // Push the freshly-parsed segments' text into their shard DOM elements,
  // but only when the node's saved content actually changed underneath us
  // (not on every render) — otherwise this would stomp on in-progress
  // typing every time an unrelated bit of state changes elsewhere.
  //
  // Any insert-a-citation/quote/footnote/link action ends with a reload()
  // (see EssayWorkspace.tsx), which hands every SectionBlock a freshly
  // *refetched* node object — a different reference even when its content
  // string hasn't actually changed for this node. That reload can complete
  // a beat after the insert itself, i.e. after the user has already kept
  // typing (or used the new "exit a block quote" Enter gesture) — the
  // debounced save from that typing hasn't necessarily flushed yet, so the
  // freshly-fetched node's draftContent can be a moment stale relative to
  // what's live in the DOM. Two checks, not one, are what keep that race
  // from clobbering those keystrokes: skip a shard outright while it's the
  // one actually focused (nothing overwrites live typing out from under
  // the user), and only touch a shard's innerHTML at all when it demonstrably
  // differs from the incoming segment — a freshly (re)mounted shard from a
  // structural change (e.g. a demote) starts out empty and always needs it;
  // an already-populated, unfocused one that already matches doesn't.
  //
  // Also, every time this runs on an unfocused shard, sweep it for any
  // already-empty citation/inline-quote/source-link chip and remove it —
  // handleSourceChipEmptying (below) stops a *new* one from ever being
  // created going forward, but can't reach one left over from before that
  // existed (or synced in from a browser inconsistent about cleaning up
  // empty inline elements on its own), since there's no way to place a
  // caret inside a chip with nothing in it to click or arrow onto. Sweeping
  // it here instead — on every render this shard isn't actively focused,
  // load included — fixes it without the user ever needing to interact
  // with the broken chip at all, which is what made a document with one
  // stuck: nothing in it could be clicked into, typed into, or deleted.
  useEffect(() => {
    if (syncedContent.current.node === node && syncedContent.current.html === node.draftContent) return
    const shardEls = wrapperRef.current ? (Array.from(wrapperRef.current.querySelectorAll(':scope > .node-content')) as HTMLDivElement[]) : []
    let i = 0
    let anyCleaned = false
    for (const seg of segments) {
      if (seg.kind !== 'text') continue
      const el = shardEls[i]
      if (el && el !== document.activeElement) {
        if (el.innerHTML !== seg.html) el.innerHTML = seg.html
        if (removeEmptySourceChips(el)) anyCleaned = true
      }
      i++
    }
    syncedContent.current = { node, html: node.draftContent }
    setDirty(node.draftContent !== head.content)
    if (anyCleaned) scheduleSave()
  }, [node, node.draftContent, segments])

  useEffect(() => {
    if (focusTitleId === node.id && titleRef.current) {
      titleRef.current.focus()
      titleRef.current.select()
      onTitleFocused()
    }
  }, [focusTitleId, node.id])

  // Marking `syncedContent` here (rather than leaving it to the effect) is
  // what stops a debounced save from fighting an already-resumed typing
  // session: this node object is mutated in place, not replaced, so on the
  // next render the effect sees the very same object reference and skips
  // re-touching the shard DOM the user is still typing into. A structural
  // change (e.g. demoteChild below) always replaces this node via reload()
  // afterwards, which hands SectionBlock a genuinely different node object
  // next render — so the effect's object-identity check still catches that
  // case and resyncs properly, regardless of what this function did here.
  function persist(html: string) {
    node.draftContent = html
    syncedContent.current = { node, html }
    return saveNode(node)
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const html = reconstructContent(node.id)
      if (html == null) return
      const prunedFootnotes = await persist(html)
      // node.footnotes is mutated in place by saveNode — this component
      // would already read the updated array on its next render regardless
      // — but a mutation to a prop object doesn't itself trigger a React
      // re-render, so without asking for one explicitly here, a footnote
      // deleted by deleting its reference from the text (rather than via
      // the footnote list's own delete button) stays looking present until
      // something unrelated happens to re-render the page.
      if (prunedFootnotes) onTitleChanged()
    }, 500)
  }

  function handleShardInput(e: Event) {
    autoListify(e as InputEvent)
    const html = reconstructContent(node.id)
    if (html != null) setDirty(html !== head.content)
    scheduleSave()
  }

  async function saveTitle() {
    if (title === node.title) return
    node.title = title || 'Untitled section'
    await saveNode(node)
    onTitleChanged()
  }

  /**
   * Un-wraps `childId`: splices that child's own current content directly
   * into this node's content at the marker's position (any grandchildren
   * embedded in it come along for free, since they're just more markers in
   * that same content string) and deletes the now-redundant child record.
   */
  async function demoteChild(childId: string) {
    const child = nodeMap.get(childId)
    if (!child) return
    if (!confirm(`Fold "${child.title}" back into this section? Its text stays, but it stops being its own subsection.`)) return
    window.clearTimeout(saveTimer.current)
    const html = reconstructContent(node.id, { replace: new Map([[childId, child.draftContent]]) })
    if (html != null) await persist(html)
    await deleteNodeOnly(childId)
    onTitleChanged()
  }

  /**
   * "Make a new version": freezes whatever's here right now, then clears
   * the node so there's a blank page to write the new version on — with
   * the just-frozen one kept in view alongside it, not tucked behind a
   * history list, for as long as that's useful. This orphans any current
   * subsections (their markers were part of the text that just got
   * cleared) until/unless the frozen version is reverted to; they aren't
   * deleted, just unreferenced in the meantime.
   */
  async function handleMakeNewVersion() {
    window.clearTimeout(saveTimer.current)
    const html = reconstructContent(node.id) ?? node.draftContent
    node.draftContent = html
    const frozen = await commitNewVersion(node)
    node.draftContent = ''
    await saveNode(node)
    setComparingVersionId(frozen.id)
    onTitleChanged()
  }

  /** Deletes the footnote's own record and, if it's still actually mounted (it might not be — this node could be collapsed, or the marker could already be gone from a since-edited draft), its `<sup>` marker from the live content too, so a deleted footnote doesn't leave a dangling reference behind. */
  async function handleDeleteFootnote(footnoteId: string) {
    window.clearTimeout(saveTimer.current)
    const marker = wrapperRef.current?.querySelector(`sup.footnote-ref[data-footnote-id="${cssEscapeId(footnoteId)}"]`)
    // The zero-width space `insertFootnote` places right after the marker
    // (see its own doc comment) is only there to give the caret something
    // real to anchor to next to the marker — with the marker itself gone,
    // it's just a stray invisible character with nothing left to anchor.
    const zwsp = marker?.nextSibling
    if (zwsp?.nodeType === Node.TEXT_NODE && zwsp.textContent === '​') zwsp.remove()
    marker?.remove()
    const html = reconstructContent(node.id)
    if (html != null) await persist(html)
    await deleteFootnote(node, footnoteId)
    onTitleChanged()
  }

  async function handleRevertToComparing() {
    if (!comparingVersionId) return
    await revertToVersion(node, comparingVersionId)
    setComparingVersionId(null)
    onTitleChanged()
  }

  /** Non-destructive: just shows an older version side by side with whatever's currently here, without touching any data. */
  function handleViewVersion(versionId: string) {
    setComparingVersionId(versionId)
    setShowHistory(false)
  }

  // Comments live flat on the node now, not per-version (see
  // `nodeComments`'s own doc comment) — so, unlike the old per-version
  // model, this never falls behind a `commitNewVersion` and never needs to
  // cross-reference the content's own marks to find a comment that's still
  // "open" but recorded against an older version. Only top-level comments
  // count here; a reply or a comment-on-a-comment being unresolved doesn't
  // make the thread itself show as open in this badge.
  const openComments = nodeComments(node).filter((c) => c.parentId === null && !c.resolved).length
  const comparingVersion: NodeVersion | undefined = comparingVersionId ? node.versions.find((v) => v.id === comparingVersionId) : undefined
  const sortedVersions = [...node.versions].sort((a, b) => b.createdAt - a.createdAt)
  // Which of this node's text-anchored comments were actually present (by
  // mark) in `comparingVersion`'s own frozen content — a comment added
  // after that version was frozen has no mark there at all, and one whose
  // mark's *text* has since been edited away in later versions still shows
  // here exactly as it looked at the time this version was made.
  const frozenComments = comparingVersion ? nodeComments(node).filter((c) => c.anchorKind === 'text' && commentIdsInContent(comparingVersion.content).includes(c.id)) : []

  const historyDropdown = showHistory && (
    <div className="history-dropdown">
      <div className="history-dropdown-title">Version history</div>
      <div className="history-list">
        {sortedVersions.map((v) => (
          <div className={`history-row${v.id === node.headVersionId ? ' current' : ''}${v.id === comparingVersionId ? ' active' : ''}`} key={v.id}>
            <div className="history-row-info">
              <div className="history-row-label">
                {v.id === node.headVersionId && <span className="chip">current</span>} {v.label || 'Version'}
              </div>
              <div className="history-row-date muted">{new Date(v.createdAt).toLocaleString()}</div>
            </div>
            <button className="btn btn-sm" onClick={() => handleViewVersion(v.id)}>
              View
            </button>
          </div>
        ))}
      </div>
    </div>
  )

  const liveEditor = (
    <div className="section-body" ref={wrapperRef} hidden={isCollapsed}>
      {segments.map((seg, i) =>
        seg.kind === 'text' ? (
          <div
            key={`text-${i}`}
            className={`node-content${isRoot ? '' : ' leaf-outline'}`}
            contentEditable={!commentMode}
            onFocus={(e) => onActivate(node.id, e.currentTarget as HTMLDivElement)}
            onMouseUp={(e) => {
              onActivate(node.id, e.currentTarget as HTMLDivElement)
              onCaptureRange()
            }}
            onInput={handleShardInput}
            onKeyDown={handleShardKeyDown}
            onKeyUp={onCaptureRange}
          />
        ) : nodeMap.has(seg.childId) ? (
          <SectionBlock
            key={seg.childId}
            node={nodeMap.get(seg.childId)!}
            nodeMap={nodeMap}
            depth={depth + 1}
            isRoot={false}
            collapsed={collapsed}
            onToggleCollapse={onToggleCollapse}
            onActivate={onActivate}
            onCaptureRange={onCaptureRange}
            onDemote={() => demoteChild(seg.childId)}
            onTitleChanged={onTitleChanged}
            focusTitleId={focusTitleId}
            onTitleFocused={onTitleFocused}
            focusFootnoteId={focusFootnoteId}
            onFootnoteFocused={onFootnoteFocused}
            commentMode={commentMode}
          />
        ) : null,
      )}
    </div>
  )

  return (
    <div className="section-block" style={{ paddingLeft: Math.min(depth, 6) * 16 }} data-node-id={node.id}>
      {isRoot ? (
        // The root has no title of its own (the essay title in the topbar
        // covers that) and can't be collapsed away, but its own text is
        // still independently versionable, so it still gets a version pill.
        <div className="section-header root-header">
          <span style={{ flex: 1 }} />
          {!commentMode && dirty && <span className="version-pill">unsaved</span>}
          {!commentMode && (
            <button className="version-pill version-pill-btn" onClick={handleMakeNewVersion} title="Make a new version: freezes the current text and starts a blank one, side by side">
              v{node.versions.length}
            </button>
          )}
          {!commentMode && (
            <button className="icon-btn" onClick={() => setShowHistory((v) => !v)} title="Version history">
              🕓
            </button>
          )}
          {openComments > 0 && <span className="chip comment-count-chip">💬 {openComments}</span>}
          {historyDropdown}
        </div>
      ) : (
        <div className="section-header">
          <button className={`section-chevron${isCollapsed ? ' collapsed' : ''}`} onClick={() => onToggleCollapse(node.id)} title={isCollapsed ? 'Expand' : 'Collapse'}>
            ▾
          </button>
          {commentMode ? (
            // A static heading, print-view style, instead of an editable
            // title field — same size/weight as the live editor's own
            // input so the layout doesn't shift when toggling comment
            // mode on and off.
            <span className="section-title-static" style={{ fontSize: headingSize(depth) }}>
              {title}
            </span>
          ) : (
            <input
              ref={titleRef}
              className="section-title-input"
              style={{ fontSize: headingSize(depth) }}
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              onBlur={saveTitle}
            />
          )}
          {!commentMode && dirty && <span className="version-pill">unsaved</span>}
          {!commentMode && (
            <button className="version-pill version-pill-btn" onClick={handleMakeNewVersion} title="Make a new version: freezes the current text and starts a blank one, side by side">
              v{node.versions.length}
            </button>
          )}
          {!commentMode && (
            <button className="icon-btn" onClick={() => setShowHistory((v) => !v)} title="Version history">
              🕓
            </button>
          )}
          {openComments > 0 && <span className="chip comment-count-chip">💬 {openComments}</span>}
          {!commentMode && onDemote && (
            <button className="icon-btn" title="Demote: fold this section's text back into its parent, removing the subsection but keeping the text" onClick={onDemote}>
              ⤴
            </button>
          )}
          {historyDropdown}
        </div>
      )}

      {/* `.section-content-row` and the "live" pane inside it are always
          *mounted* at the same position with the same key, comparing or
          collapsed or not — only the `hidden` attribute and the "frozen"
          pane's presence toggle. Unmounting this on collapse (like the
          "frozen" pane can safely do) would tear down the live editable
          DOM too, silently discarding whatever the user had just typed but
          not yet saved; conditionally *nesting* the live editor deeper
          (rather than just adding a sibling next to it) has the same
          failure mode, since Preact remounts anything moved to a different
          parent. */}
      <div className={`section-content-row${comparingVersion ? ' comparing' : ''}`} hidden={isCollapsed}>
          {comparingVersion && (
            <div className="version-split-pane frozen-pane" key="frozen">
              <div className="version-split-label">
                {comparingVersion.label || 'Version'} — {new Date(comparingVersion.createdAt).toLocaleString()}
                {comparingVersion.id === node.headVersionId && ' (current)'}
              </div>
              <FrozenPreview content={comparingVersion.content} nodeMap={nodeMap} depth={0} isRoot />
              {frozenComments.length > 0 && (
                <div className="version-split-comments">
                  {frozenComments.map((c) => (
                    <div className={`comment-item${c.resolved ? ' resolved' : ''}`} key={c.id}>
                      <div className="anchor">“{c.anchorText}”</div>
                      <div dangerouslySetInnerHTML={{ __html: c.body }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="version-split-pane live-pane" key="live">
            {comparingVersion && <div className="version-split-label">Current draft — editing</div>}
            {liveEditor}
          </div>
      </div>
      {!isCollapsed && comparingVersion && (
        <div className="version-split-actions">
          <button className="btn btn-sm btn-danger" onClick={handleRevertToComparing}>
            ↺ Revert to this version
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => setComparingVersionId(null)}>
            ✓ Done comparing
          </button>
        </div>
      )}
      {/* Footnotes aren't versioned the way a node's own text is (there's
          no equivalent of draftContent/versions for them) — they just
          always reflect node.footnotes as it stands right now, regardless
          of which version's text happens to be shown above during a
          compare. Numbered locally to this node, in marker order, via the
          `.node-footnotes` CSS counter (see styles.css) rather than a
          stored number, so adding/removing/reordering one never leaves a
          stale number sitting on another. */}
      {!isCollapsed && nodeFootnotes(node).length > 0 && (
        <div className="node-footnotes">
          {nodeFootnotes(node).map((footnote) => (
            <FootnoteRow
              key={footnote.id}
              node={node}
              footnote={footnote}
              commentMode={commentMode}
              focus={focusFootnoteId === footnote.id}
              onFocused={onFootnoteFocused}
              onDelete={() => handleDeleteFootnote(footnote.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One footnote's own editable body — an uncontrolled `contentEditable` div,
 * same debounced-save shape as a node's own text shards (see `persist`/
 * `scheduleSave` above): typing schedules a save rather than saving on
 * every keystroke, and the DOM is only ever overwritten from `footnote`
 * when it's genuinely a *different* footnote object than what's already
 * synced (an external change — e.g. a sync pull rewriting node.footnotes
 * wholesale) — never on every render, which would otherwise stomp on
 * whatever's mid-typing the moment some unrelated bit of state changes.
 */
function FootnoteRow({
  node,
  footnote,
  commentMode,
  focus,
  onFocused,
  onDelete,
}: {
  node: EssayNode
  footnote: Footnote
  commentMode: boolean
  focus: boolean
  onFocused: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const synced = useRef<{ footnote: Footnote | null; content: string }>({ footnote: null, content: '' })

  useEffect(() => {
    if (synced.current.footnote === footnote && synced.current.content === footnote.content) return
    if (ref.current) ref.current.innerHTML = footnote.content
    synced.current = { footnote, content: footnote.content }
  }, [footnote, footnote.content])

  useEffect(() => {
    if (focus && ref.current) {
      ref.current.focus()
      onFocused()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  function handleInput() {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const html = ref.current?.innerHTML ?? ''
      synced.current = { footnote, content: html }
      updateFootnoteContent(node, footnote.id, html)
    }, 500)
  }

  return (
    <div className="footnote-item">
      <div className="footnote-content" ref={ref} contentEditable={!commentMode} onInput={handleInput} />
      {!commentMode && (
        <button className="icon-btn footnote-delete" title="Delete this footnote" onClick={onDelete}>
          ×
        </button>
      )}
    </div>
  )
}

function cssEscapeId(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/**
 * Three related "leave the special formatting behind" gestures most block
 * editors support, all keyed off the same trailing/collapsed-caret shape:
 *
 * - Enter right at the trailing edge of a quote (or its attached citation
 *   line right after it) breaks out into a fresh, ordinary paragraph after
 *   it, instead of continuing to type inside it. A bare contentEditable
 *   `<blockquote>` has no such behavior built in — with nothing else after
 *   it to click or arrow past whenever it's the last thing in a section,
 *   Enter (or just typing) there normally just keeps extending the quote,
 *   which is exactly the "stuck inside it" complaint this fixes. Only fires
 *   when the caret has nothing to its right inside the quote (the two are
 *   always inserted as a pair by insertQuote in EssayWorkspace.tsx, and are
 *   meant to be exited together), so pressing Enter in the *middle* of a
 *   quote's own text still behaves normally.
 * - Backspace or Delete inside a quote that's been emptied out (every bit
 *   of its own text deleted some other way — selecting it all and hitting
 *   Delete, say) removes the blockquote wrapper entirely, turning it into a
 *   plain empty paragraph in place, rather than merging into whatever's
 *   before or after it the way deleting inside an empty `<blockquote>`
 *   normally would.
 * - Backspace or Delete that would empty a citation chip, inline quote, or
 *   "link to source" (see handleSourceChipEmptying below) removes the whole
 *   inline element itself, rather than trusting the browser's own —
 *   inconsistent across engines — cleanup of empty inline elements to do
 *   it, since a browser that doesn't can leave an unfocusable husk behind
 *   that makes the whole section look stuck (nothing clicks, types, or
 *   deletes) — the actual bug this was written to fix.
 */
function handleShardKeyDown(e: KeyboardEvent) {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  const startEl = (range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer as HTMLElement) : range.startContainer.parentElement) as HTMLElement | null
  const shard = startEl?.closest<HTMLElement>('.node-content')
  if (!shard) return

  if (e.key === 'Backspace' || e.key === 'Delete') {
    // Checked first and independently of the selection-collapsed
    // requirement below (a chip can be emptied by selecting all of its
    // text and deleting, not just by backspacing character by character).
    if (handleSourceChipEmptying(e, sel, range, shard)) return
    if (!sel.isCollapsed) return
    handleEmptyQuoteDeletion(e, sel, range, shard)
    return
  }
  if (e.key !== 'Enter' || !sel.isCollapsed) return

  // The top-level child of the shard the caret sits within or right after —
  // a blockquote and its citation paragraph are always direct children of
  // the shard, so this is the one node worth checking, however deep inside
  // it (e.g. inside the <cite> itself) the caret actually is. Collapsing a
  // selection to "the end of the document" (a very ordinary way to arrive
  // right after a trailing quote) leaves the range's boundary sitting in the
  // shard itself, one offset past its last child, rather than inside any
  // text node — the childNodes[offset - 1] case below is exactly that.
  let contextNode: Node | null
  if (range.startContainer === shard) {
    contextNode = range.startOffset > 0 ? shard.childNodes[range.startOffset - 1] : null
  } else {
    let node: Node = range.startContainer
    while (node.parentNode && node.parentNode !== shard) node = node.parentNode
    contextNode = node.parentNode === shard ? node : null
  }
  if (!contextNode || contextNode.nodeType !== Node.ELEMENT_NODE) return
  const el = contextNode as HTMLElement
  const prev = el.previousElementSibling
  const isQuote = el.tagName === 'BLOCKQUOTE' && el.classList.contains('quote')
  const isCitationAfterQuote = prev?.tagName === 'BLOCKQUOTE' && prev.classList.contains('quote')
  if (!isQuote && !isCitationAfterQuote) return
  const quoteEl = el

  // Only escape when there's nothing left to the right of the caret inside
  // this element — otherwise Enter should keep its normal, in-place meaning.
  const tail = document.createRange()
  tail.selectNodeContents(quoteEl)
  tail.setStart(range.startContainer, range.startOffset)
  if (tail.toString().replace(/ /g, ' ').trim() !== '') return

  e.preventDefault()
  // Land past the citation line too when escaping from the quote text
  // itself, so either trailing edge (the quote or its citation) exits the
  // whole quote+citation unit in one keystroke.
  const insertAfter = quoteEl.tagName === 'BLOCKQUOTE' && quoteEl.nextElementSibling?.tagName === 'P' ? (quoteEl.nextElementSibling as HTMLElement) : quoteEl
  const p = document.createElement('p')
  p.appendChild(document.createElement('br'))
  insertAfter.after(p)
  const newRange = document.createRange()
  newRange.setStart(p, 0)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)
  // No native 'input' event fires for a DOM mutation we made ourselves (we
  // preventDefault()'d the key that would have triggered one) — dispatch
  // one so the shard's own onInput (handleShardInput) picks this up and
  // schedules a save exactly like any other edit.
  shard.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The Backspace/Delete half of handleShardKeyDown's doc comment above. */
function handleEmptyQuoteDeletion(e: KeyboardEvent, sel: Selection, range: Range, shard: HTMLElement) {
  let node: Node | null = range.startContainer
  while (node && node !== shard) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BLOCKQUOTE' && (node as HTMLElement).classList.contains('quote')) break
    node = node.parentNode
  }
  if (!node || node === shard) return
  const bq = node as HTMLElement
  if ((bq.textContent || '').replace(/ /g, '').trim() !== '') return

  e.preventDefault()
  const p = document.createElement('p')
  p.appendChild(document.createElement('br'))
  bq.replaceWith(p)
  const newRange = document.createRange()
  newRange.setStart(p, 0)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)
  shard.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Nearest ancestor of `node` (stopping at `shard`) matching `test`. */
function findAncestor(node: Node, shard: HTMLElement, test: (el: HTMLElement) => boolean): HTMLElement | null {
  let n: Node | null = node
  while (n && n !== shard) {
    if (n.nodeType === Node.ELEMENT_NODE && test(n as HTMLElement)) return n as HTMLElement
    n = n.parentNode
  }
  return null
}

/** A citation chip, an inline quote, or a "link to source" — every inline
 * element the editor's own insert tools tag with `data-source-id` (see
 * EssayWorkspace.tsx), as opposed to the block-level `<blockquote>` (also
 * tagged, but handled separately above — it degrades to an empty `<br>`
 * rather than an unfocusable husk once its own text is gone). */
function isSourceChip(el: HTMLElement): boolean {
  return el.hasAttribute('data-source-id') && el.tagName !== 'BLOCKQUOTE'
}

/** Removes any already-empty citation/inline-quote/source-link chip found
 * anywhere inside `root` (a whole shard, swept on every unfocused resync —
 * see the effect above) — the reactive half of the same cleanup
 * `handleSourceChipEmptying` does proactively during live editing, for a
 * chip that's already stuck empty and has no caret position left inside it
 * to trigger that on. Returns whether anything was actually removed, so the
 * caller knows to persist the fix. */
function removeEmptySourceChips(root: HTMLElement): boolean {
  let removed = false
  root.querySelectorAll<HTMLElement>('[data-source-id]').forEach((chip) => {
    if (chip.tagName === 'BLOCKQUOTE' || (chip.textContent || '').length > 0) return
    chip.replaceWith(document.createTextNode(''))
    removed = true
  })
  return removed
}

/** How many characters into `el`'s own text the (container, offset) boundary point sits. */
function offsetWithin(el: HTMLElement, container: Node, offset: number): number {
  const r = document.createRange()
  r.selectNodeContents(el)
  r.setEnd(container, offset)
  return r.toString().length
}

/**
 * Backspace/Delete's usual behavior removes an inline element (a citation
 * chip, an inline quote, a "link to source") once every character inside
 * it is gone — but that cleanup is a browser-specific nicety, not something
 * contentEditable guarantees, and it isn't consistent across engines. A
 * browser that *doesn't* do it can leave a technically-empty but no-longer-
 * focusable husk of the chip behind — indistinguishable, from the outside,
 * from an entire section that's simply stuck: nothing can be clicked into,
 * typed into, or deleted, because there's no valid caret position left
 * anywhere in it. Rather than lean on the browser's own cleanup (which is
 * exactly what left a real user stuck this way), this intercepts the exact
 * keystroke that would empty one of these chips — whether by Backspacing
 * or Delete-ing its last remaining character, or by selecting all of its
 * text and pressing either — and removes the whole element itself, so the
 * outcome is the same, deterministic "back to plain text" everywhere. Also
 * catches a chip that's *already* empty (e.g. one left behind by a browser
 * that didn't clean up before this fix existed, or synced in from one that
 * doesn't) the moment the caret manages to land inside it at all.
 */
function handleSourceChipEmptying(e: KeyboardEvent, sel: Selection, range: Range, shard: HTMLElement): boolean {
  const chip = findAncestor(range.startContainer, shard, isSourceChip)
  if (!chip) return false
  const text = chip.textContent || ''

  let wouldEmpty = false
  if (!sel.isCollapsed) {
    const endChip = findAncestor(range.endContainer, shard, isSourceChip)
    if (endChip === chip) wouldEmpty = range.toString() === text
  } else if (text.length <= 1) {
    const offset = offsetWithin(chip, range.startContainer, range.startOffset)
    wouldEmpty = e.key === 'Backspace' ? offset === text.length : offset === 0
  }
  if (!wouldEmpty) return false

  e.preventDefault()
  const marker = document.createTextNode('')
  chip.replaceWith(marker)
  const newRange = document.createRange()
  newRange.setStart(marker, 0)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)
  shard.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

const AUTOLIST_BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE'])
const ORDERED_MARKER_RE = /^\d+\.\s$/
const BULLET_MARKER_RE = /^[-*]\s$/

/** Nearest ancestor that counts as "a line" for autolist purposes — the first block-level element walking up from `node`, or `root` itself if none is found first (a shard's own text often isn't wrapped in a `<p>` at all). */
function findLineAncestor(node: Node, root: HTMLElement): Node {
  let el = node.parentNode
  while (el && el !== root) {
    if (el.nodeType === Node.ELEMENT_NODE && AUTOLIST_BLOCK_TAGS.has((el as HTMLElement).tagName)) return el
    el = el.parentNode
  }
  return root
}

/**
 * "1. " or "- "/"* " typed at the very start of an otherwise-empty line
 * converts that line into an ordered/unordered list, the same shorthand
 * most word processors support — checked on every `input` event, but only
 * actually does anything right when the just-typed character is the
 * space that completes one of those two markers (`e.data === ' '`), so
 * this never fires mid-word or while deleting.
 *
 * Deliberately DOM-first rather than going through Preact state: this
 * shard is an uncontrolled `contentEditable` (see the module doc comment
 * on `persist`/`syncedContent` above for why), so removing the marker
 * text and calling `execCommand` are just further direct edits to the
 * same live DOM the browser itself is already editing — exactly like
 * `exec()` in EssayWorkspace.tsx does for the toolbar's Bold/Italic/list
 * buttons, just triggered by typing instead of a click.
 */
function autoListify(e: InputEvent | undefined) {
  if (!e || e.inputType !== 'insertText' || e.data !== ' ') return
  const sel = window.getSelection()
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  const cursorNode = range.startContainer
  const cursorOffset = range.startOffset
  if (cursorNode.nodeType !== Node.TEXT_NODE) return
  const shard = (cursorNode.parentElement as HTMLElement | null)?.closest<HTMLElement>('.node-content')
  if (!shard) return

  const line = findLineAncestor(cursorNode, shard)
  const beforeRange = document.createRange()
  beforeRange.setStart(line, 0)
  beforeRange.setEnd(cursorNode, cursorOffset)
  const before = beforeRange.toString()

  const isOrdered = ORDERED_MARKER_RE.test(before)
  const isBullet = !isOrdered && BULLET_MARKER_RE.test(before)
  if (!isOrdered && !isBullet) return

  // Strip the marker text (everything from the start of the line through
  // the just-typed trailing space) from the one text node it lives in —
  // `before` matching the marker regex on its own already guarantees this
  // text node holds the whole thing, since a line with anything preceding
  // the marker in another node would have made `before` longer than the
  // regex allows.
  const textNode = cursorNode as Text
  textNode.textContent = (textNode.textContent ?? '').slice(cursorOffset)
  const newRange = document.createRange()
  newRange.setStart(textNode, 0)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)

  document.execCommand(isOrdered ? 'insertOrderedList' : 'insertUnorderedList')
}
