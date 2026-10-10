<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconX } from '@tabler/icons-vue'
import { useSyncStore } from '../../stores/sync'
import { useFileStore } from '../../stores/file'
import Tooltip from '../common/Tooltip.vue'

const syncStore = useSyncStore()
const fileStore = useFileStore()

const statusLabel = computed<Record<string, string>>(() => ({
  uninitialized: '未启用同步',
  syncing: '同步中...',
  upToDate: '已同步',
  pendingCommit: '有未提交变更',
  pendingPush: '有本地提交待推送',
  pendingPull: '有远端更新待拉取',
  conflict: '存在冲突',
  error: '同步出错'
}))

const showingConfigForm = ref(false)
const actionError = ref<string | null>(null)

const statusText = computed(() => {
  if (syncStore.status === 'error' && syncStore.error) return `${statusLabel.value[syncStore.status]}：${syncStore.error}`
  return statusLabel.value[syncStore.status] ?? syncStore.status
})

/** 冲突文件相对工作区的路径，便于用户定位 */
const conflictedRelativePaths = computed(() => {
  const root = fileStore.openedFolderPath?.replace(/[\\/]+$/, '')
  return syncStore.conflictedFiles.map((f) => {
    if (root && f.startsWith(root)) return f.slice(root.length + 1)
    return f
  })
})

const remoteUrl = ref('')

async function onPull(): Promise<void> {
  actionError.value = null
  const res = await syncStore.pull()
  if (!res.success) actionError.value = res.error ?? '拉取失败'
}

async function onPush(): Promise<void> {
  actionError.value = null
  const res = await syncStore.push()
  if (!res.success) actionError.value = res.error ?? '推送失败'
}

async function onContinueRebase(): Promise<void> {
  actionError.value = null
  const res = await syncStore.continueRebase()
  if (!res.success) actionError.value = res.error ?? '继续合并失败'
}

async function onAbortRebase(): Promise<void> {
  actionError.value = null
  const res = await syncStore.abortRebase()
  if (!res.success) actionError.value = res.error ?? '中止合并失败'
}

async function onEnable(): Promise<void> {
  actionError.value = null
  const res = await syncStore.enable({
    remoteUrl: remoteUrl.value.trim() || undefined,
    autoCommit: syncStore.autoCommit,
    autoPull: syncStore.autoPull,
    autoPush: syncStore.autoPush
  })
  showingConfigForm.value = false
  if (!res.success) actionError.value = res.error ?? '启用同步失败'
}

async function onOpenFolder(): Promise<void> {
  await fileStore.openFolder()
}

async function onToggleAutoCommit(value: boolean): Promise<void> {
  await syncStore.setConfig({ autoCommit: value })
}

async function onToggleAutoPull(value: boolean): Promise<void> {
  await syncStore.setConfig({ autoPull: value })
}

async function onToggleAutoPush(value: boolean): Promise<void> {
  await syncStore.setConfig({ autoPush: value })
}

async function onDisable(): Promise<void> {
  actionError.value = null
  await syncStore.disable()
}

function onClosePanel(): void {
  actionError.value = null
  syncStore.closePanel()
}

async function onOpenConflictFile(index: number): Promise<void> {
  const filePath = syncStore.conflictedFiles[index]
  if (filePath) {
    await fileStore.openFile(filePath, { addToRecent: false })
  }
}
</script>

<template>
  <div
    class="sync-panel"
    @click.stop
  >
    <div class="sync-panel-header">
      <span class="sync-panel-title">同步</span>
      <span
        class="sync-panel-status"
        :data-status="syncStore.status"
      >{{ statusText }}</span>
      <span
        v-if="syncStore.branch"
        class="sync-panel-branch"
      >{{ syncStore.branch }}</span>
      <Tooltip content="关闭">
        <button
          class="sync-panel-close"
          @click="onClosePanel"
        >
          <IconX :size="12" />
        </button>
      </Tooltip>
    </div>

    <!-- 操作错误提示 -->
    <p
      v-if="actionError"
      class="sync-panel-error"
      data-test="sync-action-error"
    >
      {{ actionError }}
    </p>

    <!-- 未配置：引导 -->
    <div
      v-if="!syncStore.configured"
      class="sync-panel-body"
    >
      <!-- 未打开工作区文件夹：先引导打开 -->
      <template v-if="!fileStore.openedFolderPath">
        <p class="sync-panel-hint">
          尚未打开工作区文件夹。请先打开要同步的文件夹。
        </p>
        <button
          class="sync-panel-btn primary"
          data-test="sync-open-folder"
          @click="onOpenFolder"
        >
          打开文件夹
        </button>
      </template>

      <!-- 已打开工作区：引导配置 -->
      <template v-else>
        <p class="sync-panel-hint">
          {{ syncStore.isGitRepo ? '当前文件夹是 Git 仓库，但尚未配置同步。' : '当前文件夹不是 Git 仓库，启用同步将自动执行 git init。' }}
        </p>
        <button
          v-if="!showingConfigForm"
          class="sync-panel-btn primary"
          @click="showingConfigForm = true"
        >
          配置同步
        </button>
        <div
          v-else
          class="sync-panel-form"
        >
          <input
            v-model="remoteUrl"
            class="sync-panel-input"
            type="text"
            placeholder="远程仓库地址（可选）"
          >
          <label class="sync-panel-check">
            <input
              v-model="syncStore.autoCommit"
              type="checkbox"
            >
            自动提交本地变更
          </label>
          <label class="sync-panel-check">
            <input
              v-model="syncStore.autoPull"
              type="checkbox"
            >
            启动时自动拉取
          </label>
          <label class="sync-panel-check">
            <input
              v-model="syncStore.autoPush"
              type="checkbox"
            >
            自动推送
          </label>
          <button
            class="sync-panel-btn primary"
            :disabled="syncStore.syncing"
            @click="onEnable"
          >
            启用同步
          </button>
        </div>
      </template>
    </div>

    <!-- 已配置：操作与开关 -->
    <div
      v-else
      class="sync-panel-body"
    >
      <!-- 冲突状态：显示冲突文件与继续/中止 -->
      <template v-if="syncStore.status === 'conflict'">
        <p class="sync-panel-hint">
          检测到合并冲突，请按以下步骤解决：
        </p>
        <ol class="sync-panel-steps">
          <li>编辑下方冲突文件，删除冲突标记行（<code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>=======</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code>）</li>
          <li>保存后点击「继续」完成合并</li>
          <li>想放弃本次合并，点击「中止」</li>
        </ol>
        <ul
          v-if="conflictedRelativePaths.length"
          class="sync-panel-conflict-files"
          data-test="conflict-files"
        >
          <li
            v-for="(f, i) in conflictedRelativePaths"
            :key="f"
          >
            <span class="sync-panel-conflict-file-name">{{ f }}</span>
            <button
              class="sync-panel-conflict-open"
              data-test="open-conflict-file"
              @click="onOpenConflictFile(i)"
            >
              打开
            </button>
          </li>
        </ul>
        <div class="sync-panel-actions">
          <button
            class="sync-panel-btn primary"
            :disabled="syncStore.syncing"
            @click="onContinueRebase"
          >
            继续
          </button>
          <button
            class="sync-panel-btn danger"
            :disabled="syncStore.syncing"
            @click="onAbortRebase"
          >
            中止
          </button>
        </div>
      </template>

      <!-- 正常状态：拉取/推送/停用与开关 -->
      <template v-else>
        <div class="sync-panel-actions">
          <button
            class="sync-panel-btn success"
            :disabled="syncStore.syncing"
            @click="onPull"
          >
            拉取
          </button>
          <button
            class="sync-panel-btn primary"
            :disabled="syncStore.syncing"
            @click="onPush"
          >
            推送
          </button>
          <button
            class="sync-panel-btn danger"
            :disabled="syncStore.syncing"
            @click="onDisable"
          >
            停用同步
          </button>
        </div>
        <div class="sync-panel-form">
          <label class="sync-panel-check">
            <input
              :checked="syncStore.autoCommit"
              type="checkbox"
              @change="(e: Event) => onToggleAutoCommit((e.target as HTMLInputElement).checked)"
            >
            自动提交本地变更
          </label>
          <label class="sync-panel-check">
            <input
              :checked="syncStore.autoPull"
              type="checkbox"
              @change="(e: Event) => onToggleAutoPull((e.target as HTMLInputElement).checked)"
            >
            启动时自动拉取
          </label>
          <label class="sync-panel-check">
            <input
              :checked="syncStore.autoPush"
              type="checkbox"
              @change="(e: Event) => onToggleAutoPush((e.target as HTMLInputElement).checked)"
            >
            自动推送
          </label>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sync-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 8px;
  width: 320px;
  background-color: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 50;
  padding: 12px;
}

.sync-panel-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding-right: 26px;
}

.sync-panel-header > :deep(.tooltip-trigger) {
  position: absolute;
  top: 0;
  right: 0;
  flex: 0 0 auto;
}

.sync-panel-title {
  font-weight: 600;
  color: var(--color-text-primary);
}

.sync-panel-status {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-panel-branch {
  font-size: calc(var(--ui-font-size) - 1px);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-secondary);
  color: var(--color-text-tertiary);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-panel-close {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--color-danger, #ef4444);
  background: transparent;
  cursor: pointer;
  color: var(--color-danger, #ef4444);
  border-radius: 4px;
  transition: all 0.2s;
}

.sync-panel-close svg {
  width: 12px;
  height: 12px;
  display: block;
}

.sync-panel-close:hover {
  color: #fff;
  background-color: rgba(239, 68, 68, 0.45);
}

.sync-panel-close:active {
  color: #fff;
  background-color: rgba(239, 68, 68, 0.75);
}

.sync-panel-hint {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
  margin: 0 0 8px;
}

.sync-panel-conflict-files {
  margin: 0 0 10px;
  padding: 0 0 0 16px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-danger, #ef4444);
  max-height: 120px;
  overflow-y: auto;
}

.sync-panel-conflict-files li {
  word-break: break-all;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sync-panel-conflict-file-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.sync-panel-conflict-open {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: calc(var(--ui-font-size) - 2px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-secondary);
  color: var(--color-accent);
  cursor: pointer;
}

.sync-panel-steps {
  margin: 0 0 10px;
  padding: 0 0 0 18px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.sync-panel-steps code {
  font-family: var(--font-mono);
  background-color: var(--color-bg-secondary);
  padding: 0 3px;
  border-radius: 3px;
}

.sync-panel-error {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-danger, #ef4444);
  margin: 0 0 8px;
}

.sync-panel-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sync-panel-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.sync-panel-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
}

.sync-panel-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.sync-panel-btn {
  padding: 4px 12px;
  font-size: calc(var(--ui-font-size) - 1px);
  border: 1px solid var(--color-border-hover);
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.sync-panel-btn:hover {
  background-color: var(--color-bg-secondary);
}

.sync-panel-btn.primary {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.sync-panel-btn.primary:hover {
  background-color: var(--color-primary-light);
}

.sync-panel-btn.danger {
  border-color: var(--color-danger, #ef4444);
  color: var(--color-danger, #ef4444);
}

.sync-panel-btn.danger:hover {
  background-color: rgba(239, 68, 68, 0.08);
}

.sync-panel-btn.success {
  border-color: var(--color-success);
  color: var(--color-success);
}

.sync-panel-btn.success:hover {
  background-color: rgba(16, 185, 129, 0.08);
}

.sync-panel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
