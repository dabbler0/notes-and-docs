/**
 * Simulates one "device" for the sync tests: its own local database, its
 * own local encryption-key storage, its own Firebase Auth session — all
 * talking to one *shared* fake Firestore "cloud" (see fakeFirestore.ts),
 * exactly like several real browsers/devices would. `newDevice()` does a
 * `vi.resetModules()` and re-imports every sync/data module fresh, so each
 * device's module-scope state (firebaseClient.ts's cached app/auth/db,
 * account.ts's key cache, syncEngine.ts's nothing-module-scoped-but-still)
 * starts clean, the way a real separate browser tab would.
 *
 * `localStorage` itself is one global object in the test process (jsdom
 * provides a single one), so on top of resetModules() each device gets its
 * *own* fake Storage instance (fakeStorage.ts) that gets swapped in as
 * `globalThis.localStorage` for the duration of each call into that
 * device — see `withStorage` below. This is what actually keeps two
 * devices' local key material and sync cursors from leaking into each
 * other, the same way two real machines' browser profiles would never
 * share one.
 */
import { vi } from 'vitest'
import { createFakeStorage } from './fakeStorage'
import type { Backend } from '../storage/types'
import type { Essay, EssayNode, Source, BibtexEntry } from '../models/types'
import type { KeyBundle } from '../lib/crypto'
import type { LocalKey } from '../sync/account'
import type { AccountMeta } from '../sync/accountMeta'
import type { SyncResult } from '../sync/syncEngine'

const DEFAULT_CONFIG = { apiKey: 'fake', authDomain: 'fake.firebaseapp.com', projectId: 'fake-project', appId: '1:fake:web:fake' }

/**
 * `../storage` is mocked (see setup.ts) to `fakeBackend.ts`'s exports —
 * which, beyond the real module's own `backend`, also carries two
 * test-only functions this harness needs (`createFakeBackend`,
 * `__setActiveBackend`). Getting them by importing `../storage` itself
 * (rather than `./fakeBackend` directly) matters: `vi.mock`'s replacement
 * module isn't guaranteed to be the exact same module-identity instance as
 * a plain import of the underlying file would resolve to, so reaching for
 * them the "direct" way silently ended up controlling a *different*,
 * disconnected copy of the fake's internal state — this makes sure the
 * harness's calls land on the identical instance every real sync-module
 * import of `../storage` also resolves to.
 */
interface FakeStorageModule {
  backend: Backend
  createFakeBackend(): Backend
  __setActiveBackend(b: Backend): void
}

export interface Device {
  uid: string | null
  signIn(email: string): Promise<string>
  signOut(): Promise<void>

  createEssay(title: string): Promise<Essay>
  getEssay(id: string): Promise<Essay | undefined>
  saveEssay(essay: Essay): Promise<void>
  getNode(id: string): Promise<EssayNode | undefined>
  saveNode(node: EssayNode): Promise<void>
  /** Writes a node straight to local storage, bypassing saveNode's own `updatedAt = Date.now()` stamp — for tests that need to construct an exact, explicit timestamp rather than whatever the wall clock happens to produce. */
  putNodeRaw(node: EssayNode): Promise<void>
  /** Same as putNodeRaw, for essays. */
  putEssayRaw(essay: Essay): Promise<void>
  createChildNode(essayId: string, title: string, initialContent?: string): Promise<EssayNode>
  deleteEssay(id: string): Promise<void>
  listEssays(): Promise<Essay[]>

  createSource(bibtex: BibtexEntry, opts?: { comment?: string; pdfFile?: File; pageTexts?: string[] }): Promise<Source>
  getSource(id: string): Promise<Source | undefined>
  listSources(): Promise<Source[]>
  getSourcePdfBlob(source: Source): Promise<Blob | undefined>

  hasLocalKey(): boolean
  createLocalKey(): Promise<LocalKey>
  importLocalKey(bundle: KeyBundle): Promise<LocalKey>
  exportBundle(): KeyBundle | null
  forgetLocalKey(): void

  getAccountMeta(): Promise<AccountMeta | null>
  setAccountMeta(fingerprint: string): Promise<void>
  wipeRemoteAccountData(): Promise<void>

  sync(onProgress?: (message: string) => void): Promise<SyncResult>
  forceFullResync(onProgress?: (message: string) => void): Promise<SyncResult>
}

export async function newDevice(config = DEFAULT_CONFIG): Promise<Device> {
  vi.resetModules()
  const storage = createFakeStorage()
  // Imported fresh from the mocked specifier (see FakeStorageModule's own
  // doc comment above for why this has to go through '../storage' rather
  // than a direct './fakeBackend' import).
  const storageMod = (await import('../storage')) as unknown as FakeStorageModule
  const deviceBackend = storageMod.createFakeBackend()

  function withStorage<T>(fn: () => T): T {
    const prev = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
    storageMod.__setActiveBackend(deviceBackend)
    try {
      return fn()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true, writable: true })
    }
  }
  async function withStorageAsync<T>(fn: () => Promise<T>): Promise<T> {
    // Swapping only around the synchronous call-start isn't enough — the
    // async function's *body* keeps running (and reading localStorage /
    // touching the backend) after this returns a pending promise, once
    // we've already restored the previous device's storage. So the swap
    // has to stay in place for the whole awaited duration, not just until
    // the first `await` inside.
    const prev = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
    storageMod.__setActiveBackend(deviceBackend)
    try {
      return await fn()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: prev, configurable: true, writable: true })
    }
  }

  const firebaseConfigMod = await import('../sync/firebaseConfig')
  withStorage(() => firebaseConfigMod.setFirebaseConfig(config, 'manual'))

  const firebaseClientMod = await import('../sync/firebaseClient')
  const accountMod = await import('../sync/account')
  const accountMetaMod = await import('../sync/accountMeta')
  const syncEngineMod = await import('../sync/syncEngine')
  const essaysRepoMod = await import('../models/essaysRepo')
  const sourcesRepoMod = await import('../models/sourcesRepo')

  const device: Device = {
    uid: null,

    async signIn(email) {
      const user = await withStorageAsync(() => firebaseClientMod.signInForTesting(email))
      device.uid = user.uid
      return user.uid
    },
    async signOut() {
      await withStorageAsync(() => firebaseClientMod.signOutOfGoogle())
      device.uid = null
    },

    createEssay: (title) => withStorageAsync(() => essaysRepoMod.createEssay(title)),
    getEssay: (id) => withStorageAsync(() => essaysRepoMod.getEssay(id)),
    saveEssay: (essay) => withStorageAsync(() => essaysRepoMod.saveEssay(essay)),
    getNode: (id) => withStorageAsync(() => essaysRepoMod.getNode(id)),
    saveNode: (node) => withStorageAsync(() => essaysRepoMod.saveNode(node)),
    putNodeRaw: (node) => withStorageAsync(() => storageMod.backend.docs.put('nodes', node)),
    putEssayRaw: (essay) => withStorageAsync(() => storageMod.backend.docs.put('essays', essay)),
    createChildNode: (essayId, title, initialContent) => withStorageAsync(() => essaysRepoMod.createChildNode(essayId, title, initialContent)),
    deleteEssay: (id) => withStorageAsync(() => essaysRepoMod.deleteEssay(id)),
    listEssays: () => withStorageAsync(() => essaysRepoMod.listEssays()),

    createSource: (bibtex, opts) => withStorageAsync(() => sourcesRepoMod.createSource(bibtex, opts)),
    getSource: (id) => withStorageAsync(() => sourcesRepoMod.getSource(id)),
    listSources: () => withStorageAsync(() => sourcesRepoMod.listSources()),
    getSourcePdfBlob: (source) => withStorageAsync(() => sourcesRepoMod.getSourcePdfBlob(source)),

    hasLocalKey: () => withStorage(() => accountMod.hasLocalKey(device.uid!)),
    createLocalKey: () => withStorageAsync(() => accountMod.createLocalKey(device.uid!)),
    importLocalKey: (bundle) => withStorageAsync(() => accountMod.importLocalKey(device.uid!, bundle)),
    exportBundle: () => withStorage(() => accountMod.exportBundleFor(device.uid!)),
    forgetLocalKey: () => withStorage(() => accountMod.forgetLocalKey(device.uid!)),

    getAccountMeta: () => withStorageAsync(() => accountMetaMod.getAccountMeta(device.uid!)),
    setAccountMeta: (fp) => withStorageAsync(() => accountMetaMod.setAccountMeta(device.uid!, fp)),
    wipeRemoteAccountData: () => withStorageAsync(() => accountMetaMod.wipeRemoteAccountData(device.uid!)),

    sync: (onProgress) => withStorageAsync(() => syncEngineMod.runSyncPass(onProgress)),
    forceFullResync: (onProgress) =>
      withStorageAsync(async () => {
        syncEngineMod.resetSyncState()
        return syncEngineMod.runSyncPass(onProgress)
      }),
  }
  return device
}

/** Convenience for "sign in, then bootstrap or import a key" in one step — the common setup for most tests below. */
export async function newDeviceSignedIn(email: string, config?: typeof DEFAULT_CONFIG): Promise<Device> {
  const device = await newDevice(config)
  await device.signIn(email)
  return device
}
