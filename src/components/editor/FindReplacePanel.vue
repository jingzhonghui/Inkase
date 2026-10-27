<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconX
} from '@tabler/icons-vue'
import Tooltip from '../common/Tooltip.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    replaceMode: boolean
    matchCount: number
    currentIndex: number
    initialQuery?: string
    /**
     * 是否提供替换能力。
     * 思维导图没有「正文」概念，只能替换节点文字，本期不做，
     * 于是传 false 把「显示替换」折叠按钮与替换行一起藏掉。
     */
    showReplace?: boolean
  }>(),
  { showReplace: true }
)

const emit = defineEmits<{
  close: []
  search: [query: string, caseSensitive: boolean]
  next: []
  prev: []
  replace: [query: string, replaceText: string, caseSensitive: boolean]
  replaceAll: [query: string, replaceText: string, caseSensitive: boolean]
  toggleReplace: []
}>()

const query = ref('')
const replaceText = ref('')
const caseSensitive = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const replaceInputRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  (open) => {
    if (open) {
      if (props.initialQuery) query.value = props.initialQuery
      nextTick(() => {
        if (props.replaceMode) {
          replaceInputRef.value?.focus()
          replaceInputRef.value?.select()
        } else {
          searchInputRef.value?.focus()
          searchInputRef.value?.select()
        }
        if (query.value) emitSearch()
      })
    }
  }
)

function emitSearch(): void {
  emit('search', query.value, caseSensitive.value)
}

function emitReplace(): void {
  emit('replace', query.value, replaceText.value, caseSensitive.value)
}

function emitReplaceAll(): void {
  emit('replaceAll', query.value, replaceText.value, caseSensitive.value)
}

function onToggleReplace(): void {
  emit('toggleReplace')
  nextTick(() => searchInputRef.value?.focus())
}
</script>

<template>
  <div v-if="open" class="find-replace-panel">
    <div class="find-replace-row">
      <span v-if="showReplace" class="find-replace-toggle-wrap">
        <Tooltip :content="replaceMode ? '隐藏替换' : '显示替换'">
          <button
            class="find-replace-toggle"
            :aria-label="replaceMode ? '隐藏替换' : '显示替换'"
            :aria-expanded="replaceMode"
            @click="onToggleReplace"
          >
            <IconChevronDown v-if="replaceMode" :size="14" />
            <IconChevronRight v-else :size="14" />
          </button>
        </Tooltip>
      </span>
      <input
        ref="searchInputRef"
        v-model="query"
        class="find-replace-input"
        type="text"
        placeholder="查找"
        @input="emitSearch"
        @keydown.enter.exact.prevent="emit('next')"
        @keydown.shift.enter.exact.prevent="emit('prev')"
        @keydown.escape.stop.prevent="emit('close')"
      />
      <Tooltip content="上一个">
        <button class="find-replace-btn" aria-label="上一个" @click="emit('prev')">
          <IconArrowUp :size="14" />
        </button>
      </Tooltip>
      <Tooltip content="下一个">
        <button class="find-replace-btn" aria-label="下一个" @click="emit('next')">
          <IconArrowDown :size="14" />
        </button>
      </Tooltip>
      <span class="find-replace-count"
        >{{ matchCount > 0 ? currentIndex + 1 : 0 }}/{{ matchCount }}</span
      >
      <Tooltip content="关闭">
        <button class="find-replace-btn" aria-label="关闭" @click="emit('close')">
          <IconX :size="14" />
        </button>
      </Tooltip>
    </div>
    <div v-if="showReplace && replaceMode" class="find-replace-row">
      <span class="find-replace-toggle-spacer" />
      <input
        ref="replaceInputRef"
        v-model="replaceText"
        class="find-replace-input"
        type="text"
        placeholder="替换为"
        @keydown.enter.exact.prevent="emitReplace"
        @keydown.escape.stop.prevent="emit('close')"
      />
      <Tooltip content="替换">
        <button class="find-replace-btn" aria-label="替换" @click="emitReplace">替换</button>
      </Tooltip>
      <Tooltip content="全部替换">
        <button class="find-replace-btn" aria-label="全部替换" @click="emitReplaceAll">
          全部替换
        </button>
      </Tooltip>
    </div>
    <label class="find-replace-options">
      <input v-model="caseSensitive" type="checkbox" @change="emitSearch" />
      <span>区分大小写</span>
    </label>
  </div>
</template>

<style scoped>
.find-replace-panel {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
}
.find-replace-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.find-replace-input {
  width: 180px;
  padding: 4px 8px;
  font-size: var(--ui-font-size);
  color: var(--color-text-primary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  outline: none;
}
.find-replace-input:focus {
  border-color: var(--color-primary);
}
.find-replace-btn {
  padding: 4px 8px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.find-replace-toggle-wrap {
  display: inline-flex;
  flex: 0 0 20px;
  width: 20px;
}
.find-replace-toggle {
  display: inline-flex;
  flex: 0 0 20px;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
}
.find-replace-toggle:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-secondary);
}
.find-replace-toggle-spacer {
  flex: 0 0 20px;
  width: 20px;
}
.find-replace-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-secondary);
}
.find-replace-count {
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}
.find-replace-options {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-size) - 1px);
  color: var(--color-text-tertiary);
  cursor: pointer;
}
</style>
