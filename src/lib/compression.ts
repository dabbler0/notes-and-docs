/**
 * Gzip compression for a plain string, via the browser's own
 * `CompressionStream`/`DecompressionStream` (no extra dependency — Chrome
 * 80+, Firefox 113+, Safari 16.4+ all have it, comfortably within the
 * "assume a modern evergreen browser" bar this app already sets elsewhere,
 * e.g. `crypto.subtle`). Used by `sourcesRepo.ts` to shrink
 * `Source.pageHtml` before it's ever written to disk or synced — see that
 * module's own doc comment for why: the layout extractor's own inline
 * `style` attributes and base64 image data are both highly repetitive text,
 * exactly what gzip is good at, and this is a much smaller, lower-risk
 * change than inventing a whole new binary document format to get the same
 * space back.
 */

// A plain `ReadableStream` wrapping already-in-memory bytes, rather than
// `new Blob([...]).stream()` — jsdom's own `Blob` (what the test suite runs
// against) doesn't implement `.stream()` at all, while every runtime here
// actually needs to work under (real browsers, and Node via the test suite)
// does implement `ReadableStream`/`CompressionStream`/`Response` directly.
function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

// TypeScript's own DOM lib types `CompressionStream`/`DecompressionStream`'s
// `writable` side as accepting the broader `BufferSource`, which doesn't
// structurally satisfy `pipeThrough`'s `ReadableWritablePair<Uint8Array,
// Uint8Array>` even though every real implementation accepts a Uint8Array
// (a BufferSource) just fine — a known gap in the lib types, not a real
// runtime mismatch, so this is the narrow cast that papers over it.
function pipe(stream: ReadableStream<Uint8Array>, transform: CompressionStream | DecompressionStream): ReadableStream<Uint8Array> {
  return stream.pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
}

/** The byte-level primitives — used directly by `localBackend.ts` to
 * compress a PDF blob's own raw bytes (no text encoding step involved, and
 * usually little to gain: a PDF's own internal streams are very often
 * already Flate/DCT-compressed, so this mostly helps the PDFs that
 * *aren't* — a scanned PDF with uncompressed raster pages, for instance),
 * and by `gzipCompress`/`gzipDecompress` below for the plain-string case. */
export async function gzipCompressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = pipe(toReadableStream(bytes), new CompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

export async function gzipDecompressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = pipe(toReadableStream(bytes), new DecompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

export async function gzipCompress(text: string): Promise<Uint8Array> {
  return gzipCompressBytes(new TextEncoder().encode(text))
}

export async function gzipDecompress(bytes: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await gzipDecompressBytes(bytes))
}
