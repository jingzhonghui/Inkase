<script setup lang="ts">
import { computed } from 'vue'
import { IconCheck, IconChevronDown } from '@tabler/icons-vue'
import { useListboxMenu } from '../../composables/useListboxMenu'

/**
 * 设置页的表单下拉。
 *
 * 与面板里的胶囊下拉共用 `useListboxMenu`，差别只有三处：整行宽度的字段外观、
 * 菜单向下弹（设置页字段上方还有别的行）、菜单宽度与字段对齐。
 *
 * 选项可以带一句 `hint`：这两种接口格式的差别不看说明是猜不出来的
 * （一个走 `/chat/completions`、一个走 `/responses`），所以说明放在菜单项里
 * 而不是堆在行下面。
 */
interface SettingsSelectOption {
  value: string
  label: string
  hint?: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  /** 只读：选项常来自共享的 `as const` 常量表，这里不复制也不改它 */
  options: readonly SettingsSelectOption[]
  disabled?: boolean
  testId?: string
}>(), {
  disabled: false,
  testId: ''
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const current = computed(
  () => props.options.find((option) => option.value === props.modelValue) ?? props.options[0]
)

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
  count: () => props.options.length,
  // 设置页字段上方还有内容，菜单向下弹
  prefer: 'bottom',
  matchTriggerWidth: true,
  itemHeight: 44,
  disabled: () => props.disabled,
  selectedIndex: () => props.options.findIndex((option) => option.value === props.modelValue),
  onChoose: (index) => {
    const option = props.options[index]
    if (option && option.value !== props.modelValue) emit('update:modelValue', option.value)
  }
})
</script>

<template>
  <span class="settings-field-select">
    <button
      ref="triggerRef"
      type="button"
      class="settings-select__trigger"
      :data-testid="props.testId || undefined"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :disabled="props.disabled"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="settings-select__label">{{ current?.label }}</span>
      <IconChevronDown
        :size="14"
        class="settings-select__chevron"
        :class="{ 'is-open': open }"
        aria-hidden="true"
      />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="menuRef"
        class="settings-select__menu"
        role="listbox"
        :style="{
          left: `${menuPosition.left}px`,
          top: `${menuPosition.top}px`,
          width: `${menuPosition.width}px`
        }"
        @pointerdown.prevent
      >
        <button
          v-for="(option, index) in props.options"
          :key="option.value"
          type="button"
          class="settings-select__option"
          role="option"
          :data-testid="props.testId ? `${props.testId}-option` : undefined"
          :data-option="option.value"
          :aria-selected="option.value === props.modelValue"
          :class="{ 'is-active': index === activeIndex, 'is-selected': option.value === props.modelValue }"
          @mouseenter="activeIndex = index"
          @click="choose(index)"
        >
          <span class="settings-select__option-text">
            <strong>{{ option.label }}</strong>
            <small v-if="option.hint">{{ option.hint }}</small>
          </span>
          <IconCheck
            v-if="option.value === props.modelValue"
            :size="14"
            class="settings-select__check"
            aria-hidden="true"
          />
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
/*
 * 根节点的类名刻意不叫 `.settings-select`：`settings-controls.css` 里那个同名
 * 全局类是给 `EditorSection` 的原生 `<select>` 用的，自带边框与内边距。同名会让
 * 这一层套在按钮外面，看起来就是「下拉框外面还套了一个边框」。
 */
.settings-field-select {
  display: block;
  width: 100%;
}

/* 与设置页其他输入框同一副样子：白底、细边框、同样圆角与内边距 */
.settings-select__trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--ui-font-size);
  text-align: left;
  cursor: pointer;
}

.settings-select__trigger:focus-visible {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
  outline: none;
}

.settings-select__trigger:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.settings-select__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-select__chevron {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  transition: transform 0.15s ease;
}

.settings-select__chevron.is-open {
  transform: rotate(180deg);
}

.settings-select__menu {
  position: fixed;
  z-index: var(--z-popover);
  max-height: 320px;
  padding: 4px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  box-shadow: 0 10px 28px rgb(0 0 0 / 20%);
  animation: settings-select-in 0.12s ease-out;
}

.settings-select__option {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.settings-select__option.is-active {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.settings-select__option.is-selected {
  color: var(--color-text);
}

.settings-select__option-text {
  flex: 1;
  min-width: 0;
}

.settings-select__option-text strong {
  display: block;
  font-size: var(--ui-font-size);
  font-weight: 600;
}

.settings-select__option-text small {
  display: block;
  margin-top: 2px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.45;
}

.settings-select__check {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--color-primary);
}

@keyframes settings-select-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .settings-select__menu { animation: none; }
  .settings-select__chevron { transition: none; }
}
</style>
