/**
 * An in-memory stand-in for `createLocalBackend()` (`src/storage/localBackend.ts`),
 * used only in tests (see `src/test/setup.ts`, which mocks `../storage` to
 * this module).
 *
 * `backend` (the thing actually exported in place of the real module's
 * singleton) is one long-lived proxy object for the whole test file — it
 * forwards every call to whichever real in-memory backend is currently
 * "active." `deviceHarness.ts` gives each simulated device its own real
 * backend (via `createFakeBackend()`) and swaps it in as the active one
 * for the duration of each call into that device, the same way it swaps
 * `localStorage` — deliberately *not* relying on `vi.resetModules()` to
 * hand back a fresh backend on each re-import: unlike a plain source
 * module, a `vi.mock(...)` factory's result isn't guaranteed to be
 * re-evaluated on every reset, and depending on that turned out to leak
 * one shared backend across every "device" in a test file.
 */
import type { Backend, BlobStore, DocStore } from '../storage/types'

class InMemoryDocStore implements DocStore {
  private data = new Map<string, unknown>()

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    return this.data.get(`${collection}/${id}`) as T | undefined
  }

  async put<T extends { id: string }>(collection: string, doc: T): Promise<void> {
    this.data.set(`${collection}/${doc.id}`, structuredClone(doc))
  }

  async delete(collection: string, id: string): Promise<void> {
    this.data.delete(`${collection}/${id}`)
  }

  async list<T>(collection: string): Promise<T[]> {
    const prefix = `${collection}/`
    const out: T[] = []
    for (const [key, value] of this.data.entries()) {
      if (key.startsWith(prefix)) out.push(structuredClone(value) as T)
    }
    return out
  }

  async listSince<T>(collection: string, since: number): Promise<T[]> {
    const prefix = `${collection}/`
    const out: T[] = []
    for (const [key, value] of this.data.entries()) {
      if (!key.startsWith(prefix)) continue
      const updatedAt = (value as { updatedAt?: number }).updatedAt ?? 0
      if (updatedAt > since) out.push(structuredClone(value) as T)
    }
    return out
  }
}

class InMemoryBlobStore implements BlobStore {
  private data = new Map<string, Blob>()

  async put(id: string, blob: Blob): Promise<void> {
    this.data.set(id, blob)
  }

  async get(id: string): Promise<Blob | undefined> {
    return this.data.get(id)
  }

  async delete(id: string): Promise<void> {
    this.data.delete(id)
  }

  async has(id: string): Promise<boolean> {
    return this.data.has(id)
  }

  async sizeOf(id: string): Promise<number | undefined> {
    return this.data.get(id)?.size
  }
}

export function createFakeBackend(): Backend {
  return { kind: 'local', docs: new InMemoryDocStore(), blobs: new InMemoryBlobStore() }
}

let active: Backend = createFakeBackend()

/** Test-only: not part of the real storage API. Called by deviceHarness.ts to route the next call through a given device's own backend. */
export function __setActiveBackend(b: Backend): void {
  active = b
}

/** The stand-in for the real module's `backend` singleton — a stable proxy that always forwards to whichever backend is currently active. */
export const backend: Backend = {
  kind: 'local',
  docs: {
    get<T>(collection: string, id: string) {
      return active.docs.get<T>(collection, id)
    },
    put<T extends { id: string }>(collection: string, doc: T) {
      return active.docs.put<T>(collection, doc)
    },
    delete(collection: string, id: string) {
      return active.docs.delete(collection, id)
    },
    list<T>(collection: string) {
      return active.docs.list<T>(collection)
    },
    listSince<T>(collection: string, since: number) {
      return active.docs.listSince<T>(collection, since)
    },
  } as DocStore,
  blobs: {
    put(id: string, blob: Blob) {
      return active.blobs.put(id, blob)
    },
    get(id: string) {
      return active.blobs.get(id)
    },
    delete(id: string) {
      return active.blobs.delete(id)
    },
    has(id: string) {
      return active.blobs.has(id)
    },
    sizeOf(id: string) {
      return active.blobs.sizeOf(id)
    },
  } as BlobStore,
}
