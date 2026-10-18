<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { AiConversationMessage, ConversationApprovalRecord, ToolExecutionResult } from '../../../shared/ai/types'
import AiMessageItem from './AiMessageItem.vue'
import AiApprovalCard from './AiApprovalCard.vue'
import AiApprovalGroup from './AiApprovalGroup.vue'

const props = defineProps<{
  messages: AiConversationMessage[]
  running: boolean
  toolCalls: { toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed'; result?: ToolExecutionResult; messageId?: string }[]
  approvals?: ConversationApprovalRecord[]
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

/** 按 messageId 分组审批记录 */
const approvalsByMessage = computed(() => {
  const map = new Map<string, ConversationApprovalRecord[]>()
  for (const approval of props.approvals ?? []) {
    const key = approval.messageId
    if (!key) continue
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(approval)
  }
  return map
})

/**
 * 找不到归属消息的审批记录（例如旧会话文件缺少 messageId）。
 * 这些不能丢，统一补在会话末尾，否则用户批准过的操作会凭空消失。
 */
const orphanApprovals = computed(() => {
  const ids = new Set(props.messages.map((message) => message.id))
  return (props.approvals ?? []).filter((approval) => !approval.messageId || !ids.has(approval.messageId))
})

const isEmpty = computed(() =>
  props.messages.length === 0 && props.toolCalls.length === 0 && (props.approvals?.length ?? 0) === 0
)

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
    <div class="thread">
      <div
        v-if="isEmpty"
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
        :approvals="approvalsByMessage.get(message.id) ?? []"
        :can-recall="!running"
        @recall="emit('recall', $event)"
      />
      <AiApprovalGroup
        v-if="orphanApprovals.length > 1"
        :records="orphanApprovals"
      />
      <AiApprovalCard
        v-else-if="orphanApprovals.length === 1"
        :record="orphanApprovals[0]"
      />
    </div>
  </div>
</template>

<style scoped>
.message-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 18px clamp(18px, 5vw, 64px);
}

/* 会话列居中限宽：否则面板一宽，右对齐的用户消息会飞到很远的地方 */
.thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 780px;
  min-height: 100%;
  margin: 0 auto;
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