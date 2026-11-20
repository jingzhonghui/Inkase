<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import {
  cancelPrompt,
  promptState,
  stemEndIndex,
  submitPrompt
} from '../../utils/prompt'

/**
 * 全局单行输入对话框（新建文件 / 重命名 / 新建文件夹共用）。
 *
 * 只负责渲染与输入框的聚焦选区，状态与 Promise 都在 `utils/prompt.ts`。
 * 需在 `App.vue` 挂载一次，任何入口才能 `requestPrompt()`。
 */
const inputRef = ref<HTMLInputElement | null>(null)

/**
 * 挂载后按 `selection` 设置选中区。
 *
 * 必须在下一个 tick 之后做：`v-if` 打开的这一帧输入框才进 DOM。
 * `focus()` 与 `setSelectionRange` 的顺序也不能反——先聚焦会把光标收到末尾，
 * 再设选区才留得住。
 */
function applyInitialSelection(): void {
  const input = inputRef.value
  if (!input) return
  const end =
    promptState.selection === 'stem' ? stemEndIndex(promptState.value) : promptState.value.length
  input.focus()
  input.setSelectionRange(0, end)
}

watch(
  () => promptState.visible,
  (visible) => {
    if (visible) void nextTick(applyInitialSelection)
  }
)
</script>

<template>
  <teleport to="body">
    <div
      v-if="promptState.visible"
      class="dialog-overlay"
      @click.self="cancelPrompt"
    >
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        @click.stop
      >
        <h3 class="dialog-title">
          {{ promptState.title }}
        </h3>
        <input
          ref="inputRef"
          v-model="promptState.value"
          type="text"
          spellcheck="false"
          class="dialog-input"
          :class="{ 'dialog-input-error': promptState.error }"
          :placeholder="promptState.placeholder"
          @input="promptState.error = ''"
          @keydown.enter.prevent="submitPrompt"
          @keydown.esc.prevent="cancelPrompt"
        >
        <p
          v-if="promptState.error"
          class="dialog-error"
        >
          {{ promptState.error }}
        </p>
        <div class="dialog-actions">
          <button
            class="dialog-btn dialog-btn-cancel"
            @click="cancelPrompt"
          >
            取消
          </button>
          <button
            class="dialog-btn dialog-btn-confirm"
            @click="submitPrompt"
          >
            {{ promptState.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog, 10100);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.dialog {
  width: min(420px, calc(100vw - 32px));
  padding: 20px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 8px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.dialog-title {
  margin: 0 0 12px;
  font-size: calc(var(--ui-font-size) + 2px);
  font-weight: 600;
  color: var(--color-text);
}

.dialog-input {
  width: 100%;
  padding: 8px 12px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  box-sizing: border-box;
}

.dialog-input:focus {
  border-color: var(--color-primary);
}

.dialog-input-error,
.dialog-input-error:focus {
  border-color: var(--color-error);
}

.dialog-error {
  margin: 6px 0 0;
  color: var(--color-error);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.4;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.dialog-btn {
  padding: 6px 16px;
  font-size: var(--ui-font-size);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.dialog-btn-cancel {
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
}

.dialog-btn-cancel:hover {
  color: var(--color-text);
}

.dialog-btn-confirm {
  color: #fff;
  background: var(--color-primary);
}

.dialog-btn-confirm:hover {
  background: var(--color-primary-hover);
}
</style>
