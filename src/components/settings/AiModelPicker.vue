<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconMinus, IconPlus } from '@tabler/icons-vue'
import AiModelCatalogDialog from './AiModelCatalogDialog.vue'
import { MAX_AI_MODELS } from '../../../shared/ai/types'

/**
 * 模型清单：一行一个模型，可手填、可增删。
 *
 * 为什么不是「一个输入框 + 一个下拉」：
 * 1. 不少自建网关、Ollama 之类根本没实现 `/models`，手填是唯一出路，所以输入框必须留着；
 * 2. 一个服务商往往要挂好几个模型（便宜的、强的各一个），塞进单个输入框就只能留一个。
 *
 * 「获取模型」的动作按钮由外层（`SettingsRow` 的标题行）渲染，因为按位置它要跟
 * 「模型」这个标题同一行；这里通过 `defineExpose` 把 `fetchModels` 与 `fetching`
 * 交给它，只管拉取与弹窗。
 *
 * 获取结果不直接落到清单里：弹窗里勾完点「确认」才写回，避免点一下就把服务商
 * 上百个模型全部塞进来。
 */
const props = withDefaults(defineProps<{
  /** 当前使用的模型（AI 面板下拉选中的那一个） */
  model: string
  /** 模型清单（一行一个，顺序即显示顺序） */
  models: string[]
  /** 拉取模型列表所需的地址与 Key（取表单当前值，不读已存配置） */
  baseUrl: string
  apiKey?: string
  disabled?: boolean
}>(), {
  apiKey: '',
  disabled: false
})

const emit = defineEmits<{
  'update:model': [model: string]
  'update:models': [models: string[]]
}>()

const loading = ref(false)
const error = ref('')
const catalogOpen = ref(false)
/** 弹窗里的候选：本次拉到的 ∪ 已勾选的（重开弹窗不该丢掉之前的选择） */
const candidates = ref<string[]>([])

/**
 * 显示用的行。
 *
 * 清单为空时用「当前模型」兜住，否则首次配置会看到一片空白；两边都空时给一个
 * 空行，让用户直接打字。后端 `normalizeModelList` 会丢掉空白项、`withActiveModel`
 * 会把当前模型补回去，所以这里不必自作主张地过滤。
 */
const rows = computed<string[]>(() => {
  if (props.models.length > 0) return props.models
  return [props.model]
})

/** 增减行都以「眼前这份」为基准，避免空清单时丢掉用户已填的当前模型 */
function currentRows(): string[] {
  return props.models.length > 0 ? [...props.models] : [props.model]
}

function updateAt(index: number, value: string): void {
  const next = currentRows()
  const previous = next[index]
  next[index] = value
  emit('update:models', next.slice(0, MAX_AI_MODELS))
  // 改的正好是当前模型：跟着一起改名，否则保存后会出现「模型不在清单里」
  if (previous && previous === props.model) emit('update:model', value)
}

function addRow(): void {
  if (props.models.length >= MAX_AI_MODELS) return
  emit('update:models', [...currentRows(), ''])
}

function removeRow(index: number): void {
  const next = currentRows()
  const [removed] = next.splice(index, 1)
  emit('update:models', next)
  // 删掉的正好是当前模型：顺位到剩下的第一个，避免留下一个指向空行的当前模型
  if (removed && removed === props.model) {
    emit('update:model', next.find((id) => id.trim()) ?? '')
  }
}

/**
 * 弹窗里默认勾选的项 = 清单 + 当前模型。
 *
 * 把当前模型也算进去：它是「现在正在用的」，没勾上就等于用户一确认就把自己
 * 正在用的模型删了。清单里已有它时不会重复。
 */
const dialogSelection = computed<string[]>(() => {
  const out = props.models.filter((id) => id.trim())
  const current = props.model.trim()
  if (current && !out.includes(current)) out.unshift(current)
  return out
})

/** 拉取模型清单；失败只写错误，不打开弹窗（空列表没有可勾的东西） */
async function fetchModels(): Promise<void> {
  if (props.disabled || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await window.electronAPI?.fetchAiModels?.({
      baseUrl: props.baseUrl.trim(),
      // 空 Key 交给主进程决定是否沿用已存的（同源时）
      apiKey: props.apiKey.trim() || undefined
    })
    if (!result?.success) {
      error.value = result?.error || '获取模型列表失败'
      return
    }
    const models = result.data?.models ?? []
    const merged = [...dialogSelection.value]
    for (const id of models) {
      if (!merged.includes(id)) merged.push(id)
    }
    candidates.value = merged.filter((id) => id.trim()).slice(0, MAX_AI_MODELS)
    catalogOpen.value = true
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '获取模型列表失败'
  } finally {
    loading.value = false
  }
}

/** 弹窗确认：整体替换清单；当前模型不在新清单里就顺位到第一个 */
function onConfirm(models: string[]): void {
  catalogOpen.value = false
  emit('update:models', models)
  if (!models.includes(props.model)) emit('update:model', models[0] ?? '')
}

defineExpose({ fetchModels, fetching: loading })
</script>

<template>
  <div class="model-list">
    <div
      v-for="(value, index) in rows"
      :key="index"
      class="model-row"
      :class="{ 'model-row--single': rows.length <= 1 }"
    >
      <input
        class="model-row__input"
        :data-testid="index === 0 ? 'ai-model' : `ai-model-row-${index}`"
        :data-row="index"
        type="text"
        :value="value"
        :placeholder="index === 0 ? '模型名称，如 deepseek-chat' : '再填一个模型'"
        @input="updateAt(index, ($event.target as HTMLInputElement).value)"
      >
      <!--
        两个按钮位：第二列（删除位）、第三列（添加位）。
        只有一行时没有删除按钮，「+」上移顶到删除位、紧贴输入框，第三列留空占位——
        这样输入框宽度在 1 行 ↔ N 行之间完全一致，删除按钮也始终在同一列。
      -->
      <button
        v-if="rows.length > 1"
        type="button"
        class="model-row__icon"
        :data-testid="`ai-model-remove-${index}`"
        :aria-label="`移除 ${value || '这一行'}`"
        :title="`移除 ${value || '这一行'}`"
        @click="removeRow(index)"
      >
        <IconMinus
          :size="14"
          aria-hidden="true"
        />
      </button>
      <button
        v-else
        type="button"
        class="model-row__add"
        data-testid="ai-model-add"
        aria-label="添加一个模型"
        title="添加一个模型"
        @click="addRow"
      >
        <IconPlus
          :size="14"
          aria-hidden="true"
        />
      </button>
      <button
        v-if="rows.length > 1 && index === rows.length - 1"
        type="button"
        class="model-row__add"
        data-testid="ai-model-add"
        aria-label="添加一个模型"
        title="添加一个模型"
        @click="addRow"
      >
        <IconPlus
          :size="14"
          aria-hidden="true"
        />
      </button>
      <span
        v-else-if="rows.length <= 1"
        class="model-row__ghost"
        aria-hidden="true"
      />
    </div>

    <p
      v-if="error"
      class="model-list__error"
      data-testid="ai-fetch-models-error"
      role="alert"
    >
      {{ error }}
    </p>

    <AiModelCatalogDialog
      :open="catalogOpen"
      :candidates="candidates"
      :selected="dialogSelection"
      @close="catalogOpen = false"
      @confirm="onConfirm"
    />
  </div>
</template>

<style scoped>
/*
 * 网格必须建在「列表」上，不能建在每一行上。
 *
 * 每行各自一个 grid 时，列宽是各算各的：第二行多一个「+」，它那一行的输入框就
 * 被挤窄，几行摞起来正是「第一行宽、第二行窄、删除按钮不齐」的锯齿。
 * 把网格提上来让所有行共享同一套列宽，输入框宽度、删除按钮位置才会行行一致。
 * 行元素本身用 `display: contents` 透明化，它的子元素直接成为这里的网格项。
 */
.model-list {
  /* 两个图标按钮的边长：抽取成变量，将来调大小只需改这里 */
  --model-row-icon: 30px;

  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
  width: 100%;
}

/* 行只是逻辑分组（承载 --single 状态），不参与布局 */
.model-row {
  display: contents;
}

.model-row__input {
  grid-column: 1;
  min-width: 0;
  padding: 6px 9px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--ui-font-size);
  outline: none;
}

.model-row__input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
}

/* 两个图标按钮（增 / 删）共用一套方正的骨相，颜色各归各的 */
.model-row__icon,
.model-row__add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 与输入框同高：一行里一高一矮看着就别扭 */
  align-self: stretch;
  width: var(--model-row-icon);
  min-height: var(--model-row-icon);
  padding: 0;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1px);
  white-space: nowrap;
  cursor: pointer;
}

/*
 * 删除是破坏性动作，底色必须一眼看出是红的，但它常驻在每一行末尾，
 * 纯实心红会把注意力从「模型名」上拽走：默认淡红底 + 红图标，
 * 悬停才实心红并转白，既能认出危险，又不会一直喊着。
 */
.model-row__icon {
  grid-column: 2;
  color: var(--color-danger);
  background: rgb(239 68 68 / 12%);
  border-color: rgb(239 68 68 / 34%);
}

.model-row__add {
  grid-column: 3;
}

/*
 * 只有一行时「+」上移一格顶到删除位，紧贴输入框（中间留一段空白看着像漏了个按钮）；
 * 让出来的第三列由 ghost 顶住，宽度才和 N 行时一模一样。
 */
.model-row--single .model-row__add {
  grid-column: 2;
}

/* 单行时顶住添加那一列，保证「加一行」前后输入框宽度分毫不差 */
.model-row__ghost {
  grid-column: 3;
  width: var(--model-row-icon);
  align-self: stretch;
}

.model-row__add:hover:not(:disabled) {
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.model-row__icon:hover:not(:disabled) {
  color: #fff;
  background: var(--color-danger);
  border-color: var(--color-danger);
}

.model-row__icon:disabled,
.model-row__add:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.model-list__error {
  /* 错误行横跨整张网格，否则会被塞进第一列那个窄格子里 */
  grid-column: 1 / -1;
  margin: 2px 0 0;
  color: var(--color-error, #ef4444);
  font-size: calc(var(--ui-font-size) - 1px);
}
</style>
