import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 自绘 listbox 的通用行为。
 *
 * 为什么不用原生 `<select>`：选项面板由操作系统绘制，CSS 够不着，深色界面里
 * 会冒出一块系统白的列表。三处下拉（权限模式胶囊、面板模型胶囊、设置页「接口
 * 格式」）交互契约完全相同，差别只有「往哪个方向弹」和「宽度跟不跟随触发器」，
 * 所以把这套行为抽在这里，模板各写各的。
 *
 * 交互契约：`click`/`Enter`/`Space`/`↑`/`↓` 打开，`↑`/`↓` 移动高亮，
 * `Enter`/`Space` 提交，`Escape`/`Tab`/点击外部/滚动/缩放关闭。
 *
 * 菜单一律 `Teleport` 到 body（躲开祖先的 `overflow` 裁剪与层叠上下文），
 * 因此位置只能用 `position: fixed` 的视口坐标算。
 */
export interface ListboxMenuConfig {
  /** 选项数量；首帧还没量到真实菜单，用它估算高度 */
  count: () => number
  /** 首帧估算的每项高度 */
  itemHeight?: number
  /** 首帧估算的菜单宽度 */
  width?: number
  /** 触发器与菜单之间的间距 */
  gap?: number
  /** 与视口边缘的最小距离 */
  padding?: number
  /** 优先弹出方向：面板里的胶囊向上，设置页的表单字段向下 */
  prefer?: 'top' | 'bottom'
  /** 菜单宽度跟随触发器（设置页的整行字段用），否则用内容宽度 */
  matchTriggerWidth?: boolean
  /** 打开时高亮的起始项 */
  selectedIndex?: () => number
  /** 打开前的禁用判定 */
  disabled?: () => boolean
  /** 滚动 / 缩放时是否收起（默认收起：位置是按打开那一刻算的） */
  closeOnViewportChange?: boolean
  /** 提交第 index 项 */
  onChoose: (index: number) => void
}

export interface ListboxMenu {
  triggerRef: Ref<HTMLElement | null>
  menuRef: Ref<HTMLElement | null>
  open: Ref<boolean>
  activeIndex: Ref<number>
  menuPosition: Ref<{ left: number; top: number; width: number }>
  openMenu: () => void
  close: () => void
  toggle: () => void
  move: (step: number) => void
  /** 提交第 index 项（收起菜单、焦点还给触发器、再回调 onChoose） */
  choose: (index: number) => void
  positionMenu: () => void
  onTriggerKeydown: (event: KeyboardEvent) => void
}

export function useListboxMenu(config: ListboxMenuConfig): ListboxMenu {
  const triggerRef = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>
  const menuRef = ref<HTMLElement | null>(null) as Ref<HTMLElement | null>
  const open = ref(false)
  const activeIndex = ref(0)
  const menuPosition = ref({ left: 0, top: 0, width: 0 })

  const gap = config.gap ?? 8
  const padding = config.padding ?? 8
  const itemHeight = config.itemHeight ?? 30

  function positionMenu(): void {
    const trigger = triggerRef.value
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    // 首帧还没量到菜单，用估算值；下一帧再用真实尺寸校正
    const measured = menuRef.value
    const width = measured?.offsetWidth || config.width || rect.width
    const height = measured?.offsetHeight || config.count() * itemHeight + padding * 2
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const preferTop = config.prefer !== 'bottom'
    // 优先按配置的方向弹，那一侧放不下就翻到另一侧
    const fitsPreferred = preferTop
      ? spaceAbove >= height + gap
      : spaceBelow >= height + gap
    const top = fitsPreferred
      ? (preferTop ? rect.top - height - gap : rect.bottom + gap)
      : (preferTop ? rect.bottom + gap : rect.top - height - gap)

    const wanted = config.matchTriggerWidth ? rect.width : width
    menuPosition.value = {
      left: Math.round(Math.min(
        Math.max(padding, rect.left),
        Math.max(padding, window.innerWidth - width - padding)
      )),
      top: Math.round(Math.min(
        Math.max(padding, top),
        Math.max(padding, window.innerHeight - height - padding)
      )),
      width: Math.round(Math.min(
        wanted,
        Math.max(0, window.innerWidth - padding * 2)
      ))
    }
  }

  function openMenu(): void {
    if (config.disabled?.()) return
    activeIndex.value = Math.max(0, config.selectedIndex?.() ?? 0)
    open.value = true
    positionMenu()
    void nextTick(positionMenu)
  }

  function close(): void {
    open.value = false
  }

  function toggle(): void {
    if (open.value) close()
    else openMenu()
  }

  function move(step: number): void {
    const total = config.count()
    if (total === 0) return
    activeIndex.value = (activeIndex.value + step + total) % total
  }

  function choose(index: number): void {
    close()
    triggerRef.value?.focus()
    config.onChoose(index)
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (!open.value) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        close()
        break
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(activeIndex.value)
        break
      case 'Tab':
        close()
        break
    }
  }

  function onDocumentPointerDown(event: Event): void {
    if (!open.value) return
    const target = event.target as Node | null
    if (!target) return
    if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return
    close()
  }

  function onViewportChange(): void {
    if (open.value) close()
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    if (config.closeOnViewportChange !== false) {
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
    }
  })

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    if (config.closeOnViewportChange !== false) {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  })

  return {
    triggerRef,
    menuRef,
    open,
    activeIndex,
    menuPosition,
    openMenu,
    close,
    toggle,
    move,
    choose,
    positionMenu,
    onTriggerKeydown
  }
}
