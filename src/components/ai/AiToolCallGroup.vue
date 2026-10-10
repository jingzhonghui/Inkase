<script setup lang="ts">
import { computed } from 'vue'
import type { ToolExecutionResult } from '../../../shared/ai/types'
import AiToolCallCard from './AiToolCallCard.vue'

const props = defineProps<{
  calls: { toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed'; result?: ToolExecutionResult }[]
}>()

const hasRunning = computed(() => props.calls.some((c) => c.status === 'running'))
const allDone = computed(() => props.calls.length > 0 && props.calls.every((c) => c.status !== 'running'))
</script>

<template>
  <details
    v-if="calls.length > 0"
    class="tool-group"
    data-testid="ai-tool-call-group"
  >
    <summary>
      <span class="group-label">
        &#9881; 工具调用 ({{ calls.length }})
      </span>
      <span
        class="group-badge"
        :class="{ running: hasRunning, completed: allDone, failed: !hasRunning && !allDone }"
      >{{ hasRunning ? '运行中' : '已完成' }}</span>
      <span class="chevron">&#9662;</span>
    </summary>
    <div class="group-body">
      <AiToolCallCard
        v-for="call in calls"
        :key="call.toolCallId"
        :call="call"
      />
    </div>
  </details>
</template>

<style scoped>
.tool-group {
  margin: 0 2px;
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

.group-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.group-badge {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: calc(var(--ui-font-size) - 2px);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.group-badge.running {
  background: rgb(59 130 246 / 12%);
  color: #3b82f6;
}

.group-badge.completed {
  background: rgb(34 197 94 / 12%);
  color: #16a34a;
}

.group-badge.failed {
  background: rgb(156 163 175 / 12%);
  color: #6b7280;
}

.chevron {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  transition: transform 0.15s;
}

.tool-group[open] .chevron {
  transform: rotate(180deg);
}

.group-body {
  border-top: 1px solid var(--color-border);
  padding: 6px 0;
}

.group-body > :deep(.tool-card) {
  margin: 4px 8px;
  border: none;
  border-radius: 6px;
  background: var(--color-bg);
}
</style>