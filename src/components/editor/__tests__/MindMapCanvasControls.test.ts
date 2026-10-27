// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MindMapControlBar from '../MindMapControlBar.vue'

/**
 * 控制条是纯展示组件：这里只钉「事件名与按钮对应关系」，
 * 真实缩放/折叠/换向行为由 MindMapEditor 负责（jsdom 没有布局，测不出位移）。
 */

describe('MindMapControlBar', () => {
  function mountBar(overrides: Record<string, unknown> = {}) {
    return mount(MindMapControlBar, {
      props: { zoom: 1, rainbow: true, direction: 'side', ...overrides }
    })
  }

  function buttonOf(wrapper: ReturnType<typeof mountBar>, label: string) {
    const button = wrapper.findAll('button').find((item) => item.text().includes(label))
    if (!button) throw new Error(`未找到按钮：${label}`)
    return button
  }

  it('展示当前缩放百分比', () => {
    expect(mountBar().text()).toContain('100%')
    expect(mountBar({ zoom: 0.85 }).text()).toContain('85%')
  })

  it('缩放按钮分别发出 zoom-out / zoom-in / zoom-reset', async () => {
    const wrapper = mountBar()
    await buttonOf(wrapper, '−').trigger('click')
    await buttonOf(wrapper, '＋').trigger('click')
    await buttonOf(wrapper, '100%').trigger('click')

    expect(wrapper.emitted('zoom-out')).toHaveLength(1)
    expect(wrapper.emitted('zoom-in')).toHaveLength(1)
    expect(wrapper.emitted('zoom-reset')).toHaveLength(1)
  })

  it('适应 / 居中 / 折叠 / 展开 各自发出对应事件', async () => {
    const wrapper = mountBar()
    await buttonOf(wrapper, '适应').trigger('click')
    await buttonOf(wrapper, '居中').trigger('click')
    await buttonOf(wrapper, '折叠').trigger('click')
    await buttonOf(wrapper, '展开').trigger('click')

    expect(wrapper.emitted('fit')).toHaveLength(1)
    expect(wrapper.emitted('center')).toHaveLength(1)
    expect(wrapper.emitted('collapse-all')).toHaveLength(1)
    expect(wrapper.emitted('expand-all')).toHaveLength(1)
  })

  it('彩虹按钮反映当前状态并发切换事件', async () => {
    const on = mountBar({ rainbow: true })
    const rainbowButton = buttonOf(on, '彩虹分支')
    expect(rainbowButton.classes()).toContain('is-active')
    await rainbowButton.trigger('click')
    expect(on.emitted('toggle-rainbow')).toHaveLength(1)

    const off = mountBar({ rainbow: false })
    expect(buttonOf(off, '彩虹分支').classes()).not.toContain('is-active')
  })

  it('结构方向按钮标出当前方向，点击送出目标方向', async () => {
    const wrapper = mountBar({ direction: 'left' })
    expect(buttonOf(wrapper, '左').classes()).toContain('is-active')
    expect(buttonOf(wrapper, '双').classes()).not.toContain('is-active')

    await buttonOf(wrapper, '右').trigger('click')
    expect(wrapper.emitted('change-direction')).toEqual([['right']])
  })

  it('导出按钮分别送出 png / svg', async () => {
    const wrapper = mountBar()
    await buttonOf(wrapper, 'PNG').trigger('click')
    await buttonOf(wrapper, 'SVG').trigger('click')

    expect(wrapper.emitted('export-image')).toEqual([['png'], ['svg']])
  })

  it('按下鼠标不改变焦点（否则画布的 Tab/Enter 快捷键会失效）', async () => {
    const wrapper = mountBar()
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    wrapper.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('panel 形态加上 is-panel，按钮与事件不变（只是不再浮在画布上）', async () => {
    const floating = mountBar()
    expect(floating.classes()).not.toContain('is-panel')

    const panel = mountBar({ variant: 'panel' })
    expect(panel.classes()).toContain('is-panel')
    // 形态只影响样式：分组标题在面板形态下可见，事件语义保持一致
    expect(panel.text()).toContain('缩放')
    expect(panel.text()).toContain('100%')

    await buttonOf(panel, '适应').trigger('click')
    expect(panel.emitted('fit')).toHaveLength(1)
  })
})
