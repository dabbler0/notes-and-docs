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
