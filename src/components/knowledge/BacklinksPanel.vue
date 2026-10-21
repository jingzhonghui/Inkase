<script setup lang="ts">
/**
 * 反链面板
 *
 * 展示当前笔记的反向链接：已建立的链接与未链接提及分组显示（可折叠）；
 * 点击条目打开来源文件并定位到对应行；未链接提及可一键「转为链接」，
 * 真正改写来源文件（由主进程精确替换并重建索引）。
 */
import { computed, ref } from 'vue'
import { IconArrowUpRight, IconChevronDown, IconChevronRight, IconLink, IconRefresh } from '@tabler/icons-vue'
import type { BacklinkItem } from '../../../shared/knowledge/types'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'

const fileStore = useFileStore()
const knowledge = useKnowledgeStore()

/** 上下文窗口：提及前后各保留的字符数 */
const CONTEXT_PAD = 40

const linked = computed(() => knowledge.backlinks.filter((item) => item.kind === 'linked'))
const unlinked = computed(() => knowledge.backlinks.filter((item) => item.kind === 'unlinked'))
const hasActiveNote = computed(() => knowledge.activeRelPath !== null)

const linkedOpen = ref(true)
const unlinkedOpen = ref(true)
/** 正在改写的条目 key，用于禁用按钮避免重复提交 */
const converting = ref<string | null>(null)
/** 改写失败等提示 */
const notice = ref<string | null>(null)

function itemKey(item: BacklinkItem): string {
  return `${item.kind}-${item.path}-${item.line}`
}

/**
 * 截取提及附近的上下文
 *
 * 索引里的 `text` 是整行（最长 200 字），面板只展示提及前后各 40 字，
 * 过长时用省略号标出被截断的一侧。
 */
function contextOf(item: BacklinkItem): string {
  const line = item.text
  if (item.kind === 'linked' || !item.raw) return line

  const at = line.indexOf(item.raw)
  if (at === -1) return line

  const start = Math.max(0, at - CONTEXT_PAD)
  const end = Math.min(line.length, at + item.raw.length + CONTEXT_PAD)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

async function openAt(item: BacklinkItem): Promise<void> {
  const absPath = knowledge.resolveAbsolute(item.path)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
  fileStore.requestReveal(absPath, item.line, 1)
}

/** 把提及改写为 `[[链接]]` */
async function convert(item: BacklinkItem): Promise<void> {
  const key = itemKey(item)
  if (converting.value !== null) return
  if (item.column === undefined || !item.raw) {
    notice.value = '该条目缺少位置信息，请刷新反链后重试'
    return
  }

  converting.value = key
  notice.value = null
  try {
    const result = await knowledge.convertMention({
      path: item.path,
      line: item.line,
      column: item.column,
      raw: item.raw
    })
    if (!result.changed) notice.value = result.reason ?? '改写失败'
  } finally {
    converting.value = null
  }
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
      v-if="notice"
      class="panel-notice"
      data-testid="backlinks-notice"
    >
      {{ notice }}
    </div>

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
        <button
          type="button"
          class="group-title"
          data-testid="backlinks-toggle-linked"
          :aria-expanded="linkedOpen"
          @click="linkedOpen = !linkedOpen"
        >
          <component
            :is="linkedOpen ? IconChevronDown : IconChevronRight"
            :size="12"
            :stroke-width="2"
          />
          <IconLink
            :size="13"
            :stroke-width="1.8"
          />
          已链接 · {{ linked.length }}
        </button>
        <template v-if="linkedOpen">
          <button
            v-for="item in linked"
            :key="itemKey(item)"
            type="button"
            class="backlink-item"
            data-testid="backlink-linked"
            @click="openAt(item)"
          >
            <span class="item-path">{{ item.path }}</span>
            <span class="item-line">:{{ item.line }}</span>
            <span class="item-context">{{ contextOf(item) }}</span>
          </button>
        </template>
      </section>

      <section
        v-if="unlinked.length > 0"
        class="group"
      >
        <button
          type="button"
          class="group-title"
          data-testid="backlinks-toggle-unlinked"
          :aria-expanded="unlinkedOpen"
          @click="unlinkedOpen = !unlinkedOpen"
        >
          <component
            :is="unlinkedOpen ? IconChevronDown : IconChevronRight"
            :size="12"
            :stroke-width="2"
          />
          <IconArrowUpRight
            :size="13"
            :stroke-width="1.8"
          />
          未链接提及 · {{ unlinked.length }}
        </button>
        <template v-if="unlinkedOpen">
          <div
            v-for="item in unlinked"
            :key="itemKey(item)"
            class="unlinked-row"
            data-testid="backlink-unlinked"
          >
            <button
              type="button"
              class="backlink-item unlinked"
              @click="openAt(item)"
            >
              <span class="item-path">{{ item.path }}</span>
              <span class="item-line">:{{ item.line }}</span>
              <span class="item-context">{{ contextOf(item) }}</span>
            </button>
            <button
              type="button"
              class="convert-btn"
              :disabled="converting !== null"
              :data-testid="`backlink-convert-${item.path}-${item.line}`"
              title="把该处提及改写为 [[链接]]"
              @click.stop="convert(item)"
            >
              {{ converting === itemKey(item) ? '转换中…' : '转为链接' }}
            </button>
          </div>
        </template>
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
  width: 100%;
  margin: 0;
  padding: 4px 10px;
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 3px);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.group-title:hover {
  color: var(--color-text-secondary);
}

/* 未链接提及：条目与「转为链接」按钮同行 */
.unlinked-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  padding-right: 8px;
}

.unlinked-row .backlink-item {
  flex: 1;
  min-width: 0;
}

.convert-btn {
  flex-shrink: 0;
  margin-top: 6px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 3px);
  cursor: pointer;
}

.convert-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.convert-btn:disabled {
  opacity: 0.5;
  cursor: default;
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
