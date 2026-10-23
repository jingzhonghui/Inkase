<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconSourceCode, IconWorldWww } from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'
import RightDock from '../layout/RightDock.vue'
import GlobalGraphView from '../knowledge/GlobalGraphView.vue'
import AiWorkbench from '../ai/AiWorkbench.vue'
import { useDockStore } from '../../stores/dock'
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
const knowledge = useKnowledgeStore()
const dockStore = useDockStore()
defineProps<{ aiReady?: boolean }>()
const emit = defineEmits<{ openAiSettings: [] }>()

/** 全局图谱占满内容区 */
const graphActive = computed(() => knowledge.graphTabActive)
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

    <!-- 内容区：编辑区 / 全局图谱 + 右侧停靠区 -->
    <div class="editor-body">
      <!-- 无文件打开时：AI 工作台首屏（空状态） -->
      <AiWorkbench
        v-if="!hasOpenFile && !graphActive"
        :ready="aiReady ?? false"
        @open-settings="emit('openAiSettings')"
      />

      <!-- 有文件打开时：显示编辑器 -->
      <div
        v-if="hasOpenFile"
        v-show="!graphActive"
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

      <!-- 全局图谱：独立视图，占满内容区 -->
      <GlobalGraphView v-if="graphActive" />

      <!-- 右侧三合一停靠面板（反链 / 图谱 / AI）；全局图谱时让位 -->
      <RightDock
        v-if="dockStore.open && !graphActive"
        :ready="aiReady ?? false"
        :has-file="hasOpenFile"
        @open-settings="emit('openAiSettings')"
      />
    </div>
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

/* 标签栏固定在顶部，编辑区与右侧停靠区横向并排 */
.editor-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
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
