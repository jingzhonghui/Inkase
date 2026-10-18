<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ConversationApprovalRecord } from '../../../shared/ai/types'
import AiApprovalCard from './AiApprovalCard.vue'

const props = defineProps<{ records: ConversationApprovalRecord[] }>()

/** 有待批准的摊开，否则收起来；之后开合交给用户 */
const open = ref(props.records.some((record) => !record.decision))

// 分组已经收着的时候又来了新审批，得把它顶开，否则用户根本看不到
watch(
  () => props.records.some((record) => !record.decision),
  (hasPending) => {
    if (hasPending) open.value = true
  }
)

const pendingCount = computed(() => props.records.filter((record) => !record.decision).length)

const stateText = computed(() => {
  if (pendingCount.value > 0) return `${pendingCount.value} 项待批准`
  const counts = { approved: 0, rejected: 0, expired: 0, cancelled: 0 }
  for (const record of props.records) {
    const status = record.decision?.status
    if (status) counts[status] += 1
  }
  if (counts.approved === props.records.length) return '全部已允许'
  if (counts.rejected === props.records.length) return '全部已拒绝'
  const parts: string[] = []
  if (counts.approved) parts.push(`已允许 ${counts.approved}`)
  if (counts.rejected) parts.push(`已拒绝 ${counts.rejected}`)
  if (counts.expired) parts.push(`已过期 ${counts.expired}`)
  if (counts.cancelled) parts.push(`已取消 ${counts.cancelled}`)
  return parts.join(' · ')
})

const stateClass = computed(() => {
  if (pendingCount.value > 0) return 'is-pending'
  if (props.records.every((record) => record.decision?.status === 'approved')) return 'is-approved'
  return 'is-mixed'
})
</script>

<template>
  <details
    class="approval-group"
    data-testid="ai-approval-group"
    :open="open"
  >
    <summary>
      <span class="group-label">&#9881; 审批 ({{ records.length }})</span>
      <span
        class="group-badge"
        :class="stateClass"
        data-testid="approval-group-state"
      >{{ stateText }}</span>
      <span class="chevron">&#9662;</span>
    </summary>
    <div class="group-body">
      <AiApprovalCard
        v-for="record in records"
        :key="record.id"
        :record="record"
      />
    </div>
  </details>
</template>

<style scoped>
.approval-group {
  margin: 0 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  user-select: none;
}

summary::-webkit-details-marker { display: none; }

.group-label {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-badge {
  flex-shrink: 0;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: calc(var(--ui-font-size) - 2px);
  font-weight: 600;
  letter-spacing: .02em;
  white-space: nowrap;
}

.group-badge.is-pending { background: rgb(245 158 11 / 12%); color: #b45309; }
.group-badge.is-approved { background: rgb(34 197 94 / 12%); color: #15803d; }
.group-badge.is-mixed { background: rgb(156 163 175 / 12%); color: #6b7280; }

.chevron {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  transition: transform .15s;
}

.approval-group[open] .chevron { transform: rotate(180deg); }

.group-body {
  padding: 6px 0;
  border-top: 1px solid var(--color-border);
}

/* 卡片换成面板底色，否则和分组底色糊在一起；左侧那条状态色留着 */
.group-body > :deep(.approval) {
  margin: 6px 8px;
  background: var(--color-bg);
}
</style>
