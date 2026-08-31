declare module 'pdfjs-dist/web/pdf_viewer.mjs' {
  import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'

  interface TextLayerBuilderOptions {
    pdfPage: PDFPageProxy
    enablePermissions?: boolean
    onAppend?: (textLayer: HTMLDivElement) => void
    abortSignal?: AbortSignal
  }

  interface TextLayerBuilderRenderOptions {
    viewport: PageViewport
    images?: unknown
    textContentParams?: Record<string, unknown> | null
  }

  export class TextLayerBuilder {
    constructor(options: TextLayerBuilderOptions)
    readonly div: HTMLDivElement
    render(options: TextLayerBuilderRenderOptions): Promise<void>
    cancel(): void
  }
}
