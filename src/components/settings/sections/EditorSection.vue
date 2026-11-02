<script setup lang="ts">
import { computed, ref } from 'vue'
import SettingsRow from '../SettingsRow.vue'
import {
  CUSTOM_FONT_SENTINEL,
  EDITOR_FONT_FAMILY_PRESETS,
  EDITOR_MONO_FONT_FAMILY_PRESETS,
  MAX_EDITOR_FONT_SIZE,
  MAX_EDITOR_LINE_HEIGHT,
  MIN_EDITOR_FONT_SIZE,
  MIN_EDITOR_LINE_HEIGHT
} from '../../../stores/appearance'

/**
 * 编辑器：字号、正文字体、代码字体、行高。
 *
 * 字体的「自定义…」逻辑跟着这一节搬过来：存储里存的是最终 CSS font-family，
 * 下拉只是它的呈现。选到「自定义…」时下拉值停在哨兵上，实际值由文本框写回，
 * 所以打开设置时既有预设也有自定义两种状态都能正确还原。
 */
const fontSize = defineModel<number>('fontSize', { required: true })
const family = defineModel<string>('family', { required: true })
const monoFamily = defineModel<string>('monoFamily', { required: true })
const lineHeight = defineModel<number>('lineHeight', { required: true })

function toSelectValue(value: string): string {
  if (!value) return ''
  const isPreset =
    EDITOR_FONT_FAMILY_PRESETS.some((preset) => preset.value === value) ||
    EDITOR_MONO_FONT_FAMILY_PRESETS.some((preset) => preset.value === value)
  return isPreset ? value : CUSTOM_FONT_SENTINEL
}

const familySelect = ref(toSelectValue(family.value))
const familyCustom = computed(() => familySelect.value === CUSTOM_FONT_SENTINEL)
const monoFamilySelect = ref(toSelectValue(monoFamily.value))
const monoFamilyCustom = computed(() => monoFamilySelect.value === CUSTOM_FONT_SENTINEL)

function handleFamilySelect(): void {
  if (familyCustom.value) return
  family.value = familySelect.value
}

function handleMonoFamilySelect(): void {
  if (monoFamilyCustom.value) return
  monoFamily.value = monoFamilySelect.value
}

/** 滑杆的值需要固定小数位，否则 1.7999999 会原样显示 */
const lineHeightText = computed(() => lineHeight.value.toFixed(1))
</script>

<template>
  <SettingsRow
    title="编辑区域字体大小"
    desc="源码、即时渲染、预览与工具栏的字号，编辑器内可 Ctrl+滚轮缩放"
    layout="inline"
  >
    <input
      v-model.number="fontSize"
      class="settings-number"
      type="number"
      :min="MIN_EDITOR_FONT_SIZE"
      :max="MAX_EDITOR_FONT_SIZE"
    >
  </SettingsRow>

  <SettingsRow
    title="编辑器正文字体"
    desc="即时渲染编辑与预览的正文使用字体"
  >
    <div class="font-control">
      <select
        v-model="familySelect"
        class="settings-select"
        @change="handleFamilySelect"
      >
        <option
          v-for="preset in EDITOR_FONT_FAMILY_PRESETS"
          :key="preset.value || 'system'"
          :value="preset.value"
        >
          {{ preset.label }}
        </option>
      </select>
      <input
        v-if="familyCustom"
        v-model="family"
        class="settings-number font-custom-input"
        type="text"
        placeholder="如 '字体名', sans-serif"
      >
    </div>
  </SettingsRow>

  <SettingsRow
    title="编辑器代码字体"
    desc="源码编辑模式与代码块使用的等宽字体"
  >
    <div class="font-control">
      <select
        v-model="monoFamilySelect"
        class="settings-select"
        @change="handleMonoFamilySelect"
      >
        <option
          v-for="preset in EDITOR_MONO_FONT_FAMILY_PRESETS"
          :key="preset.value || 'system'"
          :value="preset.value"
        >
          {{ preset.label }}
        </option>
      </select>
      <input
        v-if="monoFamilyCustom"
        v-model="monoFamily"
        class="settings-number font-custom-input"
        type="text"
        placeholder="如 '字体名', monospace"
      >
    </div>
  </SettingsRow>

  <SettingsRow
    title="编辑器行高"
    desc="数值越大行间距越宽松"
  >
    <span class="quality-control">
      <input
        v-model.number="lineHeight"
        type="range"
        :min="MIN_EDITOR_LINE_HEIGHT"
        :max="MAX_EDITOR_LINE_HEIGHT"
        step="0.1"
      >
      <output>{{ lineHeightText }}</output>
    </span>
  </SettingsRow>
</template>
