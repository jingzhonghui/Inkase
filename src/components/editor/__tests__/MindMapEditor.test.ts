// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'

/**
 * MindMapEditor 冒烟测试
 *
 * 使用真实 mind-elixir（不桩渲染库）：jsdom 缺少布局度量，所以不做像素/交互断言，
 * 但能验证组件的构造参数、挂载链路与错误处理确实成立。
 * 节点增删、拖拽、撤销等交互仍需在实际运行中验证。
 */

const fileState = vi.hoisted(() => ({
  fileContent: '',
  activeTabId: 't1',
  activeTab: { id: 't1', fileInfo: { format: 'mindmap' } } as {
    id: string
    fileInfo: { format: string }
  },
  /** 导图标签：`documentPath` / `assetMap` 都是从这里取的 */
  tabs: [
    {
      id: 't1',
      fileInfo: { format: 'mindmap', path: '/tmp/demo.inkmind' },
      mindMapAssets: {} as Record<string, string>
    }
  ],
  registerMindMapAsset: vi.fn(),
  updateContent: vi.fn(),
  updateTabContent: vi.fn(),
  exportMindMapImage: vi.fn(async () => true),
  error: null as string | null
}))

vi.mock('../../../stores/file', () => ({
  useFileStore: () => fileState
}))

vi.mock('../../../stores/theme', () => ({
  useThemeStore: () => ({ isDark: false })
}))

import MindMapEditor from '../MindMapEditor.vue'

describe('MindMapEditor', () => {
  beforeEach(() => {
    fileState.fileContent = ''
    fileState.activeTabId = 't1'
    fileState.error = null
    // 真实 store 的标签是响应式的：注册新资源后组件里的 assetMap 必须能重新求值
    fileState.tabs = reactive([
      {
        id: 't1',
        fileInfo: { format: 'mindmap', path: '/tmp/demo.inkmind' },
        mindMapAssets: {} as Record<string, string>
      }
    ])
    fileState.updateContent.mockClear()
    fileState.updateTabContent.mockClear()
    fileState.exportMindMapImage.mockClear()
    fileState.registerMindMapAsset.mockReset()
    // 真实 store 会把新资源并进标签的表；这里同样模拟，测试才能验证解析结果
    fileState.registerMindMapAsset.mockImplementation(
      (tabId: string, src: string, absolutePath: string) => {
        const tab = fileState.tabs.find((item) => item.id === tabId)
        if (tab) tab.mindMapAssets = { ...tab.mindMapAssets, [src]: absolutePath }
      }
    )
    // jsdom 未实现 matchMedia，渲染库在构造时会读取系统主题偏好
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    /*
     * 断言失败会跳过用例末尾的 `unmount()`，残留在 body 里的画布会被后续用例的
     * `document.querySelector('me-tpc')` 命中，导致连锁误报。这里兜底清干净。
     */
    document.body.innerHTML = ''
  })

  it('内容不是合法 JSON 时显示错误提示而不是崩溃', async () => {
    fileState.fileContent = '{ broken json'
    const wrapper = mount(MindMapEditor)
    await nextTick()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('无法解析思维导图内容')
    expect(wrapper.text()).toContain('不是合法的 JSON')
    // 提供就地修复入口，原始内容写入可编辑文本域而不是被丢弃
    expect(wrapper.text()).toContain('文件内容不会被丢弃')
    const textarea = wrapper.find('#mind-map-fallback')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('{ broken json')
    wrapper.unmount()
  })

  it('修正 JSON 后重新解析成功并按 tab id 定向写回 store', async () => {
    fileState.fileContent = '{ broken json'
    const wrapper = mount(MindMapEditor)
    await nextTick()

    const textarea = wrapper.find('#mind-map-fallback')
    await textarea.setValue(
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    )
    await wrapper.find('.mind-map-action-primary').trigger('click')
    await nextTick()

    // 必须按挂载时的 tab id 定向写入，不能依赖「当前激活标签」
    expect(fileState.updateTabContent).toHaveBeenCalledTimes(1)
    expect(fileState.updateTabContent.mock.calls[0][0]).toBe('t1')
    expect(String(fileState.updateTabContent.mock.calls[0][1])).toContain(
      '"schema": "inkase.mindmap"'
    )
    expect(fileState.updateContent).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('挂载期间切换激活标签后卸载，仍写回原 tab 而不是新标签', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor)
    await nextTick()

    // 模拟用户切到另一个标签：激活标签已变，本组件随后才卸载
    fileState.activeTabId = 't2'
    fileState.activeTab = { id: 't2', fileInfo: { format: 'markdown' } }

    wrapper.unmount()

    // 关键回归点：绝不能把本文档内容写进另一个标签
    expect(fileState.updateContent).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('合法内容正常渲染画布且无错误提示', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor)
    await nextTick()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.mind-map-canvas').exists()).toBe(true)
    wrapper.unmount()
  })

  it('挂载时不会把内容误判为修改写回 store', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor)
    await nextTick()

    expect(fileState.updateContent).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('不再使用渲染库自带的全屏右键遮罩菜单', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    // 自带菜单是一个 position:fixed 覆盖整个视口的 .context-menu，会吃掉所有点击
    expect(document.querySelector('.context-menu')).toBeNull()
    wrapper.unmount()
  })

  it('右键主题弹出面板内菜单，且菜单项按根主题能力裁剪', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const rootTpc = document.querySelector('me-root me-tpc')
    expect(rootTpc).not.toBeNull()

    rootTpc!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 })
    )
    await nextTick()

    const menu = document.querySelector('.mind-map-menu')
    expect(menu).not.toBeNull()
    // 二级菜单里的项不算一级菜单项（图标现在是一级入口 + 展开后的五个开关）
    const labels = Array.from(menu!.querySelectorAll('.mind-map-menu-label'))
      .filter((el) => el.closest('.mind-map-submenu') === null)
      .map((el) => el.textContent?.trim())
    // 根主题的折叠语义是「整张导图」：库的 expandNode 对根主题会崩，必须走批量折叠
    expect(labels).toEqual([
      '编辑主题',
      '添加备注',
      '添加标签',
      '添加链接',
      '图标',
      '插入图片',
      '添加附件',
      '新建子主题',
      '添加关系线',
      '添加概要',
      '折叠全部',
      '导出为 PNG 图片',
      '导出为 SVG 矢量图',
      '删除主题'
    ])

    // 根主题不能删除，删除项必须是禁用态而不是「点了没用」
    const removeItem = Array.from(menu!.querySelectorAll('.mind-map-menu-item')).find((el) =>
      el.textContent?.includes('删除主题')
    ) as HTMLButtonElement
    expect(removeItem.disabled).toBe(true)

    wrapper.unmount()
  })

  /* 右键菜单里也能导出：不必先切到属性栏的「画布」页或顶部文件菜单 */
  it('右键菜单的导出项直接调用 store 导出图片', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    const openMenu = async (): Promise<HTMLButtonElement> => {
      const rootTpc = document.querySelector('me-root me-tpc')!
      rootTpc.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80
        })
      )
      await nextTick()
      return Array.from(document.querySelectorAll('.mind-map-menu-item')).find((el) =>
        el.textContent?.includes('导出为 PNG')
      ) as HTMLButtonElement
    }

    const pngItem = await openMenu()
    expect(pngItem).toBeDefined()
    pngItem.click()
    await flushPromises()
    expect(fileState.exportMindMapImage).toHaveBeenCalledWith('png')
    // 点击后菜单必须收起
    expect(document.querySelector('.mind-map-menu')).toBeNull()

    const rootTpc = document.querySelector('me-root me-tpc')!
    rootTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 })
    )
    await nextTick()
    const svgItem = Array.from(document.querySelectorAll('.mind-map-menu-item')).find((el) =>
      el.textContent?.includes('导出为 SVG')
    ) as HTMLButtonElement
    svgItem.click()
    await flushPromises()
    expect(fileState.exportMindMapImage).toHaveBeenCalledWith('svg')

    wrapper.unmount()
  })

  /*
   * 根主题在渲染库 DOM 里是 `me-root > me-tpc`，没有 `me-parent`/`me-epd`。
   * 直接调库的 `expandNode` 会抛 "Cannot set properties of undefined (setting 'expanded')"，
   * 而 reportRuntimeError 会把整个画布换成兜底面板——用户看到的是一条报错而不是折叠。
   * 这里守住「根主题折叠 = 批量折叠，且不崩」。
   */
  it('根主题执行折叠不崩溃，按整张导图折叠', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[{"id":"a","text":"分支","children":[{"id":"a1","text":"叶子","children":[]}]}]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    const rootTpc = document.querySelector('me-root me-tpc')!
    rootTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 })
    )
    await nextTick()

    const collapseItem = Array.from(document.querySelectorAll('.mind-map-menu-item')).find((el) =>
      el.textContent?.includes('折叠全部')
    ) as HTMLButtonElement
    expect(collapseItem).toBeDefined()
    expect(collapseItem.disabled).toBe(false)

    collapseItem.click()
    await flushPromises()
    await nextTick()
    // 落盘走自动保存的防抖，必须等过它，否则读到的是还没提交的旧内容
    await new Promise((resolve) => setTimeout(resolve, 400))

    // 没有掉进兜底错误面板
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    // 分支被折叠了，且落盘内容里根主题依然是展开的
    // （落盘走按 tab id 定向写入 updateTabContent，避免切标签时写错文档）
    const written = fileState.updateTabContent.mock.calls.at(-1)?.[1] as string | undefined
    expect(written).toBeTruthy()
    const parsed = JSON.parse(written as string)
    expect(parsed.root.collapsed).toBeUndefined()
    expect(parsed.root.children[0].collapsed).toBe(true)

    wrapper.unmount()
  })

  it('菜单打开后按 Escape 关闭', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const rootTpc = document.querySelector('me-root me-tpc')!
    rootTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })
    )
    await nextTick()
    expect(wrapper.find('.mind-map-menu').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(wrapper.find('.mind-map-menu').exists()).toBe(false)

    wrapper.unmount()
  })

  /* 导出入口就摆在画布属性栏的「画布」页里，不必去顶部「文件 › 导出」找 */
  it('属性栏控制条上的 PNG / SVG 按钮调用 store 导出图片', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    // 视图/导出控制收在「画布」页，默认停在「属性」页
    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes('画布'))!
      .trigger('click')
    await nextTick()

    const buttons = wrapper.findAll('button')
    const png = buttons.find((button) => button.text().trim() === 'PNG')
    const svg = buttons.find((button) => button.text().trim() === 'SVG')
    expect(png).toBeDefined()
    expect(svg).toBeDefined()

    await png!.trigger('click')
    await flushPromises()
    expect(fileState.exportMindMapImage).toHaveBeenCalledWith('png')

    await svg!.trigger('click')
    await flushPromises()
    expect(fileState.exportMindMapImage).toHaveBeenCalledWith('svg')

    wrapper.unmount()
  })

  it('导出失败时弹对话框说明原因，而不是把画布换成错误面板', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    fileState.exportMindMapImage.mockImplementationOnce(async () => {
      fileState.error = '思维导图还没准备好，请稍后重试'
      return false
    })
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes('画布'))!
      .trigger('click')
    await nextTick()

    const png = wrapper.findAll('button').find((button) => button.text().trim() === 'PNG')!
    await png.trigger('click')
    await flushPromises()

    // 画布还在：导出失败属于操作失败，不该触发兜底面板
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.mind-map-canvas').exists() || wrapper.find('me-nodes').exists()).toBe(
      true
    )
    // 失败原因走对话框，用户能看见
    const { dialogState } = await import('../../../utils/dialog')
    expect(dialogState.visible).toBe(true)
    expect(dialogState.title).toBe('导出失败')
    expect(dialogState.message).toContain('还没准备好')
    dialogState.visible = false

    wrapper.unmount()
  })

  it('不再使用渲染库自带的工具栏', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    // 自带工具栏画在画布内、样式不受控，已由 toolBar:false 关掉
    expect(document.querySelector('.mind-elixir-toolbar')).toBeNull()
    wrapper.unmount()
  })

  it('视图控制收在属性栏的「画布」标签页里，不再浮在画布上', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    // 默认停在「属性」页：画布上不该再有挡住右下角的浮动工具条
    expect(wrapper.find('.mind-map-viewport .mind-map-controls').exists()).toBe(false)

    const canvasTab = wrapper
      .findAll('.mind-map-inspector-tab')
      .find((tab) => tab.text() === '画布')
    expect(canvasTab).toBeTruthy()
    await canvasTab!.trigger('click')
    await nextTick()

    // 切到「画布」页后控制条出现在属性栏里，且带缩放读数
    const insideInspector = wrapper.find('.mind-map-inspector .mind-map-controls')
    expect(insideInspector.exists()).toBe(true)
    expect(insideInspector.text()).toContain('100%')
    // 嵌进面板后不再使用浮层定位
    expect(insideInspector.classes()).toContain('is-panel')

    wrapper.unmount()
  })

  it('属性栏有「属性」「画布」两个标签页', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const tabs = wrapper.findAll('.mind-map-inspector-tab')
    expect(tabs.map((tab) => tab.text())).toEqual(['属性', '画布'])
    // 默认展示属性页
    expect(tabs[0].classes()).toContain('is-active')
    expect(wrapper.find('#mind-map-inspector-text').exists()).toBe(false)
    expect(wrapper.find('.mind-map-inspector-empty').exists()).toBe(true)

    await tabs[1].trigger('click')
    await nextTick()
    expect(tabs[1].classes()).toContain('is-active')
    expect(wrapper.find('.mind-map-inspector-empty').exists()).toBe(false)

    wrapper.unmount()
  })

  it('普通主题的右键菜单带分支颜色色板，根主题不带', async () => {
    fileState.fileContent = JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '根',
        children: [{ id: 'c1', text: '分支一', children: [] }]
      }
    })
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const childTpc = Array.from(document.querySelectorAll('me-tpc')).find(
      (el) => el.parentElement?.tagName !== 'ME-ROOT'
    )
    expect(childTpc).toBeTruthy()

    childTpc!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 120 })
    )
    await nextTick()

    const menu = wrapper.find('.mind-map-menu')
    expect(menu.exists()).toBe(true)
    expect(menu.text()).toContain('分支颜色')
    // 调色板 + 一个「自动」还原项
    const swatches = menu.findAll('.mind-map-menu-color')
    expect(swatches.length).toBeGreaterThan(1)
    expect(swatches[swatches.length - 1].text()).toBe('自动')

    wrapper.unmount()
  })

  it('菜单栏派发的撤销/重做不会让画布进入错误状态', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    // 应用菜单栏通过 window 事件派发编辑动作，组件必须自己接住，
    // 否则菜单项看起来能点、实际毫无反应
    window.dispatchEvent(new Event('editor:undo'))
    window.dispatchEvent(new Event('editor:redo'))
    await nextTick()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('.mind-map-canvas').exists()).toBe(true)
    wrapper.unmount()
  })

  it('打开时自动修复过文件会显示可见提示，且可关闭', async () => {
    // 两个节点共用同一个 id：解析层会重建 id 并记一条修复原因
    fileState.fileContent = JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'dup',
        text: '根',
        children: [{ id: 'dup', text: '重复 id 的子主题', children: [] }]
      }
    })
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const notice = wrapper.find('.mind-map-repair')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('已自动修复文件中的问题')
    expect(notice.text()).toContain('重复节点 id')

    // 提示不能挡住编辑：点「知道了」后消失
    const close = notice.findAll('button').find((b) => b.text() === '知道了')
    expect(close).toBeTruthy()
    await close!.trigger('click')
    await nextTick()
    expect(wrapper.find('.mind-map-repair').exists()).toBe(false)
    // 画布仍在，说明只是提示而非阻断
    expect(wrapper.find('.mind-map-canvas').exists()).toBe(true)

    wrapper.unmount()
  })

  it('内容完全合法时不显示修复提示', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    expect(wrapper.find('.mind-map-repair').exists()).toBe(false)
    wrapper.unmount()
  })

  it('根主题的菜单不出现分支颜色（根主题没有独立分支）', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    document
      .querySelector('me-root me-tpc')!
      .dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 70 })
      )
    await nextTick()

    expect(wrapper.find('.mind-map-menu').exists()).toBe(true)
    expect(wrapper.find('.mind-map-menu-colors').exists()).toBe(false)

    wrapper.unmount()
  })

  it('右键「添加备注」可写入备注，落盘进节点 note 并打上标记', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":1,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    document
      .querySelector('me-root me-tpc')!
      .dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 70 })
      )
    await nextTick()

    // 没有备注时菜单项叫「添加备注」
    const noteItem = wrapper
      .findAll('.mind-map-menu-item')
      .find((item) => item.text().includes('添加备注'))
    expect(noteItem).toBeTruthy()
    await noteItem!.trigger('click')
    await nextTick()

    const panel = wrapper.find('.mind-map-note')
    expect(panel.exists()).toBe(true)
    await panel.find('textarea').setValue('下周一确认预算')
    const save = panel.findAll('button').find((b) => b.text() === '保存')
    await save!.trigger('click')
    await nextTick()

    // 面板关闭
    expect(wrapper.find('.mind-map-note').exists()).toBe(false)
    // 写回是防抖的（合并连续编辑），等合并窗口过去再断言落盘内容
    await new Promise((resolve) => setTimeout(resolve, 400))
    const writes = [
      ...fileState.updateTabContent.mock.calls.map((call) => String(call[call.length - 1])),
      ...fileState.updateContent.mock.calls.map((call) => String(call[call.length - 1]))
    ]
    expect(writes.some((text) => text.includes('"note"') && text.includes('下周一确认预算'))).toBe(
      true
    )

    wrapper.unmount()
  })

  it('取消备注不会写回内容', async () => {
    fileState.fileContent = JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '根',
        children: [{ id: 'c1', text: '子主题', children: [] }]
      }
    })
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()
    fileState.updateContent.mockClear()

    const childTpc = document.querySelectorAll('me-tpc')[1]
    childTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 40 })
    )
    await nextTick()

    const noteItem = wrapper
      .findAll('.mind-map-menu-item')
      .find((item) => item.text().includes('添加备注'))
    await noteItem!.trigger('click')
    await nextTick()
    await wrapper.find('.mind-map-note textarea').setValue('临时想法')
    const cancel = wrapper
      .find('.mind-map-note')
      .findAll('button')
      .find((b) => b.text() === '取消')
    await cancel!.trigger('click')
    await nextTick()

    expect(wrapper.find('.mind-map-note').exists()).toBe(false)
    // 取消不该写内容（自动保存只会在内容真的变化后触发）
    expect(fileState.updateContent).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  /* ------------------------------ 左右分栏布局 ------------------------------ */

  /** 搭一份「根 + 一个子主题」的最小文档 */
  function twoLevelContent(): string {
    return JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '中心主题',
        children: [
          { id: 'c1', text: '分支一', children: [{ id: 'c2', text: '叶子', children: [] }] }
        ]
      }
    })
  }

  it('采用左右分栏：左画布、右属性栏', async () => {
    fileState.fileContent = twoLevelContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const body = wrapper.find('.mind-map-body')
    expect(body.exists()).toBe(true)

    const mainCol = wrapper.find('.mind-map-main')
    expect(mainCol.exists()).toBe(true)
    // 画布在左列里
    expect(mainCol.find('.mind-map-viewport').exists()).toBe(true)
    expect(mainCol.find('.mind-map-canvas').exists()).toBe(true)

    // 属性栏是同一个分栏里的兄弟节点，且排在画布之后（即右侧）
    const inspector = wrapper.find('.mind-map-inspector-host')
    expect(inspector.exists()).toBe(true)
    const children = Array.from(body.element.children).map((el) => el.className)
    expect(children).toEqual(['mind-map-main', 'mind-map-inspector-host'])

    wrapper.unmount()
  })

  it('属性栏在没有选中主题时给出占位说明而不是空白', async () => {
    fileState.fileContent = twoLevelContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const inspector = wrapper.find('.mind-map-inspector')
    expect(inspector.exists()).toBe(true)
    expect(inspector.text()).toContain('未选中主题')
    expect(inspector.text()).toContain('在左侧画布上点选一个主题')

    wrapper.unmount()
  })

  it('选中主题后属性栏显示该主题的文字与层级，并可改文字', async () => {
    fileState.fileContent = twoLevelContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    // 右键会先选中命中的主题，属性栏应立刻切到它
    const childTpc = Array.from(document.querySelectorAll('me-tpc')).find(
      (el) => el.parentElement?.tagName !== 'ME-ROOT'
    )!
    childTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })
    )
    await nextTick()

    const inspector = wrapper.find('.mind-map-inspector')
    expect(inspector.text()).toContain('第 1 级主题')
    expect(inspector.text()).not.toContain('未选中主题')

    const textArea = inspector.find('#mind-map-inspector-text')
    expect((textArea.element as HTMLTextAreaElement).value).toBe('分支一')

    await textArea.setValue('分支一（改名）')
    const save = inspector.findAll('button').find((b) => b.text() === '保存文字')
    expect(save).toBeTruthy()
    await save!.trigger('click')
    await nextTick()

    // 改名要落盘（防抖合并后再断言）
    await new Promise((resolve) => setTimeout(resolve, 400))
    const writes = [
      ...fileState.updateTabContent.mock.calls.map((call) => String(call[call.length - 1])),
      ...fileState.updateContent.mock.calls.map((call) => String(call[call.length - 1]))
    ]
    expect(writes.some((text) => text.includes('分支一（改名）'))).toBe(true)

    wrapper.unmount()
  })

  it('属性栏可以给分支指定颜色，颜色落盘进文件', async () => {
    fileState.fileContent = twoLevelContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    const childTpc = Array.from(document.querySelectorAll('me-tpc')).find(
      (el) => el.parentElement?.tagName !== 'ME-ROOT'
    )!
    childTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })
    )
    await nextTick()

    const inspector = wrapper.find('.mind-map-inspector')
    const swatches = inspector.findAll('.mind-map-inspector-color')
    expect(swatches.length).toBeGreaterThan(1)
    // 最后一个是「自动」（恢复按调色板分配）
    expect(swatches[swatches.length - 1].text()).toBe('自动')

    // 第一个色块是调色板首色，点它 = 显式指定颜色
    const picked = swatches[0].attributes('title')
    expect(picked).toMatch(/^#[0-9a-f]{6}$/i)
    await swatches[0].trigger('click')
    await nextTick()

    // 改完颜色后属性栏仍然绑在同一个主题上（refresh 会清空选中态，必须补回来）
    expect(wrapper.find('.mind-map-inspector').text()).not.toContain('未选中主题')

    await new Promise((resolve) => setTimeout(resolve, 400))
    const writes = [
      ...fileState.updateTabContent.mock.calls.map((call) => String(call[call.length - 1])),
      ...fileState.updateContent.mock.calls.map((call) => String(call[call.length - 1]))
    ]
    expect(
      writes.some((text) => text.includes('"color"') && text.toLowerCase().includes(String(picked)))
    ).toBe(true)

    wrapper.unmount()
  })

  it('根主题的属性栏不提供分支颜色（根主题不属于任何分支）', async () => {
    fileState.fileContent = twoLevelContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    document
      .querySelector('me-root me-tpc')!
      .dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 70 })
      )
    await nextTick()

    const inspector = wrapper.find('.mind-map-inspector')
    expect(inspector.text()).toContain('根主题')
    expect(inspector.find('.mind-map-inspector-colors').exists()).toBe(false)

    wrapper.unmount()
  })

  it('取消备注不会写回内容', async () => {
    fileState.fileContent = JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '根',
        children: [{ id: 'c1', text: '子主题', children: [] }]
      }
    })
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()
    fileState.updateContent.mockClear()

    const childTpc = document.querySelectorAll('me-tpc')[1]
    childTpc.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 40 })
    )
    await nextTick()

    const noteItem = wrapper
      .findAll('.mind-map-menu-item')
      .find((item) => item.text().includes('添加备注'))
    await noteItem!.trigger('click')
    await nextTick()
    await wrapper.find('.mind-map-note textarea').setValue('临时想法')
    const cancel = wrapper
      .find('.mind-map-note')
      .findAll('button')
      .find((b) => b.text() === '取消')
    await cancel!.trigger('click')
    await nextTick()

    expect(wrapper.find('.mind-map-note').exists()).toBe(false)
    // 取消不该写内容（自动保存只会在内容真的变化后触发）
    expect(fileState.updateContent).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  /* ------------------------------ 画布内查找 ------------------------------ */

  /** 一份有层级、且有重复词干（Alpha）的文档，便于验证命中顺序与计数 */
  function searchContent(): string {
    return JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '产品规划',
        children: [
          {
            id: 'a',
            text: 'Alpha 计划',
            children: [{ id: 'b', text: 'Alpha 排期', children: [] }]
          },
          { id: 'd', text: 'Beta 复盘', children: [] }
        ]
      }
    })
  }

  /** 按 Ctrl+F 打开面板（走真实的键盘事件，验证接线而不只是调用函数） */
  async function openSearchPanel(wrapper: ReturnType<typeof mount>): Promise<void> {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await nextTick()
    expect(wrapper.find('.find-replace-panel').exists()).toBe(true)
  }

  it('Ctrl+F 打开查找面板，输入后高亮全部命中并停在第一处', async () => {
    fileState.fileContent = searchContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    await openSearchPanel(wrapper)
    await wrapper.find('.find-replace-panel input').setValue('Alpha')
    await flushPromises()
    await nextTick()

    // 两处命中（计划、排期）都打上标记，只有一个是「当前」
    expect(document.querySelectorAll('me-tpc.is-search-match')).toHaveLength(2)
    const current = document.querySelectorAll('me-tpc.is-search-match-current')
    expect(current).toHaveLength(1)
    // 命中顺序是阅读顺序：先父后子
    expect(current[0].textContent).toContain('Alpha 计划')
    expect(wrapper.find('.find-replace-count').text()).toBe('1/2')

    wrapper.unmount()
  })

  it('Enter 在命中之间循环、Shift+Enter 反向，两者都会回卷', async () => {
    fileState.fileContent = searchContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    await openSearchPanel(wrapper)
    const input = wrapper.find('.find-replace-panel input')
    await input.setValue('Alpha')
    await flushPromises()
    expect(wrapper.find('.find-replace-count').text()).toBe('1/2')

    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.find-replace-count').text()).toBe('2/2')
    expect(document.querySelector('me-tpc.is-search-match-current')?.textContent).toContain(
      'Alpha 排期'
    )

    // 末尾再按一次回到第一处
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.find-replace-count').text()).toBe('1/2')

    // 反向：从第一处回卷到最后一处
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()
    await nextTick()
    expect(wrapper.find('.find-replace-count').text()).toBe('2/2')

    wrapper.unmount()
  })

  it('Escape 关闭面板并清除画布上的全部标记', async () => {
    fileState.fileContent = searchContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    await openSearchPanel(wrapper)
    await wrapper.find('.find-replace-panel input').setValue('Alpha')
    await flushPromises()
    expect(document.querySelectorAll('me-tpc.is-search-match').length).toBeGreaterThan(0)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    await flushPromises()

    expect(wrapper.find('.find-replace-panel').exists()).toBe(false)
    // 关闭后不能留任何残留标记，否则下次打开会看到「幽灵命中」
    expect(document.querySelectorAll('me-tpc.is-search-match')).toHaveLength(0)
    expect(document.querySelectorAll('me-tpc.is-search-match-current')).toHaveLength(0)

    wrapper.unmount()
  })

  it('菜单栏派发的 editor:find 同样能打开面板', async () => {
    fileState.fileContent = searchContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    window.dispatchEvent(new CustomEvent('editor:find'))
    await nextTick()

    expect(wrapper.find('.find-replace-panel').exists()).toBe(true)
    // 导图没有正文，面板不该出现替换入口
    expect(wrapper.find('.find-replace-toggle').exists()).toBe(false)

    wrapper.unmount()
  })

  it('没有命中时计数为 0 且不留下标记', async () => {
    fileState.fileContent = searchContent()
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    await openSearchPanel(wrapper)
    await wrapper.find('.find-replace-panel input').setValue('不存在的关键词')
    await flushPromises()
    await nextTick()

    expect(wrapper.find('.find-replace-count').text()).toBe('0/0')
    expect(document.querySelectorAll('me-tpc.is-search-match')).toHaveLength(0)

    wrapper.unmount()
  })

  it('命中折叠分支内的节点时自动展开祖先，并把展开状态落盘', async () => {
    fileState.fileContent = JSON.stringify({
      schema: 'inkase.mindmap',
      version: 1,
      root: {
        id: 'r',
        text: '产品规划',
        children: [
          {
            id: 'a',
            text: 'Alpha 计划',
            // 折叠状态写在文件里，命中项在它下面
            collapsed: true,
            children: [{ id: 'b', text: 'Alpha 排期', children: [] }]
          },
          { id: 'd', text: 'Beta 复盘', children: [] }
        ]
      }
    })
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await flushPromises()
    await nextTick()
    fileState.updateTabContent.mockClear()

    await openSearchPanel(wrapper)
    await wrapper.find('.find-replace-panel input').setValue('排期')
    await flushPromises()
    await nextTick()

    // 展开 + 重新打标是异步的（要等渲染库重排后才知道元素在哪），这里等它稳定
    const readCurrent = (): string =>
      document.querySelector('me-tpc.is-search-match-current')?.textContent ?? ''
    for (let i = 0; i < 20 && !readCurrent().includes('Alpha 排期'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // 折叠时子节点不在 DOM 里，能选中就说明祖先确实被展开了
    expect(readCurrent()).toContain('Alpha 排期')

    // 展开会触发自动保存：等过 250ms 的防抖窗口再读落盘内容
    await new Promise((resolve) => setTimeout(resolve, 400))
    const written = fileState.updateTabContent.mock.calls.at(-1)?.[1] as string | undefined
    expect(written).toBeTruthy()
    const parsed = JSON.parse(written as string)
    const branch = parsed.root.children.find((node: { id: string }) => node.id === 'a')
    expect(branch.collapsed).not.toBe(true)

    wrapper.unmount()
  })

  /* ---------------- 富内容：星标 / 标签 / 链接 ---------------- */

  /** 右键根主题并点击指定文案的菜单项 */
  async function clickMenuItem(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
    document.querySelector('me-root me-tpc')!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 90,
        clientY: 70
      })
    )
    await nextTick()
    const item = wrapper.findAll('.mind-map-menu-item').find((el) => el.text().includes(label))
    expect(item).toBeTruthy()
    await item!.trigger('click')
    await nextTick()
  }

  /** 读取最近一次落盘的导图 JSON */
  async function lastWrittenDocument(): Promise<any> {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const calls = [
      ...fileState.updateTabContent.mock.calls.map((call) => String(call[call.length - 1])),
      ...fileState.updateContent.mock.calls.map((call) => String(call[call.length - 1]))
    ]
    const text = calls.filter((value) => value.trim().startsWith('{')).at(-1)
    expect(text).toBeTruthy()
    return JSON.parse(text as string)
  }

  it('图标走二级菜单直接插入，点完即关菜单，取消后落盘不留下空数组', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    /** 右键根主题摆出菜单，并返回图标二级菜单（每次点完图标菜单都会关掉） */
    const openIconMenu = async () => {
      document.querySelector('me-root me-tpc')!.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 70
        })
      )
      await nextTick()
      const submenu = wrapper.find('.mind-map-submenu')
      expect(submenu.exists()).toBe(true)
      return submenu
    }

    // 一级入口是「图标」，点它不弹面板，展开的是二级菜单
    const first = await openIconMenu()
    // 图标没有需要校验的输入，所以不该有输入框
    expect(wrapper.find('.mind-map-note').exists()).toBe(false)
    expect(first.findAll('.mind-map-menu-item')).toHaveLength(5)

    const chooseIcon = async (label: string) => {
      const submenu = await openIconMenu()
      const item = submenu
        .findAll('.mind-map-menu-item')
        .find((el) => el.text().includes(label))!
      expect(item).toBeTruthy()
      await item.trigger('click')
      await nextTick()
      // 插入图标后菜单立刻关闭（与其余菜单项一致）
      expect(wrapper.find('.mind-map-menu').exists()).toBe(false)
    }

    // 星标与重点可以同时存在：菜单会关，重新右键即可再选一个
    await chooseIcon('星标')
    expect((await lastWrittenDocument()).root.icons).toEqual(['star'])

    await chooseIcon('重点')
    expect((await lastWrittenDocument()).root.icons).toEqual(['star', 'exclamation'])

    // 重新打开时，已选中的项带勾选态
    const reopened = await openIconMenu()
    const starred = reopened.findAll('.mind-map-menu-item').find((el) => el.text().includes('星标'))
    expect(starred!.classes()).toContain('is-active')

    // 再点一次是取消；全部取消后文件里不应该留下空数组
    await chooseIcon('星标')
    await chooseIcon('重点')
    expect((await lastWrittenDocument()).root.icons).toBeUndefined()

    wrapper.unmount()
  })

  it('插入图片后立刻可见：新资源先补登记进资源表，再解析成可加载的 URL', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根","children":[]}}'
    const addMindMapAsset = vi.fn(async () => ({
      success: true,
      data: {
        src: 'assets/images/hero.png',
        absolutePath: '/tmp/inkmind-demo/assets/images/hero.png',
        name: 'hero.png',
        size: 2048,
        mime: 'image/png'
      }
    }))
    vi.stubGlobal('electronAPI', { addMindMapAsset })

    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    await clickMenuItem(wrapper, '插入图片')
    await flushPromises()
    await nextTick()

    // 主进程返回的「包内路径 + 绝对路径」必须补进标签的资源表：
    // 打开文件时给出的表里只有 ZIP 中已有的条目，新图片不在其中
    expect(addMindMapAsset).toHaveBeenCalledWith('/tmp/demo.inkmind', 'image')
    expect(fileState.registerMindMapAsset).toHaveBeenCalledWith(
      't1',
      'assets/images/hero.png',
      '/tmp/inkmind-demo/assets/images/hero.png'
    )

    // 画布上的 <img> 必须拿到非空 url——空串就是「插入后看不见」的老毛病
    const img = wrapper.find('me-tpc img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(
      'inkase-preview://local/tmp/inkmind-demo/assets/images/hero.png'
    )

    // 文件里存的仍是包内路径，重开时靠它找回图片
    const written = await lastWrittenDocument()
    expect(written.root.image).toEqual({
      src: 'assets/images/hero.png',
      width: 200,
      height: 140
    })

    wrapper.unmount()
  })

  /** 等几帧：重绘被 rAF 合并，附件卡片是在回调里注入的 */
  async function settleCanvas(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 0)
      })
    }
    await nextTick()
  }

  const ATTACHMENT_DOC = JSON.stringify({
    schema: 'inkase.mindmap',
    version: 2,
    root: {
      id: 'r',
      text: '根',
      attachments: [
        {
          id: 'att_1',
          name: '方案.pdf',
          src: 'assets/files/方案.pdf',
          mime: 'application/pdf',
          size: 20480
        }
      ],
      children: [{ id: 'a', text: '分支', children: [] }]
    }
  })

  it('节点附件在画布上显示为卡片，带文件名与大小', async () => {
    fileState.fileContent = ATTACHMENT_DOC
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()
    await settleCanvas()

    const cards = wrapper.findAll('.inkase-attach-card')
    expect(cards).toHaveLength(1)
    expect(cards[0].text()).toContain('方案.pdf')
    expect(cards[0].text()).toContain('20.0 KB')

    wrapper.unmount()
  })

  it('卡片右键能移除附件，落盘不再包含它', async () => {
    fileState.fileContent = ATTACHMENT_DOC
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()
    await settleCanvas()

    await wrapper.find('.inkase-attach-card').trigger('contextmenu')
    await nextTick()

    const menu = wrapper.find('.mind-map-card-menu')
    expect(menu.exists()).toBe(true)
    const removeItem = menu.findAll('.mind-map-menu-item').find((b) => b.text().includes('移除'))
    expect(removeItem).toBeTruthy()
    await removeItem!.trigger('click')
    await nextTick()
    await settleCanvas()

    // 卡片跟着数据消失，文件里也不该留下空 attachments
    expect(wrapper.findAll('.inkase-attach-card')).toHaveLength(0)
    expect((await lastWrittenDocument()).root.attachments).toBeUndefined()

    wrapper.unmount()
  })

  it('标签面板支持逗号分隔，P1 自动套用优先级配色', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    await clickMenuItem(wrapper, '添加标签')
    const panel = wrapper.find('.mind-map-note')
    expect(panel.exists()).toBe(true)
    await panel.find('input').setValue('P1，待确认')
    await panel
      .findAll('button')
      .find((b) => b.text() === '保存')!
      .trigger('click')
    await nextTick()
    expect(wrapper.find('.mind-map-note').exists()).toBe(false)

    const written = await lastWrittenDocument()
    expect(written.root.tags).toEqual([{ text: 'P1', color: '#ef4444' }, { text: '待确认' }])

    wrapper.unmount()
  })

  it('链接格式不合法时就地提示，不关闭面板也不落盘', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    await clickMenuItem(wrapper, '添加链接')
    const panel = wrapper.find('.mind-map-note')
    await panel.find('input').setValue('javascript:alert(1)')
    await panel
      .findAll('button')
      .find((b) => b.text() === '保存')!
      .trigger('click')
    await nextTick()

    // 面板还开着，错误提示可见
    expect(wrapper.find('.mind-map-note').exists()).toBe(true)
    expect(wrapper.find('.mind-map-rich-error').text()).toContain('http')

    // 换成合法链接就能存下
    await wrapper.find('.mind-map-note input').setValue('https://example.com/spec')
    await wrapper
      .findAll('.mind-map-note button')
      .find((b) => b.text() === '保存')!
      .trigger('click')
    await nextTick()
    expect(wrapper.find('.mind-map-note').exists()).toBe(false)
    expect((await lastWrittenDocument()).root.href).toBe('https://example.com/spec')

    wrapper.unmount()
  })

  it('右键「添加概要」盖住该主题的全部子主题，并落盘进 summaries', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根","children":[' +
      '{"id":"a","text":"A","children":[]},{"id":"b","text":"B","children":[]}]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    await clickMenuItem(wrapper, '添加概要')

    const written = await lastWrittenDocument()
    expect(written.summaries).toEqual([{ id: expect.any(String), parent: 'r', start: 0, end: 1 }])

    wrapper.unmount()
  })

  it('关系线在只选中一个主题时是禁用态', async () => {
    fileState.fileContent =
      '{"schema":"inkase.mindmap","version":2,"root":{"id":"r","text":"根","children":[]}}'
    const wrapper = mount(MindMapEditor, { attachTo: document.body })
    await nextTick()

    document
      .querySelector('me-root me-tpc')!
      .dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 70 })
      )
    await nextTick()

    const arrowItem = wrapper
      .findAll('.mind-map-menu-item')
      .find((item) => item.text().includes('添加关系线'))
    expect(arrowItem).toBeTruthy()
    expect((arrowItem!.element as HTMLButtonElement).disabled).toBe(true)

    wrapper.unmount()
  })
})
