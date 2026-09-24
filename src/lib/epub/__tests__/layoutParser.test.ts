import { describe, expect, it } from 'vitest'
import { isLayoutHtml, parseLayoutPage } from '../layoutParser'

function span(text: string, x: number, y: number, fontSize: number): string {
  return `<span style="position:absolute;left:${x}px;top:${y}px;font-size:${fontSize}px;font-family:sans-serif;color:#000;white-space:pre;">${text}</span>`
}

function page(width: number, height: number, inner: string): string {
  return `<div style="position:relative;width:${width}px;height:${height}px;background:#fff;overflow:hidden;">${inner}</div>`
}

describe('isLayoutHtml', () => {
  it('recognizes layout-mode markup', () => {
    expect(isLayoutHtml(page(100, 100, span('hi', 0, 0, 12)))).toBe(true)
  })

  it('rejects plain-mode markup', () => {
    expect(isLayoutHtml('<p>Just a paragraph.</p><p>Another one.</p>')).toBe(false)
  })

  it('rejects empty input', () => {
    expect(isLayoutHtml('')).toBe(false)
  })
})

describe('parseLayoutPage', () => {
  it('reads the page height off the outer wrapping div', () => {
    const { pageHeight } = parseLayoutPage(page(400, 600, span('x', 0, 0, 12)))
    expect(pageHeight).toBe(600)
  })

  it('joins runs on the same line (separated by &nbsp;) into one line of text', () => {
    const html = page(400, 600, `${span('Hello', 10, 20, 12)}&nbsp;${span('world', 60, 20, 12)}`)
    const { lines } = parseLayoutPage(html)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('Hello world')
    expect(lines[0].y).toBe(20)
    expect(lines[0].height).toBe(12)
  })

  it('splits a single <br> into two lines, both part of the same paragraph', () => {
    const html = page(400, 600, `${span('First line', 10, 20, 12)}<br>${span('Second line', 10, 35, 12)}`)
    const { lines } = parseLayoutPage(html)
    expect(lines.map((l) => l.text)).toEqual(['First line', 'Second line'])
    expect(lines[0].newParagraph).toBe(true) // page's first line is always true
    expect(lines[1].newParagraph).toBe(false)
  })

  it('marks the line after <br><br> as starting a new paragraph', () => {
    const html = page(400, 600, `${span('Paragraph one.', 10, 20, 12)}<br><br>${span('Paragraph two.', 10, 60, 12)}`)
    const { lines } = parseLayoutPage(html)
    expect(lines.map((l) => l.text)).toEqual(['Paragraph one.', 'Paragraph two.'])
    expect(lines[1].newParagraph).toBe(true)
  })

  it('takes a line\'s height as the tallest run on it', () => {
    const html = page(400, 600, `${span('big', 10, 20, 18)}&nbsp;${span('small', 60, 20, 10)}`)
    const { lines } = parseLayoutPage(html)
    expect(lines[0].height).toBe(18)
  })

  it('ignores <img> tags entirely (no text, no line break)', () => {
    const html = page(400, 600, `${span('before', 10, 20, 12)}<img src="data:image/png;base64,x" alt="" style="position:absolute;">${span(' after', 60, 20, 12)}`)
    const { lines } = parseLayoutPage(html)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('before after')
  })

  it('returns no lines for empty or whitespace-only pages', () => {
    expect(parseLayoutPage('')).toEqual({ pageHeight: 0, pageWidth: 0, lines: [] })
    expect(parseLayoutPage(page(400, 600, '')).lines).toEqual([])
  })

  it('reads the page width off the outer wrapping div, and each line\'s x off its first run', () => {
    const html = page(400, 600, `${span('Hello', 25, 20, 12)}&nbsp;${span('world', 60, 20, 12)}`)
    const { pageWidth, lines } = parseLayoutPage(html)
    expect(pageWidth).toBe(400)
    expect(lines[0].x).toBe(25)
  })
})
