import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { commitNewVersion, deleteFootnote, deleteNodeOnly, headVersion, nodeFootnotes, revertToVersion, saveNode, updateFootnoteContent } from '../../models/essaysRepo'
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
  useEffect(() => {
    if (syncedContent.current.node === node && syncedContent.current.html === node.draftContent) return
    const shardEls = wrapperRef.current ? (Array.from(wrapperRef.current.querySelectorAll(':scope > .node-content')) as HTMLDivElement[]) : []
    let i = 0
    for (const seg of segments) {
      if (seg.kind !== 'text') continue
      const el = shardEls[i]
      if (el) el.innerHTML = seg.html
      i++
    }
    syncedContent.current = { node, html: node.draftContent }
    setDirty(node.draftContent !== head.content)
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
    saveTimer.current = window.setTimeout(() => {
      const html = reconstructContent(node.id)
      if (html != null) persist(html)
    }, 500)
  }

  function handleShardInput() {
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

  const openComments = head.comments.filter((c) => !c.resolved).length
  const comparingVersion: NodeVersion | undefined = comparingVersionId ? node.versions.find((v) => v.id === comparingVersionId) : undefined
  const sortedVersions = [...node.versions].sort((a, b) => b.createdAt - a.createdAt)

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
              {comparingVersion.comments.length > 0 && (
                <div className="version-split-comments">
                  {comparingVersion.comments.map((c) => (
                    <div className={`comment-item${c.resolved ? ' resolved' : ''}`} key={c.id}>
                      <div className="anchor">“{c.anchorText}”</div>
                      {c.body}
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
