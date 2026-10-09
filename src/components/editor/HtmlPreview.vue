<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconRefresh } from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { buildPreviewUrl } from '../../utils/preview-url'

/**
 * HTML 浏览器式预览
 *
 * 通过自定义协议 inkase-preview:// 在沙箱 iframe 中加载已保存的 HTML 文件，
 * JS 可运行（allow-scripts）但与渲染进程隔离（无 allow-same-origin）。
 * 预览内容来自磁盘：编辑未保存时提示并提供刷新。
 */

const fileStore = useFileStore()

const reloadToken = ref(0)

const previewUrl = computed(() => {
  const path = fileStore.activeTab?.fileInfo?.path
  return path ? buildPreviewUrl(path) : ''
})

const frameKey = computed(() => `${previewUrl.value}|${reloadToken.value}`)

const isModified = computed(() => fileStore.activeTab?.fileInfo?.modified === true)

function refresh(): void {
  reloadToken.value++
}
</script>

<template>
  <div class="html-preview">
    <div class="preview-toolbar">
      <span
        v-if="isModified"
        class="preview-hint"
      >预览为已保存版本</span>
      <button
        class="html-preview-refresh"
        title="刷新预览"
        @click="refresh"
      >
        <IconRefresh
          :size="14"
          :stroke-width="2"
        />
      </button>
    </div>
    <iframe
      v-if="previewUrl"
      :key="frameKey"
      class="preview-frame"
      :src="previewUrl"
      sandbox="allow-scripts"
    />
  </div>
</template>

<style scoped>
.html-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-primary);
}

.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  min-height: 28px;
}

.preview-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.html-preview-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.html-preview-refresh:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-primary);
}

.preview-frame {
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  border: none;
  background: #ffffff;
}
</style>
