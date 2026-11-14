/**
 * The author name shown in a print/PDF export's own page header (see
 * ExportDialog.tsx) — a single, device-wide preference rather than
 * something re-typed per export, which is what "global" means here: it
 * isn't per-essay, and it isn't re-asked for each time you print. Stored
 * in plain localStorage, not through the app's own encrypted sync — a
 * name is low-sensitivity, and making it a genuinely cross-device,
 * end-to-end-encrypted setting would mean threading it through the full
 * SYNCED_COLLECTIONS/SENSITIVE_FIELDS machinery (see sync/collections.ts,
 * sync/syncEngine.ts) for one string field. The real cost today is that
 * it has to be set again on each device you export from — acceptable for
 * now; nothing about this shape rules out moving it onto real synced
 * account metadata later if that turns out to matter.
 */
const AUTHOR_NAME_KEY = 'marginal.authorName.v1'

export function getAuthorName(): string {
  try {
    return localStorage.getItem(AUTHOR_NAME_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function setAuthorName(name: string): void {
  try {
    localStorage.setItem(AUTHOR_NAME_KEY, name.trim())
  } catch {
    /* ignore — purely a per-device convenience, nothing to recover */
  }
}

/**
 * The institutional affiliation shown alongside the author name on the
 * same attribution line — same "global, per-device" shape as
 * `getAuthorName`/`setAuthorName` above (one value, not re-typed per
 * essay/slideshow), and the same reasoning for staying in plain
 * localStorage rather than synced account metadata. Kept entirely
 * separate from whether it's actually *shown* in any one render — that's
 * each export/present flow's own per-render checkbox (`ExportDialog.tsx`,
 * `SlideshowWorkspace.tsx`), not a property of the affiliation string
 * itself.
 */
const AUTHOR_AFFILIATION_KEY = 'marginal.authorAffiliation.v1'

export function getAuthorAffiliation(): string {
  try {
    return localStorage.getItem(AUTHOR_AFFILIATION_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function setAuthorAffiliation(affiliation: string): void {
  try {
    localStorage.setItem(AUTHOR_AFFILIATION_KEY, affiliation.trim())
  } catch {
    /* ignore — purely a per-device convenience, nothing to recover */
  }
}
