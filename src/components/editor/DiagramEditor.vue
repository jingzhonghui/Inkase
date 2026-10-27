<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  IconAlertTriangle,
  IconArrowsMaximize,
  IconDeviceFloppy,
  IconFileTypeSvg,
  IconLoader2,
  IconPhoto,
  IconRefresh
} from '@tabler/icons-vue'
import { useFileStore } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { DiagramBridge } from '../../utils/diagram/bridge'
import { registerDiagramFlusher } from '../../utils/diagram/flush'
import { decodeDiagramDataUrl } from '../../../shared/diagram/embed'
import { normalizeDiagramXml } from '../../../shared/diagram/document'

/**
 * 图表编辑器：一个 iframe 套住自托管的 draw.io webapp，双方只走 embed 协议。
 *
 * 为什么不是「把 draw.io 打散成组件」：draw.io 的编辑器是强耦合的单体应用，
 * 拆到底也只能拿到 mxGraph 内核（那正是 B0 验证过的重造轮子路线）。
 * 直接把官方 webapp 装进 iframe，换来的是完整的形状库、导出、快捷键与撤销栈。
 *
 * 内容所有权：
 * - `tab.content` 是唯一真相（保存、崩溃恢复、外部变更都靠它）；
 * - iframe 里的画布是它的一个视图，改动经 `autosave` 回来，去抖后写回 store；
 * - 只有当内容变化**不是自己写的**（外部文件被改、会话恢复、切换标签）才回灌给 iframe，
 *   否则会陷入「写回 → 监听到变化 → 再加载」的活锁。
 */

const fileStore = useFileStore()
const themeStore = useThemeStore()

const iframeRef = ref<HTMLIFrameElement | null>(null)
const bridge = shallowRef<DiagramBridge | null>(null)
const status = ref<'checking' | 'loading' | 'ready' | 'missing' | 'error'>('checking')
const errorMessage = ref('')
const webappRoot = ref('')
const exporting = ref<'svg' | 'png' | null>(null)
const saving = ref(false)
/** 换主题时重建 iframe（draw.io 的配色只能靠 URL 参数决定） */
const frameKey = ref(0)

/** 最近一次「由自己写回 store」的 revision，用来识别外部变更 */
let lastWrittenRevision = -1
/** 最近一次同步给 iframe 的内容，避免重复装载 */
let lastLoadedContent = ''

const tabId = computed(() => fileStore.activeTabId)
const tab = computed(() => fileStore.activeTab)
const content = computed(() => String(tab.value?.content ?? ''))
const title = computed(() => tab.value?.fileInfo?.name ?? '未命名图表')

const embedUrl = computed(() =>
  DiagramBridge.url({
    dark: themeStore.isDark,
    lang: 'zh',
    libraries: true,
    ui: 'min'
  })
)

function disposeBridge(): void {
  bridge.value?.flushPendingAutosave()
  bridge.value?.dispose()
  bridge.value = null
}

/** 把 iframe 里当前的模型写回 store（autosave 与冲刷共用）。 */
function applyModelXml(xml: string): void {
  const normalized = normalizeDiagramXml(xml)
  if (!normalized) return
  // 与 store 里已有的正文一致就不写：drawio 装载后会补发一次 autosave，
  // 若不拦，打开一个文件就先把自己标成「未保存」。
  const current = normalizeDiagramXml(String(content.value ?? ''))
  if (normalized === current) {
    lastLoadedContent = normalized
    return
  }
  lastLoadedContent = normalized
  fileStore.updateContent(normalized)
  lastWrittenRevision = tab.value?.revision ?? -1
}

async function initBridge(): Promise<void> {
  const bridgeInstance = new DiagramBridge({
    target: () => iframeRef.value?.contentWindow ?? null,
    onAutosave: (xml) => applyModelXml(xml),
    autosaveDebounceMs: 350
  })
  // 必须先挂监听再等 init：draw.io 在脚本执行的下一拍就会发 init
  bridgeInstance.start()
  bridge.value = bridgeInstance

  try {
    await bridgeInstance.waitForInit(30000)
  } catch (error) {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '图表编辑器初始化失败'
    return
  }

  const initial = content.value.trim() || '<?xml version="1.0" encoding="UTF-8"?>'
  try {
    await bridgeInstance.load(initial, { title: title.value })
    lastLoadedContent = normalizeDiagramXml(initial)
  } catch (error) {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '装载图表失败'
    return
  }

  status.value = 'ready'
  await bridgeInstance.fit().catch(() => undefined)
}

/** 检查 webapp 是否就位：缺失时给可执行的提示，而不是白屏 */
async function checkWebapp(): Promise<void> {
  status.value = 'checking'
  errorMessage.value = ''
  try {
    const result = await window.electronAPI?.getDiagramSupport?.()
    if (!result || !result.success || !result.data) {
      status.value = 'missing'
      errorMessage.value = result?.error ?? '无法确认 draw.io 组件状态'
      return
    }
    webappRoot.value = result.data.root
    if (!result.data.available) {
      status.value = 'missing'
      return
    }
    status.value = 'loading'
    await nextTickInit()
  } catch (error) {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : '检查组件失败'
  }
}

async function nextTickInit(): Promise<void> {
  frameKey.value += 1
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await initBridge()
}

async function onSave(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await fileStore.saveFile()
  } finally {
    saving.value = false
  }
}

async function onFit(): Promise<void> {
  await bridge.value?.fit()
}

async function onExport(format: 'svg' | 'png'): Promise<void> {
  if (exporting.value) return
  exporting.value = format
  try {
    const bridgeInstance = bridge.value
    if (!bridgeInstance) return
    const event = await bridgeInstance.exportAs(format)
    const dataUrl = String(event.data ?? '')
    const decoded = decodeDiagramDataUrl(dataUrl)
    if (!decoded) {
      errorMessage.value = '导出失败：没有拿到图片数据'
      return
    }
    const baseName = title.value.replace(/\.drawio$/i, '') || '图表'
    await window.electronAPI?.exportMindMapImage(baseName, format, decoded.bytes)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = null
  }
}

/** 正在把外部内容装进画布的 Promise；保存前冲刷要等它，避免导出旧模型。 */
let loadChain: Promise<void> = Promise.resolve()

/** 外部变更（重新打开文件、外部编辑、恢复快照）回灌给画布。 */
function reloadFromContent(): void {
  const bridgeInstance = bridge.value
  if (!bridgeInstance || status.value !== 'ready') return
  const raw = content.value.trim()
  if (!raw || raw === lastLoadedContent) return
  lastLoadedContent = raw
  loadChain = bridgeInstance.load(raw, { title: title.value }).catch((error) => {
    errorMessage.value = error instanceof Error ? error.message : '重新载入图表失败'
  })
}

watch(
  () => content.value,
  () => {
    // 自己写回的变更不需要回灌（revision 相等即视为同一次写入）
    if ((tab.value?.revision ?? -1) === lastWrittenRevision) return
    reloadFromContent()
  }
)

watch(
  () => themeStore.isDark,
  async () => {
    // 主题影响 draw.io 自己的配色与形状默认色：重建 iframe，再把当前内容装回去
    const snapshot = await bridge.value?.flushXml().catch(() => '')
    disposeBridge()
    status.value = 'loading'
    await nextTickInit()
    if (snapshot) {
      lastLoadedContent = ''
      applyModelXmlSilently(snapshot)
    }
  }
)

/** 主题切换后的重装：内容与已落盘的一致，不该把标签标脏 */
function applyModelXmlSilently(xml: string): void {
  const normalized = normalizeDiagramXml(xml)
  if (!normalized) return
  lastLoadedContent = normalized
  lastWrittenRevision = tab.value?.revision ?? -1
}

let unregisterFlusher: (() => void) | null = null

onMounted(async () => {
  unregisterFlusher = registerDiagramFlusher(tabId.value ?? '', async () => {
    const bridgeInstance = bridge.value
    if (!bridgeInstance || status.value !== 'ready') return
    // 等一拍：外部写入（AI 改正文、重新打开）触发的 watcher 是批处理的，
    // 不等这一拍就导出，拿到的还是装载前的旧模型。
    await nextTick()
    // 再等「把新内容装进画布」这件事完成，否则同样会导出旧模型
    await loadChain.catch(() => undefined)
    const xml = await bridgeInstance.flushXml()
    if (xml) applyModelXml(xml)
  })
  await checkWebapp()
})

onBeforeUnmount(() => {
  // 卸载前把去抖窗口里最后一条改动落地，避免「切标签再回来少了东西」
  disposeBridge()
  unregisterFlusher?.()
  unregisterFlusher = null
})
</script>

<template>
  <div class="diagram-editor">
    <div class="diagram-toolbar">
      <div class="diagram-toolbar-left">
        <span class="diagram-title">{{ title }}</span>
        <span
          v-if="status === 'ready'"
          class="diagram-hint"
        >双击图形编辑文字 · 从左侧拖入形状</span>
      </div>
      <div class="diagram-toolbar-right">
        <button
          class="diagram-btn"
          title="适应窗口"
          :disabled="status !== 'ready'"
          @click="onFit"
        >
          <IconArrowsMaximize :size="16" />
        </button>
        <button
          class="diagram-btn"
          title="重新加载"
          :disabled="status !== 'ready'"
          @click="reloadFromContent"
        >
          <IconRefresh :size="16" />
        </button>
        <button
          class="diagram-btn"
          title="导出 SVG"
          :disabled="status !== 'ready' || exporting !== null"
          @click="onExport('svg')"
        >
          <IconFileTypeSvg :size="16" />
        </button>
        <button
          class="diagram-btn"
          title="导出 PNG"
          :disabled="status !== 'ready' || exporting !== null"
          @click="onExport('png')"
        >
          <IconPhoto :size="16" />
        </button>
        <button
          class="diagram-btn primary"
          title="保存 (Ctrl+S)"
          :disabled="saving"
          @click="onSave"
        >
          <IconDeviceFloppy :size="16" />
        </button>
      </div>
    </div>

    <div class="diagram-surface">
      <div
        v-if="status === 'checking' || status === 'loading'"
        class="diagram-overlay"
      >
        <IconLoader2
          :size="20"
          class="spin"
        />
        <span>{{ status === 'checking' ? '正在检查图表组件…' : '正在加载图表编辑器…' }}</span>
      </div>

      <div
        v-else-if="status === 'missing'"
        class="diagram-overlay missing"
      >
        <IconAlertTriangle :size="22" />
        <p class="overlay-title">
          图表组件尚未安装
        </p>
        <p class="overlay-desc">
          Inkase 的图表编辑器是本地自托管的 draw.io，需要先把它下载到
          <code>resources/drawio</code>。
        </p>
        <code class="overlay-cmd">pnpm run fetch:drawio</code>
        <p
          v-if="webappRoot"
          class="overlay-path"
        >
          期望位置：{{ webappRoot }}
        </p>
      </div>

      <div
        v-else-if="status === 'error'"
        class="diagram-overlay error"
      >
        <IconAlertTriangle :size="22" />
        <p class="overlay-title">
          图表编辑器没能启动
        </p>
        <p class="overlay-desc">
          {{ errorMessage }}
        </p>
        <button
          class="diagram-btn primary"
          @click="checkWebapp"
        >
          重试
        </button>
      </div>

      <iframe
        v-show="status === 'ready' || status === 'loading' || status === 'error'"
        :key="`${frameKey}-${embedUrl}`"
        ref="iframeRef"
        class="diagram-frame"
        :src="embedUrl"
        :title="`图表编辑器：${title}`"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  </div>
</template>

<style scoped>
.diagram-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg-primary);
}

.diagram-toolbar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-bg-secondary);
}

.diagram-toolbar-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.diagram-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diagram-hint {
  font-size: 11px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.diagram-toolbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}

.diagram-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.diagram-btn:hover:not(:disabled) {
  background-color: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.diagram-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.diagram-btn.primary {
  color: var(--color-accent);
}

.diagram-surface {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.diagram-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background-color: var(--color-bg-primary);
}

.diagram-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  background-color: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.diagram-overlay.missing,
.diagram-overlay.error {
  color: var(--color-text-secondary);
}

.overlay-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.overlay-desc {
  margin: 0;
  max-width: 460px;
  line-height: 1.7;
}

.overlay-cmd {
  padding: 4px 10px;
  border-radius: 4px;
  background-color: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-family: var(--editor-font-family, monospace);
}

.overlay-path {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-tertiary);
  word-break: break-all;
}

.spin {
  animation: diagram-spin 1s linear infinite;
}

@keyframes diagram-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
