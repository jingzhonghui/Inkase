<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  ApprovalDecision,
  ApprovalTier,
  ConversationApprovalRecord,
  ToolExecutionResult
} from '../../../shared/ai/types'
import { useAiStore } from '../../stores/ai'
import { useSnapshotStore } from '../../stores/ai-snapshots'
import { approvalPreviewType, validApprovalPreview } from '../../utils/ai/approval-preview'
import MarkdownDiffPreview from './approval/MarkdownDiffPreview.vue'
import DocumentPreview from './approval/DocumentPreview.vue'
import BatchApprovalPreview from './approval/BatchApprovalPreview.vue'
import NetworkRequestPreview from './approval/NetworkRequestPreview.vue'
import LocalFileReadPreview from './approval/LocalFileReadPreview.vue'

const props = defineProps<{ record: ConversationApprovalRecord }>()
const store = useAiStore()
const snapshots = useSnapshotStore()
const resolving = ref(false)
const rollingBack = ref(false)
const rollbackError = ref<string | null>(null)

onMounted(() => {
  void snapshots.ensureLoaded()
})

/**
 * 折叠状态只取一次初值：等待批准的要摊开（否则用户看不见、点不到），
 * 已经判定过的收起来，让会话保持清爽。之后开合完全交给用户。
 */
const open = ref(props.record.decision === undefined)

const preview = computed(() => validApprovalPreview(props.record.preview))
const previewType = computed(() => approvalPreviewType(preview.value))
/** 预览结构不可信时不允许通过，与主进程 fail-closed 的取向保持一致 */
const blocked = computed(() => previewType.value === 'unsupported')

const EFFECT_LABELS: Record<ConversationApprovalRecord['effect'], string> = {
  read: '只读',
  network: '联网',
  write: '写入',
  'external-action': '外部操作',
  dangerous: '危险操作'
}

const RISK_LABELS: Record<ConversationApprovalRecord['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险'
}

const TIER_LABELS: Record<ApprovalTier, string> = {
  auto: '自动',
  confirm: '逐次审批',
  batch: '批量审批'
}

const meta = computed(() => {
  const tier = props.record.approvalTier ? TIER_LABELS[props.record.approvalTier] : ''
  return [tier, EFFECT_LABELS[props.record.effect], RISK_LABELS[props.record.riskLevel]]
    .filter(Boolean)
    .join(' · ')
})

const pending = computed(() => props.record.decision === undefined)

/** 判定结果：允许时补上执行结果，冲突/失败要说清楚，否则用户会以为已经写入 */
const verdict = computed(() => {
  const decision = props.record.decision
  if (!decision) return '等待批准'
  if (decision.status === 'approved') {
    const base = outcomeText(props.record.outcome)
    return decision.scope === 'session' ? `${base} · 本次会话已记住` : base
  }
  if (decision.status === 'rejected') return decision.reason ? `已拒绝 · ${decision.reason}` : '已拒绝'
  if (decision.status === 'expired') return '已过期'
  return '已取消'
})

function outcomeText(outcome: ToolExecutionResult['status'] | undefined): string {
  switch (outcome) {
    case 'applied': return '已允许 · 已应用'
    case 'completed': return '已允许 · 已执行'
    case 'conflict': return '已允许 · 文档已变更，未写入'
    case 'failed': return '已允许 · 执行失败'
    case 'cancelled': return '已允许 · 已取消'
    case 'rejected': return '已允许 · 执行被拒绝'
    default: return '已允许'
  }
}

const stateClass = computed(() => props.record.decision ? `is-${props.record.decision.status}` : 'is-pending')

const canRollback = computed(() => props.record.decision?.status === 'approved'
  && props.record.outcome === 'applied'
  && snapshots.has(props.record.runId))

async function rollbackRun(): Promise<void> {
  if (rollingBack.value) return
  rollingBack.value = true
  rollbackError.value = null
  try {
    const restored = await snapshots.rollback(props.record.runId)
    if (restored === 0 && snapshots.error) rollbackError.value = snapshots.error
  } finally {
    rollingBack.value = false
  }
}

async function submit(allow: boolean, remember = false): Promise<void> {
  if (!pending.value || resolving.value || (allow && blocked.value)) return
  resolving.value = true
  try {
    const decision: ApprovalDecision = !allow
      ? { status: 'rejected' }
      : remember
        ? { status: 'approved', scope: 'session', toolName: props.record.toolName }
        : { status: 'approved', scope: 'once' }
    await store.resolveApproval(props.record.id, decision)
  } finally {
    resolving.value = false
  }
}
</script>

<template>
  <details
    class="approval"
    :class="stateClass"
    data-testid="ai-approval-card"
    :open="open"
  >
    <summary>
      <span class="approval__ico">&#9881;</span>
      <b class="approval__title">{{ record.title }}</b>
      <code class="approval__tool">{{ record.toolName }}</code>
      <span
        class="approval__state"
        data-testid="approval-state"
        aria-live="polite"
      >{{ verdict }}</span>
      <span class="chevron">&#9662;</span>
    </summary>

    <div class="approval__body">
      <div class="approval__meta">
        {{ meta }}
      </div>
      <p
        v-if="record.description"
        class="approval__desc"
      >
        {{ record.description }}
      </p>
      <p
        v-if="record.reason"
        class="approval__reason"
      >
        原因：{{ record.reason }}
      </p>

      <div class="approval__preview">
        <MarkdownDiffPreview
          v-if="preview?.type === 'markdown-diff'"
          v-bind="preview"
          :reason="record.reason"
        />
        <DocumentPreview
          v-else-if="preview?.type === 'document'"
          v-bind="preview"
        />
        <BatchApprovalPreview
          v-else-if="preview?.type === 'batch'"
          v-bind="preview"
        />
        <NetworkRequestPreview
          v-else-if="preview?.type === 'network-request'"
          v-bind="preview"
          :reason="preview.reason!"
        />
        <LocalFileReadPreview
          v-else-if="preview?.type === 'local-file-read'"
          v-bind="preview"
        />
        <p
          v-else
          data-testid="unsupported-preview"
          class="approval__unsupported"
        >
          不支持的审批预览类型。为确保安全，此操作不能被允许。
        </p>
      </div>

      <div
        v-if="canRollback"
        class="approval__acts"
      >
        <button
          type="button"
          data-testid="approval-rollback"
          class="approval__btn approval__btn--rollback"
          :disabled="rollingBack"
          @click="rollbackRun"
        >
          {{ rollingBack ? '回滚中…' : '回滚本次运行' }}
        </button>
        <span
          v-if="rollbackError"
          class="approval__hint approval__hint--error"
        >{{ rollbackError }}</span>
      </div>

      <div
        v-if="pending"
        class="approval__acts"
      >
        <button
          v-if="!blocked"
          type="button"
          data-testid="approval-allow"
          class="approval__btn approval__btn--ok"
          :disabled="resolving"
          @click="submit(true)"
        >
          {{ resolving ? '处理中…' : '允许本次' }}
        </button>
        <button
          v-if="!blocked && record.supportsRememberDecision && record.approvalTier !== 'batch'"
          type="button"
          data-testid="approval-allow-session"
          class="approval__btn"
          :disabled="resolving"
          @click="submit(true, true)"
        >
          本会话自动批准此类
        </button>
        <button
          type="button"
          data-testid="approval-reject"
          class="approval__btn"
          :disabled="resolving"
          @click="submit(false)"
        >
          拒绝
        </button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.approval {
  margin: 8px 0;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.approval.is-pending { border-left-color: #d97706; }
.approval.is-approved { border-left-color: #16a34a; }
.approval.is-rejected,
.approval.is-expired { border-left-color: #ef4444; }
.approval.is-cancelled { border-left-color: #9ca3af; }

summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
}

summary::-webkit-details-marker { display: none; }

.approval__ico { flex-shrink: 0; color: var(--color-text-tertiary); }
.approval__title { overflow: hidden; color: var(--color-text); text-overflow: ellipsis; white-space: nowrap; }
.approval__tool { flex-shrink: 0; color: var(--color-text-tertiary); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.approval__state {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--color-text-tertiary);
  font-weight: 600;
  letter-spacing: .02em;
  white-space: nowrap;
}

.approval.is-approved .approval__state { color: #16a34a; }
.approval.is-rejected .approval__state,
.approval.is-expired .approval__state { color: #ef4444; }

.chevron {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  transition: transform .15s;
}

.approval[open] .chevron { transform: rotate(180deg); }

.approval__body {
  padding: 0 12px 10px;
  border-top: 1px solid var(--color-border);
}

.approval__meta {
  padding-top: 9px;
  color: var(--color-text-tertiary);
}

.approval__desc,
.approval__reason { margin: 5px 0 0; color: var(--color-text-secondary); }
.approval__reason { color: var(--color-text-tertiary); }

.approval__preview { padding-top: 10px; }
.approval__preview > :deep(section) { font-size: inherit; }
.approval__unsupported { margin: 0; padding: 10px; border: 1px solid var(--color-error, #ef4444); border-radius: 6px; color: var(--color-error, #ef4444); }

.approval__acts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}

.approval__btn {
  padding: 4px 12px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
}

.approval__btn:hover:not(:disabled) { color: var(--color-text); }
.approval__btn--ok { border-color: var(--color-primary); color: var(--color-primary); }
.approval__btn--rollback { border-color: #d97706; color: #b45309; }
.approval__btn:disabled { cursor: not-allowed; opacity: .55; }
.approval__hint--error { color: #b91c1c; }
</style>
