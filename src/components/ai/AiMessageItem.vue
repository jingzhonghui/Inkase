<script setup lang="ts">
import { computed } from 'vue'
import { IconArrowBackUp, IconMessageChatbot, IconUserFilled } from '@tabler/icons-vue'
import type { AiConversationMessage, ConversationApprovalRecord, ToolExecutionResult } from '../../../shared/ai/types'
import { renderAiMarkdown } from '../../utils/ai/markdown'
import { extractAnalysisBlock, ANALYSIS_START_RE, hasAnalysisEnd } from '../../utils/ai/analysis-block'
import Tooltip from '../common/Tooltip.vue'
import AiAnalysisCard from './AiAnalysisCard.vue'
import AiApprovalCard from './AiApprovalCard.vue'
import AiApprovalGroup from './AiApprovalGroup.vue'
import AiToolCallGroup from './AiToolCallGroup.vue'

const props = defineProps<{
  message: AiConversationMessage
  streaming?: boolean
  toolCalls?: { toolCallId: string; toolName: string; status: 'running' | 'completed' | 'failed'; result?: ToolExecutionResult }[]
  approvals?: ConversationApprovalRecord[]
  canRecall?: boolean
}>()

const emit = defineEmits<{ recall: [messageId: string] }>()

const parsed = computed(() => {
  if (props.message.role !== 'assistant') return { analysis: '', answer: props.message.content }
  const content = props.message.content

  if (props.streaming && !hasAnalysisEnd(content)) {
    const cleaned = content.replace(ANALYSIS_START_RE, '')
    return { analysis: cleaned.trim(), answer: '' }
  }

  return extractAnalysisBlock(content)
})

const answerHtml = computed(() => renderAiMarkdown(parsed.value.answer))
const showAnalysisCard = computed(() => {
  if (props.message.role !== 'assistant') return false
  return parsed.value.analysis.length > 0 || (props.streaming && props.message.content.length > 0)
})
const hasToolCalls = computed(() => (props.toolCalls?.length ?? 0) > 0)
const approvalList = computed(() => props.approvals ?? [])
const showRecall = computed(() => props.canRecall && props.message.role === 'user')
const isAssistant = computed(() => props.message.role === 'assistant')

/**
 * 头像代替文字标签：图形不同（人 vs 星芒）本身就区分了发言人，不必只靠颜色。
 * aria-label 兜住读屏用户——头像上的字看不见了，名字不能丢。
 */
const roleLabel = computed(() => {
  if (props.message.role === 'assistant') return 'AI 助手'
  if (props.message.role === 'user') return '你'
  return props.message.role
})

const roleIcon = computed(() => (isAssistant.value ? IconMessageChatbot : IconUserFilled))
</script>

<template>
  <article
    class="message"
    :class="`message-${message.role}`"
    data-testid="ai-message"
  >
    <span
      class="avatar"
      role="img"
      data-testid="ai-avatar"
      :aria-label="roleLabel"
    >
      <component
        :is="roleIcon"
        :size="15"
        aria-hidden="true"
      />
    </span>

    <div class="message-content">
      <div
        class="bubble"
        :class="isAssistant ? 'bubble-assistant' : 'bubble-user'"
      >
        <template v-if="!isAssistant">
          <div
            class="message-body"
            v-html="answerHtml"
          />
        </template>
        <template v-else>
          <AiAnalysisCard
            v-if="showAnalysisCard"
            :content="parsed.analysis"
            :streaming="streaming || false"
          />
          <AiApprovalGroup
            v-if="approvalList.length > 1"
            :records="approvalList"
          />
          <AiApprovalCard
            v-else-if="approvalList.length === 1"
            :record="approvalList[0]"
          />
          <AiToolCallGroup
            v-if="hasToolCalls"
            :calls="toolCalls!"
          />
          <div
            v-if="parsed.answer"
            class="message-body"
            v-html="answerHtml"
          />
          <span
            v-if="streaming && parsed.answer"
            class="stream-caret"
            aria-label="正在生成"
          />
        </template>
      </div>
    </div>

    <!-- Tooltip 的根节点是 flex:1 的 span，直接放进 .message 会变成一个撑开的 flex 项，
         所以外面再套一层脱离文档流的容器 -->
    <div
      v-if="showRecall"
      class="recall-slot"
    >
      <Tooltip content="撤回">
        <button
          type="button"
          class="recall-btn"
          data-testid="ai-recall"
          aria-label="撤回"
          @click="emit('recall', message.id)"
        >
          <IconArrowBackUp :size="14" />
        </button>
      </Tooltip>
    </div>
  </article>
</template>

<style scoped>
/* 发言人靠三件事区分，任何一件单独失效都还认得出来：
   头像（图形不同）、左右位置、气泡样式。 */
.message {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 0;
}

/* 用户头像放右边：整条消息镜像过来 */
.message-user {
  flex-direction: row-reverse;
}

.message-content {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}

.message-user .message-content {
  align-items: flex-end;
}

.avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  margin-top: 3px;
  border-radius: 50%;
  /* 前景用面板底色，深浅两套主题下都能自动取到对的那一侧 */
  background: var(--color-text-secondary);
  color: var(--color-bg-primary);
}

.message-assistant .avatar {
  background: linear-gradient(135deg, var(--color-primary), var(--color-primary-hover));
}

/* 用户气泡：实底 + 缺角 */
.bubble-user {
  max-width: 86%;
  padding: 9px 13px;
  border-radius: 12px 12px 4px 12px;
  background: var(--color-primary-light);
  color: var(--color-text);
}

/* 助手气泡：描边而不是实底。里面的工具/审批/分析卡片都是 bg-secondary，
   气泡要是也用这个底色，卡片就全糊进背景里了。
   描边用 border-hover 而不是 border：浅色下 border 对白底只有 1.24:1，基本看不见。 */
.bubble-assistant {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--color-border-hover);
  border-radius: 12px 12px 12px 4px;
  background: var(--color-bg-primary);
}

.bubble-assistant :deep(> :first-child) { margin-top: 0; }
.bubble-assistant :deep(> :last-child) { margin-bottom: 0; }

.message-body { line-height: 1.65; overflow-wrap: anywhere; }
.message-body :deep(> :first-child) { margin-top: 0; }
.message-body :deep(> :last-child) { margin-bottom: 0; }
.message-body :deep(pre) { overflow: auto; padding: 12px; border-radius: 6px; background: var(--color-bg-secondary); }
/* 用户气泡是蓝底，里面再套灰底代码块会显得像画错了，改用面板底色当"卡中卡" */
.bubble-user .message-body :deep(pre) { background: var(--color-bg-primary); }

.stream-caret { display: inline-block; width: 2px; height: 1em; margin-left: 3px; background: var(--color-primary); animation: blink 1s steps(1) infinite; vertical-align: text-bottom; }
@keyframes blink { 50% { opacity: .15; } }
@media (prefers-reduced-motion: reduce) { .stream-caret { animation: none; } }

/* 挂在气泡左侧的空白里：用户气泡限宽 86%，左边一定留得下这 22px */
.recall-slot {
  position: absolute;
  top: 2px;
  left: 0;
}

.recall-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s, color .12s, background .12s;
}
.message:hover .recall-btn { opacity: 1; }
.recall-btn:hover { background: var(--color-bg-tertiary); color: var(--color-text); }
</style>
