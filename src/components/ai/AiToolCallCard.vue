<script setup lang="ts">
import { computed } from 'vue'
import type { ToolExecutionResult } from '../../../shared/ai/types'
import { useAiStore } from '../../stores/ai'

const props = defineProps<{ call: { toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed'; result?: ToolExecutionResult } }>()
const store = useAiStore()
const waiting = computed(() => store.pendingApprovals.some((approval) => approval.toolCallId === props.call.toolCallId))
const displayStatus = computed(() => waiting.value ? 'waiting' : props.call.result?.status ?? props.call.status)
const resultText = computed(() => {
  const result = props.call.result
  if (!result) return ''
  if ('message' in result) return result.message
  if (result.data === undefined) return labels[result.status] ?? result.status
  return typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)
})
const labels: Record<string, string> = {
  waiting: '等待审批', running: '运行中', completed: '已完成', applied: '已应用',
  rejected: '已拒绝', conflict: '冲突', failed: '失败', cancelled: '已取消'
}
</script>

<template>
  <details
    class="tool-card"
    data-testid="ai-tool-call"
  >
    <summary>
      <span class="tool-label">
        <span class="tool-icon">&#9881;</span>
        <span class="tool-name">{{ call.toolName }}</span>
      </span>
      <span
        class="tool-badge"
        :class="displayStatus"
      >{{ labels[displayStatus] }}</span>
      <span class="chevron">&#9662;</span>
    </summary>
    <pre
      v-if="call.result"
      class="tool-result"
    >{{ resultText }}</pre>
  </details>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 9px 12px;
  user-select: none;
}

summary::-webkit-details-marker {
  display: none;
}

.tool-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tool-icon {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: var(--ui-font-size);
}

.tool-name {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-badge {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: calc(var(--ui-font-size) - 2px);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.tool-badge.running {
  background: rgb(59 130 246 / 12%);
  color: #3b82f6;
}
.tool-badge.waiting,
.tool-badge.pending {
  background: rgb(245 158 11 / 12%);
  color: #d97706;
}
.tool-badge.completed,
.tool-badge.applied {
  background: rgb(34 197 94 / 12%);
  color: #16a34a;
}
.tool-badge.failed,
.tool-badge.rejected,
.tool-badge.conflict {
  background: rgb(239 68 68 / 12%);
  color: #ef4444;
}
.tool-badge.cancelled {
  background: rgb(156 163 175 / 12%);
  color: #6b7280;
}

.chevron {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  transition: transform 0.15s;
}

.tool-card[open] .chevron {
  transform: rotate(180deg);
}

.tool-result {
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  white-space: pre-wrap;
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.55;
}
</style>