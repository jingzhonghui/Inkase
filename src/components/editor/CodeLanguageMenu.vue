<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  matchCodeLanguages,
  normalizeCodeLanguage,
  type CodeLanguageMatch
} from '../../utils/code-languages'

/**
 * 代码块语言下拉（可输入模糊匹配）。
 *
 * 为什么不是原生 `<select>`：
 * ① 原生下拉的选项面板由系统绘制，CSS 够不着，深色主题下会冒出一块系统白列表；
 * ② 它只在**第一字母**上做跳转，既不认子序列也不认别名，「cmakelists」找不到 CMake。
 * 另一个必须自绘的原因在排版：`.ir-code-block` 是个 `overflow-x: auto` 的 `<pre>`，
 * 定点浮层留在 DOM 里会被裁掉，所以这里 `Teleport` 到 body，用 fixed 视口坐标定位。
 */
interface Props {
  /** 触发按钮的视口矩形（用于定位与翻边） */
  anchor: { left: number; top: number; bottom: number }
  /** 当前语言；比较前会归一，空串等价于 txt */
  current: string
  /** 触发按钮元素：点它由触发按钮自己去切换，不当作「点击外部」 */
  triggerEl?: HTMLElement | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (event: 'choose', value: string): void
  (event: 'close', reason: 'escape' | 'dismiss'): void
}>()

/** 菜单宽度：触发按钮很窄（只放得下一个语言名），菜单自己定宽 */
const MENU_WIDTH = 236
/** 与触发按钮之间的缝隙 */
const GAP = 4
/** 与视口边缘的最小距离 */
const EDGE = 8
/** 列表最多显示这么高，超出滚动 */
const LIST_MAX_HEIGHT = 248

const query = ref('')
const activeIndex = ref(0)
const menuRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const position = ref({ left: 0, top: 0 })

/** 高亮位置预先摊平成数组：模板里对每一行都 `positions.includes(i)` 是 O(n²) */
const matches = computed(() =>
  matchCodeLanguages(query.value).map((match: CodeLanguageMatch) => ({
    value: match.language.value,
    label: match.language.label,
    chars: match.language.label
      .split('')
      .map((char, index) => ({ char, hit: match.positions.includes(index) }))
  }))
)

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** 贴着触发按钮放：下方放不下就翻到上方，最后夹进视口 */
function placeMenu(): void {
  const menu = menuRef.value
  if (!menu) return
  const width = menu.offsetWidth || MENU_WIDTH
  const height = menu.offsetHeight
  const spaceBelow = window.innerHeight - props.anchor.bottom - GAP
  const spaceAbove = props.anchor.top - GAP
  const openDown = spaceBelow >= height || spaceBelow >= spaceAbove
  const top = openDown ? props.anchor.bottom + GAP : props.anchor.top - GAP - height

  position.value = {
    left: Math.round(clamp(props.anchor.left, EDGE, window.innerWidth - width - EDGE)),
    top: Math.round(clamp(top, EDGE, window.innerHeight - height - EDGE))
  }
}

/** 键盘移动高亮后把那一行滚进可视区（不用 scrollIntoView：它会连带滚动外层编辑器） */
function scrollActiveIntoView(): void {
  const list = listRef.value
  const item = list?.children[activeIndex.value] as HTMLElement | undefined
  if (!list || !item) return
  const top = item.offsetTop
  const bottom = top + item.offsetHeight
  if (top < list.scrollTop) list.scrollTop = top
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
}

function choose(index: number): void {
  const match = matches.value[index]
  if (!match) return
  emit('choose', match.value)
}

function onKeydown(event: KeyboardEvent): void {
  const total = matches.value.length

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (total > 0) activeIndex.value = (activeIndex.value + 1) % total
    scrollActiveIntoView()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (total > 0) activeIndex.value = (activeIndex.value - 1 + total) % total
    scrollActiveIntoView()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose(activeIndex.value)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close', 'escape')
  } else if (event.key === 'Tab') {
    // 不拦截 Tab：让焦点正常移走，菜单跟着关掉
    emit('close', 'dismiss')
  }
}

function onDocumentPointerDown(event: Event): void {
  const target = event.target as Node | null
  if (!target) return
  if (menuRef.value?.contains(target)) return
  if (props.triggerEl?.contains(target)) return
  emit('close', 'dismiss')
}

/**
 * 位置是按下那一刻的视口坐标，编辑器一滚就会脱节，所以直接收起。
 * 菜单自己的列表滚动要放过（scroll 不冒泡，但 capture 阶段会在 window 上收到）。
 */
function onViewportChange(event: Event): void {
  if (event.target instanceof Node && menuRef.value?.contains(event.target)) return
  emit('close', 'dismiss')
}

// 过滤后结果变了，高度也变了：重新定位一帧，否则底部可能被视口切掉
watch(matches, () => {
  activeIndex.value = 0
  void nextTick(() => {
    placeMenu()
    scrollActiveIntoView()
  })
})

onMounted(async () => {
  const normalized = normalizeCodeLanguage(props.current)
  const index = matches.value.findIndex((match) => match.value === normalized)
  activeIndex.value = index >= 0 ? index : 0

  await nextTick()
  placeMenu()
  inputRef.value?.focus()
  scrollActiveIntoView()

  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
})
</script>

<template>
  <teleport to="body">
    <div
      ref="menuRef"
      class="code-language-menu"
      :style="{ left: `${position.left}px`, top: `${position.top}px`, width: `${MENU_WIDTH}px` }"
      role="dialog"
      aria-label="选择代码语言"
      @mousedown.stop
      @contextmenu.prevent.stop
    >
      <input
        ref="inputRef"
        v-model="query"
        class="code-language-menu__input"
        type="text"
        placeholder="搜索语言，如 cmake"
        spellcheck="false"
        autocomplete="off"
        aria-label="搜索代码语言"
        @keydown="onKeydown"
      >
      <div
        ref="listRef"
        class="code-language-menu__list"
        :style="{ maxHeight: `${LIST_MAX_HEIGHT}px` }"
        role="listbox"
        aria-label="代码语言"
      >
        <button
          v-for="(match, index) in matches"
          :key="match.value"
          type="button"
          class="code-language-menu__item"
          :class="{ active: index === activeIndex, current: match.value === normalizeCodeLanguage(props.current) }"
          role="option"
          :aria-selected="index === activeIndex"
          @mouseenter="activeIndex = index"
          @click="choose(index)"
        >
          <span class="code-language-menu__label">
            <span
              v-for="(part, charIndex) in match.chars"
              :key="charIndex"
              :class="{ hit: part.hit }"
            >{{ part.char }}</span>
          </span>
          <span
            v-if="match.value === normalizeCodeLanguage(props.current)"
            class="code-language-menu__check"
            aria-hidden="true"
          >✓</span>
        </button>
        <div
          v-if="matches.length === 0"
          class="code-language-menu__empty"
        >
          没有匹配的语言
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.code-language-menu {
  position: fixed;
  /* 常驻浮层一档：比上下文菜单(10000)高，仍低于需要确认的对话框 */
  z-index: var(--z-popover, 10020);
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 6px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
}

.code-language-menu__input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  margin-bottom: 4px;
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 4px);
  font: var(--ui-font-size, 13px) var(--font-sans);
  outline: none;
}

.code-language-menu__input:focus {
  border-color: var(--color-primary);
}

.code-language-menu__list {
  position: relative;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.code-language-menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  color: var(--color-text);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm, 4px);
  font: var(--ui-font-size, 13px) var(--font-sans);
  text-align: left;
  cursor: pointer;
}

.code-language-menu__item.active {
  background: var(--color-bg-secondary);
}

.code-language-menu__item.current .code-language-menu__label {
  color: var(--color-primary);
}

.code-language-menu__label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.code-language-menu__label .hit {
  color: var(--color-primary);
  font-weight: 600;
}

.code-language-menu__check {
  flex: none;
  color: var(--color-primary);
  font-size: 12px;
}

.code-language-menu__empty {
  padding: 8px;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size, 13px);
  text-align: center;
}
</style>
