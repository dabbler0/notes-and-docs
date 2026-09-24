import { useMemo, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { classifyPages, detectEdgeGroups, type EdgeGroup } from '../../lib/epub/classify'
import { buildEpub } from '../../lib/epub/buildEpub'
import { epubFilenameFor } from '../../lib/epub'
import { displayAuthors, displayTitle } from '../../lib/bibtex'
import { downloadBlob } from '../../lib/download'
import type { BlockType, DocBlock } from '../../lib/epub/types'
import type { Source } from '../../models/types'

/**
 * The "Download as EPUB" flow's own review step: `classify.ts`'s guesses at
 * headers/footers/headings/footnotes are best-effort, and can guess wrong on
 * an unusual layout (see that module's own doc comment) — rather than
 * silently baking a wrong guess into the downloaded file, this asks a person
 * to confirm or correct the two decisions most worth their time:
 *
 * 1. Which repeating top/bottom-of-page lines are actually running
 *    headers/footers to strip (`detectEdgeGroups`/`EdgeOverride`) — shown
 *    first, since accepting/rejecting one of these reshapes the rest of the
 *    classification (a rejected "footer" becomes ordinary body text that
 *    could itself get misread as something else).
 * 2. The resulting structure — every detected heading, footnote, and
 *    section break, plus (collapsed by default, since a book's ordinary
 *    paragraphs are the one thing this already gets right often enough not
 *    to need reviewing one by one) the paragraph runs between them, each
 *    expandable in case a real heading or footnote hiding among them was
 *    missed.
 */
export function EpubExportDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const edgeGroups = useMemo(() => detectEdgeGroups(source.pageHtml), [source])
  const hasEdgeCandidates = edgeGroups.header.length > 0 || edgeGroups.footer.length > 0
  const [step, setStep] = useState<'edges' | 'review'>(hasEdgeCandidates ? 'edges' : 'review')
  const [acceptedHeader, setAcceptedHeader] = useState<Set<string>>(() => new Set(edgeGroups.header.filter((g) => g.suggested).map((g) => g.key)))
  const [acceptedFooter, setAcceptedFooter] = useState<Set<string>>(() => new Set(edgeGroups.footer.filter((g) => g.suggested).map((g) => g.key)))
  const [blocks, setBlocks] = useState<DocBlock[] | null>(hasEdgeCandidates ? null : () => classifyPages(source.pageHtml))
  const [expandedRuns, setExpandedRuns] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  function toggleKey(setFn: (fn: (prev: Set<string>) => Set<string>) => void, key: string) {
    setFn((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function proceedToReview() {
    setBlocks(classifyPages(source.pageHtml, { header: acceptedHeader, footer: acceptedFooter }))
    setStep('review')
  }

  function updateBlock(index: number, patch: Partial<DocBlock>) {
    setBlocks((prev) => prev && prev.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }

  function removeBlock(index: number) {
    setBlocks((prev) => prev && prev.filter((_, i) => i !== index))
  }

  function setBlockType(index: number, type: BlockType) {
    updateBlock(index, { type, level: type === 'heading' ? 1 : undefined })
  }

  async function handleDownload() {
    if (!blocks) return
    setBusy(true)
    try {
      const title = displayTitle(source.bibtex)
      const author = displayAuthors(source.bibtex) || undefined
      const blob = await buildEpub({ title, author }, blocks)
      downloadBlob(blob, epubFilenameFor(source))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  if (step === 'edges') {
    return (
      <Modal onClose={onClose} wide>
        <h2>Running headers &amp; footers</h2>
        <p className="muted">
          These lines repeat near the top or bottom of many pages — almost always a running head/foot or page number, not part of the actual text. Uncheck any that are wrong before continuing; a
          checked one gets stripped out of the book entirely.
        </p>
        <div className="epub-edge-columns">
          <div className="epub-edge-column">
            <h3>Header candidates</h3>
            <EdgeGroupList groups={edgeGroups.header} accepted={acceptedHeader} onToggle={(key) => toggleKey(setAcceptedHeader, key)} />
          </div>
          <div className="epub-edge-column">
            <h3>Footer candidates</h3>
            <EdgeGroupList groups={edgeGroups.footer} accepted={acceptedFooter} onToggle={(key) => toggleKey(setAcceptedFooter, key)} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={proceedToReview}>
            Continue
          </button>
        </div>
      </Modal>
    )
  }

  if (!blocks) return null // unreachable — classifyPages() always runs before this step renders

  const rows = buildReviewRows(blocks)
  const headingCount = blocks.filter((b) => b.type === 'heading').length
  const footnoteCount = blocks.filter((b) => b.type === 'footnote').length

  return (
    <Modal onClose={onClose} wide>
      <h2>Review structure</h2>
      <p className="muted">
        {headingCount} heading{headingCount === 1 ? '' : 's'} and {footnoteCount} footnote{footnoteCount === 1 ? '' : 's'} detected — fix anything wrong below before downloading. Ordinary paragraphs
        are collapsed into runs; expand one if it's hiding a heading or footnote this missed.
      </p>
      <div className="epub-review-scroll">
        {rows.map((row) =>
          row.kind === 'run' ? (
            <ParagraphRun
              key={`run-${row.startIndex}`}
              startIndex={row.startIndex}
              count={row.count}
              expanded={expandedRuns.has(row.startIndex)}
              onToggleExpand={() =>
                setExpandedRuns((prev) => {
                  const next = new Set(prev)
                  if (next.has(row.startIndex)) next.delete(row.startIndex)
                  else next.add(row.startIndex)
                  return next
                })
              }
              blocks={blocks}
              onSetType={setBlockType}
            />
          ) : (
            <BlockRow key={row.index} index={row.index} block={blocks[row.index]} onUpdate={updateBlock} onRemove={removeBlock} onSetType={setBlockType} />
          ),
        )}
        {rows.length === 0 && <p className="muted">Nothing detected — this source may not have any extracted text yet.</p>}
      </div>
      <div className="modal-actions">
        {hasEdgeCandidates && (
          <button className="btn btn-ghost" onClick={() => setStep('edges')}>
            ← Back
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={handleDownload}>
          {busy ? 'Building…' : 'Download EPUB'}
        </button>
      </div>
    </Modal>
  )
}

function EdgeGroupList({ groups, accepted, onToggle }: { groups: EdgeGroup[]; accepted: Set<string>; onToggle: (key: string) => void }) {
  if (groups.length === 0) return <p className="muted">None detected.</p>
  return (
    <div className="epub-edge-group-list">
      {groups.map((g) => (
        <label className="epub-edge-group-row" key={g.key}>
          <input type="checkbox" checked={accepted.has(g.key)} onChange={() => onToggle(g.key)} />
          <span className="epub-edge-sample">“{g.sampleText}”</span>
          <span className="muted epub-edge-count">
            {g.pages.length} of {g.totalPages} pages
          </span>
        </label>
      ))}
    </div>
  )
}

// ---- review rows -----------------------------------------------------------

type ReviewRow = { kind: 'block'; index: number } | { kind: 'run'; startIndex: number; count: number }

/** Collapses consecutive plain-paragraph blocks into one run entry — the one thing classification already gets right often enough that reviewing every paragraph individually would just be noise; everything else (heading, footnote, break) stays its own row. */
function buildReviewRows(blocks: DocBlock[]): ReviewRow[] {
  const rows: ReviewRow[] = []
  let runStart = -1
  let runCount = 0
  const flushRun = () => {
    if (runCount > 0) rows.push({ kind: 'run', startIndex: runStart, count: runCount })
    runCount = 0
  }
  blocks.forEach((b, i) => {
    if (b.type === 'paragraph') {
      if (runCount === 0) runStart = i
      runCount++
    } else {
      flushRun()
      rows.push({ kind: 'block', index: i })
    }
  })
  flushRun()
  return rows
}

function ParagraphRun({
  startIndex,
  count,
  expanded,
  onToggleExpand,
  blocks,
  onSetType,
}: {
  startIndex: number
  count: number
  expanded: boolean
  onToggleExpand: () => void
  blocks: DocBlock[]
  onSetType: (index: number, type: BlockType) => void
}) {
  return (
    <div className="epub-run">
      <button className="btn btn-ghost btn-sm" onClick={onToggleExpand}>
        {expanded ? '▾' : '▸'} {count} paragraph{count === 1 ? '' : 's'}
      </button>
      {expanded && (
        <div className="epub-run-items">
          {Array.from({ length: count }, (_, i) => startIndex + i).map((index) => (
            <div className="epub-run-item" key={index}>
              <span className="epub-block-text">{truncate(blocks[index].text)}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => onSetType(index, 'heading')}>
                → Heading
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => onSetType(index, 'footnote')}>
                → Footnote
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function truncate(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function BlockRow({
  index,
  block,
  onUpdate,
  onRemove,
  onSetType,
}: {
  index: number
  block: DocBlock
  onUpdate: (index: number, patch: Partial<DocBlock>) => void
  onRemove: (index: number) => void
  onSetType: (index: number, type: BlockType) => void
}) {
  if (block.type === 'break') {
    return (
      <div className="epub-block-row epub-block-break">
        <span className="chip">Section break</span>
        <button className="btn btn-ghost btn-sm" onClick={() => onRemove(index)}>
          Remove
        </button>
      </div>
    )
  }

  if (block.type === 'heading') {
    return (
      <div className="epub-block-row epub-block-heading">
        <span className="chip">Heading</span>
        <select value={block.level ?? 1} onChange={(e) => onUpdate(index, { level: Number((e.target as HTMLSelectElement).value) })}>
          <option value={1}>H1</option>
          <option value={2}>H2</option>
          <option value={3}>H3</option>
        </select>
        <input className="epub-heading-text" type="text" value={block.text} onInput={(e) => onUpdate(index, { text: (e.target as HTMLInputElement).value })} />
        <button className="btn btn-ghost btn-sm" onClick={() => onSetType(index, 'paragraph')}>
          Not a heading
        </button>
      </div>
    )
  }

  // footnote
  return (
    <div className="epub-block-row epub-block-footnote">
      <span className="chip">Footnote</span>
      <span className="epub-block-text">{truncate(block.text)}</span>
      <button className="btn btn-ghost btn-sm" onClick={() => onSetType(index, 'paragraph')}>
        Not a footnote
      </button>
    </div>
  )
}
