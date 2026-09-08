import { useRef, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { backupFileName, exportBackup, restoreBackup, type RestoreResult } from '../../lib/backup'
import { downloadBlob } from '../../lib/download'

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message: string }

export function BackupDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle', message: '' })
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleExport() {
    setStatus({ kind: 'busy', message: 'Preparing backup…' })
    try {
      const blob = await exportBackup()
      downloadBlob(blob, backupFileName())
      setStatus({ kind: 'ok', message: '✓ Backup downloaded.' })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleFileChosen(file: File) {
    if (mode === 'replace' && !confirm('This replaces ALL local data on this device with the contents of this backup file, and cannot be undone. Continue?')) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setStatus({ kind: 'busy', message: 'Restoring…' })
    try {
      const result = await restoreBackup(file, { mode })
      setStatus({ kind: 'ok', message: `${summarize(result)} Reloading…` })
      // Every open view loaded its own data once on mount; a restore can
      // touch all of it at once (or wipe it, in replace mode), so a full
      // reload is the simplest way to guarantee nothing on screen is left
      // showing stale pre-restore state.
      setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const busy = status.kind === 'busy'

  return (
    <Modal onClose={onClose}>
      <h2>Backup &amp; restore</h2>
      <p className="muted">
        A full local backup of everything on this device — essays, sections, version history, comments, sources, and PDFs — as one downloadable file. Unlike sync, this file is <b>not encrypted</b>: keep it somewhere you trust
        (your own disk, a personal cloud drive), not somewhere it could be shared or leaked.
      </p>

      <div className="export-option">
        <div className="export-option-body">
          <div className="export-option-title">Export a backup</div>
          <p className="muted">Downloads everything as one .zip file, for safekeeping or moving to a new browser/device.</p>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={handleExport}>
          ⬇ Download backup
        </button>
      </div>

      <div className="export-option">
        <div className="export-option-body">
          <div className="export-option-title">Restore from a backup</div>
          <p className="muted">Choose a backup .zip file to bring back in.</p>
          <label className="field-inline" style={{ display: 'flex' }}>
            <input type="radio" name="restore-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
            Merge — keep whichever copy of each item is newer (safe to run anytime)
          </label>
          <label className="field-inline" style={{ display: 'flex', marginTop: 4 }}>
            <input type="radio" name="restore-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            Replace everything — wipes this device's local data first
          </label>
          <div style={{ marginTop: 10 }}>
            <input ref={fileInputRef} type="file" accept="application/zip,.zip" disabled={busy} onChange={(e) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (file) handleFileChosen(file)
            }} />
          </div>
        </div>
      </div>

      {status.kind !== 'idle' && <p className={status.kind === 'error' ? 'error-text' : 'muted'}>{status.message}</p>}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function summarize(result: RestoreResult): string {
  const total = result.essays + result.nodes + result.sources + result.blobs
  if (total === 0) return result.mode === 'replace' ? '✓ Restored (backup was empty).' : '✓ Nothing to apply — local data was already newer or identical everywhere.'
  const parts: string[] = []
  if (result.essays) parts.push(`${result.essays} essay${result.essays === 1 ? '' : 's'}`)
  if (result.nodes) parts.push(`${result.nodes} section${result.nodes === 1 ? '' : 's'}`)
  if (result.sources) parts.push(`${result.sources} source${result.sources === 1 ? '' : 's'}`)
  if (result.blobs) parts.push(`${result.blobs} PDF${result.blobs === 1 ? '' : 's'}`)
  return `✓ Restored ${parts.join(', ')}.`
}
