<script setup lang="ts">
import type { BatchApprovalFile } from '../../../../shared/ai/types'

defineProps<{
  title: string
  description?: string
  files: BatchApprovalFile[]
  totalChanges?: number
}>()
</script>

<template>
  <div
    class="batch-preview"
    data-testid="batch-preview"
  >
    <div class="batch-head">
      <strong>{{ title }}</strong>
      <span class="batch-count">
        {{ files.length }} 个文件
        <template v-if="totalChanges !== undefined"> · {{ totalChanges }} 处变更</template>
      </span>
    </div>
    <p
      v-if="description"
      class="batch-desc"
    >
      {{ description }}
    </p>

    <div class="batch-files">
      <details
        v-for="(file, index) in files"
        :key="`${file.path}:${index}`"
        class="batch-file"
        :open="false"
      >
        <summary>
          <code class="batch-path">{{ file.path }}</code>
          <span class="batch-summary">{{ file.summary }}</span>
          <span
            v-if="file.additions !== undefined || file.deletions !== undefined"
            class="batch-stat"
          >
            <span
              v-if="file.additions"
              class="batch-add"
            >+{{ file.additions }}</span>
            <span
              v-if="file.deletions"
              class="batch-del"
            >-{{ file.deletions }}</span>
          </span>
        </summary>
        <pre
          v-if="file.diff"
          class="batch-diff"
          data-testid="batch-file-diff"
        >{{ file.diff }}</pre>
      </details>
    </div>
  </div>
</template>

<style scoped>
.batch-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.batch-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.batch-head strong {
  min-width: 0;
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 1px);
}

.batch-count {
  flex: none;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
}

.batch-desc {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 2px);
  line-height: 1.55;
}

.batch-files {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.batch-file {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-primary);
}

.batch-file summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  list-style: none;
}

.batch-file summary::-webkit-details-marker {
  display: none;
}

.batch-path {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-summary {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 3px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-stat {
  display: inline-flex;
  flex: none;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
}

.batch-add {
  color: #15803d;
}

.batch-del {
  color: #b91c1c;
}

.batch-diff {
  margin: 0;
  padding: 8px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
