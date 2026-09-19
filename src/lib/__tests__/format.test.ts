import { describe, expect, it } from 'vitest'
import { formatBytes } from '../format'

describe('formatBytes', () => {
  it('shows bytes below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('shows KB with one decimal below 10, none at or above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(500 * 1024)).toBe('500 KB')
  })

  it('shows MB once past 1024 KB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB')
  })

  it('shows GB once past 1024 MB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })

  it('never goes past GB', () => {
    expect(formatBytes(5000 * 1024 * 1024 * 1024)).toBe('5000 GB')
  })
})
