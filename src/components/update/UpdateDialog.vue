<script setup lang="ts">
import { computed } from 'vue'
import { useUpdateStore } from '../../stores/update'
import { renderMarkdown } from '../../utils/markdown'

const updateStore = useUpdateStore()

const releaseNotesHtml = computed(() => {
  const notes = updateStore.info?.releaseNotes
  if (!notes) return ''
  return renderMarkdown(notes)
})

async function handleDownload(): Promise<void> {
  await updateStore.openReleases()
}
</script>

<template>
  <teleport to="body">
    <div
      v-if="updateStore.dialogOpen"
      class="update-overlay"
    >
      <section
        class="update-dialog"
        role="dialog"
        aria-modal="true"
        @click.stop
      >
        <!-- 发现新版本 -->
        <template v-if="updateStore.status === 'available'">
          <h3>发现新版本</h3>
          <p class="update-version">
            Inkase v{{ updateStore.info?.version }}
          </p>
          <div
            v-if="releaseNotesHtml"
            class="update-notes"
            v-html="releaseNotesHtml"
          />
          <div class="update-actions">
            <button
              type="button"
              class="update-btn update-btn-cancel"
              @click="updateStore.dismiss"
            >
              稍后
            </button>
            <button
              type="button"
              class="update-btn update-btn-confirm"
              @click="handleDownload"
            >
              前往下载
            </button>
          </div>
        </template>

        <!-- 错误 -->
        <template v-else-if="updateStore.status === 'error'">
          <h3>更新失败</h3>
          <p class="update-message">
            {{ updateStore.errorMessage }}
          </p>
          <div class="update-actions">
            <button
              type="button"
              class="update-btn update-btn-cancel"
              @click="updateStore.dismiss"
            >
              关闭
            </button>
          </div>
        </template>
      </section>
    </div>
  </teleport>
</template>

<style scoped>
.update-overlay {
  position: fixed;
  inset: 0;
  z-index: 12000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.35);
}

.update-dialog {
  width: min(440px, calc(100vw - 32px));
  padding: 20px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.2);
}

.update-dialog h3 {
  margin: 0 0 12px;
  font-size: calc(var(--ui-font-size) + 3px);
  font-weight: 600;
}

.update-version {
  margin: 0 0 12px;
  font-weight: 600;
  color: var(--color-primary);
}

.update-message {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
  line-height: 1.6;
}

.update-notes {
  max-height: 240px;
  margin: 0 0 4px;
  padding: 10px 12px;
  overflow: auto;
  font-size: var(--ui-font-size);
  line-height: 1.6;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
}

.update-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.update-btn {
  padding: 7px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--ui-font-size);
}

.update-btn-cancel {
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
}

.update-btn-confirm {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: white;
}
</style>
