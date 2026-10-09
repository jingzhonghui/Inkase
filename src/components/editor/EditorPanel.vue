<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconFile, IconFolder, IconPlus, IconSourceCode, IconWorldWww } from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useAiStore } from '../../stores/ai'
import AiPanel from '../ai/AiPanel.vue'
import SourceEditor from './SourceEditor.vue'
import IrEditor from './IrEditor.vue'
import PreviewPanel from './PreviewPanel.vue'
import ImageViewer from './ImageViewer.vue'
import PdfViewer from './PdfViewer.vue'
import HtmlPreview from './HtmlPreview.vue'
import TabBar from './TabBar.vue'
import { Splitpanes, Pane } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'

const fileStore = useFileStore()
const aiStore = useAiStore()
defineProps<{ aiReady?: boolean }>()
const emit = defineEmits<{ openAiSettings: [] }>()

const showPreview = computed(() => fileStore.effectiveEditorMode === 'split')
const isIrMode = computed(() => fileStore.effectiveEditorMode === 'ir')
const hasOpenFile = computed(() => fileStore.tabs.length > 0 && fileStore.activeTabId !== null)
const isImageTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'image')
const isPdfTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'pdf')
const isPlainTextTab = computed(() => fileStore.effectiveEditorMode === 'plain')
const isHtmlTab = computed(() => fileStore.isHtmlFile)
const isHtmlPreviewOn = computed(() => isHtmlTab.value && fileStore.htmlPreviewActive)

// 组件引用
const sourceEditorRef = ref<InstanceType<typeof SourceEditor>>()
const previewRef = ref<InstanceType<typeof PreviewPanel>>()

// 滚动同步锁，防止循环同步
let isSyncing = false

/**
 * 编辑器滚动回调
 */
function onEditorScroll(ratio: number): void {
  if (isSyncing) return
  isSyncing = true
  previewRef.value?.scrollTo(ratio)
  setTimeout(() => { isSyncing = false }, 50)
}

/**
 * 预览区域滚动回调
 */
function onPreviewScroll(ratio: number): void {
  if (isSyncing) return
  isSyncing = true
  sourceEditorRef.value?.scrollTo(ratio)
  setTimeout(() => { isSyncing = false }, 50)
}
</script>

<template>
  <div class="editor-panel">
    <!-- 标签栏 -->
    <TabBar />

    <!-- 无文件打开时：显示欢迎页 -->
    <div
      v-show="!hasOpenFile && !aiStore.panelActive"
      class="welcome-page"
    >
      <div class="welcome-content">
        <img
          src="../../assets/logo.svg"
          alt="Inkase"
          class="welcome-logo"
        >
        <h1 class="welcome-title">
          Inkase
        </h1>
        <p class="welcome-subtitle">
          自包含文档工作台
        </p>

        <div class="welcome-actions">
          <button
            class="welcome-btn primary"
            @click="fileStore.newFile()"
          >
            <IconPlus />
            新建文件
          </button>
          <button
            class="welcome-btn"
            @click="fileStore.openFile()"
          >
            <IconFile />
            打开文件
          </button>
          <button
            class="welcome-btn"
            @click="fileStore.openFolder()"
          >
            <IconFolder />
            打开文件夹
          </button>
        </div>

        <div class="welcome-shortcuts">
          <h2 class="shortcuts-title">
            快捷键
          </h2>
          <div class="shortcuts-grid">
            <div class="shortcut-item">
              <kbd>Ctrl+N</kbd>
              <span>新建文件</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+O</kbd>
              <span>打开文件</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+P</kbd>
              <span>快速打开文件</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+S</kbd>
              <span>保存文件</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+Shift+S</kbd>
              <span>另存为</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+B</kbd>
              <span>粗体</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+I</kbd>
              <span>斜体</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+K</kbd>
              <span>插入链接</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+H</kbd>
              <span>替换</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+F</kbd>
              <span>查找</span>
            </div>
            <div class="shortcut-item">
              <kbd>Ctrl+/</kbd>
              <span>切换编辑模式</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 有文件打开时：显示编辑器 -->
    <div
      v-if="hasOpenFile"
      v-show="!aiStore.panelActive"
      class="document-view"
    >
      <!-- HTML 预览切换悬浮按钮（仅 HTML 标签页显示，独立于 Markdown 模式体系） -->
      <button
        v-if="isHtmlTab"
        class="html-preview-toggle"
        :class="{ active: isHtmlPreviewOn }"
        :title="isHtmlPreviewOn ? '返回源码' : '预览 HTML'"
        @click="fileStore.toggleHtmlPreview()"
      >
        <IconSourceCode
          v-if="isHtmlPreviewOn"
          :size="16"
          :stroke-width="2"
        />
        <IconWorldWww
          v-else
          :size="16"
          :stroke-width="2"
        />
      </button>

      <!-- 图片文件：只读查看 -->
      <ImageViewer
        v-if="isImageTab"
        :key="fileStore.activeTabId || 'image-viewer'"
      />

      <!-- PDF 文件：只读查看 -->
      <PdfViewer
        v-else-if="isPdfTab"
        :key="fileStore.activeTabId || 'pdf-viewer'"
      />

      <!-- HTML 文件预览态：浏览器式渲染（右上角按钮切换源码/预览） -->
      <HtmlPreview
        v-else-if="isHtmlPreviewOn"
        :key="`html-preview-${fileStore.activeTabId || 'html'}`"
      />

      <!-- HTML 文件源码态：纯文本源码 + 右上角预览按钮 -->
      <SourceEditor
        v-else-if="isPlainTextTab && isHtmlTab"
        :key="`html-source-${fileStore.activeTabId || 'html-src'}`"
        :plain-text="true"
      />

      <!-- 纯文本文件（.txt 等）：源码编辑显示原文，不进入即时渲染/预览 -->
      <SourceEditor
        v-else-if="isPlainTextTab"
        :key="`plain-${fileStore.activeTabId || 'plain'}`"
        :plain-text="true"
      />

      <!-- 即时渲染模式 -->
      <IrEditor
        v-else-if="isIrMode"
        :key="fileStore.activeTabId || 'ir-editor'"
      />

      <!-- 源码模式：仅显示编辑器 -->
      <SourceEditor
        v-else-if="!showPreview"
      />

      <!-- 分屏模式：可拖拽调整左右面板 -->
      <Splitpanes
        v-else
        class="splitpanes-theme"
      >
        <Pane :min-size="20">
          <SourceEditor
            ref="sourceEditorRef"
            @scroll="onEditorScroll"
          />
        </Pane>
        <Pane :min-size="20">
          <PreviewPanel
            ref="previewRef"
            :enable-scroll-sync="true"
            @scroll="onPreviewScroll"
          />
        </Pane>
      </Splitpanes>
    </div>

    <AiPanel
      v-if="aiStore.panelOpen"
      v-show="aiStore.panelActive"
      :ready="aiReady ?? false"
      @open-settings="emit('openAiSettings')"
    />
  </div>
</template>

<style scoped>
.editor-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--color-bg-primary);
}

.document-view {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* HTML 预览切换悬浮按钮（编辑器右上角） */
.html-preview-toggle {
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-secondary) 85%, transparent);
  color: var(--color-text-secondary);
  cursor: pointer;
  backdrop-filter: blur(4px);
  transition: all 0.15s;
}

.html-preview-toggle:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.html-preview-toggle.active {
  background: var(--color-primary-light);
  color: var(--color-primary);
  border-color: var(--color-primary);
}

/* 欢迎页 */
.welcome-page {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
}

.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 32px;
  max-width: 520px;
  width: 100%;
}

.welcome-logo {
  width: 64px;
  height: 64px;
  margin-bottom: 16px;
}

.welcome-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
  margin: 0;
}

.welcome-subtitle {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin: 8px 0 32px;
}

.welcome-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 40px;
}

.welcome-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  color: var(--color-text);
  cursor: pointer;
  transition: all 0.2s;
}

.welcome-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-primary-light);
}

.welcome-btn.primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.welcome-btn.primary:hover {
  background: var(--color-primary-hover);
}

.welcome-btn svg {
  width: 16px;
  height: 16px;
}

.shortcuts-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 16px;
}

.shortcuts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 32px;
}

.shortcut-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
}

.shortcut-item kbd {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.shortcut-item span {
  font-size: 13px;
  color: var(--color-text-secondary);
}

/* Splitpanes 主题适配 */
.splitpanes-theme {
  flex: 1;
  height: auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.splitpanes-theme :deep(.splitpanes__pane) {
  min-width: 0;
  min-height: 0;
  background-color: var(--color-bg-primary);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.splitpanes-theme :deep(.splitpanes__splitter) {
  background-color: var(--color-bg-secondary);
  border-left: 1px solid var(--color-border);
  border-right: 1px solid var(--color-border);
  position: relative;
  width: 2px;
  cursor: col-resize;
  transition: background-color 0.2s;
}

.splitpanes-theme :deep(.splitpanes__splitter:hover) {
  background-color: var(--color-primary);
}

.splitpanes-theme :deep(.splitpanes__splitter::before) {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 2px;
  height: 24px;
  background-color: var(--color-border);
  border-radius: 1px;
  transition: background-color 0.2s;
}

.splitpanes-theme :deep(.splitpanes__splitter:hover::before) {
  background-color: white;
}
</style>
