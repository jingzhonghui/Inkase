<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import AiPermissionSelect from './AiPermissionSelect.vue'
import AiModelSelect from './AiModelSelect.vue'
import { DEFAULT_AI_PERMISSION_MODE, type AiPermissionMode } from '../../../shared/ai/permission'

const props = withDefaults(defineProps<{
  running: boolean
  ready: boolean
  /** 当前权限模式：真相在主进程配置里，这里只负责呈现与回传选择 */
  permissionMode?: AiPermissionMode
  permissionSaving?: boolean
  /** 当前模型与可选目录，同样以主进程配置为准 */
  model?: string
  models?: string[]
  modelSaving?: boolean
}>(), {
  permissionMode: DEFAULT_AI_PERMISSION_MODE,
  permissionSaving: false,
  model: '',
  models: () => [],
  modelSaving: false
})
const emit = defineEmits<{
  send: [text: string]
  stop: []
  permissionChange: [mode: AiPermissionMode]
  modelChange: [model: string]
}>()
const text = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const disabled = computed(() => !text.value.trim() || !props.ready || props.running)

function submit(): void { if (!disabled.value) { emit('send', text.value); text.value = '' } }
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    submit()
  }
}

function setText(value: string): void {
  text.value = value
  void nextTick(() => {
    textareaRef.value?.focus()
    textareaRef.value?.setSelectionRange(value.length, value.length)
  })
}

defineExpose({ setText })
</script>

<template>
  <form
    class="composer"
    @submit.prevent="submit"
  >
    <textarea
      ref="textareaRef"
      v-model="text"
      data-testid="ai-input"
      rows="2"
      placeholder="与文稿协作…"
      aria-label="AI 消息"
      spellcheck="false"
      @keydown="keydown"
    />
    <div class="composer-actions">
      <!-- 权限模式与模型都住在输入框内部：它们跟这条消息一起发送，就是输入框的一部分 -->
      <AiPermissionSelect
        :model-value="permissionMode"
        :disabled="permissionSaving"
        @change="emit('permissionChange', $event)"
      />
      <AiModelSelect
        :model="model"
        :models="models"
        :disabled="modelSaving"
        @change="emit('modelChange', $event)"
      />
      <button
        v-if="running"
        type="button"
        class="stop"
        data-testid="ai-stop"
        @click="emit('stop')"
      >
        停止
      </button>
      <button
        v-else
        type="submit"
        data-testid="ai-send"
        :disabled="disabled"
      >
        发送
      </button>
    </div>
  </form>
</template>

<style scoped>
/* 输入框与外框是一体的：textarea 无边框，底栏（权限 + 发送）在同一张卡里 */
.composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 780px;
  margin: 0 auto;
  padding: 10px 10px 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-primary);
  box-shadow: 0 8px 24px rgb(0 0 0 / 8%);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.composer:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light), 0 8px 24px rgb(0 0 0 / 8%);
}
textarea {
  width: 100%;
  min-height: 42px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  line-height: 1.5;
  resize: none;
}
.composer-actions { display: flex; align-items: center; gap: 8px; }
.composer-actions button {
  min-width: 62px;
  margin-left: auto;
  padding: 7px 13px;
  border: 0;
  border-radius: 6px;
  background: var(--color-primary);
  color: white;
  cursor: pointer;
}
.composer-actions button:disabled { cursor: not-allowed; opacity: .45; }
.composer-actions .stop { background: var(--color-text-secondary); }
</style>
