import { formatBytes } from '../../lib/format'
import { FIREBASE_STORAGE_LIMIT_BYTES } from '../../sync/storageUsage'

/** Thin "X of 1 GB used" meter for the top of the Sources tab — `bytes` is
 * `estimateFirebaseStorageBytes()`'s own estimate (see that function's own
 * doc comment for what it does and doesn't account for), `null` while
 * that's still loading. Renders nothing while loading rather than a
 * placeholder bar at 0%, which would misleadingly flash "empty" for a
 * library that's actually using most of its quota. */
export function StorageUsageBar({ bytes }: { bytes: number | null }) {
  if (bytes === null) return null

  const fraction = Math.min(1, bytes / FIREBASE_STORAGE_LIMIT_BYTES)
  const nearLimit = fraction >= 0.9

  return (
    <div className="storage-usage" title="Estimated Firebase storage used by this account, synced data only">
      <div className="storage-usage-track">
        <div className={`storage-usage-fill${nearLimit ? ' storage-usage-fill-warn' : ''}`} style={{ width: `${fraction * 100}%` }} />
      </div>
      <span className={`storage-usage-label${nearLimit ? ' error-text' : ' muted'}`}>
        {formatBytes(bytes)} of {formatBytes(FIREBASE_STORAGE_LIMIT_BYTES)} used (estimated)
      </span>
    </div>
  )
}
