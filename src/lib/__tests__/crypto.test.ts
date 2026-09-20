import { describe, expect, it } from 'vitest'
import { decryptJson, encryptJson, generateKeyBundle } from '../crypto'

describe('encryptJson / decryptJson', () => {
  it('round-trips plain JSON values same as before', async () => {
    const { cryptoKey } = await generateKeyBundle()
    const value = { a: 'text', b: 42, c: [1, 2, 3], d: null }
    const field = await encryptJson(cryptoKey, value)
    expect(await decryptJson(cryptoKey, field)).toEqual(value)
  })

  it('round-trips a Uint8Array nested inside the value as real bytes, not a per-byte object', async () => {
    const { cryptoKey } = await generateKeyBundle()
    const bytes = new Uint8Array([31, 139, 8, 0, 255, 0, 1])
    const value = { pageHtmlCompressed: bytes, pdfFileName: 'paper.pdf' }
    const field = await encryptJson(cryptoKey, value)
    const decoded = await decryptJson<typeof value>(cryptoKey, field)
    expect(decoded.pdfFileName).toBe('paper.pdf')
    expect(decoded.pageHtmlCompressed).toBeInstanceOf(Uint8Array)
    expect(Array.from(decoded.pageHtmlCompressed)).toEqual(Array.from(bytes))
  })

  it('round-trips an empty Uint8Array', async () => {
    const { cryptoKey } = await generateKeyBundle()
    const value = { bytes: new Uint8Array(0) }
    const field = await encryptJson(cryptoKey, value)
    const decoded = await decryptJson<typeof value>(cryptoKey, field)
    expect(decoded.bytes).toBeInstanceOf(Uint8Array)
    expect(decoded.bytes.length).toBe(0)
  })
})
