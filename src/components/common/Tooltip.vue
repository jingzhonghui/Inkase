<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  content: string
  placement?: 'top' | 'bottom'
  /** 触发元素使用块级布局（默认内联），用于纵向堆叠的场景（如菜单子项） */
  block?: boolean
}>(), {
  placement: 'bottom',
  block: false
})

const triggerRef = ref<HTMLElement | null>(null)
const tooltipRef = ref<HTMLElement | null>(null)
const visible = ref(false)
const position = ref({ top: 0, left: 0 })
let showTimer: number | null = null
let hideTimer: number | null = null

function clearTimers(): void {
  if (showTimer !== null) window.clearTimeout(showTimer)
  if (hideTimer !== null) window.clearTimeout(hideTimer)
  showTimer = null
  hideTimer = null
}

function updatePosition(): void {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const halfTooltipWidth = (tooltipRef.value?.offsetWidth ?? 0) / 2
  const viewportPadding = 12
  const center = rect.left + rect.width / 2
  const minLeft = viewportPadding + halfTooltipWidth
  const maxLeft = Math.max(minLeft, window.innerWidth - viewportPadding - halfTooltipWidth)
  position.value = {
    left: Math.round(Math.min(maxLeft, Math.max(minLeft, center))),
    top: Math.round(props.placement === 'top' ? rect.top - 8 : rect.bottom + 8)
  }
}

function show(): void {
  clearTimers()
  showTimer = window.setTimeout(() => {
    updatePosition()
    visible.value = true
    void nextTick(updatePosition)
  }, 400)
}

function hide(): void {
  clearTimers()
  visible.value = false
}

function handleWindowChange(): void {
  if (visible.value) updatePosition()
}

watch(() => props.content, hide)

window.addEventListener('resize', handleWindowChange)
window.addEventListener('scroll', handleWindowChange, true)

onBeforeUnmount(() => {
  clearTimers()
  window.removeEventListener('resize', handleWindowChange)
  window.removeEventListener('scroll', handleWindowChange, true)
})
</script>

<template>
  <span
    ref="triggerRef"
    class="tooltip-trigger"
    :class="{ 'tooltip-trigger--block': props.block }"
    @mouseover="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="visible && content"
      ref="tooltipRef"
      role="tooltip"
      class="app-tooltip"
      :class="`app-tooltip--${placement}`"
      :style="{ top: `${position.top}px`, left: `${position.left}px`, width: 'max-content' }"
    >
      {{ content }}
    </div>
  </Teleport>
</template>

<style scoped>
.tooltip-trigger {
  display: inline-flex;
  flex: 1;
  min-width: 0;
}

.tooltip-trigger--block {
  display: block;
}

.app-tooltip {
  position: fixed;
  /* 需高于下拉菜单(.menu-dropdown 10002 / .submenu 10003)，避免被菜单遮挡 */
  z-index: 10004;
  width: max-content;
  max-width: min(420px, calc(100vw - 24px));
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
  pointer-events: none;
  transform: translateX(-50%);
  animation: tooltip-in 0.12s ease-out;
}

.app-tooltip--top {
  transform: translate(-50%, -100%);
}

@keyframes tooltip-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .app-tooltip { animation: none; }
}
</style>
