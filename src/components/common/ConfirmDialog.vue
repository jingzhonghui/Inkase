<script setup lang="ts">
import { cancelDialogRequest, dialogState, resolveDialogRequest } from '../../utils/dialog'
</script>

<template>
  <teleport to="body">
    <div
      v-if="dialogState.visible"
      class="dialog-overlay"
      @click.self="cancelDialogRequest"
    >
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        @click.stop
      >
        <div class="dialog-header">
          <h3 class="dialog-title">
            {{ dialogState.title }}
          </h3>
          <button
            class="dialog-close"
            aria-label="关闭"
            @click="cancelDialogRequest"
          >
            ×
          </button>
        </div>
        <p class="dialog-message">
          {{ dialogState.message }}
        </p>
        <p
          v-if="dialogState.detail"
          class="dialog-detail"
        >
          {{ dialogState.detail }}
        </p>
        <div class="dialog-actions">
          <button
            v-for="button in dialogState.buttons"
            :key="button.value"
            class="dialog-btn"
            :class="button.primary ? 'dialog-btn-confirm' : 'dialog-btn-cancel'"
            @click="resolveDialogRequest(button.value)"
          >
            {{ button.label }}
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
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.35);
}

.dialog {
  width: min(420px, calc(100vw - 32px));
  padding: 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-primary);
  color: var(--color-text);
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.2);
}

.dialog-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.dialog-close {
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
}

.dialog-message,
.dialog-detail {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.dialog-detail {
  margin-top: 6px;
  color: var(--color-text-tertiary);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

.dialog-btn {
  padding: 7px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 13px;
}

.dialog-btn-cancel {
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
}

.dialog-btn-confirm {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: white;
}
</style>
