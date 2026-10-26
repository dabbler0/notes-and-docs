import type { Node as PMNode } from 'prosemirror-model'
import { Modal } from '../Modal'
import { nodeOwnText, pmSectionOwnText, subtreeText, wordCountStats } from '../../lib/wordCount'
import type { EssayNode } from '../../models/types'

/**
 * A snapshot, not a live-updating counter — computed once, from whatever's
 * already saved (or, for a migrated essay, the live PM doc — always
 * current, nothing to "save" separately), when the dialog opens. A
 * running count that re-tallies on every keystroke would mean re-walking
 * the whole essay's tree just to update a number nobody's watching
 * continuously the way a cursor position is — opening this to check in on
 * where things stand is the actual use case, not a persistent live
 * display. `selectedText` is the one exception to "from whatever's
 * already there" — it's whatever was actually highlighted in the live
 * editor at the moment the Word Count button was clicked, not anything
 * read back out of stored content.
 *
 * `rootNode`/`activeNode`/`nodeMap` (the old per-node model) and
 * `doc`/`activeSection` (a migrated essay's own PM doc and whichever
 * `section` the cursor was in when this opened) are each a matched pair —
 * exactly one pair is ever passed, same `EssayWorkspace.tsx`-decides-
 * which-pipeline branching `ExportDialog.tsx` already uses.
 */
export function WordCountDialog({
  onClose,
  rootNode,
  activeNode,
  nodeMap,
  doc,
  activeSection,
  selectedText,
}: {
  onClose: () => void
  rootNode?: EssayNode
  /** The section actually focused when this was opened, if any — gives a "this section" row alongside the whole-essay one; null when nothing's focused (or the active node is the root itself, which would just repeat the first row). */
  activeNode?: EssayNode | null
  nodeMap?: Map<string, EssayNode>
  doc?: PMNode
  activeSection?: PMNode | null
  /** Whatever was actually highlighted in the editor the moment this dialog was opened — empty when there was no real selection, collapsed or otherwise, which simply skips the row below rather than showing a zero-word one nobody asked for. */
  selectedText: string
}) {
  const whole = doc ? wordCountStats(doc.firstChild!.textContent) : wordCountStats(subtreeText(rootNode!, nodeMap!))
  const sectionTitle = doc ? activeSection?.firstChild?.textContent || 'Untitled section' : activeNode?.title || 'Untitled section'
  const isRootActive = doc ? !activeSection || activeSection === doc.firstChild : !activeNode || activeNode.id === rootNode!.id
  const section = doc ? (activeSection && !isRootActive ? wordCountStats(pmSectionOwnText(activeSection)) : null) : !isRootActive ? wordCountStats(nodeOwnText(activeNode!)) : null
  const selection = selectedText.trim() ? wordCountStats(selectedText) : null

  return (
    <Modal onClose={onClose}>
      <h2>Word count</h2>
      <table className="word-count-table">
        <tbody>
          <tr>
            <td>Whole essay</td>
            <td>{whole.words.toLocaleString()} words</td>
            <td className="muted">{whole.characters.toLocaleString()} characters</td>
          </tr>
          {section && (
            <tr>
              <td>“{sectionTitle}” (this section only)</td>
              <td>{section.words.toLocaleString()} words</td>
              <td className="muted">{section.characters.toLocaleString()} characters</td>
            </tr>
          )}
          {selection && (
            <tr>
              <td>Selected text</td>
              <td>{selection.words.toLocaleString()} words</td>
              <td className="muted">{selection.characters.toLocaleString()} characters</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
