import { useEffect, useRef, useState } from 'preact/hooks'
import { Modal } from '../Modal'
import { QrScanner } from './QrScanner'
import { clearFirebaseConfig, getFirebaseConfig, setFirebaseConfig, validateFirebaseConfig, type FirebaseWebConfig } from '../../sync/firebaseConfig'
import { createAccount, forgetAccount, getAccount, importAccount } from '../../sync/account'
import { isAccountBundle, type AccountBundle } from '../../lib/crypto'
import { isAutoSyncEnabled, setAutoSyncEnabled, syncNow } from '../../sync/autoSync'
import type { SyncResult } from '../../sync/syncEngine'
import { bundleToQrDataUrl } from '../../sync/qr'
import { downloadBlob } from '../../lib/download'

type Account = { bundle: AccountBundle; cryptoKey: CryptoKey }
type SyncStatus = { kind: 'idle' | 'running' | 'ok' | 'error'; message: string }

export function SyncSettingsDialog({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<FirebaseWebConfig | null>(() => getFirebaseConfig())
  const [account, setAccount] = useState<Account | null>(null)
  const [loadingAccount, setLoadingAccount] = useState(true)

  useEffect(() => {
    getAccount().then((a) => {
      setAccount(a)
      setLoadingAccount(false)
    })
  }, [])

  return (
    <Modal onClose={onClose} wide>
      <h2>Sync across devices</h2>
      <p className="muted">
        Your data lives locally on every device first; syncing just reconciles that local copy with an encrypted copy in your own Firebase project — PDFs and essay drafts are encrypted before they ever leave this device, with the key
        staying local unless you deliberately move it to another device.
      </p>

      {!config ? (
        <FirebaseConfigForm onSaved={setConfig} />
      ) : (
        <>
          <div className="sync-row">
            <span className="muted">Firebase project: {config.projectId}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                if (!confirm('Disconnect this Firebase project? Your account key is kept, but syncing stops until you reconnect a project.')) return
                clearFirebaseConfig()
                setConfig(null)
              }}
            >
              Change project
            </button>
          </div>

          {loadingAccount ? (
            <p className="muted">Loading…</p>
          ) : !account ? (
            <AccountSetup onReady={setAccount} />
          ) : (
            <AccountPanel account={account} onForgotten={() => setAccount(null)} />
          )}
        </>
      )}

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function FirebaseConfigForm({ onSaved }: { onSaved: (cfg: FirebaseWebConfig) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  function save(e: Event) {
    e.preventDefault()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setError('Not valid JSON.')
      return
    }
    const err = validateFirebaseConfig(parsed)
    if (err) {
      setError(err)
      return
    }
    const cfg = parsed as FirebaseWebConfig
    setFirebaseConfig(cfg)
    onSaved(cfg)
  }

  return (
    <form onSubmit={save}>
      <div className="field">
        <label>Firebase project config</label>
        <textarea
          rows={7}
          placeholder={'{\n  "apiKey": "…",\n  "authDomain": "your-app.firebaseapp.com",\n  "projectId": "your-app",\n  "storageBucket": "your-app.appspot.com",\n  "appId": "…"\n}'}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <p className="muted">
        From your Firebase project's settings → "Your apps" → web app config. This isn't a secret by itself (it's meant to be embedded in client code) — what actually protects your data is Firestore/Storage security rules plus the
        encryption below. See the README for the project setup and rules to use.
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button type="submit" className="btn btn-primary">
          Connect project
        </button>
      </div>
    </form>
  )
}

function AccountSetup({ onReady }: { onReady: (account: Account) => void }) {
  const [importMode, setImportMode] = useState<'file' | 'paste' | 'scan' | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleCreate() {
    onReady(await createAccount())
  }

  async function adopt(bundle: unknown) {
    if (!isAccountBundle(bundle)) {
      setError('Not a valid account key.')
      return
    }
    onReady(await importAccount(bundle))
  }

  async function handleFile(file: File) {
    try {
      adopt(JSON.parse(await file.text()))
    } catch {
      setError('Could not read that file as an account key.')
    }
  }

  function handlePaste() {
    try {
      adopt(JSON.parse(pasteText))
    } catch {
      setError('Not valid key JSON.')
    }
  }

  return (
    <div className="sync-account-setup">
      <h3>No account on this device yet</h3>
      <div className="export-option">
        <div className="export-option-body">
          <div className="export-option-title">Start a new account</div>
          <p className="muted">Generates a fresh encryption key and account id on this device.</p>
        </div>
        <button className="btn btn-primary" onClick={handleCreate}>
          Create account
        </button>
      </div>

      <div className="export-option">
        <div className="export-option-body">
          <div className="export-option-title">Use an existing account</div>
          <p className="muted">Bring in the key from a device that already has one — scan its QR code, upload its key file, or paste the key text.</p>
          <div className="sync-import-tabs">
            <button className={`btn btn-sm${importMode === 'scan' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setImportMode('scan')}>
              📷 Scan QR
            </button>
            <button className={`btn btn-sm${importMode === 'file' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setImportMode('file')}>
              📄 Key file
            </button>
            <button className={`btn btn-sm${importMode === 'paste' ? ' btn-primary' : ' btn-ghost'}`} onClick={() => setImportMode('paste')}>
              ⌨ Paste
            </button>
          </div>
        </div>
      </div>

      {importMode === 'scan' && <QrScanner onResult={(text) => adopt(safeParse(text))} />}
      {importMode === 'file' && (
        <div className="field">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (file) handleFile(file)
            }}
          />
        </div>
      )}
      {importMode === 'paste' && (
        <div className="field">
          <textarea rows={3} placeholder='{"userId": "…", "key": "…", "v": 1}' value={pasteText} onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)} />
          <button className="btn btn-sm btn-primary" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={handlePaste}>
            Use this key
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function AccountPanel({ account, onForgotten }: { account: Account; onForgotten: () => void }) {
  const [status, setStatus] = useState<SyncStatus>({ kind: 'idle', message: '' })
  const [autoSync, setAutoSync] = useState(isAutoSyncEnabled())
  const [showQr, setShowQr] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')

  async function handleSync() {
    setStatus({ kind: 'running', message: 'Starting…' })
    try {
      const result: SyncResult = await syncNow((message) => setStatus({ kind: 'running', message }))
      setStatus({ kind: 'ok', message: summarize(result) })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  async function handleShowQr() {
    setQrDataUrl(await bundleToQrDataUrl(JSON.stringify(account.bundle)))
    setShowQr(true)
  }

  function handleDownloadKeyFile() {
    downloadBlob(new Blob([JSON.stringify(account.bundle, null, 2)], { type: 'application/json' }), 'marginal-account-key.json')
  }

  function handleForget() {
    if (!confirm('Unlink this device from its sync account? Local data on this device is kept exactly as is — it just stops syncing until you import a key again.')) return
    forgetAccount()
    onForgotten()
  }

  return (
    <div className="sync-account-panel">
      <p>
        This device's account: <code>{account.bundle.userId}</code>
      </p>

      <div className="sync-row">
        <button className="btn btn-sm" onClick={handleShowQr}>
          📱 Show transfer QR
        </button>
        <button className="btn btn-sm" onClick={handleDownloadKeyFile}>
          ⬇ Download key file
        </button>
        <button className="btn btn-sm btn-ghost btn-danger" onClick={handleForget}>
          Unlink this device
        </button>
      </div>

      {showQr && (
        <div className="sync-qr-block">
          <img src={qrDataUrl} alt="Account transfer QR code" width={200} height={200} />
          <p className="muted">Scan this on a new device (Sync settings → Use an existing account → Scan QR) to link it to the same account. Anyone with this code can read and write your synced data — treat it like a password.</p>
          <button className="btn btn-sm" onClick={() => setShowQr(false)}>
            Hide
          </button>
        </div>
      )}

      <div className="sync-row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" disabled={status.kind === 'running'} onClick={handleSync}>
          {status.kind === 'running' ? 'Syncing…' : '🔄 Sync now'}
        </button>
        <label className="field-inline">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked
              setAutoSync(v)
              setAutoSyncEnabled(v)
            }}
          />
          Auto-sync every 30s while open
        </label>
      </div>

      {status.kind !== 'idle' && <p className={status.kind === 'error' ? 'error-text' : 'muted'}>{status.message}</p>}
    </div>
  )
}

function summarize(result: SyncResult): string {
  const { pushed, pulled } = result
  const pushedTotal = pushed.essays + pushed.nodes + pushed.sources + pushed.blobs
  const pulledTotal = pulled.essays + pulled.nodes + pulled.sources + pulled.blobs
  if (pushedTotal === 0 && pulledTotal === 0) return '✓ Already up to date.'
  const parts: string[] = []
  if (pushedTotal) parts.push(`sent ${pushedTotal} change${pushedTotal === 1 ? '' : 's'}`)
  if (pulledTotal) parts.push(`received ${pulledTotal} change${pulledTotal === 1 ? '' : 's'}`)
  return `✓ Synced — ${parts.join(', ')}.`
}
