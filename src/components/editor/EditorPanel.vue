<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { IconSourceCode, IconWorldWww } from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useAiStore } from '../../stores/ai'
import { useGraphStore } from '../../stores/graph'
import { useWorkspaceStore } from '../../stores/workspace'
import AiPanel from '../ai/AiPanel.vue'
import WorkspaceTopBar from '../layout/WorkspaceTopBar.vue'
import SourceEditor from './SourceEditor.vue'
import IrEditor from './IrEditor.vue'
import PreviewPanel from './PreviewPanel.vue'
import ImageViewer from './ImageViewer.vue'
import PdfViewer from './PdfViewer.vue'
import HtmlPreview from './HtmlPreview.vue'
import TabBar from './TabBar.vue'
import { Splitpanes, Pane } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'

/**
 * 思维导图编辑器按需加载：
 * 渲染核心约 120KB，没必要进入首屏包。
 */
const MindMapEditor = defineAsyncComponent(() => import('./MindMapEditor.vue'))

/**
 * 图表编辑器同样按需加载：它本体只有一个 iframe，
 * 但配套的桥接/图标/工具栏没必要进首屏。
 */
const DiagramEditor = defineAsyncComponent(() => import('./DiagramEditor.vue'))

/**
 * 知识图谱同样按需加载：索引之外的仿真、绘制、问题清单只在打开图谱时才需要，
 * 让它们进首屏包等于给每个用户多发一份用不到的画布代码（设计 §6）。
 */
const GraphView = defineAsyncComponent(() => import('../graph/GraphView.vue'))

const fileStore = useFileStore()
const aiStore = useAiStore()
const graphStore = useGraphStore()
const workspaceStore = useWorkspaceStore()
defineProps<{ aiReady?: boolean }>()
const emit = defineEmits<{ openAiSettings: [] }>()

// ===== 工作台与文档视图的切换规则 =====
// 1. 关了最后一个文档 → 回到工作台（这正是「常驻」的意义：有地方可回）
// 2. 打开/切换到别的文档 → 让文档视图接管，否则用户点了节点或最近文件却没有反应
//    注意只认 activeTabId 的**变化**：点工作台分段不会动它，不会误关工作台
watch(
  () => fileStore.tabs.length,
  (count) => {
    if (count === 0) workspaceStore.open('graph')
  },
  // 启动时没有文档就直接落在工作台：这里不再是「欢迎页占位」，而是首屏
  { immediate: true }
)

watch(
  () => fileStore.activeTabId,
  (next, previous) => {
    if (next !== previous && next !== null) workspaceStore.close()
  }
)

// 3. AI 被关掉（且当时正停在 AI 段）→ 退回图谱段，别留一块空白
//    AI 段的挂载条件是 panelOpen，关掉之后这一段就没有内容了。
//    只在工作台处于前台时兜底：在文档视图里点工具栏关 AI，不该把人拽到工作台
watch(
  () => aiStore.panelOpen,
  (open) => {
    if (!open && workspaceStore.active && workspaceStore.segment === 'ai') {
      workspaceStore.setSegment('graph')
    }
  }
)

const showPreview = computed(() => fileStore.effectiveEditorMode === 'split')
const isIrMode = computed(() => fileStore.effectiveEditorMode === 'ir')
const hasOpenFile = computed(() => fileStore.tabs.length > 0 && fileStore.activeTabId !== null)
const isImageTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'image')
const isPdfTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'pdf')
const isMindMapTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'mindmap')
const isDiagramTab = computed(() => fileStore.activeTab?.fileInfo?.format === 'diagram')
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

    <!-- 工作台顶条：图谱 / AI 两段共用一条，避免"双页头" -->
    <WorkspaceTopBar v-if="workspaceStore.active" />

    <!-- 有文件打开时：显示编辑器 -->
    <div
      v-if="hasOpenFile"
      v-show="!workspaceStore.active"
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

      <!-- 思维导图：独立编辑器（不走 Markdown 的源码/即时渲染/分屏体系） -->
      <MindMapEditor
        v-else-if="isMindMapTab"
        :key="fileStore.activeTabId || 'mindmap-editor'"
      />

      <!-- 图表（.drawio）：iframe 套自托管 draw.io，走 embed 协议 -->
      <DiagramEditor
        v-else-if="isDiagramTab"
        :key="fileStore.activeTabId || 'diagram-editor'"
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
      v-show="workspaceStore.isAi"
      :ready="aiReady ?? false"
      @open-settings="emit('openAiSettings')"
    />

    <!-- 知识图谱：工作台的第三段。embedded 让它交出自己的页头，
         由顶条统一提供搜索、统计与刷新，否则顶部会叠两条横条 -->
    <GraphView
      v-if="graphStore.panelOpen"
      v-show="workspaceStore.isGraph"
      embedded
      :rail-visible="!workspaceStore.expanded"
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
