<script setup lang="ts">
import SettingsRow from '../SettingsRow.vue'
import { MAX_UI_FONT_SIZE, MIN_UI_FONT_SIZE } from '../../../stores/appearance'

/**
 * 外观：主题与主界面字号。
 *
 * 主题与其余设置项语义不同——它**即时生效**（否则没法判断好不好看），
 * 由外壳负责在取消时回滚，这一节只负责把选择抛上去。
 */
type ThemeMode = 'light' | 'dark' | 'system'

const theme = defineModel<ThemeMode>('theme', { required: true })
const uiFontSize = defineModel<number>('uiFontSize', { required: true })

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' }
]
</script>

<template>
  <SettingsRow
    title="主题"
    desc="切换后立即预览；取消会恢复到打开设置时的主题"
  >
    <div class="theme-options">
      <button
        v-for="option in THEME_OPTIONS"
        :key="option.value"
        type="button"
        :class="{ active: theme === option.value }"
        :aria-pressed="theme === option.value"
        @click="theme = option.value"
      >
        {{ option.label }}
      </button>
    </div>
  </SettingsRow>

  <SettingsRow
    title="主界面字体大小"
    desc="菜单栏、标签页、侧边栏、状态栏等的字号"
  >
    <input
      v-model.number="uiFontSize"
      class="settings-number"
      type="number"
      :min="MIN_UI_FONT_SIZE"
      :max="MAX_UI_FONT_SIZE"
    >
    <span class="settings-unit">px</span>
  </SettingsRow>
</template>
