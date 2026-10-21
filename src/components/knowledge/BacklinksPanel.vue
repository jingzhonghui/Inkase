<script setup lang="ts">
/**
 * 反链面板
 *
 * 展示当前笔记的反向链接：已建立的链接与未链接提及分组显示；
 * 点击条目打开来源文件并定位到对应行。
 */
import { computed } from 'vue'
import { IconArrowUpRight, IconLink, IconRefresh } from '@tabler/icons-vue'
import type { BacklinkItem } from '../../../shared/knowledge/types'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'

const fileStore = useFileStore()
const knowledge = useKnowledgeStore()

const linked = computed(() => knowledge.backlinks.filter((item) => item.kind === 'linked'))
const unlinked = computed(() => knowledge.backlinks.filter((item) => item.kind === 'unlinked'))
const hasActiveNote = computed(() => knowledge.activeRelPath !== null)

async function openAt(item: BacklinkItem): Promise<void> {
  const absPath = knowledge.resolveAbsolute(item.path)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
  fileStore.requestReveal(absPath, item.line, 1)
}

async function refresh(): Promise<void> {
  if (knowledge.backlinksPath !== null) await knowledge.loadBacklinks(knowledge.backlinksPath)
}
</script>

<template>
  <div
    class="backlinks-panel"
    data-testid="backlinks-panel"
  >
    <header class="panel-head">
      <span class="panel-title">
        反向链接
        <span
          v-if="knowledge.backlinks.length > 0"
          class="panel-count"
        >{{ knowledge.backlinks.length }}</span>
      </span>
      <button
        type="button"
        class="icon-btn"
        aria-label="刷新反链"
        data-testid="backlinks-refresh"
        @click="refresh"
      >
        <IconRefresh
          :size="14"
          :stroke-width="1.8"
        />
      </button>
    </header>

    <div
      v-if="knowledge.degraded"
      class="panel-notice"
      data-testid="backlinks-degraded"
    >
      索引不可用，反链暂不可见
    </div>

    <div
      v-else-if="!hasActiveNote"
      class="panel-empty"
      data-testid="backlinks-no-note"
    >
      打开一篇笔记以查看反链
    </div>

    <div
      v-else-if="knowledge.backlinks.length === 0"
      class="panel-empty"
      data-testid="backlinks-empty"
    >
      暂无反向链接
    </div>

    <div
      v-else
      class="panel-body"
    >
      <section
        v-if="linked.length > 0"
        class="group"
      >
        <h4 class="group-title">
          <IconLink
            :size="13"
            :stroke-width="1.8"
          />
          已链接 · {{ linked.length }}
        </h4>
        <button
          v-for="item in linked"
          :key="`linked-${item.path}-${item.line}`"
          type="button"
          class="backlink-item"
          data-testid="backlink-linked"
          @click="openAt(item)"
        >
          <span class="item-path">{{ item.path }}</span>
          <span class="item-context">{{ item.text }}</span>
          <span class="item-line">:{{ item.line }}</span>
        </button>
      </section>

      <section
        v-if="unlinked.length > 0"
        class="group"
      >
        <h4 class="group-title">
          <IconArrowUpRight
            :size="13"
            :stroke-width="1.8"
          />
          未链接提及 · {{ unlinked.length }}
        </h4>
        <button
          v-for="item in unlinked"
          :key="`unlinked-${item.path}-${item.line}`"
          type="button"
          class="backlink-item unlinked"
          data-testid="backlink-unlinked"
          @click="openAt(item)"
        >
          <span class="item-path">{{ item.path }}</span>
          <span class="item-context">{{ item.text }}</span>
          <span class="item-line">:{{ item.line }}</span>
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.backlinks-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-primary);
  color: var(--color-text);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--color-border);
}

.panel-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-secondary);
}

.panel-count {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--color-bg-secondary);
  color: var(--color-text-tertiary);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 10px;
}

.panel-empty,
.panel-notice {
  padding: 14px 12px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.panel-notice {
  color: var(--color-error, #ef4444);
}

.group + .group {
  margin-top: 6px;
  border-top: 1px solid var(--color-border);
  padding-top: 6px;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 4px 10px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 500;
}

.backlink-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.backlink-item:hover {
  background: var(--color-bg-secondary);
}

.item-path {
  overflow: hidden;
  color: var(--color-primary);
  font-size: calc(var(--ui-font-size) - 2px);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backlink-item.unlinked .item-path {
  color: var(--color-text-secondary);
}

.item-line {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
}

.item-context {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 3px);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
