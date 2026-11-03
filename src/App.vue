<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useThemeStore } from './stores/theme'
import { useFileStore } from './stores/file'
import { useUpdateStore } from './stores/update'
import { useFileDrop } from './composables/useFileDrop'
import { useAiStore } from './stores/ai'
import { useSyncStore } from './stores/sync'
import AppHeader from './components/layout/AppHeader.vue'
import SideBar from './components/layout/SideBar.vue'
import StatusBar from './components/layout/StatusBar.vue'
import EditorPanel from './components/editor/EditorPanel.vue'
import ConfirmDialog from './components/common/ConfirmDialog.vue'
import PdfExportView from './components/export/PdfExportView.vue'
import PdfBatchProgressDialog from './components/export/PdfBatchProgressDialog.vue'
import UpdateDialog from './components/update/UpdateDialog.vue'
import FileDropOverlay from './components/common/FileDropOverlay.vue'

const themeStore = useThemeStore()
const fileStore = useFileStore()
const updateStore = useUpdateStore()
const { init: initFileDrop, dispose: disposeFileDrop } = useFileDrop()
const aiStore = useAiStore()
const syncStore = useSyncStore()
const aiReady = ref(false)

/**
 * AI 配置在设置中心里（「AI 助手」节），不在 AI 面板里。
 *
 * 面板那边只留一个「设置」按钮，点它发一个窗口事件，由 `AppHeader` 打开设置
 * 中心并落到 AI 节——设置面板的开关只有 AppHeader 持有，别在这里再养一份状态。
 */
const openAiSettings = (): void => {
  window.dispatchEvent(
    new CustomEvent('inkase:open-settings', { detail: { section: 'ai' } })
  )
}

async function loadAiReadiness(): Promise<void> {
  aiReady.value = false
  try {
    const result = await window.electronAPI.getAiConfig()
    aiReady.value = result.success && result.data?.ready === true
  } catch {
    aiReady.value = false
  }
}

async function openLaunchTargets(targets: Array<{ path: string; kind: 'file' | 'directory' }>): Promise<void> {
  for (const target of targets) {
    if (target.kind === 'directory') {
      await fileStore.openFolderPath(target.path)
    } else {
      await fileStore.openFile(target.path)
    }
  }
}

/**
 * 处理窗口关闭确认事件
 * 主进程检测到未保存修改时发送此事件
 */
async function handleConfirmClose(): Promise<void> {
  const canClose = await fileStore.confirmSaveBeforeClose()
  if (canClose && window.electronAPI?.closeConfirmed) {
    fileStore.cleanupTimers()
    await window.electronAPI.closeConfirmed()
  }
}

let removeConfirmCloseListener: (() => void) | null = null
let removeOpenTargetsListener: (() => void) | null = null

/**
 * 设置中心保存/探测完 AI 配置后回传的就绪状态。
 *
 * 面板标题栏的「配置可用」由这里驱动。不在这里反查 `getAiConfig`：设置中心刚
 * 拿到主进程的返回值，再查一次既是多余往返，也会把「探测通过但未保存」的
 * 中间态抹掉。
 */
function handleAiReadiness(event: Event): void {
  aiReady.value = (event as CustomEvent<boolean>).detail === true
}

onMounted(async () => {
  themeStore.initTheme()
  updateStore.init()
  initFileDrop()
  aiStore.init()
  syncStore.init()
  void loadAiReadiness()
  window.addEventListener('ai:readiness', handleAiReadiness)

  if (window.electronAPI?.onOpenTargets) {
    removeOpenTargetsListener = window.electronAPI.onOpenTargets((targets) => {
      void openLaunchTargets(targets)
    })
  }

  await fileStore.init()
  if (window.electronAPI?.getOpenTargets) {
    await openLaunchTargets(await window.electronAPI.getOpenTargets())
  }

  if (window.electronAPI?.onConfirmClose) {
    removeConfirmCloseListener = window.electronAPI.onConfirmClose(handleConfirmClose)
  }
})

onUnmounted(() => {
  if (removeConfirmCloseListener) {
    removeConfirmCloseListener()
  }
  if (removeOpenTargetsListener) {
    removeOpenTargetsListener()
  }
  window.removeEventListener('ai:readiness', handleAiReadiness)
  disposeFileDrop()
  updateStore.dispose()
  fileStore.cleanupTimers()
  aiStore.dispose()
})
</script>

<template>
  <div
    class="app-container"
    :data-theme="themeStore.currentTheme"
  >
    <!-- 顶部标题栏 -->
    <AppHeader />

    <!-- 主体区域 -->
    <div class="main-content">
      <!-- 左侧边栏 -->
      <SideBar
        :collapsed="fileStore.sidebarCollapsed"
        @toggle="fileStore.toggleSidebar"
      />
      
      <!-- 编辑区域 -->
      <EditorPanel
        :ai-ready="aiReady"
        @open-ai-settings="openAiSettings"
      />
    </div>
    
    <!-- 状态栏 -->
    <StatusBar />

    <ConfirmDialog />
    <PdfExportView />
    <PdfBatchProgressDialog />
    <UpdateDialog />
    <FileDropOverlay />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: var(--color-bg);
  color: var(--color-text);
}

.main-content {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
