// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ShortcutsSection from '../sections/ShortcutsSection.vue'

/**
 * 设置面板里「该显示什么」的约定。
 *
 * 这两条都不是纯视觉问题：一条决定用户会不会误以为 Ctrl+C 是本应用的设置，
 * 另一条决定冲突提示会不会指向一个他根本找不到的行。
 */
describe('快捷键设置面板的命令列表', () => {
  function mountSection(overrides: Record<string, string | null> = {}) {
    return mount(ShortcutsSection, { props: { overrides } })
  }

  it('不列系统原生命令（剪切/复制/粘贴）', () => {
    const wrapper = mountSection()
    const text = wrapper.text()

    // 这三条的键位由 Chromium 定死，列在应用设置里只会让人以为能改
    expect(text).not.toContain('剪切')
    expect(text).not.toContain('复制')
    expect(text).not.toContain('粘贴')
    expect(text).not.toContain('Ctrl+C')

    // 但应用命令和编辑器命令都还在
    expect(text).toContain('新建文件')
    expect(text).toContain('粗体')
  })

  it('撞到系统快捷键时，提示不指名那个看不见的命令', () => {
    // 把「保存」改成 Ctrl+C：与系统复制撞键
    const wrapper = mountSection({ 'file.save': 'Mod+C' })
    const text = wrapper.text()

    expect(text).toContain('系统快捷键')
    // 「复制」这一行不在列表里，提示里再出现它就是幽灵条目
    expect(text).not.toContain('复制')
    // 但冲突本身要被报出来，且指向看得见的那一行
    expect(text).toContain('保存文件')
  })

  it('编辑器命令只读：没有录制按钮，标出由谁处理', () => {
    const wrapper = mountSection()
    const boldRow = wrapper
      .findAll('.shortcut-line')
      .find((row) => row.text().includes('粗体'))

    expect(boldRow).toBeTruthy()
    // 只读行渲染成 span，不是可点的 button
    expect(boldRow!.find('button.shortcut-line__keys').exists()).toBe(false)
    expect(boldRow!.find('.shortcut-line__owner').text()).toBe('编辑器')

    const saveRow = wrapper
      .findAll('.shortcut-line')
      .find((row) => row.text().includes('保存文件'))
    expect(saveRow!.find('button.shortcut-line__keys').exists()).toBe(true)
  })
})
