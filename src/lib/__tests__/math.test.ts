import { describe, expect, it } from 'vitest'
import { renderMathHtml } from '../math'

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
