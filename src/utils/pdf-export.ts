import { nextTick, shallowRef } from 'vue'
import { getHighlighter } from './shiki'
import { renderMarkdown } from './markdown'
import { normalizeCodeLanguage } from './code-languages'
import type { PdfSource } from '../types/pdf'

export const pdfSource = shallowRef<PdfSource | null>(null)
export const pdfHtml = shallowRef('')

async function highlightCode(container: HTMLElement): Promise<void> {
  const highlighter = await getHighlighter()
  for (const codeBlock of container.querySelectorAll('pre code')) {
    const element = codeBlock as HTMLElement
    // 围栏里的写法五花八门（`CMakeLists`、`text`、`sh`…），归一后再交给 Shiki
    const language = normalizeCodeLanguage(element.className.match(/language-([\w+#.-]+)/)?.[1] ?? '')
    try {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = highlighter.codeToHtml(element.textContent || '', {
        lang: language,
        theme: 'github-light'
      })
      const highlighted = wrapper.querySelector('pre')
      element.closest('pre')?.replaceWith(highlighted || element)
    } catch {
      // Unsupported languages remain as plain code blocks.
    }
  }
}

async function resolveImages(container: HTMLElement, source: PdfSource): Promise<void> {
  for (const image of container.querySelectorAll('img')) {
    const imagePath = image.getAttribute('src')
    if (!imagePath || /^(https?:|data:)/i.test(imagePath)) continue

    const embedded = source.images[imagePath]
    if (embedded) {
      image.src = embedded
      continue
    }

    const result = await window.electronAPI.getImage(imagePath, source.filePath)
    if (!result.success || !result.data) {
      image.alt = image.alt || '图片加载失败'
      image.removeAttribute('src')
      continue
    }
    const raw = result.data.buffer
    const bytes = raw instanceof Uint8Array
      ? raw
      : Array.isArray(raw)
        ? new Uint8Array(raw)
        : new Uint8Array(raw.data)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    image.src = `data:${result.data.mimeType || 'image/png'};base64,${btoa(binary)}`
  }

  await Promise.all(Array.from(container.querySelectorAll('img')).map((image) => {
    if (image.complete) return Promise.resolve()
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => resolve(), { once: true })
    })
  }))
}

export async function preparePdfView(source: PdfSource): Promise<void> {
  pdfSource.value = source
  pdfHtml.value = renderMarkdown(source.content)
  await nextTick()

  const container = document.querySelector<HTMLElement>('#pdf-export-content')
  if (!container) throw new Error('PDF 打印视图未就绪')
  await Promise.all([highlightCode(container), resolveImages(container, source)])
  await document.fonts.ready
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

export function clearPdfView(): void {
  pdfSource.value = null
  pdfHtml.value = ''
}
