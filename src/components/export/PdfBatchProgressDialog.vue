<script setup lang="ts">
import { computed } from 'vue'
import { useFileStore } from '../../stores/file'

const fileStore = useFileStore()
const progress = computed(() => fileStore.pdfBatchProgress)
const percentage = computed(() => progress.value.total > 0
  ? Math.round(progress.value.completed / progress.value.total * 100)
  : 0)
</script>

<template>
  <teleport to="body">
    <div
      v-if="progress.visible"
      class="pdf-progress-overlay"
    >
      <section class="pdf-progress-dialog">
        <h3>{{ progress.running ? '正在批量导出 PDF' : '批量导出完成' }}</h3>
        <p v-if="progress.running">
          {{ progress.currentFile }}
        </p>
        <p v-else>
          成功 {{ progress.successCount }} 个，失败 {{ progress.failures.length }} 个
        </p>
        <div class="pdf-progress-track">
          <div :style="{ width: percentage + '%' }" />
        </div>
        <div class="pdf-progress-count">
          {{ progress.completed }} / {{ progress.total }}
        </div>
        <div
          v-if="progress.failures.length"
          class="pdf-progress-errors"
        >
          <div
            v-for="failure in progress.failures"
            :key="failure.file"
          >
            <strong>{{ failure.file }}</strong>: {{ failure.error }}
          </div>
        </div>
        <button
          v-if="!progress.running"
          type="button"
          @click="fileStore.closePdfBatchProgress"
        >
          关闭
        </button>
      </section>
    </div>
  </teleport>
</template>

<style>
.pdf-progress-overlay {
  position: fixed;
  inset: 0;
  z-index: 11000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
}

.pdf-progress-dialog {
  width: min(440px, calc(100vw - 32px));
  padding: 20px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.24);
}

.pdf-progress-dialog h3 { margin: 0 0 12px; font-size: calc(var(--ui-font-size) + 3px); }
.pdf-progress-dialog p { margin: 0 0 12px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdf-progress-track { height: 8px; overflow: hidden; background: var(--color-bg-tertiary); border-radius: 4px; }
.pdf-progress-track > div { height: 100%; background: var(--color-primary); transition: width 0.2s ease; }
.pdf-progress-count { margin-top: 6px; font-size: calc(var(--ui-font-size) - 1px); color: var(--color-text-tertiary); text-align: right; }
.pdf-progress-errors { max-height: 160px; margin-top: 12px; padding: 8px; overflow: auto; font-size: calc(var(--ui-font-size) - 1px); line-height: 1.6; color: var(--color-error); background: var(--color-bg-secondary); border-radius: var(--radius-sm); }
.pdf-progress-dialog button { display: block; margin: 16px 0 0 auto; padding: 6px 18px; color: #fff; background: var(--color-primary); border: 0; border-radius: var(--radius-sm); cursor: pointer; }
</style>
