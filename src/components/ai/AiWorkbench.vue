<script setup lang="ts">
/**
 * AI 工作台首屏（空状态）
 *
 * 设计文档 §5.8：只放四块——大输入框、动态快捷动作、一行库状态、最近修改。
 * 打开文件夹后，孤立/断链/重复标题/未链接提及都可点进巡检；没有配置 AI 时，动作会把人带去设置。
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
import type { LinkRef, UnlinkedMention } from '../../../shared/knowledge/types'
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

type HealthCategory = 'isolated' | 'broken' | 'duplicates' | 'unlinked'

/** 当前展开的巡检分类；null 表示收起 */
const healthOpen = ref<HealthCategory | null>(null)

/** 巡检列表最多展示的条数（其余用「共 N 处」提示） */
const HEALTH_PREVIEW_LIMIT = 20

type QuickActionId = 'orphans' | 'broken' | 'duplicates' | 'unlinked' | 'recent' | 'new' | 'open-folder'

interface QuickAction {
  id: QuickActionId
  label: string
  icon: unknown
}

const hasVault = computed(() => knowledge.root !== null)
const recent = computed(() => knowledge.overview.recent)
const health = computed(() => knowledge.health)

/** 健康报告未载入时回退到 overview 的旧计数，避免首屏闪 0 */
const counts = computed(() => {
  if (knowledge.healthLoaded) return health.value.counts
  return {
    isolated: knowledge.overview.isolatedCount,
    broken: knowledge.overview.brokenCount,
    duplicateTitles: 0,
    unlinkedMentions: 0
  }
})

const brokenItems = computed<LinkRef[]>(() =>
  knowledge.healthLoaded ? health.value.broken : knowledge.unresolved
)
const brokenPreview = computed(() => brokenItems.value.slice(0, HEALTH_PREVIEW_LIMIT))
const isolatedPreview = computed(() => health.value.isolated.slice(0, HEALTH_PREVIEW_LIMIT))
const duplicatePreview = computed(() => health.value.duplicates.slice(0, HEALTH_PREVIEW_LIMIT))
const unlinkedPreview = computed(() => health.value.unlinked.slice(0, HEALTH_PREVIEW_LIMIT))

const healthTitle = computed(() => {
  switch (healthOpen.value) {
    case 'isolated':
      return '孤立笔记'
    case 'broken':
      return '断链'
    case 'duplicates':
      return '重复标题'
    case 'unlinked':
      return '未链接提及'
    default:
      return ''
  }
})

const healthTotal = computed(() => {
  switch (healthOpen.value) {
    case 'isolated':
      return counts.value.isolated
    case 'broken':
      return counts.value.broken
    case 'duplicates':
      return counts.value.duplicateTitles
    case 'unlinked':
      return counts.value.unlinkedMentions
    default:
      return 0
  }
})

const healthListLength = computed(() => {
  switch (healthOpen.value) {
    case 'isolated':
      return isolatedPreview.value.length
    case 'broken':
      return brokenPreview.value.length
    case 'duplicates':
      return duplicatePreview.value.length
    case 'unlinked':
      return unlinkedPreview.value.length
    default:
      return 0
  }
})

/** 动态快捷动作：有问题先给问题，没有问题给日常动作 */
const quickActions = computed<QuickAction[]>(() => {
  const actions: QuickAction[] = []

  if (hasVault.value) {
    if (counts.value.isolated > 0) {
      actions.push({ id: 'orphans', label: '找出孤立笔记', icon: IconTopologyStar3 })
    }
    if (counts.value.broken > 0) {
      actions.push({ id: 'broken', label: '修复断链', icon: IconLink })
    }
    if (counts.value.duplicateTitles > 0) {
      actions.push({ id: 'duplicates', label: '合并重复标题', icon: IconFile })
    }
    if (counts.value.unlinkedMentions > 0) {
      actions.push({ id: 'unlinked', label: '补全未链接提及', icon: IconLink })
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
      toggleHealth('isolated')
      break
    case 'broken':
      toggleHealth('broken')
      break
    case 'duplicates':
      toggleHealth('duplicates')
      break
    case 'unlinked':
      toggleHealth('unlinked')
      break
    case 'recent':
      askAboutRecent()
      break
  }
}

/** 孤立笔记：在巡检面板列出，另提供进入图谱的入口 */
function inspectOrphans(): void {
  knowledge.updateGraphFilters({ orphans: 'only' })
  knowledge.openGraphTab()
}

/** 打开/切换巡检分类 */
function toggleHealth(category: HealthCategory): void {
  healthOpen.value = healthOpen.value === category ? null : category
}

function askAboutRecent(): void {
  const noteList =
    recent.value.length > 0
      ? recent.value.map((note) => `- ${note.path}`).join('\n')
      : '（索引里还没有最近修改）'
  askAi(`总结这个知识库最近的改动，并指出值得继续推进的部分。\n最近修改：\n${noteList}`)
}

function askAboutHealth(): void {
  switch (healthOpen.value) {
    case 'broken': {
      const list = brokenItems.value
        .slice(0, HEALTH_PREVIEW_LIMIT)
        .map((ref) => `- ${ref.from}:${ref.line} ${ref.raw}`)
        .join('\n')
      askAi(`请检查这些断链，逐条给出修复建议（先不要改文件）。\n${list}`)
      break
    }
    case 'isolated': {
      const list = health.value.isolated
        .slice(0, HEALTH_PREVIEW_LIMIT)
        .map((path) => `- ${path}`)
        .join('\n')
      askAi(`这些笔记没有任何链接。请按主题分组，建议它们应该链接到哪些笔记。\n${list}`)
      break
    }
    case 'duplicates': {
      const list = health.value.duplicates
        .slice(0, HEALTH_PREVIEW_LIMIT)
        .map((group) => `- ${group.title}: ${group.paths.join(' / ')}`)
        .join('\n')
      askAi(`这些笔记的标题重复。请判断哪些应该合并、哪些需要改名，并给出具体方案。\n${list}`)
      break
    }
    case 'unlinked': {
      const list = health.value.unlinked
        .slice(0, HEALTH_PREVIEW_LIMIT)
        .map((item) => `- ${item.from}:${item.line} 提到「${item.raw}」，目标是 ${item.targetPath}`)
        .join('\n')
      askAi(`这些提及还没有建立链接。请逐条给出改写建议（保留原句）。\n${list}`)
      break
    }
    default:
      break
  }
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

async function openMention(item: UnlinkedMention): Promise<void> {
  const absPath = knowledge.resolveAbsolute(item.from)
  if (absPath === null) return
  await fileStore.openFile(absPath, { addToRecent: false })
  fileStore.requestReveal(absPath, item.line, item.column)
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
            :disabled="counts.isolated === 0"
            data-testid="status-isolated"
            @click="toggleHealth('isolated')"
          >
            孤立 <strong>{{ counts.isolated }}</strong>
          </button>
          <span class="status-dot">·</span>
          <button
            type="button"
            class="status-item status-action"
            :class="{ alert: counts.broken > 0 }"
            :disabled="counts.broken === 0"
            data-testid="status-broken"
            @click="toggleHealth('broken')"
          >
            断链 <strong>{{ counts.broken }}</strong>
          </button>
          <span class="status-dot">·</span>
          <button
            type="button"
            class="status-item status-action"
            :disabled="counts.duplicateTitles === 0"
            data-testid="status-duplicates"
            @click="toggleHealth('duplicates')"
          >
            重名 <strong>{{ counts.duplicateTitles }}</strong>
          </button>
          <span class="status-dot">·</span>
          <button
            type="button"
            class="status-item status-action"
            :disabled="counts.unlinkedMentions === 0"
            data-testid="status-unlinked"
            @click="toggleHealth('unlinked')"
          >
            未链接 <strong>{{ counts.unlinkedMentions }}</strong>
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
        v-if="healthOpen"
        class="broken-panel"
        :data-testid="healthOpen === 'broken' ? 'broken-list' : 'health-panel'"
        :aria-label="`${healthTitle}清单`"
      >
        <header class="broken-head">
          <strong>{{ healthTitle }} {{ healthTotal }}</strong>
          <button
            type="button"
            class="broken-close"
            @click="healthOpen = null"
          >
            收起
          </button>
        </header>

        <template v-if="healthOpen === 'isolated'">
          <button
            v-for="path in isolatedPreview"
            :key="path"
            type="button"
            class="broken-item"
            data-testid="health-item"
            @click="openRecent(path)"
          >
            <span class="broken-source">{{ noteFolder(path) }}</span>
            <span>{{ noteTitle(path) }}</span>
          </button>
          <button
            type="button"
            class="broken-ask"
            data-testid="health-graph"
            @click="inspectOrphans"
          >
            在图谱中查看
          </button>
        </template>

        <template v-else-if="healthOpen === 'broken'">
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
        </template>

        <template v-else-if="healthOpen === 'duplicates'">
          <div
            v-for="group in duplicatePreview"
            :key="group.title"
            class="health-group"
            data-testid="duplicate-group"
          >
            <strong class="health-group-title">{{ group.title }}</strong>
            <button
              v-for="path in group.paths"
              :key="path"
              type="button"
              class="broken-item health-item"
              @click="openRecent(path)"
            >
              <span class="broken-source">{{ noteFolder(path) }}</span>
              <span>{{ noteTitle(path) }}</span>
            </button>
          </div>
        </template>

        <template v-else>
          <button
            v-for="(item, index) in unlinkedPreview"
            :key="`${item.from}-${item.line}-${item.column}-${index}`"
            type="button"
            class="broken-item"
            data-testid="unlinked-item"
            @click="openMention(item)"
          >
            <span class="broken-source">{{ item.from }}:{{ item.line }}</span>
            <code>{{ item.raw }}</code>
            <span class="health-target">→ {{ item.targetPath }}</span>
          </button>
        </template>

        <p
          v-if="healthTotal > healthListLength"
          class="broken-more"
        >
          还有 {{ healthTotal - healthListLength }} 处未列出
        </p>
        <button
          type="button"
          class="broken-ask"
          @click="askAboutHealth"
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

.health-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-border);
}

.health-group:last-of-type {
  border-bottom: 0;
}

.health-group-title {
  padding: 2px 8px;
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) - 1px);
}

.health-item {
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
}

.health-target {
  color: var(--color-text-tertiary);
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
