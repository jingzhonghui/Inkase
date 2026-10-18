<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'

const props = defineProps<{ running: boolean; ready: boolean }>()
const emit = defineEmits<{ send: [text: string]; stop: [] }>()
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
  </form>
</template>

<style scoped>
/* 与消息列同宽居中，否则输入框和上方的会话对不齐 */
.composer { display: flex; align-items: flex-end; gap: 10px; max-width: 780px; margin: 0 auto; padding: 12px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-primary); box-shadow: 0 8px 24px rgb(0 0 0 / 8%); }
textarea { flex: 1; min-height: 42px; resize: none; border: 0; outline: none; background: transparent; color: var(--color-text); font: inherit; line-height: 1.5; }
button { min-width: 62px; padding: 8px 13px; border: 0; border-radius: 6px; background: var(--color-primary); color: white; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }.stop { background: var(--color-text-secondary); }
</style>
