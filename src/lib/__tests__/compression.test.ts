import { describe, expect, it } from 'vitest'
import { gzipCompress, gzipCompressBytes, gzipDecompress, gzipDecompressBytes } from '../compression'

describe('gzipCompress / gzipDecompress', () => {
  it('round-trips an ordinary string', async () => {
    const text = 'Hello, world! '.repeat(50)
    const compressed = await gzipCompress(text)
    expect(await gzipDecompress(compressed)).toBe(text)
  })

  it('round-trips an empty string', async () => {
    const compressed = await gzipCompress('')
    expect(await gzipDecompress(compressed)).toBe('')
  })

  it('round-trips unicode text', async () => {
    const text = '日本語のテキスト — émojis 🎉🎉🎉 and math ∑∫√'
    const compressed = await gzipCompress(text)
    expect(await gzipDecompress(compressed)).toBe(text)
  })

  it('meaningfully shrinks highly repetitive text (the layout extractor\'s own shape)', async () => {
    const text = '<span style="position:absolute;left:10px;top:20px;font-size:12px;color:#000;">word</span>'.repeat(200)
    const compressed = await gzipCompress(text)
    expect(compressed.byteLength).toBeLessThan(new TextEncoder().encode(text).length * 0.1)
  })

  it('returns a Uint8Array, not something JSON.stringify would mangle', async () => {
    const compressed = await gzipCompress('x')
    expect(compressed).toBeInstanceOf(Uint8Array)
  })
})

describe('gzipCompressBytes / gzipDecompressBytes', () => {
  it('round-trips arbitrary binary data byte-for-byte', async () => {
    const bytes = new Uint8Array(2000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256
    const compressed = await gzipCompressBytes(bytes)
    const decompressed = await gzipDecompressBytes(compressed)
    expect(Array.from(decompressed)).toEqual(Array.from(bytes))
  })

  it('round-trips an empty byte array', async () => {
    const compressed = await gzipCompressBytes(new Uint8Array(0))
    const decompressed = await gzipDecompressBytes(compressed)
    expect(decompressed.length).toBe(0)
  })

  it("compressed output starts with the gzip magic bytes (what PDF-blob compression detection relies on)", async () => {
    const compressed = await gzipCompressBytes(new Uint8Array([1, 2, 3]))
    expect(compressed[0]).toBe(0x1f)
    expect(compressed[1]).toBe(0x8b)
  })
})
