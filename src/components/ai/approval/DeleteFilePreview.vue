<script setup lang="ts">
import type { WorkspaceFileFormat } from '../../../../shared/ai/types'

defineProps<{
  relativePath: string
  fileSize: number
  format: WorkspaceFileFormat
}>()

const FORMAT_LABELS: Record<WorkspaceFileFormat, string> = {
  text: '文本',
  markdown: 'Markdown',
  mdx: 'MDX 文档',
  mindmap: '思维导图',
  diagram: '图表'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${Number(value.toFixed(1))} ${unit}`
}
</script>

<template>
  <section class="file-delete">
    <p class="warning">
      此操作会从磁盘上删除该文件，<strong>不可恢复</strong>。
    </p>
    <dl>
      <dt>文件</dt>
      <dd><code>{{ relativePath }}</code></dd>
      <dt>类型</dt>
      <dd>{{ FORMAT_LABELS[format] ?? format }}</dd>
      <dt>大小</dt>
      <dd>{{ formatSize(fileSize) }}</dd>
    </dl>
  </section>
</template>

<style scoped>
.file-delete { padding: 12px; border: 1px solid var(--color-border); border-radius: 6px; }
.warning { margin: 0 0 10px; color: var(--color-error, #ef4444); }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 12px; margin: 0; }
dt { color: var(--color-text-secondary); }
dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, monospace; }
</style>
