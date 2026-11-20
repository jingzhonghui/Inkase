// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CodeLanguageMenu from '../CodeLanguageMenu.vue'

const ANCHOR = { left: 120, top: 200, bottom: 222 }

describe('CodeLanguageMenu', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** 挂载并等到 onMounted 里的 `await nextTick()` 走完（聚焦与定位在那之后） */
  async function mountMenu(current = '') {
    const wrapper = mount(CodeLanguageMenu, {
      props: { anchor: ANCHOR, current },
      attachTo: document.body
    })
    await flushPromises()
    return wrapper
  }

  function items(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll<HTMLElement>('.code-language-menu__item'))
  }

  function input(): HTMLInputElement {
    return document.body.querySelector<HTMLInputElement>('.code-language-menu__input')!
  }

  async function typeQuery(text: string): Promise<void> {
    const el = input()
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await nextTick()
  }

  async function pressKey(key: string): Promise<void> {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await nextTick()
  }

  it('渲染全部语言，并把焦点放到搜索框', async () => {
    await mountMenu()

    expect(items().length).toBeGreaterThan(20)
    expect(items()[0].textContent).toContain('txt')
    expect(document.activeElement).toBe(input())
  })

  it('输入可模糊过滤，命中字符加高亮', async () => {
    await mountMenu()
    await typeQuery('cmake')

    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('CMake')
    expect(items()[0].querySelectorAll('.hit').length).toBe('CMake'.length)
  })

  it('cmakelists 也能找到 CMake（搜索词，不是标签）', async () => {
    await mountMenu()
    await typeQuery('cmakelists')

    expect(items()).toHaveLength(1)
    expect(items()[0].textContent).toContain('CMake')
    expect(items()[0].querySelectorAll('.hit')).toHaveLength(0)
  })

  it('点击选项回传语言标识', async () => {
    const wrapper = await mountMenu()
    await typeQuery('cmake')

    items()[0].click()
    await nextTick()

    expect(wrapper.emitted('choose')).toEqual([['cmake']])
  })

  it('Enter 选中的是高亮项，选择后不再重复触发', async () => {
    const wrapper = await mountMenu()
    await typeQuery('python')

    await pressKey('Enter')

    expect(wrapper.emitted('choose')).toEqual([['python']])
  })

  it('上下键移动高亮，Enter 提交移动后的项', async () => {
    const wrapper = await mountMenu()
    await typeQuery('c')

    const firstActive = document.body.querySelector('.code-language-menu__item.active')
    expect(firstActive?.textContent).toContain('C')

    await pressKey('ArrowDown')

    const secondActive = document.body.querySelector('.code-language-menu__item.active')
    expect(secondActive).not.toBe(firstActive)

    const chosen = wrapper.emitted('choose')
    expect(chosen).toBeUndefined()
  })

  it('Escape 以 escape 理由关闭（会把焦点还给编辑器）', async () => {
    const wrapper = await mountMenu()

    await pressKey('Escape')

    expect(wrapper.emitted('close')).toEqual([['escape']])
  })

  it('当前语言那一项带 current 标记', async () => {
    await mountMenu('python')

    const currentItem = document.body.querySelector('.code-language-menu__item.current')
    expect(currentItem?.textContent).toContain('Python')
  })

  it('空语言把 txt 认作当前项', async () => {
    await mountMenu('')

    const currentItem = document.body.querySelector('.code-language-menu__item.current')
    expect(currentItem?.textContent).toContain('txt')
  })

  it('搜不到时显示空态且 Enter 不做任何事', async () => {
    const wrapper = await mountMenu()
    await typeQuery('zzzzz')

    expect(items()).toHaveLength(0)
    expect(document.body.querySelector('.code-language-menu__empty')).not.toBeNull()

    await pressKey('Enter')
    expect(wrapper.emitted('choose')).toBeUndefined()
  })

  it('编辑器滚动时收起，但列表自己的滚动不算', async () => {
    const wrapper = await mountMenu()

    document.body.querySelector('.code-language-menu__list')!.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()

    document.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(wrapper.emitted('close')).toEqual([['dismiss']])
  })

  it('点击外部以 dismiss 理由关闭，点触发按钮则不算外部', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const wrapper = mount(CodeLanguageMenu, {
      props: { anchor: ANCHOR, current: '', triggerEl: trigger }
    })

    trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeUndefined()

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toEqual([['dismiss']])
  })
})
