<script setup lang="ts">
defineProps<{
  operation: 'move' | 'create-directory'
  from?: string
  to: string
}>()
</script>

<template>
  <section class="file-operation">
    <dl>
      <template v-if="operation === 'move'">
        <dt>从</dt>
        <dd><code>{{ from }}</code></dd>
        <dt>到</dt>
        <dd><code>{{ to }}</code></dd>
      </template>
      <template v-else>
        <dt>新建目录</dt>
        <dd><code>{{ to }}</code></dd>
      </template>
    </dl>
  </section>
</template>

<style scoped>
.file-operation { padding: 12px; border: 1px solid var(--color-border); border-radius: 6px; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 12px; margin: 0; }
dt { color: var(--color-text-secondary); }
dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, monospace; }
</style>
