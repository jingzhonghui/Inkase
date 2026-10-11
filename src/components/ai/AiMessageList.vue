<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AiConversationMessage, ToolExecutionResult } from '../../../shared/ai/types'
import AiMessageItem from './AiMessageItem.vue'

const props = defineProps<{
  messages: AiConversationMessage[]
  running: boolean
  toolCalls: { toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed'; result?: ToolExecutionResult; messageId?: string }[]
}>()

const emit = defineEmits<{ recall: [messageId: string] }>()

/** 按 messageId 分组工具调用 */
const toolCallsByMessage = computed(() => {
  const map = new Map<string, typeof props.toolCalls>()
  for (const call of props.toolCalls) {
    const key = call.messageId
    if (!key) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(call)
  }
  return map
})

const scrollRoot = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  const el = scrollRoot.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

watch(
  () => props.messages,
  () => {
    void nextTick(scrollToBottom)
  },
  { deep: true }
)
</script>

<template>
  <div
    ref="scrollRoot"
    class="message-list"
    aria-live="polite"
  >
    <div
      v-if="messages.length === 0 && toolCalls.length === 0"
      class="welcome"
    >
      <strong>从文稿开始</strong>
      <span>提问、改写，或添加材料作为参考。</span>
    </div>
    <AiMessageItem
      v-for="(message, index) in messages"
      :key="message.id"
      :message="message"
      :streaming="running && index === messages.length - 1 && message.role === 'assistant'"
      :tool-calls="toolCallsByMessage.get(message.id) ?? []"
      :can-recall="!running"
      @recall="emit('recall', $event)"
    />
  </div>
</template>

<style scoped>
.message-list {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding: 18px clamp(18px, 5vw, 64px);
}

.welcome {
  display: grid;
  place-content: center;
  flex: 1;
  gap: 7px;
  color: var(--color-text-secondary);
  text-align: center;
}
.welcome strong {
  color: var(--color-text);
  font-size: calc(var(--ui-font-size) + 5px);
}
</style>