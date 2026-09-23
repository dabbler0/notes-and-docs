/**
 * Stand-in for `firebase/firestore`, used only in tests (see
 * `src/test/setup.ts`). An in-memory document store implementing just the
 * handful of calls this app's sync code actually makes (`doc`, `collection`,
 * `getDoc`, `getDocs`, `query` + `where('field', '>', value)`, `setDoc`,
 * `deleteDoc`) — enough to run `syncEngine.ts`/`accountMeta.ts` for real
 * against something that behaves like Firestore, without a network or a
 * real emulator process.
 *
 * The documents themselves live in `globalThis.__fakeFirestoreCloud`
 * rather than ordinary module-scope state, specifically so they survive
 * `vi.resetModules()` — `deviceHarness.ts` resets the module registry to
 * simulate a fresh "device" (a real browser reloading the SDK from
 * scratch), but the whole point of these tests is that the *remote* data
 * they all talk to is shared and persists across that. Call
 * `__resetFakeCloud()` between independent test cases to start clean.
 */
export function __getFakeCloud(): Map<string, Record<string, unknown>> {
  const g = globalThis as unknown as { __fakeFirestoreCloud?: Map<string, Record<string, unknown>> }
  if (!g.__fakeFirestoreCloud) g.__fakeFirestoreCloud = new Map()
  return g.__fakeFirestoreCloud
}

export function __resetFakeCloud(): void {
  __getFakeCloud().clear()
}

interface FakeDb {
  __isFakeDb: true
}

interface DocRef {
  __isFakeDocRef: true
  path: string
  id: string
}

interface ColRef {
  __isFakeColRef: true
  path: string
}

type WhereClause = { field: string; op: string; value: unknown }

interface FakeQuery {
  __isFakeQuery: true
  col: ColRef
  clauses: WhereClause[]
}

function isDocRef(v: unknown): v is DocRef {
  return !!v && typeof v === 'object' && (v as DocRef).__isFakeDocRef === true
}
function isColRef(v: unknown): v is ColRef {
  return !!v && typeof v === 'object' && (v as ColRef).__isFakeColRef === true
}

export function getFirestore(): FakeDb {
  return { __isFakeDb: true }
}

export function connectFirestoreEmulator(): void {
  /* no-op */
}

/** Mirrors Firestore's own client-side validation: it refuses to write `undefined` anywhere in a document. Catches the same class of accidental-bug this app would otherwise hit for real. */
function assertNoUndefined(value: unknown, label: string): void {
  if (value === undefined) throw new Error(`Fake Firestore: unsupported field value: undefined (at ${label})`)
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${label}[${i}]`))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${label}.${k}`)
  }
}

// Real Firestore rejects a single field value over roughly this many UTF-8
// bytes — for a string field (the only kind this app ever writes something
// large enough to matter for), that's one byte per character for the
// plain-ASCII base64 this app always stores, so length works as a stand-in
// for byte count here. Caught a real production bug directly: a source's
// encrypted page text ran past this without the app-level chunking that's
// supposed to kick in first (see syncEngine.ts's own `_enc` chunking doc
// comment) — this check exists so a *future* regression of that same kind
// fails a test locally instead of only ever surfacing against real
// Firestore, in production, after the fact.
const MAX_FIELD_BYTES = 1_048_487

/** Mirrors Firestore's real rejection of an oversized *nested* field value
 * — its actual wording for this ("Property X contains an invalid nested
 * entity") is distinct from the top-level "Unsupported field value"
 * `assertNoUndefined` reproduces above, so this reproduces it separately
 * with its own matching message rather than piggybacking on that one. */
function assertNoOversizedField(value: unknown, label: string, depth = 0): void {
  if (typeof value === 'string' && value.length > MAX_FIELD_BYTES) {
    const kind = depth === 0 ? 'Unsupported field value' : 'invalid nested entity'
    throw new Error(`Fake Firestore: ${kind} — field longer than ${MAX_FIELD_BYTES} bytes (at ${label})`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoOversizedField(v, `${label}[${i}]`, depth + 1))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoOversizedField(v, `${label}.${k}`, depth + 1)
  }
}

export function doc(parent: FakeDb | DocRef | ColRef, ...segs: string[]): DocRef {
  if (segs.length === 0) throw new Error('doc() needs at least one path segment')
  const base = isDocRef(parent) || isColRef(parent) ? parent.path : ''
  const path = base ? `${base}/${segs.join('/')}` : segs.join('/')
  return { __isFakeDocRef: true, path, id: segs[segs.length - 1] }
}

export function collection(parent: FakeDb | DocRef | ColRef, ...segs: string[]): ColRef {
  if (segs.length === 0) throw new Error('collection() needs at least one path segment')
  const base = isDocRef(parent) || isColRef(parent) ? parent.path : ''
  const path = base ? `${base}/${segs.join('/')}` : segs.join('/')
  return { __isFakeColRef: true, path }
}

export function where(field: string, op: string, value: unknown): WhereClause {
  return { field, op, value }
}

export function query(col: ColRef, ...clauses: WhereClause[]): FakeQuery {
  return { __isFakeQuery: true, col, clauses }
}

// Real Firestore's client SDK caps how many individual write mutations can
// be in flight on its one write stream at once (around 500) — a genuine
// production bug (this app once fired hundreds of independent `setDoc()`
// calls via `Promise.all` for a large PDF/encrypted-payload's worth of
// chunks) hit exactly this: "Write stream exhausted maximum allowed queued
// writes." `writeBatch()`'s own 500-op cap (see below) only catches the
// case where writes are *already* batched — it says nothing about the
// unbatched `Promise.all`-of-many-`setDoc()`-calls pattern that actually
// caused the bug, which needs its own, separate simulation: this tracks
// how many `setDoc()` calls are simultaneously in flight (started but not
// yet resolved) and rejects once too many are, the same shape of failure
// real Firestore's stream limit produces. A real await point (not just an
// already-resolved microtask) matters here — it's what actually lets
// several concurrently-fired calls overlap in flight at once the way
// `Promise.all` would trigger for real, rather than each one finishing
// before the next even starts.
const MAX_CONCURRENT_WRITES = 500
let inFlightWrites = 0

/** `options.merge` mirrors real Firestore's shallow top-level merge (not a deep merge, not field-path merge — the one form this app's own code actually uses, in accountMeta.ts's markEncryptionVersion). Without it, setDoc replaces the whole document, same as real Firestore's own default. */
export async function setDoc(ref: DocRef, data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void> {
  inFlightWrites++
  try {
    // A microtask yield, not a macrotask (`setTimeout`) one: this needs to
    // let several concurrently-fired `setDoc()` calls actually interleave
    // in flight, which any real `await` already does regardless of what
    // it's awaiting — but a real timer would never fire at all under a
    // test using `vi.useFakeTimers()` (a real, hit-directly bug this had
    // at first) unless that test explicitly advanced it, which nothing
    // about ordinary Firestore usage should ever require a test to do.
    await Promise.resolve()
    if (inFlightWrites > MAX_CONCURRENT_WRITES) {
      throw new Error('Fake Firestore: Write stream exhausted maximum allowed queued writes.')
    }
    assertNoUndefined(data, ref.path)
    assertNoOversizedField(data, ref.path)
    const cloud = __getFakeCloud()
    if (options?.merge) {
      const existing = cloud.get(ref.path)
      cloud.set(ref.path, { ...(existing ? structuredClone(existing) : {}), ...structuredClone(data) })
    } else {
      cloud.set(ref.path, structuredClone(data))
    }
  } finally {
    inFlightWrites--
  }
}

const MAX_BATCH_WRITES = 500

/** Mirrors real Firestore's `writeBatch()`: queues `.set()` calls locally and only actually writes anything on `.commit()`, as one unit — real Firestore also caps a single batch at 500 writes and rejects a bigger one outright, which this reproduces too (see `syncEngine.ts`'s own chunked-write helper, which pages into batches of exactly this size specifically to respect it). */
export function writeBatch(_db: FakeDb): { set(ref: DocRef, data: Record<string, unknown>): void; commit(): Promise<void> } {
  const ops: { ref: DocRef; data: Record<string, unknown> }[] = []
  return {
    set(ref, data) {
      ops.push({ ref, data })
    },
    async commit() {
      if (ops.length > MAX_BATCH_WRITES) throw new Error(`Fake Firestore: a WriteBatch cannot have more than ${MAX_BATCH_WRITES} writes`)
      for (const { ref, data } of ops) await setDoc(ref, data)
    },
  }
}

interface DocSnap {
  exists(): boolean
  data(): Record<string, unknown> | undefined
  id: string
  ref: DocRef
}

export async function getDoc(ref: DocRef): Promise<DocSnap> {
  const cloud = __getFakeCloud()
  const value = cloud.get(ref.path)
  return {
    exists: () => value !== undefined,
    data: () => (value === undefined ? undefined : structuredClone(value)),
    id: ref.id,
    ref,
  }
}

export async function deleteDoc(ref: DocRef): Promise<void> {
  __getFakeCloud().delete(ref.path)
}

function matchesClause(data: Record<string, unknown>, clause: WhereClause): boolean {
  const actual = data[clause.field]
  switch (clause.op) {
    case '>':
      return typeof actual === 'number' && actual > (clause.value as number)
    case '>=':
      return typeof actual === 'number' && actual >= (clause.value as number)
    case '<':
      return typeof actual === 'number' && actual < (clause.value as number)
    case '<=':
      return typeof actual === 'number' && actual <= (clause.value as number)
    case '==':
      return actual === clause.value
    case '!=':
      return actual !== clause.value
    default:
      throw new Error(`Fake Firestore: unsupported where() operator ${clause.op}`)
  }
}

interface QuerySnap {
  docs: DocSnap[]
}

export async function getDocs(target: ColRef | FakeQuery): Promise<QuerySnap> {
  const cloud = __getFakeCloud()
  const col: ColRef = 'col' in target ? target.col : target
  const clauses: WhereClause[] = 'clauses' in target ? target.clauses : []
  const depth = col.path.split('/').length + 1 // direct children only, not deeper subcollections
  const docs: DocSnap[] = []
  for (const [path, value] of cloud.entries()) {
    if (!path.startsWith(`${col.path}/`)) continue
    if (path.split('/').length !== depth) continue
    if (!clauses.every((c) => matchesClause(value, c))) continue
    const id = path.slice(col.path.length + 1)
    docs.push({ exists: () => true, data: () => structuredClone(value), id, ref: { __isFakeDocRef: true, path, id } })
  }
  return { docs }
}

export type Firestore = FakeDb
