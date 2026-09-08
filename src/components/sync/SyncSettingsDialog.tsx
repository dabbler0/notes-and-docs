import { useEffect, useRef, useState } from 'preact/hooks'
import type { User } from 'firebase/auth'
import { Modal } from '../Modal'
import { QrScanner } from './QrScanner'
import { clearFirebaseConfig, detectHostingConfig, getStoredFirebaseConfig, setFirebaseConfig, validateFirebaseConfig, type FirebaseWebConfig, type StoredFirebaseConfig } from '../../sync/firebaseConfig'
import { createLocalKey, exportBundleFor, forgetLocalKey, getLocalKey, importLocalKey, type LocalKey } from '../../sync/account'
import { onAuthChange, signInWithGoogle, signOutOfGoogle } from '../../sync/firebaseClient'
import { getAccountMeta, setAccountMeta, wipeRemoteAccountData, type AccountMeta } from '../../sync/accountMeta'
import { computeKeyFingerprint, importKeyFromBundle, isKeyBundle, type KeyBundle } from '../../lib/crypto'
import { isAutoSyncEnabled, setAutoSyncEnabled, syncNow } from '../../sync/autoSync'
import { resetSyncState, type SyncResult } from '../../sync/syncEngine'
import { bundleToQrDataUrl } from '../../sync/qr'
import { downloadBlob } from '../../lib/download'

type SyncStatus = { kind: 'idle' | 'running' | 'ok' | 'error'; message: string }

export function SyncSettingsDialog({ onClose }: { onClose: () => void }) {
  const [stored, setStored] = useState<StoredFirebaseConfig | null>(() => getStoredFirebaseConfig())
  const [detecting, setDetecting] = useState(!stored)
  const [detectError, setDetectError] = useState<{ error: string; raw: unknown } | null>(null)
  const [forceManualForm, setForceManualForm] = useState(false)

  // Covers opening this dialog before App.tsx's own startup auto-detect
  // (which runs the same check) has had a chance to resolve yet — without
  // this, a fresh Firebase-Hosting deploy would flash the manual-paste
  // form for a moment even though auto-detection is about to succeed.
  useEffect(() => {
    if (stored) return
    setDetecting(true)
    detectHostingConfig().then((result) => {
      if (result.status === 'found') {
        setFirebaseConfig(result.config, 'auto')
        setStored({ config: result.config, source: 'auto' })
      } else if (result.status === 'invalid') {
        setDetectError({ error: result.error, raw: result.raw })
      }
      setDetecting(false)
    })
  }, [stored])

  const showManualForm = !stored?.config || forceManualForm

  return (
    <Modal onClose={onClose} wide>
      <h2>Sync across devices</h2>
      <p className="muted">
        Your data lives locally on every device first; syncing just reconciles that local copy with an encrypted copy in your own Firebase project. Two independent guards protect it there: signing in with Google decides who can
        even reach the encrypted data at all, and a separate encryption key — which never leaves your devices except when you deliberately move it — decides who can actually read it.
      </p>

      {showManualForm ? (
        <>
          {detecting && <p className="muted">Checking whether this page's own Firebase Hosting already has a project config for it…</p>}
          {detectError && (
            <p className="error-text">
              Found this page's own Firebase Hosting config, but it's missing something this app needs: <b>{detectError.error}</b> That usually means the project's web app registration itself is incomplete — check Project settings
              → General → "Your apps" in the Firebase console. In the meantime, or if you'd rather point at a different project, you can fix it up and paste it below.
            </p>
          )}
          {!detecting && (
            <FirebaseConfigForm
              initialText={stored ? JSON.stringify(stored.config, null, 2) : detectError ? JSON.stringify(detectError.raw, null, 2) : ''}
              onSaved={(cfg) => {
                setFirebaseConfig(cfg, 'manual')
                setStored({ config: cfg, source: 'manual' })
                setForceManualForm(false)
              }}
              onCancel={stored ? () => setForceManualForm(false) : undefined}
            />
          )}
        </>
      ) : (
        <>
          <div className="sync-row">
            <span className="muted">
              Firebase project: {stored!.config.projectId}
              {stored!.source === 'auto' && ' (auto-detected from this page\'s own Firebase Hosting)'}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => setForceManualForm(true)}>
              Use a different project
            </button>
            {stored!.source === 'manual' && (
              <button
                className="btn btn-sm btn-ghost btn-danger"
                onClick={() => {
                  if (!confirm('Disconnect this Firebase project? Your local encryption key is kept, but syncing stops until you reconnect a project.')) return
                  clearFirebaseConfig()
                  setStored(null)
                }}
              >
                Disconnect
              </button>
            )}
          </div>

          <GoogleAccountFlow />
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

function FirebaseConfigForm({ initialText, onSaved, onCancel }: { initialText: string; onSaved: (cfg: FirebaseWebConfig) => void; onCancel?: () => void }) {
  const [text, setText] = useState(initialText)
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
    onSaved(parsed as FirebaseWebConfig)
  }

  return (
    <form onSubmit={save}>
      <div className="field">
        <label>Firebase project config</label>
        <textarea
          rows={7}
          placeholder={'{\n  "apiKey": "…",\n  "authDomain": "your-app.firebaseapp.com",\n  "projectId": "your-app",\n  "appId": "…"\n}'}
          value={text}
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <p className="muted">
        From your Firebase project's settings → "Your apps" → web app config — pasting the whole object (any extra fields, like `storageBucket`, are simply ignored) works fine too. This isn't a secret by itself (it's meant to be
        embedded in client code) — what actually protects your data is Google sign-in plus Firestore security rules, and the encryption key on top of that. See the README for the project setup and rules to use. If this page is
        served from that same project's own Firebase Hosting, you shouldn't need this at all — it's detected automatically.
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary">
          Connect project
        </button>
      </div>
    </form>
  )
}

/** The identity layer: nothing below this can happen until a Google account is signed in — see the module note on syncEngine.ts for why that's an independent guard from the encryption key, not a replacement for it. */
function GoogleAccountFlow() {
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authError, setAuthError] = useState('')
  const [signingIn, setSigningIn] = useState(false)

  useEffect(() => {
    return onAuthChange((u) => {
      setUser(u)
      setAuthLoading(false)
    })
  }, [])

  async function handleSignIn() {
    setAuthError('')
    setSigningIn(true)
    try {
      await signInWithGoogle()
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err))
    } finally {
      setSigningIn(false)
    }
  }

  if (authLoading) return <p className="muted">Checking sign-in…</p>

  if (!user) {
    return (
      <div className="sync-google-signin">
        <p className="muted">
          Sign in with Google to identify this account — a second, independent guard on top of the encryption key below: only this specific Google account can even reach the encrypted data, regardless of who might otherwise know
          or guess where it lives. Needs this page to be actually hosted somewhere (not opened as a downloaded file) — Google's sign-in pop-up can't complete from a <code>file://</code> page.
        </p>
        <button className="btn btn-primary" disabled={signingIn} onClick={handleSignIn}>
          {signingIn ? 'Opening sign-in…' : 'Sign in with Google'}
        </button>
        {authError && <p className="error-text">{authError}</p>}
      </div>
    )
  }

  return <KeySetup user={user} />
}

/** The encryption layer: once signed in, figures out whether this device already has the right key for this Google account, and routes to whichever of the three states below applies. */
function KeySetup({ user }: { user: User }) {
  const [checking, setChecking] = useState(true)
  const [meta, setMeta] = useState<AccountMeta | null>(null)
  const [localKey, setLocalKey] = useState<LocalKey | null>(null)
  const [metaError, setMetaError] = useState('')

  async function refresh() {
    setChecking(true)
    setMetaError('')
    try {
      const [m, k] = await Promise.all([getAccountMeta(user.uid), getLocalKey(user.uid)])
      setMeta(m)
      setLocalKey(k)
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid])

  if (checking) return <p className="muted">Checking this account's encryption key…</p>

  const keyReady = !!localKey && !!meta && localKey.fingerprint === meta.keyFingerprint

  return (
    <div className="sync-google-account">
      <div className="sync-row">
        <span className="muted">Signed in as {user.email ?? user.uid}</span>
        <button className="btn btn-sm btn-ghost" onClick={() => signOutOfGoogle()}>
          Sign out
        </button>
      </div>

      {metaError ? (
        <div>
          <p className="error-text">{metaError}</p>
          <button className="btn btn-sm" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : !meta ? (
        <KeyBootstrap uid={user.uid} onReady={refresh} />
      ) : !keyReady ? (
        <KeyMismatch uid={user.uid} meta={meta} onResolved={refresh} />
      ) : (
        <AccountPanel uid={user.uid} onKeyForgotten={refresh} />
      )}
    </div>
  )
}

/** No account metadata at all yet — this Google account has never synced from anywhere. Either generate the first key for it, or bring in one you already have (e.g. deliberately reusing a key from a different setup). */
function KeyBootstrap({ uid, onReady }: { uid: string; onReady: () => void }) {
  const [importMode, setImportMode] = useState<'file' | 'paste' | 'scan' | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleCreate() {
    setBusy(true)
    try {
      const key = await createLocalKey(uid)
      await setAccountMeta(uid, key.fingerprint)
      onReady()
    } finally {
      setBusy(false)
    }
  }

  async function adopt(bundle: unknown) {
    if (!isKeyBundle(bundle)) {
      setError('Not a valid key.')
      return
    }
    setBusy(true)
    try {
      const key = await importLocalKey(uid, bundle)
      await setAccountMeta(uid, key.fingerprint)
      onReady()
    } finally {
      setBusy(false)
    }
  }

  async function handleFile(file: File) {
    try {
      await adopt(JSON.parse(await file.text()))
    } catch {
      setError('Could not read that file as a key.')
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
      <h3>No encryption key set up for this account yet</h3>
      <div className="export-option">
        <div className="export-option-body">
          <div className="export-option-title">Start fresh</div>
          <p className="muted">Generates a new encryption key on this device — this becomes the account's key from here on.</p>
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={handleCreate}>
          Create key
        </button>
      </div>

      <div className="export-option">
        <div className="export-option-body">
          <div className="export-option-title">Use a key you already have</div>
          <p className="muted">If you're deliberately reusing a key from elsewhere, bring it in the same way as onto any other new device.</p>
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
          <textarea rows={3} placeholder='{"key": "…", "v": 2}' value={pasteText} onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)} />
          <button className="btn btn-sm btn-primary" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={handlePaste} disabled={busy}>
            Use this key
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/**
 * This Google account already has a key established somewhere else, and
 * this device either has none cached or has one that doesn't match. The
 * "reset" path is deliberately the least prominent thing on screen and
 * gated behind typing a confirmation word — it's real, permanent data
 * loss for every other device still relying on the key being reset away
 * from.
 */
function KeyMismatch({ uid, meta, onResolved }: { uid: string; meta: AccountMeta; onResolved: () => void }) {
  const [importMode, setImportMode] = useState<'file' | 'paste' | 'scan' | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showReset, setShowReset] = useState(false)
  const [resetConfirmText, setResetConfirmText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function adopt(bundleUnknown: unknown) {
    if (!isKeyBundle(bundleUnknown)) {
      setError('Not a valid key.')
      return
    }
    const bundle = bundleUnknown as KeyBundle
    setBusy(true)
    setError('')
    try {
      const candidateKey = await importKeyFromBundle(bundle)
      const fingerprint = await computeKeyFingerprint(candidateKey)
      if (fingerprint !== meta.keyFingerprint) {
        setError("This key doesn't match the one this account was set up with — double-check you're scanning/uploading the right device's key.")
        return
      }
      await importLocalKey(uid, bundle)
      onResolved()
    } catch {
      setError('Could not read that as a key.')
    } finally {
      setBusy(false)
    }
  }

  async function handleFile(file: File) {
    try {
      await adopt(JSON.parse(await file.text()))
    } catch {
      setError('Could not read that file as a key.')
    }
  }

  function handlePaste() {
    try {
      adopt(JSON.parse(pasteText))
    } catch {
      setError('Not valid key JSON.')
    }
  }

  async function handleReset() {
    if (resetConfirmText.trim().toUpperCase() !== 'RESET') return
    if (!confirm("This permanently deletes ALL of this account's data from Firestore — every other device relying on the current key loses access to it entirely, forever. This cannot be undone. Continue?")) return
    setBusy(true)
    setError('')
    try {
      await wipeRemoteAccountData(uid)
      resetSyncState()
      const key = await createLocalKey(uid)
      await setAccountMeta(uid, key.fingerprint)
      onResolved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sync-account-setup">
      <p className="error-text">
        This Google account already has an encryption key set up on another device, and this device doesn't have the matching one. Scan its QR code, upload its key file, or paste the key text to unlock your data here.
      </p>
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
          <textarea rows={3} placeholder='{"key": "…", "v": 2}' value={pasteText} onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)} />
          <button className="btn btn-sm btn-primary" style={{ alignSelf: 'flex-start', marginTop: 8 }} onClick={handlePaste} disabled={busy}>
            Use this key
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      <p className="sync-reset-toggle">
        <button className="btn-link-muted" onClick={() => setShowReset((v) => !v)}>
          I've lost the key file — reset this account instead
        </button>
      </p>
      {showReset && (
        <div className="sync-reset-box">
          <p>
            <b>This is permanent and destructive.</b> It deletes every essay, source, and PDF this account has synced to Firestore, on every device — the old key becomes useless the moment this finishes, so any device still
            relying on it will simply stop syncing. Local data on this device is not touched. Type <b>RESET</b> to confirm.
          </p>
          <div className="sync-row">
            <input value={resetConfirmText} onInput={(e) => setResetConfirmText((e.target as HTMLInputElement).value)} placeholder="RESET" style={{ maxWidth: 120 }} />
            <button className="btn btn-sm btn-danger" disabled={busy || resetConfirmText.trim().toUpperCase() !== 'RESET'} onClick={handleReset}>
              Permanently reset this account
            </button>
          </div>
        </div>
      )}
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

function AccountPanel({ uid, onKeyForgotten }: { uid: string; onKeyForgotten: () => void }) {
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

  async function handleForceResync() {
    if (
      !confirm(
        "Re-check every remote item against this device's local copy, ignoring what's already been synced before? This is safe (it can't lose data — anything already up to date here is simply skipped again) but re-reads everything, which counts against your Firestore quota faster than a normal sync.",
      )
    )
      return
    resetSyncState()
    await handleSync()
  }

  async function handleShowQr() {
    const bundle = exportBundleFor(uid)
    if (!bundle) return
    setQrDataUrl(await bundleToQrDataUrl(JSON.stringify(bundle)))
    setShowQr(true)
  }

  function handleDownloadKeyFile() {
    const bundle = exportBundleFor(uid)
    if (!bundle) return
    downloadBlob(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), 'marginal-account-key.json')
  }

  function handleForgetKey() {
    if (!confirm("Forget this device's copy of the encryption key? Local data is kept exactly as is — this device just can't sync until you import the key again. You'll stay signed into Google.")) return
    forgetLocalKey(uid)
    onKeyForgotten()
  }

  return (
    <div className="sync-account-panel">
      <div className="sync-row">
        <button className="btn btn-sm" onClick={handleShowQr}>
          📱 Show transfer QR
        </button>
        <button className="btn btn-sm" onClick={handleDownloadKeyFile}>
          ⬇ Download key file
        </button>
        <button className="btn btn-sm btn-ghost btn-danger" onClick={handleForgetKey}>
          Forget key on this device
        </button>
      </div>

      {showQr && (
        <div className="sync-qr-block">
          <img src={qrDataUrl} alt="Encryption key transfer QR code" width={200} height={200} />
          <p className="muted">
            Scan this on a new device signed into the same Google account (Sync settings → Scan QR) to unlock your data there. Anyone with this code can read your synced data if they can also sign into this Google account —
            treat it like a password.
          </p>
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

      <p className="sync-reset-toggle">
        <button className="btn-link-muted" disabled={status.kind === 'running'} onClick={handleForceResync}>
          Not seeing something you expect? Force a full resync
        </button>
      </p>
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
