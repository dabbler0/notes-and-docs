/**
 * The one small piece of *remote* state about a device's encryption key:
 * not the key itself (never uploaded), just a fingerprint of it — so a
 * second device signing into the same Google account can tell "this
 * account already has a key established elsewhere, and mine doesn't match
 * it" *before* syncing anything, rather than silently writing ciphertext
 * nothing else can decrypt. Firestore rules scope `accounts/{uid}/...` to
 * that same signed-in uid, so only the account's own owner can even read
 * whether this doc exists.
 */
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import { firestoreDb } from './firebaseClient'

export interface AccountMeta {
  keyFingerprint: string
  createdAt: number
}

function metaDocRef(uid: string) {
  return doc(firestoreDb(), 'accounts', uid, 'meta', 'account')
}

export async function getAccountMeta(uid: string): Promise<AccountMeta | null> {
  const snap = await getDoc(metaDocRef(uid))
  return snap.exists() ? (snap.data() as AccountMeta) : null
}

export async function setAccountMeta(uid: string, keyFingerprint: string): Promise<void> {
  await setDoc(metaDocRef(uid), { keyFingerprint, createdAt: Date.now() })
}

const TOP_COLLECTIONS = ['essays', 'nodes', 'sources'] as const

/**
 * The "I lost my key file" last resort: deletes every remote document this
 * account has (structured records, PDF blob manifests and chunks, and the
 * fingerprint doc itself), so the account can start over from a brand-new
 * key. Local data on this device is completely untouched — this only
 * wipes the *remote* ciphertext copy, which is unusable without the lost
 * key anyway. Callers should re-push everything fresh immediately after
 * (see resetSyncState() in syncEngine.ts) and make this hard to reach by
 * accident: it is genuine, irreversible data loss for every other device
 * still relying on the old key.
 */
export async function wipeRemoteAccountData(uid: string): Promise<void> {
  const db = firestoreDb()
  for (const col of TOP_COLLECTIONS) {
    const snap = await getDocs(collection(db, 'accounts', uid, col))
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)))
  }
  const blobsSnap = await getDocs(collection(db, 'accounts', uid, 'blobs'))
  for (const blobDoc of blobsSnap.docs) {
    const chunksSnap = await getDocs(collection(db, 'accounts', uid, 'blobs', blobDoc.id, 'chunks'))
    await Promise.all(chunksSnap.docs.map((d) => deleteDoc(d.ref)))
    await deleteDoc(blobDoc.ref)
  }
  await deleteDoc(metaDocRef(uid)).catch(() => {
    /* already gone — fine */
  })
}
