<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
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

const MAX_RESULTS = 50

const query = ref('')
const allFiles = ref<SearchableFile[]>([])
const activeIndex = ref(0)
const listRef = ref<HTMLElement | null>(null)

const results = computed<FileSearchResult[]>(() => searchFiles(allFiles.value, query.value).slice(0, MAX_RESULTS))

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

watch([query, results], () => {
  activeIndex.value = 0
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

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    if (results.value.length > 0) activeIndex.value = (activeIndex.value + 1) % results.value.length
    scrollToActive()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    if (results.value.length > 0) activeIndex.value = (activeIndex.value - 1 + results.value.length) % results.value.length
    scrollToActive()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const result = results.value[activeIndex.value]
    if (result) void openResult(result)
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
        <div
          v-if="showEmptyHint"
          class="quick-open-empty"
        >
          请先打开文件夹再搜索文件
        </div>
        <div
          v-else-if="results.length === 0"
          class="quick-open-empty"
        >
          无匹配文件
        </div>
        <ul
          v-else
          ref="listRef"
          class="quick-open-list"
        >
          <li
            v-for="(result, index) in results"
            :key="result.file.path"
            class="quick-open-item"
            :class="{ 'is-active': index === activeIndex }"
            @mouseenter="activeIndex = index"
            @click="openResult(result)"
          >
            <span class="quick-open-name">
              <template
                v-for="(chunk, i) in highlightText(result).text"
                :key="i"
              >
                <mark
                  v-if="highlightText(result).matched[i]"
                  class="quick-open-hl"
                >{{ chunk }}</mark>
                <template v-else>{{ chunk }}</template>
              </template>
            </span>
          </li>
        </ul>
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
