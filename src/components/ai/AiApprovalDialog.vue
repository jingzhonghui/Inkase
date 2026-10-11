<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApprovalPreview } from '../../../shared/ai/types'
import { useAiStore } from '../../stores/ai'
import MarkdownDiffPreview from './approval/MarkdownDiffPreview.vue'
import DocumentPreview from './approval/DocumentPreview.vue'
import NetworkRequestPreview from './approval/NetworkRequestPreview.vue'
import LocalFileReadPreview from './approval/LocalFileReadPreview.vue'

type PreviewType = ApprovalPreview['type'] | 'unsupported'

const store = useAiStore()
const resolving = ref(false)
const approval = computed(() => store.pendingApprovals[0])

function validPreview(preview: unknown): ApprovalPreview | null {
  if (!preview || typeof preview !== 'object') return null
  const value = preview as Record<string, unknown>
  if (value.type === 'markdown-diff'
    && typeof value.title === 'string'
    && typeof value.before === 'string'
    && typeof value.after === 'string') return preview as ApprovalPreview
  if (value.type === 'document'
    && typeof value.title === 'string'
    && typeof value.content === 'string') return preview as ApprovalPreview
  if (value.type === 'network-request'
    && typeof value.method === 'string'
    && typeof value.url === 'string'
    && typeof value.reason === 'string'
    && (value.bodySummary === undefined || typeof value.bodySummary === 'string')) return preview as ApprovalPreview
  if (value.type === 'local-file-read'
    && typeof value.requestedPath === 'string'
    && typeof value.normalizedPath === 'string'
    && (value.fileType === 'pdf' || value.fileType === 'markdown' || value.fileType === 'mdx' || value.fileType === 'text')
    && (value.size === undefined || (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0))
    && typeof value.reason === 'string') return preview as ApprovalPreview
  return null
}

function previewType(preview: ApprovalPreview | null): PreviewType {
  if (!preview) return 'unsupported'
  switch (preview.type) {
    case 'markdown-diff': return 'markdown-diff'
    case 'document': return 'document'
    case 'network-request': return 'network-request'
    case 'local-file-read': return 'local-file-read'
    default: {
      const exhaustive: never = preview
      void exhaustive
      return 'unsupported'
    }
  }
}

const activePreview = computed(() => validPreview(approval.value?.preview))
const activePreviewType = computed(() => approval.value ? previewType(activePreview.value) : undefined)

async function submit(allow: boolean): Promise<void> {
  if (!approval.value || resolving.value || (allow && activePreviewType.value === 'unsupported')) return
  resolving.value = true
  try {
    await store.resolveApproval(
      approval.value.id,
      allow ? { status: 'approved', scope: 'once' } : { status: 'rejected' }
    )
  } finally {
    resolving.value = false
  }
}
</script>

<template>
  <div
    v-if="approval"
    class="backdrop"
    role="presentation"
  >
    <section
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
    >
      <header>
        <div>
          <h2 id="approval-title">
            {{ approval.title }}
          </h2>
          <p>{{ approval.description }}</p>
        </div>
        <span class="risk">{{ approval.riskLevel }}</span>
      </header>

      <MarkdownDiffPreview
        v-if="activePreview?.type === 'markdown-diff'"
        v-bind="activePreview"
        :reason="approval.reason"
      />
      <DocumentPreview
        v-else-if="activePreview?.type === 'document'"
        v-bind="activePreview"
      />
      <NetworkRequestPreview
        v-else-if="activePreview?.type === 'network-request'"
        v-bind="activePreview"
        :reason="activePreview.reason!"
      />
      <LocalFileReadPreview
        v-else-if="activePreview?.type === 'local-file-read'"
        v-bind="activePreview"
      />
      <p
        v-else
        data-testid="unsupported-preview"
        class="unsupported"
      >
        不支持的审批预览类型。为确保安全，此操作不能被允许。
      </p>

      <footer>
        <button
          data-testid="approval-reject"
          :disabled="resolving"
          @click="submit(false)"
        >
          拒绝
        </button>
        <button
          v-if="activePreviewType !== 'unsupported'"
          data-testid="approval-allow"
          class="primary"
          :disabled="resolving"
          @click="submit(true)"
        >
          {{ resolving ? '处理中…' : '允许本次' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; z-index: 10000; inset: 0; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / 48%); }
.dialog { width: min(680px, 100%); max-height: calc(100vh - 48px); overflow: auto; padding: 20px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg); box-shadow: 0 20px 50px rgb(0 0 0 / 30%); }
header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h2 { margin: 0; font-size: calc(var(--ui-font-size) + 5px); }
header p { margin: 5px 0 0; color: var(--color-text-secondary); }
.risk { align-self: start; padding: 3px 7px; border-radius: 4px; background: var(--color-bg-secondary); text-transform: uppercase; }
.unsupported { padding: 12px; border: 1px solid var(--color-error, #ef4444); border-radius: 6px; color: var(--color-error, #ef4444); }
footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
button { padding: 7px 14px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-bg-secondary); color: inherit; cursor: pointer; }
button.primary { border-color: var(--color-primary); background: var(--color-primary); color: white; }
button:disabled { cursor: not-allowed; opacity: .55; }
</style>
