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

export async function setDoc(ref: DocRef, data: Record<string, unknown>): Promise<void> {
  assertNoUndefined(data, ref.path)
  __getFakeCloud().set(ref.path, structuredClone(data))
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
