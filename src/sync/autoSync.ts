/**
 * A deliberately simple sync loop: no realtime listeners, just a periodic
 * "run a pass" on an interval while the tab is open, plus whatever manual
 * "Sync now" presses add on top. Good enough for "rudimentary" — a device
 * that's been closed for a while just catches up on its next pass.
 */
import { runSyncPass } from './syncEngine'
import { getFirebaseConfig } from './firebaseConfig'
import { getStoredBundle } from './account'

const ENABLED_KEY = 'marginal.sync.autoEnabled.v1'
const INTERVAL_MS = 30_000

export function isAutoSyncEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== 'off'
}

export function setAutoSyncEnabled(enabled: boolean): void {
  localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off')
}

export interface AutoSyncStatus {
  at: number
  ok: boolean
  message: string
}

let lastStatus: AutoSyncStatus | null = null
let timer: number | undefined
const listeners = new Set<(status: AutoSyncStatus) => void>()

export function getLastAutoSyncStatus(): AutoSyncStatus | null {
  return lastStatus
}

export function onAutoSyncStatus(fn: (status: AutoSyncStatus) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function canSyncAtAll(): boolean {
  return !!getFirebaseConfig() && !!getStoredBundle()
}

async function tick() {
  if (!isAutoSyncEnabled() || !canSyncAtAll()) return
  try {
    await runSyncPass()
    lastStatus = { at: Date.now(), ok: true, message: 'Synced' }
  } catch (err) {
    lastStatus = { at: Date.now(), ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  listeners.forEach((fn) => fn(lastStatus!))
}

/** Call once at app startup. A no-op until both a Firebase project and an account are configured — it starts checking on its own interval only once those exist, and each tick re-checks so toggling "auto sync" off/on or forgetting the account takes effect without restarting the loop. */
export function startAutoSyncLoop(): void {
  if (timer !== undefined) return
  tick()
  timer = window.setInterval(tick, INTERVAL_MS)
}

/** Runs a pass right now, outside the regular interval — used by the "Sync now" button, and by anything that wants a progress callback (the loop's own ticks don't report progress, only success/failure). */
export async function syncNow(onProgress?: (message: string) => void) {
  const result = await runSyncPass(onProgress)
  lastStatus = { at: Date.now(), ok: true, message: 'Synced' }
  listeners.forEach((fn) => fn(lastStatus!))
  return result
}
