import { useEffect, useState } from 'preact/hooks'
import { SourcesView } from './components/sources/SourcesView'
import { PdfSearchView } from './components/sources/PdfSearchView'
import { QuoteBankView } from './components/quotes/QuoteBankView'
import { EssaysView } from './components/essays/EssaysView'
import { SyncSettingsDialog } from './components/sync/SyncSettingsDialog'
import { BackupDialog } from './components/backup/BackupDialog'
import { ConfirmHost } from './components/ConfirmDialog'
import { PromptHost } from './components/PromptDialog'
import { getLastAutoSyncStatus, onAutoSyncStatus, startAutoSyncLoop, type AutoSyncStatus } from './sync/autoSync'
import { detectHostingConfig, getStoredFirebaseConfig, setFirebaseConfig } from './sync/firebaseConfig'
import { Icon } from './components/Icon'
import { TodoDrawer } from './components/todos/TodoDrawer'

type Tab = 'essays' | 'sources' | 'quotes' | 'search'

export function App() {
  const [tab, setTab] = useState<Tab>('essays')
  const [showSync, setShowSync] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  // Auto-sync runs silently every 30s in the background (startAutoSyncLoop,
  // below) — without this, a failing background pass had genuinely no
  // visible trace anywhere short of opening Sync settings and clicking
  // "Sync now" yourself to reproduce it. This is what makes a stuck sync
  // (the corrupted-essay-history bug, or anything else) actually visible
  // without having to go looking for it.
  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus | null>(() => getLastAutoSyncStatus())

  // A no-op until a Firebase project and an account are both configured —
  // see startAutoSyncLoop's own doc comment. Started once, here, rather
  // than from inside the sync dialog, so a device keeps syncing on its
  // 30s interval even while that dialog isn't open.
  useEffect(() => onAutoSyncStatus(setAutoSyncStatus), [])

  useEffect(() => {
    startAutoSyncLoop()

    // If this copy of the app is itself being served from its own project's
    // Firebase Hosting, that project's config is available with nothing
    // pasted in — see detectHostingConfig()'s own doc comment. Skipped
    // entirely once a config has been pasted in by hand (source: 'manual'):
    // an explicit choice always wins over whatever the current origin
    // happens to auto-serve.
    const stored = getStoredFirebaseConfig()
    if (stored?.source === 'manual') return
    detectHostingConfig().then((result) => {
      if (result.status === 'found') setFirebaseConfig(result.config, 'auto')
      // 'invalid' is surfaced in the Sync settings dialog itself (it needs
      // the diagnostic message on screen, not just a console log) rather
      // than handled here.
    })
  }, [])

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">Marginal</div>
        <div className="tabs">
          <button className={`tab${tab === 'essays' ? ' active' : ''}`} onClick={() => setTab('essays')}>
            Drafts
          </button>
          <button className={`tab${tab === 'sources' ? ' active' : ''}`} onClick={() => setTab('sources')}>
            Sources
          </button>
          <button className={`tab${tab === 'quotes' ? ' active' : ''}`} onClick={() => setTab('quotes')}>
            Quotes
          </button>
          <button className={`tab${tab === 'search' ? ' active' : ''}`} onClick={() => setTab('search')}>
            Search PDFs
          </button>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setShowBackup(true)}>
          <Icon name="backup" /> <span className="btn-label">Backup</span>
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ position: 'relative' }}
          title={autoSyncStatus && !autoSyncStatus.ok ? `Last sync failed: ${autoSyncStatus.message}` : undefined}
          onClick={() => setShowSync(true)}
        >
          <Icon name="sync" /> <span className="btn-label">Sync</span>
          {autoSyncStatus && !autoSyncStatus.ok && (
            <span
              style={{ position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: '50%', background: '#a23b2c' }}
              aria-label="Last sync failed"
            />
          )}
        </button>
      </div>
      <TodoDrawer />
      <div className="main-area">
        {tab === 'essays' && <EssaysView />}
        {tab === 'sources' && <SourcesView />}
        {tab === 'quotes' && <QuoteBankView />}
        {tab === 'search' && <PdfSearchView />}
      </div>
      {showSync && <SyncSettingsDialog onClose={() => setShowSync(false)} />}
      {showBackup && <BackupDialog onClose={() => setShowBackup(false)} />}
      <ConfirmHost />
      <PromptHost />
    </div>
  )
}
