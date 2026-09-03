import { useEffect, useRef, useState } from 'preact/hooks'
import { addComment, attachChild, createChildNode, headVersion, saveNode } from '../../models/essaysRepo'
import { citationLabel } from '../../lib/bibtex'
import { extractRangeHtml, getRangeWithin, insertHtmlAtRange } from '../../lib/selection'
import type { Essay, EssayNode, Source } from '../../models/types'
import { CitationPickerDialog } from './CitationPickerDialog'
import { QuoteInsertDialog } from './QuoteInsertDialog'
import { VersionDialog } from './VersionDialog'
import { MoveTargetDialog } from './MoveTargetDialog'
import { CommentsPanel } from './CommentsPanel'

export function NodeEditor({
  essay,
  node,
  nodeMap,
  onChanged,
  onSelectNode,
}: {
  essay: Essay
  node: EssayNode
  nodeMap: Map<string, EssayNode>
  onChanged: () => void
  onSelectNode: (id: string) => void
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  // Tracks the (nodeId, html) we last pushed into the contentEditable DOM, so
  // we can tell "the parent gave us a fresh node object after a revert/reload"
  // (re-sync the DOM) apart from "the user is still typing" (leave DOM alone).
  const syncedContent = useRef<{ id: string; html: string }>({ id: '', html: '' })
  const [title, setTitle] = useState(node.title)
  const [showCitation, setShowCitation] = useState(false)
  const [showQuote, setShowQuote] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showComments, setShowComments] = useState(true)
  const [commentMode, setCommentMode] = useState(false)
  const [pendingComment, setPendingComment] = useState<{ range: Range; text: string; x: number; y: number } | null>(null)
  const [moveState, setMoveState] = useState<{ html: string } | null>(null)

  const head = headVersion(node)
  const isDirty = node.draftContent !== head.content

  useEffect(() => {
    setTitle(node.title)
    setCommentMode(false)
    setPendingComment(null)
  }, [node.id])

  // Re-sync the DOM whenever the node prop's draft content changed for a
  // reason other than our own in-progress typing (switching nodes, a
  // version revert, a comment/split/move mutation coming back from storage).
  useEffect(() => {
    if (!editorRef.current) return
    if (syncedContent.current.id !== node.id || syncedContent.current.html !== node.draftContent) {
      editorRef.current.innerHTML = node.draftContent
      syncedContent.current = { id: node.id, html: node.draftContent }
    }
  }, [node.id, node.draftContent])

  function scheduleSave() {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      if (!editorRef.current) return
      const html = editorRef.current.innerHTML
      node.draftContent = html
      syncedContent.current = { id: node.id, html }
      await saveNode(node)
    }, 500)
  }

  async function saveTitle() {
    node.title = title || 'Untitled section'
    await saveNode(node)
    onChanged()
  }

  function captureRange() {
    if (editorRef.current) {
      const r = getRangeWithin(editorRef.current)
      if (r) savedRange.current = r
    }
  }

  function exec(cmd: string) {
    editorRef.current?.focus()
    document.execCommand(cmd)
    scheduleSave()
  }

  async function insertCitation(source: Source) {
    setShowCitation(false)
    const range = savedRange.current
    if (!range || !editorRef.current) return
    editorRef.current.focus()
    insertHtmlAtRange(range, `<cite class="citation" data-source-id="${source.id}">${citationLabel(source.bibtex)}</cite>&nbsp;`)
    node.draftContent = editorRef.current.innerHTML
    await saveNode(node)
  }

  async function insertQuote(source: Source, quote: string, page: number) {
    setShowQuote(false)
    const range = savedRange.current
    if (!range || !editorRef.current) return
    editorRef.current.focus()
    const html = `<blockquote class="quote" data-source-id="${source.id}" data-page="${page}">${escapeHtml(quote)}</blockquote><p><cite class="citation" data-source-id="${source.id}">${citationLabel(source.bibtex)}, p. ${page}</cite></p>`
    insertHtmlAtRange(range, html)
    node.draftContent = editorRef.current.innerHTML
    await saveNode(node)
  }

  function handleMouseUp() {
    captureRange()
    if (!commentMode) return
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed || !editorRef.current) return
    const range = sel.getRangeAt(0)
    if (!editorRef.current.contains(range.commonAncestorContainer)) return
    const text = range.toString().trim()
    if (!text) return
    const rect = range.getBoundingClientRect()
    setPendingComment({ range: range.cloneRange(), text, x: rect.left, y: rect.bottom + window.scrollY })
  }

  async function submitComment(body: string) {
    if (!pendingComment) return
    try {
      const mark = document.createElement('mark')
      mark.className = 'comment-anchor'
      const contents = pendingComment.range.extractContents()
      mark.appendChild(contents)
      pendingComment.range.insertNode(mark)
      if (editorRef.current) {
        node.draftContent = editorRef.current.innerHTML
        await saveNode(node)
      }
    } catch {
      /* fall back to just recording the comment without an inline mark */
    }
    await addComment(node, head.id, pendingComment.text, body)
    setPendingComment(null)
    onChanged()
  }

  async function handleAddChild() {
    const t = prompt('Title for the new subsection?')
    if (t == null) return
    const child = await createChildNode(essay.id, t)
    await attachChild(node, child.id)
    onChanged()
    onSelectNode(child.id)
  }

  function beginSplit() {
    captureRange()
    const range = savedRange.current
    if (!range || range.collapsed || !editorRef.current) {
      alert('Select the text you want to split into a new subsection first.')
      return
    }
    const t = prompt('Title for the new subsection?')
    if (t == null) return
    const html = extractRangeHtml(range)
    node.draftContent = editorRef.current.innerHTML
    createChildNode(essay.id, t, html).then(async (child) => {
      await attachChild(node, child.id)
      await saveNode(node)
      onChanged()
    })
  }

  function beginMove() {
    captureRange()
    const range = savedRange.current
    if (!range || range.collapsed || !editorRef.current) {
      alert('Select the text you want to move to another section first.')
      return
    }
    const html = extractRangeHtml(range)
    node.draftContent = editorRef.current.innerHTML
    setMoveState({ html })
  }

  async function finishMove(targetId: string) {
    if (!moveState) return
    await saveNode(node)
    const target = nodeMap.get(targetId)
    if (target) {
      target.draftContent = target.draftContent + moveState.html
      await saveNode(target)
    }
    setMoveState(null)
    onChanged()
  }

  return (
    <div className="editor-panel">
      <div className="editor-toolbar">
        <button className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
          <b>B</b>
        </button>
        <button className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
          <i>I</i>
        </button>
        <button
          className="btn btn-sm"
          onMouseDown={(e) => {
            e.preventDefault()
            captureRange()
          }}
          onClick={() => setShowCitation(true)}
        >
          🔖 Cite
        </button>
        <button
          className="btn btn-sm"
          onMouseDown={(e) => {
            e.preventDefault()
            captureRange()
          }}
          onClick={() => setShowQuote(true)}
        >
          “ ” Quote from PDF
        </button>
        <button className="btn btn-sm" onClick={beginSplit}>
          ✂ Split into subsection
        </button>
        <button className="btn btn-sm" onClick={beginMove}>
          ↪ Move to…
        </button>
        <button
          className={`btn btn-sm toolbar-toggle${commentMode ? ' active' : ''}`}
          disabled={isDirty}
          title={isDirty ? 'Save this as a version before commenting on it' : 'Toggle comment mode'}
          onClick={() => setCommentMode((v) => !v)}
        >
          💬 {commentMode ? 'Commenting…' : 'Comment mode'}
        </button>
        <div className="spacer" />
        {isDirty && <span className="version-pill">Unsaved changes since last version</span>}
        <button className="btn btn-sm" onClick={() => setShowVersions(true)}>
          🕓 Versions ({node.versions.length})
        </button>
        <button className="btn btn-sm" onClick={() => setShowComments((v) => !v)}>
          {showComments ? 'Hide comments' : 'Show comments'}
        </button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="editor-scroll" style={{ flex: 1 }}>
          <div className="editor-titlebar">
            <input value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onBlur={saveTitle} />
            <span className="version-pill">{head.label || 'current version'}</span>
          </div>

          <div
            ref={editorRef}
            className="node-content"
            contentEditable
            data-placeholder="Write this section's text here…"
            onInput={scheduleSave}
            onMouseUp={handleMouseUp}
            onKeyUp={captureRange}
          />

          <div className="children-list">
            <h3>
              Subsections ({node.childIds.length}) <button className="btn btn-sm" onClick={handleAddChild}>+ Add subsection</button>
            </h3>
            {node.childIds.map((cid) => {
              const child = nodeMap.get(cid)
              if (!child) return null
              return (
                <div className="child-row" key={cid} onClick={() => onSelectNode(cid)}>
                  <span>{child.title}</span>
                  <span className="muted" style={{ marginLeft: 'auto' }}>
                    {child.versions.length} version{child.versions.length === 1 ? '' : 's'}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {showComments && <CommentsPanel node={node} onChanged={onChanged} />}
      </div>

      {pendingComment && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPendingComment(null)}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <h2>Add comment</h2>
            <p className="muted">On: “{pendingComment.text}”</p>
            <CommentComposer onCancel={() => setPendingComment(null)} onSubmit={submitComment} />
          </div>
        </div>
      )}

      {showCitation && <CitationPickerDialog onClose={() => setShowCitation(false)} onSelect={insertCitation} />}
      {showQuote && <QuoteInsertDialog onClose={() => setShowQuote(false)} onInsert={insertQuote} />}
      {showVersions && <VersionDialog node={node} onClose={() => setShowVersions(false)} onChanged={onChanged} />}
      {moveState && <MoveTargetDialog nodeMap={nodeMap} rootId={essay.rootNodeId} excludeId={node.id} onClose={() => setMoveState(null)} onPick={finishMove} />}
    </div>
  )
}

function CommentComposer({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (body: string) => void }) {
  const [body, setBody] = useState('')
  return (
    <>
      <div className="field">
        <textarea autoFocus rows={3} value={body} onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div className="modal-actions">
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

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
