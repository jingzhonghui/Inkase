<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { IconSearch } from '@tabler/icons-vue'

/**
 * 「获取模型」的勾选弹窗。
 *
 * 从服务商拉到的模型可能有几十上百个，塞进设置页里那一小格根本翻不动，所以
 * 单独做一层弹窗：列表、搜索、全选都在这里完成，点「确认」才把结果交回去。
 *
 * 必须盖住设置面板本身（`--z-dialog` 高于 `--z-settings-overlay`）：早先它是
 * 一个挂在下拉层（10000）里的菜单，被设置面板的遮罩整个压住，看着像「点了没反应」。
 */
const props = defineProps<{
  open: boolean
  /** 候选模型（已并上当前已选的，勾选态才不会凭空丢） */
  candidates: string[]
  /** 打开时的初始勾选 */
  selected: string[]
}>()

const emit = defineEmits<{
  close: []
  confirm: [models: string[]]
}>()

const checked = ref<string[]>([])
const query = ref('')
const panelRef = ref<HTMLElement | null>(null)

/**
 * 每次打开都从「当前已选」重新起算。
 *
 * 不这么做的话，上次取消掉的勾选会残留到下一次——用户看到的是「我明明取消了，
 * 再打开又勾上了」。
 */
watch(
  () => props.open,
  (open) => {
    if (!open) return
    checked.value = [...props.selected]
    query.value = ''
    void nextTick(() => panelRef.value?.focus())
  },
  { immediate: true }
)

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.candidates
  return props.candidates.filter((id) => id.toLowerCase().includes(keyword))
})

const allChecked = computed(
  () => filtered.value.length > 0 && filtered.value.every((id) => checked.value.includes(id))
)

function toggle(id: string): void {
  checked.value = checked.value.includes(id)
    ? checked.value.filter((item) => item !== id)
    : [...checked.value, id]
}

function toggleAll(): void {
  if (allChecked.value) {
    const drop = new Set(filtered.value)
    checked.value = checked.value.filter((id) => !drop.has(id))
    return
  }
  const next = [...checked.value]
  for (const id of filtered.value) {
    if (!next.includes(id)) next.push(id)
  }
  checked.value = next
}

/** 一个都不选就确认，等于把模型清空——发送按钮会跟着变灰，所以直接拦住 */
function confirm(): void {
  if (checked.value.length === 0) return
  emit('confirm', [...checked.value])
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.open"
      class="catalog-overlay"
      @mousedown.self="emit('close')"
    >
      <section
        ref="panelRef"
        class="catalog-panel"
        role="dialog"
        aria-modal="true"
        aria-label="选择模型"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="catalog-head">
          <strong>选择模型</strong>
          <span class="catalog-count">
            共 {{ props.candidates.length }} 个，已选 {{ checked.length }} 个
          </span>
        </header>

        <div class="catalog-toolbar">
          <label class="catalog-search">
            <IconSearch
              :size="14"
              aria-hidden="true"
            />
            <input
              v-model="query"
              data-testid="ai-model-search"
              type="search"
              placeholder="搜索模型…"
              aria-label="搜索模型"
            >
          </label>
          <button
            type="button"
            class="catalog-all"
            data-testid="ai-model-select-all"
            @click="toggleAll"
          >
            {{ allChecked ? '取消全选' : '全选' }}
          </button>
        </div>

        <div
          class="catalog-list"
          role="group"
          aria-label="模型列表"
        >
          <p
            v-if="filtered.length === 0"
            class="catalog-empty"
          >
            没有匹配的模型
          </p>
          <label
            v-for="id in filtered"
            :key="id"
            class="catalog-item"
            :class="{ 'is-checked': checked.includes(id) }"
            data-testid="ai-model-catalog-option"
            :data-option="id"
          >
            <input
              type="checkbox"
              :checked="checked.includes(id)"
              @change="toggle(id)"
            >
            <span class="catalog-item-name">{{ id }}</span>
          </label>
        </div>

        <footer class="catalog-foot">
          <button
            type="button"
            class="catalog-btn"
            data-testid="ai-model-catalog-cancel"
            @click="emit('close')"
          >
            取消
          </button>
          <button
            type="button"
            class="catalog-btn catalog-btn--primary"
            data-testid="ai-model-catalog-confirm"
            :disabled="checked.length === 0"
            @click="confirm"
          >
            确认
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.catalog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 40%);
}

.catalog-panel {
  display: flex;
  width: 420px;
  max-width: calc(100vw - 48px);
  max-height: min(520px, calc(100vh - 96px));
  flex-direction: column;
  padding: 16px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 44px rgb(0 0 0 / 28%);
  outline: none;
}

.catalog-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.catalog-head strong {
  font-size: var(--ui-font-size);
  font-weight: 600;
}

.catalog-count {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.catalog-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.catalog-search {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  color: var(--color-text-tertiary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.catalog-search input {
  flex: 1;
  min-width: 0;
  color: var(--color-text);
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  outline: none;
}

.catalog-all {
  flex: 0 0 auto;
  padding: 5px 10px;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.catalog-all:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.catalog-list {
  flex: 1;
  min-height: 120px;
  padding: 4px;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.catalog-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.catalog-item:hover {
  background: var(--color-bg-tertiary);
}

.catalog-item.is-checked {
  color: var(--color-text);
  font-weight: 600;
}

.catalog-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-empty {
  margin: 12px 8px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.catalog-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.catalog-btn {
  padding: 6px 14px;
  color: var(--color-text);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font: inherit;
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.catalog-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.catalog-btn--primary {
  color: #fff;
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.catalog-btn--primary:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.06);
}

.catalog-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
