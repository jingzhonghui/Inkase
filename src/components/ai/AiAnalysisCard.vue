<script setup lang="ts">
import { computed } from 'vue'
import { renderAiMarkdown } from '../../utils/ai/markdown'

const props = defineProps<{ content: string; streaming?: boolean }>()
const html = computed(() => renderAiMarkdown(props.content))
</script>

<template>
  <details
    v-if="content || streaming"
    class="analysis-card"
    data-testid="ai-analysis-card"
  >
    <summary>
      <span class="analysis-label">
        <span
          v-if="streaming"
          class="analysis-dot"
          aria-label="正在分析"
        />
        <span>{{ streaming ? '正在分析...' : '分析过程' }}</span>
      </span>
      <span class="chevron">&#9662;</span>
    </summary>
    <div
      class="analysis-body"
      v-html="html"
    />
  </details>
</template>

<style scoped>
.analysis-card {
  margin-bottom: 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
  font-size: var(--ui-font-size);
}

summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 9px 12px;
  user-select: none;
  color: var(--color-text-secondary);
}

summary::-webkit-details-marker {
  display: none;
}

.analysis-label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.analysis-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: analysis-pulse 1.2s ease-in-out infinite;
}

@keyframes analysis-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.1); }
}

.chevron {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  transition: transform 0.15s;
}

.analysis-card[open] .chevron {
  transform: rotate(180deg);
}

.analysis-body {
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  line-height: 1.55;
  font-size: calc(var(--ui-font-size) - 1px);
}

.analysis-body :deep(> :first-child) { margin-top: 0; }
.analysis-body :deep(> :last-child) { margin-bottom: 0; }
</style>