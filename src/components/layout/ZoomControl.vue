<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import { IconChevronUp, IconMinus, IconPlus } from '@tabler/icons-vue'
import { useListboxMenu } from '../../composables/useListboxMenu'
import { formatZoomPercent, type ZoomProfile } from '../../stores/zoom'

/**
 * 状态栏右下角的缩放控件：`−` / 百分比下拉 / `+`。
 *
 * 只负责「显示 + 发事件」，数值与能力由调用方（StatusBar）从 zoom store 取，
 * 这样换成别的宿主也不用重写交互。
 *
 * 下拉必须 `prefer: 'top'`——状态栏贴着窗口底边，往下弹会立刻撞到屏幕外。
 * 菜单项是「适应（可选） + 快捷档位」；「适应」要容器尺寸，只有视图算得出来，
 * 所以这里只发 `fit` 事件，由宿主转给 store 里登记的动作。
 */
const props = defineProps<{
  profile: ZoomProfile
  value: number
  /** 当前标签是否登记了「适应」动作；没登记时不显示那一项 */
  canFit: boolean
}>()

const emit = defineEmits<{
  /** 走一档：+1 放大、-1 缩小 */
  step: [direction: 1 | -1]
  /** 直接设为某个倍率 */
  set: [value: number]
  /** 触发视图的「适应」动作 */
  fit: []
}>()

interface MenuItem {
  key: string
  label: string
  /** null 表示「适应」那一项，动作由视图执行 */
  value: number | null
}

const items = computed<MenuItem[]>(() => {
  const list: MenuItem[] = []
  if (props.profile.fitLabel && props.canFit) {
    list.push({ key: 'fit', label: props.profile.fitLabel, value: null })
  }
  for (const preset of props.profile.presets) {
    list.push({ key: String(preset), label: formatZoomPercent(preset), value: preset })
  }
  return list
})

/** 「适应」之后的值通常不是某个整数档位，此时高亮最接近的那一档 */
const selectedIndex = computed(() => {
  const presets = props.profile.presets
  if (presets.length === 0) return 0
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < presets.length; i++) {
    const distance = Math.abs(presets[i] - props.value)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  // 有「适应」项时整体后移一位
  return props.profile.fitLabel && props.canFit ? best + 1 : best
})

const {
  triggerRef,
  menuRef,
  open,
  activeIndex,
  menuPosition,
  toggle,
  choose,
  onTriggerKeydown
} = useListboxMenu({
  count: () => items.value.length,
  prefer: 'top',
  width: 104,
  itemHeight: 26,
  selectedIndex: () => selectedIndex.value,
  onChoose: (index) => {
    const item = items.value[index]
    if (!item) return
    if (item.value === null) emit('fit')
    else emit('set', item.value)
  }
})

watch(activeIndex, (index) => {
  void nextTick(() => {
    const node = menuRef.value?.querySelectorAll<HTMLElement>('[role="option"]')[index]
    node?.scrollIntoView?.({ block: 'nearest' })
  })
})

const readout = computed(() => formatZoomPercent(props.value))
</script>

<template>
  <div
    class="zoom-control"
    role="group"
    :aria-label="profile.hint"
  >
    <button
      type="button"
      class="zoom-step"
      title="缩小"
      aria-label="缩小"
      @click="emit('step', -1)"
    >
      <IconMinus
        :size="13"
        :stroke-width="2.2"
        aria-hidden="true"
      />
    </button>

    <button
      ref="triggerRef"
      type="button"
      class="zoom-readout"
      :class="{ 'is-open': open }"
      :title="`${profile.hint}：点击选择倍率`"
      aria-haspopup="listbox"
      :aria-label="`缩放 ${readout}`"
      :aria-expanded="open"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="zoom-percent">{{ readout }}</span>
      <IconChevronUp
        :size="12"
        class="zoom-chevron"
        :class="{ 'is-open': open }"
        aria-hidden="true"
      />
    </button>

    <button
      type="button"
      class="zoom-step"
      title="放大"
      aria-label="放大"
      @click="emit('step', 1)"
    >
      <IconPlus
        :size="13"
        :stroke-width="2.2"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="zoom-menu"
        role="listbox"
        :aria-label="profile.hint"
        :style="{
          left: `${menuPosition.left}px`,
          top: `${menuPosition.top}px`,
          minWidth: `${menuPosition.width}px`
        }"
        @pointerdown.prevent
      >
        <button
          v-for="(item, index) in items"
          :key="item.key"
          type="button"
          class="zoom-option"
          :class="{
            'is-active': index === activeIndex,
            'is-selected': index === selectedIndex,
            'is-fit': item.value === null
          }"
          role="option"
          :aria-selected="index === selectedIndex"
          :data-zoom-option="item.key"
          @mouseenter="activeIndex = index"
          @click="choose(index)"
        >
          <span class="zoom-option-label">{{ item.label }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 状态栏只有 32px 高，控件整体压到 22px，与左侧的模式切换按钮同一档 */
.zoom-control {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex: 0 0 auto;
  padding: 1px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
}

.zoom-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.zoom-step:hover {
  color: var(--color-text);
  background-color: var(--color-bg-secondary);
}

.zoom-step:active {
  background-color: var(--color-bg-tertiary);
}

.zoom-readout {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 48px;
  height: 20px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.zoom-readout:hover,
.zoom-readout.is-open {
  color: var(--color-text);
  background-color: var(--color-bg-secondary);
}

.zoom-percent {
  line-height: 1;
}

.zoom-chevron {
  flex: 0 0 auto;
  opacity: 0.65;
  transition: transform 0.15s ease;
}

/* 向上弹，箭头朝下表示「展开」 */
.zoom-chevron.is-open {
  transform: rotate(180deg);
}

.zoom-menu {
  position: fixed;
  z-index: var(--z-popover);
  max-height: 260px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-primary);
  box-shadow: 0 10px 28px rgb(0 0 0 / 20%);
  animation: zoom-menu-in 0.12s ease-out;
}

.zoom-option {
  display: flex;
  width: 100%;
  align-items: center;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}

.zoom-option.is-active {
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
}

.zoom-option.is-selected {
  color: var(--color-primary);
  font-weight: 600;
}

/* 「适应」与档位之间拉一条分隔线，避免被当成某个具体百分比 */
.zoom-option.is-fit {
  margin-bottom: 4px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

.zoom-option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes zoom-menu-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .zoom-menu {
    animation: none;
  }
  .zoom-chevron {
    transition: none;
  }
}
</style>
