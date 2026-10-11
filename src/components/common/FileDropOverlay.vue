<script setup lang="ts">
import { useFileDrop } from '../../composables/useFileDrop'

const { isDragging } = useFileDrop()
</script>

<template>
  <teleport to="body">
    <div
      v-if="isDragging"
      class="file-drop-overlay"
    >
      <div class="file-drop-box">
        <p class="file-drop-title">
          松开以打开
        </p>
        <p class="file-drop-subtitle">
          支持 .md / .mdx 文件与文件夹
        </p>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.file-drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 13000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  pointer-events: none;
}

.file-drop-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: min(480px, calc(100vw - 48px));
  padding: 48px 24px;
  border: 2px dashed var(--color-primary);
  border-radius: var(--radius-lg);
  background: var(--color-bg-primary);
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.2);
}

.file-drop-title {
  margin: 0;
  font-size: calc(var(--ui-font-size) + 5px);
  font-weight: 600;
  color: var(--color-text);
}

.file-drop-subtitle {
  margin: 0;
  font-size: var(--ui-font-size);
  color: var(--color-text-secondary);
}
</style>
