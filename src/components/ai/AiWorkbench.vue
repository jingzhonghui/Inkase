<script setup lang="ts">
/**
 * AI 工作台首屏（空状态）
 *
 * 设计文档 §5.8：只放四块——大输入框、动态快捷动作、一行库状态、最近修改。
 * 打开文件夹后，孤立/断链直接可点进巡检；没有配置 AI 时，动作会把人带去设置。
 */
import { computed, ref } from 'vue'
import {
  IconFile,
  IconFolder,
  IconLink,
  IconPlus,
  IconRefresh,
  IconTopologyStar3
} from '@tabler/icons-vue'
import type { LinkRef } from '../../../shared/knowledge/types'
import { useAiStore } from '../../stores/ai'
import { useDockStore } from '../../stores/dock'
import { useFileStore } from '../../stores/file'
import { useKnowledgeStore } from '../../stores/knowledge'
import AiComposer from './AiComposer.vue'

const props = defineProps<{ ready: boolean }>()
const emit = defineEmits<{ openSettings: [] }>()

const aiStore = useAiStore()
const dockStore = useDockStore()
const fileStore = useFileStore()
const knowledge = useKnowledgeStore()

/** 断链巡检面板是否展开 */
const brokenOpen = ref(false)

/** 巡检列表最多展示的条数（其余用「共 N 处」提示） */
const BROKEN_PREVIEW_LIMIT = 20

type QuickActionId = 'orphans' | 'broken' | 'recent' | 'new' | 'open-folder'

interface QuickAction {
  id: QuickActionId
  label: string
  icon: unknown
}

const hasVault = computed(() => knowledge.root !== null)
const recent = computed(() => knowledge.overview.recent)
const brokenPreview = computed(() => knowledge.unresolved.slice(0, BROKEN_PREVIEW_LIMIT))

/** 动态快捷动作：有问题先给问题，没有问题给日常动作 */
const quickActions = computed<QuickAction[]>(() => {
  const actions: QuickAction[] = []

  if (hasVault.value) {
    if (knowledge.overview.isolatedCount > 0) {
      actions.push({ id: 'orphans', label: '找出孤立笔记', icon: IconTopologyStar3 })
    }
    if (knowledge.overview.brokenCount > 0) {
      actions.push({ id: 'broken', label: '修复断链', icon: IconLink })
    }
    actions.push({ id: 'recent', label: '总结最近的改动', icon: IconRefresh })
    actions.push({ id: 'new', label: '新建笔记', icon: IconPlus })
  } else {
    actions.push({ id: 'new', label: '新建笔记', icon: IconPlus })
    actions.push({ id: 'open-folder', label: '打开文件夹', icon: IconFolder })
  }

  return actions.slice(0, 4)
})

/** 未配置 AI 时，AI 动作统一先去设置，避免点了没反应 */
function requireAi(): boolean {
  if (props.ready) return true
  emit('openSettings')
  return false
}

function askAi(text: string): void {
  if (!requireAi()) return
  dockStore.show('ai')
  void aiStore.sendMessage(text)
}

function handleSend(text: string): void {
  askAi(text)
}

async function runAction(id: QuickActionId): Promise<void> {
  switch (id) {
    case 'new':
      await fileStore.newFile()
      break
    case 'open-folder':
      await fileStore.openFolder()
      break
    case 'orphans':
      inspectOrphans()
      break
    case 'broken':
      brokenOpen.value = !brokenOpen.value
      break
    case 'recent':
      askAboutRecent()
      break
  }
}

/** 孤立笔记：直接进全局图谱并只显示孤立节点 */
function inspectOrphans(): void {
  knowledge.updateGraphFilters({ orphans: 'only' })
  knowledge.openGraphTab()
}

/** 断链：先用面板列出结果，用户再决定是否交给 AI */
function toggleBroken(): void {
  if (knowledge.overview.brokenCount === 0) return
  brokenOpen.value = !brokenOpen.value
}

function askAboutRecent(): void {
  const noteList =
    recent.value.length > 0
      ? recent.value.map((note) => `- ${note.path}`).join('\n')
      : '（索引里还没有最近修改）'
  askAi(`总结这个知识库最近的改动，并指出值得继续推进的部分。\n最近修改：\n${noteList}`)
}

function askAboutBroken(): void {
  const list = knowledge.unresolved
    .slice(0, BROKEN_PREVIEW_LIMIT)
    .map((ref) => `- ${ref.from}:${ref.line} ${ref.raw}`)
    .join('\n')
  askAi(`请检查这些断链，逐条给出修复建议（先不要改文件）。\n${list}`)
}

async function openRecent(path: string): Promise<void> {
  const absPath = knowledge.resolveAbsolute(path)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
}

async function openBroken(ref: LinkRef): Promise<void> {
  const absPath = knowledge.resolveAbsolute(ref.from)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
  fileStore.requestReveal(absPath, ref.line, ref.column)
}

function noteTitle(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.(md|mdx)$/i, '')
}

function noteFolder(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : '库根'
}

/** 毫秒时间戳 → 首屏用的相对时间 */
function relativeTime(mtime: number): string {
  const diff = Date.now() - mtime
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(mtime)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}
</script>

<template>
  <section
    class="ai-workbench"
    aria-label="AI 工作台"
    data-testid="ai-workbench"
  >
    <div class="workbench-inner">
      <header class="workbench-header">
        <h1>今天想整理什么？</h1>
        <p>让 AI 读你的库、找线索，或者直接开始写。</p>
      </header>

      <AiComposer
        large
        :running="aiStore.running"
        :ready="props.ready"
        @send="handleSend"
        @stop="aiStore.cancelRun"
      />

      <button
        v-if="!props.ready"
        type="button"
        class="config-hint"
        data-testid="workbench-config"
        @click="emit('openSettings')"
      >
        配置 AI 服务后开始 →
      </button>

      <div
        class="quick-actions"
        data-testid="workbench-quick-actions"
      >
        <button
          v-for="action in quickActions"
          :key="action.id"
          type="button"
          class="quick-action"
          :data-testid="`workbench-action-${action.id}`"
          @click="runAction(action.id)"
        >
          <component
            :is="action.icon"
            :size="15"
            :stroke-width="1.8"
          />
          <span>{{ action.label }}</span>
        </button>
      </div>

      <div
        class="vault-status"
        data-testid="vault-status"
      >
        <template v-if="hasVault">
          <span class="status-item">笔记 <strong>{{ knowledge.overview.noteCount }}</strong></span>
          <span class="status-dot">·</span>
          <span class="status-item">标签 <strong>{{ knowledge.overview.tagCount }}</strong></span>
          <span class="status-dot">·</span>
          <button
            type="button"
            class="status-item status-action"
            :disabled="knowledge.overview.isolatedCount === 0"
            data-testid="status-isolated"
            @click="inspectOrphans"
          >
            孤立 <strong>{{ knowledge.overview.isolatedCount }}</strong>
          </button>
          <span class="status-dot">·</span>
          <button
            type="button"
            class="status-item status-action"
            :class="{ alert: knowledge.overview.brokenCount > 0 }"
            :disabled="knowledge.overview.brokenCount === 0"
            data-testid="status-broken"
            @click="toggleBroken"
          >
            断链 <strong>{{ knowledge.overview.brokenCount }}</strong>
          </button>
          <span
            v-if="knowledge.building"
            class="status-building"
          >索引构建中…</span>
        </template>
        <template v-else>
          <span class="status-item">还没有打开知识库</span>
          <button
            type="button"
            class="status-open"
            @click="fileStore.openFolder()"
          >
            打开文件夹
          </button>
        </template>
      </div>

      <section
        v-if="brokenOpen"
        class="broken-panel"
        data-testid="broken-list"
        aria-label="断链清单"
      >
        <header class="broken-head">
          <strong>断链 {{ knowledge.unresolved.length }}</strong>
          <button
            type="button"
            class="broken-close"
            @click="brokenOpen = false"
          >
            收起
          </button>
        </header>
        <button
          v-for="(item, index) in brokenPreview"
          :key="`${item.from}-${item.line}-${index}`"
          type="button"
          class="broken-item"
          @click="openBroken(item)"
        >
          <span class="broken-source">{{ item.from }}:{{ item.line }}</span>
          <code>{{ item.raw }}</code>
        </button>
        <p
          v-if="knowledge.unresolved.length > brokenPreview.length"
          class="broken-more"
        >
          还有 {{ knowledge.unresolved.length - brokenPreview.length }} 处未列出
        </p>
        <button
          type="button"
          class="broken-ask"
          @click="askAboutBroken"
        >
          让 AI 给出修复建议
        </button>
      </section>

      <section
        v-if="recent.length > 0"
        class="recent"
        aria-label="最近修改"
      >
        <header class="recent-head">
          <span>最近修改</span>
        </header>
        <button
          v-for="note in recent"
          :key="note.path"
          type="button"
          class="recent-item"
          data-testid="recent-note"
          @click="openRecent(note.path)"
        >
          <IconFile
            :size="15"
            :stroke-width="1.8"
            class="recent-icon"
          />
          <span class="recent-title">{{ noteTitle(note.path) }}</span>
          <span class="recent-folder">{{ noteFolder(note.path) }}</span>
          <time class="recent-time">{{ relativeTime(note.mtime) }}</time>
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.ai-workbench {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  background: var(--color-bg-primary);
  color: var(--color-text);
}

.workbench-inner {
  width: 100%;
  max-width: 860px;
  padding: clamp(48px, 12vh, 120px) 32px 56px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.workbench-header {
  text-align: center;
  margin-bottom: 2px;
}

.workbench-header h1 {
  margin: 0;
  font-size: calc(var(--ui-font-size) + 14px);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.workbench-header p {
  margin: 8px 0 0;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
}

.config-hint {
  align-self: center;
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.config-hint:hover {
  text-decoration: underline;
}

.quick-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.quick-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 13px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s;
}

.quick-action:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
  color: var(--color-primary);
}

.vault-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.status-item {
  color: var(--color-text-tertiary);
}

.status-item strong {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.status-dot {
  color: var(--color-border);
}

.status-action {
  padding: 1px 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.status-action:hover:not(:disabled) {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}

.status-action.alert strong {
  color: var(--color-error, #ef4444);
}

.status-action:disabled {
  cursor: default;
  opacity: 0.55;
}

.status-building {
  margin-left: 4px;
  color: var(--color-text-tertiary);
}

.status-open {
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  cursor: pointer;
}

.status-open:hover {
  text-decoration: underline;
}

.broken-panel {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-secondary);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.broken-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
  font-size: calc(var(--ui-font-size) - 1px);
}

.broken-close {
  border: 0;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.broken-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.broken-item:hover {
  background: var(--color-bg-tertiary);
}

.broken-source {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.broken-item code {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: calc(var(--ui-font-size) - 2px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.broken-more {
  margin: 2px 0 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.broken-ask {
  margin-top: 4px;
  align-self: flex-start;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-primary);
  color: var(--color-primary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.recent {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent-head {
  padding: 0 8px 4px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  font-weight: 600;
  letter-spacing: 0.04em;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.recent-item:hover {
  background: var(--color-bg-secondary);
}

.recent-icon {
  flex: none;
  color: var(--color-text-tertiary);
}

.recent-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: calc(var(--ui-font-size) - 1px);
}

.recent-folder {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.recent-time {
  margin-left: auto;
  flex: none;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

@media (max-width: 760px) {
  .workbench-inner {
    padding: 40px 14px 36px;
  }

  .recent-folder {
    display: none;
  }
}
</style>
