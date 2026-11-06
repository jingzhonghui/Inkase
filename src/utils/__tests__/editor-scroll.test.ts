// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  elementTopWithin,
  readScrollRatio,
  restoreScroll,
  saveScrollPosition,
  scrollRestoreTarget,
  scrollTargetForViewportOffset
} from '../editor-scroll'
import type { TabInfo } from '../../stores/file/types'

function scrollable(height: number, client: number, initialTop = 0): {
  element: HTMLElement
  setTop: (value: number) => void
  getTop: () => number
} {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let top = initialTop
  const scrollHeight = height
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => client })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = value }
  })
  return {
    element,
    setTop: (value: number) => { top = value },
    getTop: () => top
  }
}

function makeTab(): TabInfo {
  return {
    id: 'tab-1',
    fileInfo: null,
    document: null,
    content: '',
    revision: 0
  } as unknown as TabInfo
}

describe('readScrollRatio', () => {
  it('returns null when the container cannot scroll', () => {
    const box = scrollable(500, 500)
    expect(readScrollRatio(box.element)).toBeNull()
  })

  it('returns the scroll progress between 0 and 1', () => {
    const box = scrollable(5000, 800, 2100)
    expect(readScrollRatio(box.element)).toBeCloseTo(0.5, 5)
  })
})

describe('saveScrollPosition / scrollRestoreTarget', () => {
  it('records pixel offset, ratio and mode, preserving selection fields', () => {
    const box = scrollable(5000, 800, 2100)
    const tab = makeTab()
    tab.savedEditorPosition = { scrollTop: 10, scrollRatio: 0.1, mode: 'ir', from: 42, to: 42 }

    saveScrollPosition(tab, box.element, 'source')

    expect(tab.savedEditorPosition).toMatchObject({
      scrollTop: 2100,
      scrollRatio: 0.5,
      mode: 'source',
      from: 42,
      to: 42
    })
  })

  it('keeps the previous ratio when the container is not laid out yet', () => {
    const box = scrollable(0, 0)
    const tab = makeTab()
    tab.savedEditorPosition = { scrollTop: 100, scrollRatio: 0.25, mode: 'ir', from: 0, to: 0 }

    saveScrollPosition(tab, box.element, 'ir')

    expect(tab.savedEditorPosition?.scrollRatio).toBe(0.25)
    expect(tab.savedEditorPosition?.scrollTop).toBe(100)
  })

  it('uses pixels within the same mode and ratio across modes', () => {
    const saved = { scrollTop: 3000, scrollRatio: 0.5, mode: 'source' as const, from: 0, to: 0 }
    expect(scrollRestoreTarget(saved, 'source')).toEqual({ top: 3000 })
    expect(scrollRestoreTarget(saved, 'ir')).toEqual({ ratio: 0.5 })
    expect(scrollRestoreTarget(undefined, 'ir')).toBeNull()
  })
})

describe('restoreScroll', () => {  it('applies the ratio immediately when the layout is ready', () => {
    const box = scrollable(5000, 800)
    restoreScroll(box.element, { ratio: 0.5 })
    expect(box.getTop()).toBeCloseTo(2100, 5)
  })

  it('retries until the layout is ready', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    let top = 0
    let scrollHeight = 0
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => { top = value }
    })

    restoreScroll(element, { top: 1500 }, { attempts: 10, interval: 10 })
    expect(top).toBe(0)

    // 模拟布局就绪后的一次重试
    scrollHeight = 5000
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    expect(top).toBe(1500)
  })

  it('stops retrying once cancelled', async () => {
    const box = scrollable(0, 800)
    const cancel = restoreScroll(box.element, { top: 1500 }, { attempts: 10, interval: 10 })
    cancel()
    await new Promise<void>((resolve) => setTimeout(resolve, 60))
    expect(box.getTop()).toBe(0)
  })
})

describe('scrollTargetForViewportOffset（按顶边对齐）', () => {
  it('puts the element top back at the saved viewport offset', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const element = document.createElement('div')
    container.appendChild(element)

    let scrollTop = 1000
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 5000 })
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => { scrollTop = v }
    })
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 100, bottom: 900, left: 0, right: 800, width: 800, height: 800, x: 0, y: 100, toJSON: () => ({}) })
    })
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 700, bottom: 860, left: 0, right: 600, width: 600, height: 160, x: 0, y: 700, toJSON: () => ({}) })
    })

    // 内容坐标下元素顶部 = 700 - 100 + 1000 = 1600；顶边屏幕偏移 = 700 - 100 = 600
    expect(elementTopWithin(container, element)).toBe(1600)
    expect(scrollTargetForViewportOffset(container, element, 600)).toBe(1000)

    // 元素在新模式下变高/变矮都不影响顶边落点
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 700, bottom: 720, left: 0, right: 600, width: 600, height: 20, x: 0, y: 700, toJSON: () => ({}) })
    })
    expect(scrollTargetForViewportOffset(container, element, 600)).toBe(1000)
  })
})
