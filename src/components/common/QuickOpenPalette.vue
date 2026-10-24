<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { IconCalendar } from '@tabler/icons-vue'
import { useDailyStore } from '../../stores/daily'
import { useFileStore } from '../../stores/file'
import { searchFiles, type SearchableFile, type FileSearchResult } from '../../utils/fuzzy'

interface Props {
  visible: boolean
}

const props = withDefaults(defineProps<Props>(), {
  visible: false
})

const emit = defineEmits<{
  (e: 'close'): void
}>()

const fileStore = useFileStore()
const dailyStore = useDailyStore()

const MAX_RESULTS = 50
const DAILY_COMMAND_LABEL = '打开今天的每日笔记'

type PaletteRow =
  | { kind: 'command'; id: 'daily'; label: string }
  | { kind: 'file'; result: FileSearchResult }

const query = ref('')
const allFiles = ref<SearchableFile[]>([])
const activeIndex = ref(0)
const listRef = ref<HTMLElement | null>(null)

const results = computed<FileSearchResult[]>(() => searchFiles(allFiles.value, query.value).slice(0, MAX_RESULTS))

const commandMatches = computed(() => {
  const value = query.value.trim().toLowerCase()
  if (value === '') return true
  return DAILY_COMMAND_LABEL.toLowerCase().includes(value)
    || 'daily'.includes(value)
    || 'today'.includes(value)
    || '每日'.includes(value)
    || '日记'.includes(value)
})

const rows = computed<PaletteRow[]>(() => {
  const fileRows: PaletteRow[] = results.value.map((result) => ({ kind: 'file', result }))
  return commandMatches.value
    ? [{ kind: 'command', id: 'daily', label: DAILY_COMMAND_LABEL }, ...fileRows]
    : fileRows
})

const showEmptyHint = computed(() => !fileStore.openedFolderPath)

async function loadFiles(): Promise<void> {
  const folderPath = fileStore.openedFolderPath
  if (!folderPath || !window.electronAPI?.searchFiles) {
    allFiles.value = []
    return
  }
  try {
    const result = await window.electronAPI.searchFiles(folderPath)
    allFiles.value = result.success && result.data ? result.data : []
  } catch {
    allFiles.value = []
  }
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return
    query.value = ''
    activeIndex.value = 0
    allFiles.value = []
    await loadFiles()
    await nextTick()
    document.querySelector<HTMLInputElement>('.quick-open-input')?.focus()
  },
  { immediate: true }
)

watch([query, rows], () => {
  // 空查询时把默认焦点留给第一个文件，避免 Ctrl+P 后回车误开每日笔记
  activeIndex.value = query.value.trim() === '' && rows.value.length > 1 ? 1 : 0
})

function close(): void {
  emit('close')
}

function highlightText(result: FileSearchResult): { text: string; matched: boolean[] } {
  // 归一化分隔符得到相对路径展示；反斜杠→正斜杠与大小写归一都是 1:1 替换，positions 索引保持有效
  const root = (fileStore.openedFolderPath ?? '').replace(/\\/g, '/')
  const normalizedPath = result.file.path.replace(/\\/g, '/')
  const inFolder = root.length > 0 && normalizedPath.toLowerCase().startsWith(root.toLowerCase())
  const text = inFolder ? normalizedPath.slice(root.length).replace(/^\//, '') : normalizedPath
  const matched = new Array(text.length).fill(false)
  const offset = normalizedPath.length - text.length
  for (const pos of result.positions) {
    if (pos >= offset) matched[pos - offset] = true
  }
  return { text, matched }
}

async function openResult(result: FileSearchResult): Promise<void> {
  close()
  const ok = await fileStore.openFile(result.file.path, { addToRecent: false, preview: true })
  if (!ok && fileStore.error) {
    const { requestDialog } = await import('../../utils/dialog')
    const ext = result.file.name.includes('.')
      ? result.file.name.split('.').pop()!.toUpperCase()
      : result.file.name
    await requestDialog({
      title: '无法打开文件',
      message: `暂不支持 ${ext} 类型文件打开`,
      buttons: [{ label: '确定', value: 0, primary: true }]
    })
  }
}

async function runRow(row: PaletteRow): Promise<void> {
  if (row.kind === 'command') {
    close()
    await dailyStore.openToday()
    return
  }
  await openResult(row.result)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (rows.value.length > 0) activeIndex.value = (activeIndex.value + 1) % rows.value.length
    scrollToActive()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (rows.value.length > 0) activeIndex.value = (activeIndex.value - 1 + rows.value.length) % rows.value.length
    scrollToActive()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const row = rows.value[activeIndex.value]
    if (row) void runRow(row)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

function scrollToActive(): void {
  void nextTick(() => {
    const el = listRef.value?.children[activeIndex.value] as HTMLElement | undefined
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  })
}
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="quick-open-overlay"
      @mousedown.self="close"
    >
      <div class="quick-open-panel">
        <input
          v-model="query"
          type="text"
          spellcheck="false"
          class="quick-open-input"
          placeholder="输入文件名模糊搜索…"
          @keydown="onKeydown"
        >
        <ul
          v-if="rows.length > 0"
          ref="listRef"
          class="quick-open-list"
        >
          <li
            v-for="(row, index) in rows"
            :key="row.kind === 'command' ? `command:${row.id}` : row.result.file.path"
            class="quick-open-item"
            :class="{ 'is-active': index === activeIndex, 'is-command': row.kind === 'command' }"
            :data-testid="row.kind === 'command' ? 'quick-open-daily' : undefined"
            @mouseenter="activeIndex = index"
            @click="runRow(row)"
          >
            <template v-if="row.kind === 'command'">
              <IconCalendar
                :size="15"
                :stroke-width="1.8"
                class="quick-open-command-icon"
              />
              <span class="quick-open-name">{{ row.label }}</span>
              <span class="quick-open-hint">命令</span>
            </template>
            <span
              v-else
              class="quick-open-name"
            >
              <template
                v-for="(chunk, i) in highlightText(row.result).text"
                :key="i"
              >
                <mark
                  v-if="highlightText(row.result).matched[i]"
                  class="quick-open-hl"
                >{{ chunk }}</mark>
                <template v-else>{{ chunk }}</template>
              </template>
            </span>
          </li>
        </ul>
        <div
          v-if="showEmptyHint"
          class="quick-open-empty"
        >
          请先打开文件夹再搜索文件
        </div>
        <div
          v-else-if="rows.length === 0"
          class="quick-open-empty"
        >
          无匹配文件
        </div>
        <div class="quick-open-footer">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.quick-open-overlay {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.25);
}

.quick-open-panel {
  width: 520px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 8px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}

.quick-open-input {
  margin: 10px;
  padding: 9px 12px;
  font-size: calc(var(--ui-font-size) + 1px);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  box-sizing: border-box;
}

.quick-open-input:focus {
  border-color: var(--color-primary);
}

.quick-open-list {
  list-style: none;
  margin: 0;
  padding: 0 6px 6px;
  max-height: 320px;
  overflow-y: auto;
}

.quick-open-item {
  padding: 6px 10px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.quick-open-item.is-active {
  background: var(--color-primary-light);
  color: var(--color-primary);
}

.quick-open-item.is-command {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-border);
  border-radius: 0;
}

.quick-open-command-icon {
  flex: none;
  color: var(--color-primary);
}

.quick-open-hint {
  margin-left: auto;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.quick-open-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-open-hl {
  background: transparent;
  color: var(--color-primary);
  font-weight: 600;
}

.quick-open-empty {
  padding: 18px 12px 22px;
  text-align: center;
  font-size: var(--ui-font-size);
  color: var(--color-text-secondary);
}

.quick-open-footer {
  display: flex;
  gap: 14px;
  padding: 6px 12px;
  font-size: calc(var(--ui-font-size) - 2px);
  color: var(--color-text-tertiary);
  border-top: 1px solid var(--color-border);
}
</style>
