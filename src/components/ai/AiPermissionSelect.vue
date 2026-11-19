<script setup lang="ts">
import { computed } from 'vue'
import { IconBolt, IconCheck, IconChevronDown, IconLock, IconShieldCheck } from '@tabler/icons-vue'
import Tooltip from '../common/Tooltip.vue'
import { useListboxMenu } from '../../composables/useListboxMenu'
import {
  AI_PERMISSION_MODE_OPTIONS,
  DEFAULT_AI_PERMISSION_MODE,
  permissionModeOption,
  type AiPermissionMode
} from '../../../shared/ai/permission'

/**
 * 权限模式下拉。
 *
 * 为什么不用原生 `<select>`：它的选项列表由操作系统绘制，CSS 完全够不着，
 * 在深色面板里会冒出一块系统白的列表，跟输入框格格不入。这里自绘一个
 * listbox：触发器就是输入框左下角那枚胶囊，菜单向上弹出并 teleport 到 body
 * （输入框在面板底部，必须躲开任何祖先的 overflow 裁剪与层叠上下文）。
 * 打开/关闭、键盘、定位这套行为在 `useListboxMenu` 里，与面板的模型下拉共用。
 *
 * 菜单里只放图标 + 名称 + 选中勾，不放解释文字；每档「会发生什么」在悬停
 * 触发器时由 tooltip 给出（打开菜单时先收起 tooltip，避免两者打架）。
 */
const props = withDefaults(defineProps<{
  modelValue?: AiPermissionMode
  disabled?: boolean
}>(), {
  modelValue: DEFAULT_AI_PERMISSION_MODE,
  disabled: false
})

const emit = defineEmits<{ change: [mode: AiPermissionMode] }>()

const MODE_ICONS = {
  readonly: IconLock,
  standard: IconShieldCheck,
  auto: IconBolt
} as const

const options = AI_PERMISSION_MODE_OPTIONS

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
  count: () => options.length,
  // 贴着胶囊本身向上弹：菜单下沿离胶囊上沿 8px，左沿与胶囊左沿对齐
  prefer: 'top',
  width: 176,
  itemHeight: 30,
  disabled: () => props.disabled,
  selectedIndex: () => options.findIndex((option) => option.value === props.modelValue),
  onChoose: (index) => {
    const option = options[index]
    if (!option) return
    if (option.value !== props.modelValue) emit('change', option.value)
  }
})

const current = computed(() => permissionModeOption(props.modelValue))
const tooltip = computed(() => `${current.value.label}：${current.value.hint}`)

function iconFor(mode: AiPermissionMode) {
  return MODE_ICONS[mode] ?? IconShieldCheck
}
</script>

<template>
  <span
    class="permission-slot"
    :data-mode="props.modelValue"
  >
    <Tooltip
      :content="open ? '' : tooltip"
      placement="top"
    >
      <button
        ref="triggerRef"
        type="button"
        class="permission-trigger"
        data-testid="ai-permission-mode"
        aria-haspopup="listbox"
        aria-label="AI 权限模式"
        :aria-expanded="open"
        :disabled="props.disabled"
        @click="toggle"
        @keydown="onTriggerKeydown"
      >
        <component
          :is="iconFor(props.modelValue)"
          :size="13"
          class="permission-icon"
          aria-hidden="true"
        />
        <span class="permission-name">{{ current.label }}</span>
        <IconChevronDown
          :size="12"
          class="permission-chevron"
          :class="{ 'is-open': open }"
          aria-hidden="true"
        />
      </button>
    </Tooltip>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="permission-menu"
        role="listbox"
        aria-label="AI 权限模式"
        :data-mode="props.modelValue"
        :style="{
          left: `${menuPosition.left}px`,
          top: `${menuPosition.top}px`,
          minWidth: `${menuPosition.width}px`
        }"
        @pointerdown.prevent
      >
        <button
          v-for="(option, index) in options"
          :key="option.value"
          type="button"
          class="permission-option"
          role="option"
          data-testid="ai-permission-option"
          :data-option="option.value"
          :aria-selected="option.value === props.modelValue"
          :class="{ 'is-active': index === activeIndex, 'is-selected': option.value === props.modelValue }"
          @mouseenter="activeIndex = index"
          @click="choose(index)"
        >
          <component
            :is="iconFor(option.value)"
            :size="14"
            class="option-icon"
            aria-hidden="true"
          />
          <span class="option-name">{{ option.label }}</span>
          <IconCheck
            v-if="option.value === props.modelValue"
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
/* 触发器：输入框左下角的一枚安静胶囊，默认只用文字色 */
.permission-slot { display: flex; flex: 0 0 auto; min-width: 0; }
.permission-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
.permission-trigger:hover:not(:disabled) { background: var(--color-bg-secondary); color: var(--color-text-secondary); }
.permission-trigger:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--color-primary-light); color: var(--color-text); }
.permission-trigger:disabled { cursor: progress; opacity: .6; }
.permission-icon { flex: 0 0 auto; }
.permission-name { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.permission-chevron { flex: 0 0 auto; opacity: .7; transition: transform .15s ease; }
.permission-chevron.is-open { transform: rotate(180deg); }

/* 只读态用主色示意「受保护」，完全控制态用警示色 */
.permission-slot[data-mode="readonly"] .permission-trigger { color: var(--color-primary); }
.permission-slot[data-mode="auto"] .permission-trigger {
  background: rgb(217 119 6 / 12%);
  color: #b45309;
  font-weight: 600;
}
[data-theme='dark'] .permission-slot[data-mode="auto"] .permission-trigger { color: #fbbf24; }

/* 菜单：向上贴在胶囊上方，圆角浮层 */
.permission-menu {
  position: fixed;
  z-index: var(--z-popover);
  min-width: 176px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-primary);
  box-shadow: 0 10px 28px rgb(0 0 0 / 20%);
  animation: permission-menu-in .12s ease-out;
}
.permission-option {
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
.permission-option.is-active { background: var(--color-bg-secondary); color: var(--color-text); }
.permission-option.is-selected { color: var(--color-text); font-weight: 600; }
.option-icon { flex: 0 0 auto; opacity: .85; }
.option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.option-check { flex: 0 0 auto; color: var(--color-primary); }
.permission-option[data-option="readonly"] .option-icon { color: var(--color-primary); opacity: 1; }
.permission-option[data-option="auto"] .option-icon { color: #d97706; opacity: 1; }
[data-theme='dark'] .permission-option[data-option="auto"] .option-icon { color: #fbbf24; }

@keyframes permission-menu-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .permission-menu { animation: none; }
  .permission-chevron { transition: none; }
}
</style>
