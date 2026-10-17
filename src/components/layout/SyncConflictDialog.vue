<script setup lang="ts">
import type { ConflictChoice } from '../../../shared/sync/types'

defineProps<{
  /** 冲突文件：path 为绝对路径（提交给主进程用），label 为工作区相对路径（展示用） */
  files: Array<{ path: string; label: string }>
  /** 同步进行中：禁用所有裁决按钮，避免重入 */
  busy?: boolean
}>()

defineEmits<{
  close: []
  open: [path: string]
  resolve: [{ path: string; choice: ConflictChoice['choice'] }]
  resolveAll: [choice: ConflictChoice['choice']]
}>()
</script>

<template>
  <teleport to="body">
    <div
      class="conflict-overlay"
      data-test="conflict-dialog"
      @click.self="$emit('close')"
    >
      <div
        class="conflict-dialog"
        role="dialog"
        aria-modal="true"
      >
        <div class="conflict-header">
          <h3 class="conflict-title">
            同步冲突
          </h3>
          <button
            type="button"
            class="conflict-close"
            data-test="conflict-dialog-close"
            aria-label="关闭"
            @click="$emit('close')"
          >
            ×
          </button>
        </div>
        <p class="conflict-message">
          检测到
          <span data-test="conflict-dialog-count">{{ files.length }}</span>
          个文件冲突，请为每个文件选择保留本地或用远端覆盖。
        </p>
        <ul
          class="conflict-files"
          data-test="conflict-dialog-files"
        >
          <li
            v-for="file in files"
            :key="file.path"
            class="conflict-file"
          >
            <span class="conflict-file-name">{{ file.label }}</span>
            <span class="conflict-file-actions">
              <button
                type="button"
                class="conflict-file-btn"
                data-test="conflict-open-file"
                @click="$emit('open', file.path)"
              >
                打开
              </button>
              <button
                type="button"
                class="conflict-file-btn"
                data-test="conflict-keep-local"
                :disabled="busy"
                @click="$emit('resolve', { path: file.path, choice: 'local' })"
              >
                保留本地
              </button>
              <button
                type="button"
                class="conflict-file-btn"
                data-test="conflict-take-remote"
                :disabled="busy"
                @click="$emit('resolve', { path: file.path, choice: 'remote' })"
              >
                用远端覆盖
              </button>
            </span>
          </li>
        </ul>
        <div class="conflict-actions">
          <button
            type="button"
            class="conflict-btn"
            data-test="conflict-resolve-all-local"
            :disabled="busy"
            @click="$emit('resolveAll', 'local')"
          >
            全部保留本地
          </button>
          <button
            type="button"
            class="conflict-btn danger"
            data-test="conflict-resolve-all-remote"
            :disabled="busy"
            @click="$emit('resolveAll', 'remote')"
          >
            全部用远端覆盖
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.conflict-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.35);
}

.conflict-dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 80px);
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-primary);
  color: var(--color-text);
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.2);
}

.conflict-title {
  margin: 0;
  font-size: calc(var(--ui-font-size) + 3px);
  font-weight: 600;
}

.conflict-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.conflict-message {
  margin: 0 0 12px;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
  line-height: 1.6;
}

/* 文件多时只占固定高度，内部滚动，避免弹窗无限拉长 */
.conflict-files {
  margin: 0;
  padding: 0;
  max-height: min(320px, 45vh);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  list-style: none;
}

.conflict-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: calc(var(--ui-font-size) - 1px);
}

.conflict-file + .conflict-file {
  border-top: 1px solid var(--color-border);
}

.conflict-file-name {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conflict-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.conflict-btn {
  padding: 7px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: var(--ui-font-size);
}

.conflict-btn:hover {
  background: var(--color-bg-secondary);
}

.conflict-btn.danger {
  border-color: var(--color-danger, #ef4444);
  color: var(--color-danger, #ef4444);
}

.conflict-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.conflict-close {
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  font-size: calc(var(--ui-font-size) + 7px);
  line-height: 1;
}

.conflict-file-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.conflict-file-btn {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: calc(var(--ui-font-size) - 2px);
}

.conflict-file-btn:hover {
  background: var(--color-bg-secondary);
}

.conflict-file-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
