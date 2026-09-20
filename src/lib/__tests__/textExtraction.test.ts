import { describe, expect, it } from 'vitest'
import { htmlToPlainText, plainTextToHtml } from '../textExtraction'

describe('plainTextToHtml', () => {
  it('wraps a single paragraph in <p>', () => {
    expect(plainTextToHtml('Hello world.')).toBe('<p>Hello world.</p>')
  })

  it('turns a blank-line-separated paragraph into its own <p>', () => {
    expect(plainTextToHtml('First paragraph.\n\nSecond paragraph.')).toBe('<p>First paragraph.</p><p>Second paragraph.</p>')
  })

  it('turns a single line break within a paragraph into <br>', () => {
    expect(plainTextToHtml('Line one.\nLine two.')).toBe('<p>Line one.<br>Line two.</p>')
  })

  it('escapes HTML-significant characters', () => {
    expect(plainTextToHtml('<script>alert(1)</script> & "quotes"')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes"</p>')
  })

  it('drops blank/whitespace-only paragraphs and returns empty for blank input', () => {
    expect(plainTextToHtml('')).toBe('')
    expect(plainTextToHtml('   \n\n   ')).toBe('')
  })
})

describe('htmlToPlainText', () => {
  it('returns empty string for empty/falsy input', () => {
    expect(htmlToPlainText('')).toBe('')
  })

  it('reads plain text straight through', () => {
    expect(htmlToPlainText('<p>Hello world.</p>')).toBe('Hello world.')
  })

  it('turns <br> into a line break', () => {
    expect(htmlToPlainText('<p>Line one.<br>Line two.</p>')).toBe('Line one.\nLine two.')
  })

  it('turns adjacent <p> elements into a paragraph break', () => {
    expect(htmlToPlainText('<p>First.</p><p>Second.</p>')).toBe('First.\n\nSecond.')
  })

  it('contributes nothing for an <img>', () => {
    expect(htmlToPlainText('<p>Before</p><img src="data:image/png;base64,x"><p>After</p>')).toBe('Before\n\nAfter')
  })

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('<p>&lt;tag&gt; &amp; "quotes"</p>')).toBe('<tag> & "quotes"')
  })

  it('round-trips plainTextToHtml output back to equivalent plain text', () => {
    const original = 'First paragraph,\nwith a line break.\n\nSecond paragraph.'
    expect(htmlToPlainText(plainTextToHtml(original))).toBe(original)
  })
})
