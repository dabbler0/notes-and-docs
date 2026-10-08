import { describe, expect, it } from 'vitest'
import { emptyMathMarkers, renderMathHtml } from '../math'

describe('renderMathHtml', () => {
  it('renders valid LaTeX to KaTeX markup', () => {
    const html = renderMathHtml('x^2 + y^2 = z^2', false)
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('katex-display')
  })

  it('wraps display-mode output in katex-display', () => {
    const html = renderMathHtml('x^2', true)
    expect(html).toContain('katex-display')
  })

  it('renders unparseable LaTeX as an inline error instead of throwing', () => {
    expect(() => renderMathHtml('\\frac{1', false)).not.toThrow()
    const html = renderMathHtml('\\frac{1', false)
    expect(html).toContain('katex-error')
  })
})

describe('emptyMathMarkers', () => {
  it('clears a math marker’s own children while keeping its attributes', () => {
    const div = document.createElement('div')
    div.innerHTML = '<span class="math-inline" data-math-id="m1" data-latex="x"><span class="katex">rendered</span></span>'
    const result = emptyMathMarkers(div)
    expect(result).toBe(div)
    expect(div.innerHTML).toBe('<span class="math-inline" data-math-id="m1" data-latex="x"></span>')
  })

  it('clears every marker when more than one is present', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<span class="math-inline" data-math-id="m1"><span class="katex">a</span></span> and <span class="math-block" data-math-id="m2"><span class="katex">b</span></span>'
    emptyMathMarkers(div)
    expect(div.innerHTML).toBe('<span class="math-inline" data-math-id="m1"></span> and <span class="math-block" data-math-id="m2"></span>')
  })

  it('leaves content with no markers untouched', () => {
    const div = document.createElement('div')
    div.innerHTML = 'Just <strong>text</strong>.'
    emptyMathMarkers(div)
    expect(div.innerHTML).toBe('Just <strong>text</strong>.')
  })
})
