<script setup lang="ts">
import SettingsRow from '../SettingsRow.vue'

/**
 * 通用：标签页与窗口层面的行为。
 *
 * 「恢复上次会话」的开关暂时不做——会话恢复目前是隐式且无副作用的，
 * 加开关属于新功能，不在这次「纯搬家」的范围里。
 */
const maxTabs = defineModel<number>('maxTabs', { required: true })
</script>

<template>
  <SettingsRow
    title="最大打开标签数"
    desc="同时打开的标签数量上限，防止打开过多"
    layout="inline"
  >
    <input
      v-model.number="maxTabs"
      class="settings-number"
      type="number"
      min="1"
      max="100"
    >
  </SettingsRow>
</template>
