/** Formats a byte count as a short human-readable size, e.g. "842 B",
 * "3.4 MB", "1.2 GB" — one decimal place below 10 of a unit, none above,
 * so the label stays compact in a badge or a card without ever needing more
 * than a handful of characters. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`
}
