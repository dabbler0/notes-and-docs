import { describe, expect, it } from 'vitest'
import { gzipCompress, gzipDecompress } from '../compression'

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
