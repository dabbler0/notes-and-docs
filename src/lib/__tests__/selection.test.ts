import { afterEach, describe, expect, it } from 'vitest'
import { extractRangeHtml } from '../selection'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('extractRangeHtml and equation markers', () => {
  it('strips a math marker’s portal-rendered children out of extracted content, keeping its data attributes', () => {
    const container = document.createElement('div')
    container.innerHTML =
      'Before. <span class="math-inline" data-math-id="m1" data-latex="a+b" contenteditable="false"><span class="math-rendered"><span class="katex">rendered</span></span></span> After.'
    document.body.appendChild(container)

    const range = document.createRange()
    range.selectNodeContents(container)
    const html = extractRangeHtml(range)

    expect(html).toContain('<span class="math-inline" data-math-id="m1" data-latex="a+b" contenteditable="false"></span>')
    expect(html).not.toContain('math-rendered')
    expect(html).not.toContain('katex')
  })

  it('leaves content with no equation markers untouched', () => {
    const container = document.createElement('div')
    container.innerHTML = 'Just <strong>some</strong> text.'
    document.body.appendChild(container)

    const range = document.createRange()
    range.selectNodeContents(container)
    expect(extractRangeHtml(range)).toBe('Just <strong>some</strong> text.')
  })
})
