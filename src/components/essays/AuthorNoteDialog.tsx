import { useState } from 'preact/hooks'
import { Modal } from '../Modal'

/**
 * Edits `Essay.authorNote`/`Slideshow.authorNote` (see either one's own
 * doc comment in `models/types.ts`) — an essay or deck's own optional
 * thanks/acknowledgements/disclosures text. Shown differently depending
 * on which: `lib/export.ts`'s `addAuthorAttribution` attaches an essay's
 * own note as a footnote on the author-attribution line beneath the
 * title, in every print mode but Substack; a slideshow has no footnote
 * mechanism to attach one to, so `slideSerializer.ts`'s own
 * `renderAcknowledgementsSlide` gives it a whole dedicated
 * "Acknowledgements" slide instead, right before References —
 * `description` is this component's one piece of copy that actually
 * differs between the two, passed in by whichever caller knows which
 * case it is. A plain `<textarea>` rather than the rich contentEditable
 * body/footnote editors use elsewhere — this is always short, and a
 * handful of basic inline Markdown markers (`*bold*`/`_italic_`,
 * `[text](url)`) already round-trip through the same pipeline every real
 * footnote body does, same as typing them directly into a real footnote.
 */
export function AuthorNoteDialog({
  initialValue,
  description = "Thanks, acknowledgements, or disclosures for this essay's author attribution — shown as a footnote beneath your name in every print mode but Substack. Leave blank for no note.",
  onSave,
  onClose,
}: {
  initialValue: string
  description?: string
  onSave: (note: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)

  function handleSave() {
    onSave(value.trim())
    onClose()
  }

  return (
    <Modal onClose={onClose}>
      <h2>Author note</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        {description}
      </p>
      <div className="field">
        <textarea
          autoFocus
          rows={5}
          placeholder="e.g. Thanks to A and B for comments on an earlier draft."
          value={value}
          onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={handleSave}>
          Save
        </button>
      </div>
    </Modal>
  )
}
