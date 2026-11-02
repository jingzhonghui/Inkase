<script setup lang="ts">
import SettingsRow from '../SettingsRow.vue'

/**
 * 文件与图片：插入图片时的压缩策略。
 *
 * 质量滑杆在没有开启压缩时禁用——它能调的范围完全由压缩决定，
 * 留着可点会让人以为「调了就会生效」。
 */
const compressEnabled = defineModel<boolean>('compressEnabled', { required: true })
const compressQuality = defineModel<number>('compressQuality', { required: true })
</script>

<template>
  <SettingsRow
    title="图片自动压缩"
    desc="插入图片时自动压缩以减小文档体积"
    layout="inline"
    clickable
  >
    <input
      v-model="compressEnabled"
      type="checkbox"
    >
  </SettingsRow>

  <SettingsRow
    title="压缩质量"
    desc="数值越高画质越好、体积越大"
  >
    <span class="quality-control">
      <input
        v-model.number="compressQuality"
        type="range"
        min="1"
        max="100"
        :disabled="!compressEnabled"
      >
      <output>{{ compressQuality }}</output>
    </span>
  </SettingsRow>
</template>
