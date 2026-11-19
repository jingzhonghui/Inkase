<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import { IconCheck, IconChevronDown, IconCpu } from '@tabler/icons-vue'
import Tooltip from '../common/Tooltip.vue'
import { useListboxMenu } from '../../composables/useListboxMenu'

/**
 * AI 面板输入框里的模型下拉。
 *
 * 与权限胶囊并排住在输入框底栏，样式沿用同一套「安静胶囊」：平时只有一枚
 * 图标 + 模型名 + 箭头，完整模型名放 tooltip（长名字会被截断）。
 *
 * 列表来自设置页的模型清单（`AiConfigView.models`）。**只有一个选项时也要展开**：
 * 点下去什么都不发生，用户只会认为这个按钮坏了；弹出一项、勾在它自己身上，
 * 才是「有反馈」的正确答案。
 */
const props = withDefaults(defineProps<{
  /** 当前模型（运行期真相在主进程配置里） */
  model?: string
  /** 可选模型目录 */
  models?: string[]
  disabled?: boolean
}>(), {
  model: '',
  models: () => [],
  disabled: false
})

const emit = defineEmits<{ change: [model: string] }>()

const current = computed(() => props.model.trim())
const label = computed(() => current.value || '未选择模型')
/**
 * 候选 = 清单 ∪ 当前模型。
 *
 * 清单为空（老配置、手填的模型、服务商没实现 `/models`）时，当前模型就是唯一
 * 候选：触发器上明明写着用的是哪个模型，点开却一项都没有，用户只会认为按钮坏了。
 * 主进程 `toView()` 也做同一步归一，这里再兜一层——界面上「有名字必有列表」。
 */
const options = computed<string[]>(() => {
  const list = props.models.filter((id) => id.trim())
  return current.value && !list.includes(current.value) ? [current.value, ...list] : list
})
/** 只有「一个候选都没有」时才点不开：一项也要能展开，否则点了像没反应 */
const locked = computed(() => props.disabled || options.value.length === 0)

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
  count: () => options.value.length,
  prefer: 'top',
  width: 240,
  itemHeight: 30,
  disabled: () => locked.value,
  selectedIndex: () => options.value.indexOf(current.value),
  onChoose: (index) => {
    const next = options.value[index]
    if (next && next !== current.value) emit('change', next)
  }
})

// 键盘上下移动时把高亮项滚进可视区：目录可能有几百项
watch(activeIndex, (index) => {
  void nextTick(() => {
    const item = menuRef.value?.querySelectorAll<HTMLElement>('[role="option"]')[index]
    item?.scrollIntoView?.({ block: 'nearest' })
  })
})
</script>

<template>
  <span class="model-slot">
    <Tooltip
      :content="open ? '' : `模型：${label}`"
      placement="top"
    >
      <button
        ref="triggerRef"
        type="button"
        class="model-trigger"
        :class="{ 'is-locked': locked }"
        data-testid="ai-model-select"
        aria-haspopup="listbox"
        aria-label="AI 模型"
        :aria-expanded="open"
        :aria-disabled="locked"
        :disabled="props.disabled"
        @click="toggle"
        @keydown="onTriggerKeydown"
      >
        <IconCpu
          :size="13"
          class="model-icon"
          aria-hidden="true"
        />
        <span class="model-name">{{ label }}</span>
        <IconChevronDown
          :size="12"
          class="model-chevron"
          :class="{ 'is-open': open }"
          aria-hidden="true"
        />
      </button>
    </Tooltip>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="model-menu"
        role="listbox"
        aria-label="AI 模型"
        :style="{
          left: `${menuPosition.left}px`,
          top: `${menuPosition.top}px`,
          minWidth: `${menuPosition.width}px`
        }"
        @pointerdown.prevent
      >
        <button
          v-for="(option, index) in options"
          :key="option"
          type="button"
          class="model-option"
          role="option"
          data-testid="ai-model-option"
          :data-option="option"
          :aria-selected="option === current"
          :class="{ 'is-active': index === activeIndex, 'is-selected': option === current }"
          @mouseenter="activeIndex = index"
          @click="choose(index)"
        >
          <span class="option-name">{{ option }}</span>
          <IconCheck
            v-if="option === current"
            :size="14"
            class="option-check"
            aria-hidden="true"
          />
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
/* 与权限胶囊同一套「安静」触发器：透明底、次要文字色、悬停才浮起来 */
.model-slot { display: flex; flex: 0 1 auto; min-width: 0; }
.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.4;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.model-trigger:hover:not(:disabled) { background: var(--color-bg-secondary); color: var(--color-text-secondary); }
.model-trigger:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--color-primary-light); color: var(--color-text); }
/* 没有候选时点不开：仍然可见、仍可悬停看完整名字，但光标不再暗示可点 */
.model-trigger:disabled { cursor: default; opacity: .75; }
.model-trigger.is-locked { cursor: default; }
.model-icon { flex: 0 0 auto; }
.model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-chevron { flex: 0 0 auto; opacity: .7; transition: transform .15s ease; }
.model-chevron.is-open { transform: rotate(180deg); }

.model-menu {
  position: fixed;
  z-index: var(--z-popover);
  max-height: 280px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-primary);
  box-shadow: 0 10px 28px rgb(0 0 0 / 20%);
  animation: model-menu-in .12s ease-out;
}
.model-option {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  text-align: left;
  cursor: pointer;
}
.model-option.is-active { background: var(--color-bg-secondary); color: var(--color-text); }
.model-option.is-selected { color: var(--color-text); font-weight: 600; }
.option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.option-check { flex: 0 0 auto; color: var(--color-primary); }

@keyframes model-menu-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .model-menu { animation: none; }
  .model-chevron { transition: none; }
}
</style>
