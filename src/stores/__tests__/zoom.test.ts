import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  IMAGE_ZOOM_PROFILE,
  MINDMAP_ZOOM_PROFILE,
  PDF_ZOOM_PROFILE,
  TEXT_ZOOM_PROFILE,
  clampZoom,
  formatZoomPercent,
  resolveZoomProfile,
  stepZoom,
  useZoomStore
} from '../zoom'

describe('缩放能力表', () => {
  it('按文件格式给出能力，图表与 HTML 预览不支持缩放', () => {
    expect(resolveZoomProfile({ format: 'image', isHtmlFile: false, htmlPreviewActive: false })?.kind).toBe('image')
    expect(resolveZoomProfile({ format: 'pdf', isHtmlFile: false, htmlPreviewActive: false })?.kind).toBe('pdf')
    expect(resolveZoomProfile({ format: 'mindmap', isHtmlFile: false, htmlPreviewActive: false })?.kind).toBe('mindmap')
    expect(resolveZoomProfile({ format: 'mdx', isHtmlFile: false, htmlPreviewActive: false })?.kind).toBe('text')
    expect(resolveZoomProfile({ format: 'markdown', isHtmlFile: false, htmlPreviewActive: false })?.kind).toBe('text')
    // 图表：缩放在 draw.io 的 iframe 里，跨域拿不到
    expect(resolveZoomProfile({ format: 'diagram', isHtmlFile: false, htmlPreviewActive: false })).toBeNull()
  })

  it('HTML 只有预览态不支持缩放，源码态仍按文本处理', () => {
    expect(resolveZoomProfile({ format: 'mdx', isHtmlFile: true, htmlPreviewActive: true })).toBeNull()
    expect(resolveZoomProfile({ format: 'mdx', isHtmlFile: true, htmlPreviewActive: false })?.kind).toBe('text')
  })

  it('四类视图的范围各自成立，文本范围明显窄于图片', () => {
    expect(IMAGE_ZOOM_PROFILE.min).toBe(0.25)
    expect(IMAGE_ZOOM_PROFILE.max).toBe(8)
    expect(PDF_ZOOM_PROFILE.max).toBe(5)
    expect(MINDMAP_ZOOM_PROFILE.min).toBe(0.2)
    expect(TEXT_ZOOM_PROFILE.min).toBe(0.5)
    expect(TEXT_ZOOM_PROFILE.max).toBe(3)
    // 每档 25%
    expect(TEXT_ZOOM_PROFILE.step).toBe(0.25)
  })
})

describe('clampZoom / stepZoom / formatZoomPercent', () => {
  it('夹到范围内并归到 1%', () => {
    expect(clampZoom(PDF_ZOOM_PROFILE, 99)).toBe(5)
    expect(clampZoom(PDF_ZOOM_PROFILE, 0)).toBe(1)
    expect(clampZoom(PDF_ZOOM_PROFILE, Number.NaN)).toBe(1)
    expect(clampZoom(PDF_ZOOM_PROFILE, 1.23456)).toBe(1.23)
  })

  it('加法步进每次 ±25%，到边界不再越界', () => {
    expect(stepZoom(TEXT_ZOOM_PROFILE, 1, 1)).toBe(1.25)
    expect(stepZoom(TEXT_ZOOM_PROFILE, 1, -1)).toBe(0.75)
    expect(stepZoom(TEXT_ZOOM_PROFILE, 3, 1)).toBe(3)
    expect(stepZoom(TEXT_ZOOM_PROFILE, 0.5, -1)).toBe(0.5)
  })

  it('导图用乘法步进（×1.2），与渲染库手感一致', () => {
    expect(stepZoom(MINDMAP_ZOOM_PROFILE, 1, 1)).toBe(1.2)
    expect(stepZoom(MINDMAP_ZOOM_PROFILE, 1.2, -1)).toBe(1)
    expect(stepZoom(MINDMAP_ZOOM_PROFILE, 3, 1)).toBe(3)
  })

  it('读数四舍五入到整数百分比', () => {
    expect(formatZoomPercent(1)).toBe('100%')
    expect(formatZoomPercent(0.873)).toBe('87%')
    expect(formatZoomPercent(2.5)).toBe('250%')
    expect(formatZoomPercent(Number.NaN)).toBe('100%')
  })
})

describe('useZoomStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('倍率按标签页独立保存：切换标签各读各的', () => {
    const store = useZoomStore()
    store.set('tab-1', 1.25, TEXT_ZOOM_PROFILE)

    expect(store.valueOf('tab-1')).toBe(1.25)
    // 没调过的标签是 100%
    expect(store.valueOf('tab-2')).toBe(1)
  })

  it('step 在当前值上走一档并返回新值', () => {
    const store = useZoomStore()
    expect(store.step('tab-1', TEXT_ZOOM_PROFILE, 1)).toBe(1.25)
    expect(store.step('tab-1', TEXT_ZOOM_PROFILE, 1)).toBe(1.5)
    expect(store.step('tab-1', TEXT_ZOOM_PROFILE, -1)).toBe(1.25)
  })

  it('prune 清掉已关闭标签的值（重开回到 100%）', () => {
    const store = useZoomStore()
    store.set('tab-1', 1.5, TEXT_ZOOM_PROFILE)
    store.set('tab-2', 2, TEXT_ZOOM_PROFILE)

    store.prune(['tab-2'])

    expect(store.raw('tab-1')).toBeUndefined()
    expect(store.valueOf('tab-1')).toBe(1)
    expect(store.valueOf('tab-2')).toBe(2)
  })

  it('「适应」动作按标签登记、可注销，requestFit 只触发当前标签', () => {
    const store = useZoomStore()
    let calls = 0
    const dispose = store.registerFit('tab-1', () => {
      calls++
    })

    expect(store.hasFit('tab-1')).toBe(true)
    expect(store.hasFit('tab-2')).toBe(false)

    store.requestFit('tab-1')
    store.requestFit('tab-2')
    expect(calls).toBe(1)

    dispose()
    expect(store.hasFit('tab-1')).toBe(false)
    store.requestFit('tab-1')
    expect(calls).toBe(1)
  })

  it('clear 同时清掉倍率与登记的动作', () => {
    const store = useZoomStore()
    store.set('tab-1', 2, TEXT_ZOOM_PROFILE)
    store.registerFit('tab-1', () => {})

    store.clear('tab-1')

    expect(store.raw('tab-1')).toBeUndefined()
    expect(store.hasFit('tab-1')).toBe(false)
  })
})
