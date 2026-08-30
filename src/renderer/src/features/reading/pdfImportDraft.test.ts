import { describe, expect, it } from 'vitest'
import { titleAfterPdfSelection } from './pdfImportDraft'

describe('PDF import title', () => {
  it('refreshes the automatic title every time a different new PDF is selected', () => {
    const first = titleAfterPdfSelection('D:\\Downloads\\第一篇文章.pdf', null, '')
    const second = titleAfterPdfSelection('D:\\Downloads\\第二篇文章.pdf', null, first)

    expect(first).toBe('第一篇文章')
    expect(second).toBe('第二篇文章')
  })

  it('keeps the catalogued title when connecting a PDF to an existing document', () => {
    expect(
      titleAfterPdfSelection('D:\\Downloads\\下载文件名.pdf', 'existing-document', '手工登记的标题')
    ).toBe('手工登记的标题')
  })
})
