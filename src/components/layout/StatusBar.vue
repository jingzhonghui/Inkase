<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { IconCode, IconColumns, IconFileText } from '@tabler/icons-vue'
import { useFileStore, type EditorMode } from '../../stores/file'
import { findCodeLanguage, languageDisplayName } from '../../utils/editor-language'
import Tooltip from '../common/Tooltip.vue'

const fileStore = useFileStore()
const appVersion = ref('')

/** 当前生效的编辑模式：非 .md/.mdx 文件（如 .txt）实际按源码编辑显示 */
const effectiveMode = computed<EditorMode>(() =>
  fileStore.effectiveEditorMode
)

onMounted(async () => {
  try {
    appVersion.value = await window.electronAPI.getVersion()
  } catch {
    appVersion.value = ''
  }
})

const appLabel = computed(() => {
  return appVersion.value ? `Inkase v${appVersion.value}` : 'Inkase'
})

const fileSize = computed(() => {
  const bytes = new Blob([fileStore.fileContent]).size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
})

const saveStatus = computed(() => {
  if (fileStore.isLoading) return '加载中...'
  if (fileStore.isModified) return '未保存'
  return '已保存'
})

const saveStatusClass = computed(() => {
  if (fileStore.isLoading) return 'loading'
  if (fileStore.isModified) return 'modified'
  return 'saved'
})

/**
 * 切换编辑模式
 * 顺序：分屏预览 -> 源码编辑 -> 即时渲染 -> 分屏预览
 */
function toggleEditorMode(): void {
  const modes: EditorMode[] = ['split', 'source', 'ir']
  const currentIndex = modes.indexOf(fileStore.editorMode)
  const nextIndex = (currentIndex + 1) % modes.length
  fileStore.setEditorMode(modes[nextIndex])
}

/**
 * 获取模式图标
 */
const modeIcon = computed(() => {
  const icons: Record<EditorMode, string> = {
    split: 'split',
    source: 'source',
    ir: 'ir',
    plain: 'source'
  }
  return icons[effectiveMode.value]
})

/**
 * 纯文本模式按后缀匹配到的语言展示名（如 Shell/INI），无匹配时回退“纯文本”
 */
const plainLanguageLabel = computed<string | null>(() => {
  const name = fileStore.activeTab?.fileInfo?.name
  if (!name) return null
  const desc = findCodeLanguage(name)
  return desc ? languageDisplayName(desc) : null
})

/**
 * 获取模式展示名
 */
const modeLabel = computed(() => {
  if (effectiveMode.value === 'plain') return plainLanguageLabel.value ?? '纯文本'
  const labels: Record<Exclude<EditorMode, 'plain'>, string> = {
    split: '分屏预览',
    source: '源码编辑',
    ir: '即时渲染'
  }
  return labels[effectiveMode.value]
})

/**
 * 获取模式提示文字
 */
const modeTooltip = computed(() => `${modeLabel.value} (点击切换)`)
</script>

<template>
  <footer class="status-bar">
    <div class="status-left">
      <span class="status-item">字数: {{ fileStore.wordCount }}</span>
      <span class="status-separator">|</span>
      <span class="status-item">文件大小: {{ fileSize }}</span>
      <span class="status-separator">|</span>
      <span class="status-item">
        行 {{ fileStore.cursorLine }}, 列 {{ fileStore.cursorColumn }}
      </span>
    </div>

    <div class="status-right">
      <!-- 编辑模式切换按钮 -->
      <Tooltip :content="modeTooltip">
        <button
          class="mode-toggle-btn"
          :class="effectiveMode"
          :disabled="!fileStore.canSwitchEditorMode"
          @click="toggleEditorMode"
        >
          <!-- 分屏预览图标 -->
          <IconColumns v-if="modeIcon === 'split'" />
          <!-- 即时渲染图标 -->
          <IconFileText v-else-if="modeIcon === 'ir'" />
          <!-- 源码编辑图标 -->
          <IconCode v-else />
          <span class="mode-label">{{ modeLabel }}</span>
        </button>
      </Tooltip>

      <span class="status-separator">|</span>

      <span
        class="status-item"
        :class="saveStatusClass"
      >
        {{ saveStatus }}
      </span>
      <template v-if="appVersion">
        <span class="status-separator">|</span>
        <span class="status-item">{{ appLabel }}</span>
      </template>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--statusbar-height);
  padding: 0 var(--spacing-md);
  background-color: var(--color-bg-secondary);
  border-top: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.status-right > :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.status-item {
  white-space: nowrap;
}

.status-separator {
  color: var(--color-border-hover);
  user-select: none;
}

.saved {
  color: var(--color-success);
}

.modified {
  color: var(--color-warning);
}

.loading {
  color: var(--color-text-tertiary);
}

/* 模式切换按钮 */
.mode-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.mode-toggle-btn svg {
  width: 14px;
  height: 14px;
}

.mode-toggle-btn:hover {
  border-color: var(--color-border-hover);
  background-color: var(--color-bg-secondary);
}

.mode-toggle-btn.split {
  color: #8b5cf6;
  border-color: #8b5cf6;
  background-color: rgba(139, 92, 246, 0.1);
}

.mode-toggle-btn.source {
  color: #10b981;
  border-color: #10b981;
  background-color: rgba(16, 185, 129, 0.1);
}

.mode-toggle-btn.ir {
  color: #f59e0b;
  border-color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.1);
}

.mode-toggle-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mode-toggle-btn:disabled:hover {
  border-color: var(--color-border);
  background-color: var(--color-bg-primary);
}

.mode-label {
  white-space: nowrap;
}
</style>
