<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useAiStore } from '../../stores/ai'
import AiComposer from './AiComposer.vue'
import AiMessageList from './AiMessageList.vue'
import AiConversationSidebar from './AiConversationSidebar.vue'
import {
  DEFAULT_AI_PERMISSION_MODE,
  normalizeAiPermissionMode,
  type AiPermissionMode
} from '../../../shared/ai/permission'

const store = useAiStore()
const props = defineProps<{ ready: boolean }>()
const emit = defineEmits<{ openSettings: [] }>()

const composerRef = ref<InstanceType<typeof AiComposer> | null>(null)

function handleRecall(messageId: string): void {
  const content = store.recallMessage(messageId)
  if (content !== null) composerRef.value?.setText(content)
}

// ===== 权限模式（只读 / 标准 / 完全控制） =====
/**
 * 真相在主进程的配置里（`ai-config.json`），这里只做展示与切换。
 *
 * 控件本身住在输入框内部（`AiComposer`）而不是设置中心：这是「这一次怎么干」的
 * 运行期许可，跟消息一起使用，来回切设置面板才能改太绕；参考 opencode 等工具的做法。
 * 名称与完整解释都不写在外面——平时只是一枚小胶囊，解释交给 tooltip。
 */
const permissionMode = ref<AiPermissionMode>(DEFAULT_AI_PERMISSION_MODE)
const permissionSaving = ref(false)
const permissionError = ref('')

// ===== 模型 =====
/**
 * 当前模型与可选目录都来自同一份配置：`model` 是运行期真相，`models` 只是
 * 设置页「获取模型」勾出来的候选目录。切换只改 `model`，不重建 runtime——
 * 主进程在下一次 `AI.RUN.START` 时自己发现配置变了。
 */
const model = ref('')
const models = ref<string[]>([])
const modelSaving = ref(false)
const modelError = ref('')

onMounted(() => {
  void loadConfig()
  // 设置页保存后会广播一次：新勾选的模型要立刻出现在下拉里
  window.addEventListener('ai:config-changed', loadConfig)
})

onBeforeUnmount(() => {
  window.removeEventListener('ai:config-changed', loadConfig)
})

async function loadConfig(): Promise<void> {
  try {
    const result = await window.electronAPI?.getAiConfig?.()
    if (result?.success && result.data) {
      permissionMode.value = normalizeAiPermissionMode(result.data.permissionMode)
      model.value = result.data.model ?? ''
      models.value = result.data.models ?? []
    }
  } catch {
    // 读不到配置就按默认值显示；用户切换时会再写一次
  }
}

async function changePermissionMode(next: AiPermissionMode): Promise<void> {
  const previous = permissionMode.value
  if (next === previous) return

  // 先乐观更新：下拉要立刻反映用户的选择，失败再退回去
  permissionMode.value = next
  permissionSaving.value = true
  permissionError.value = ''
  try {
    const result = await window.electronAPI?.setAiPermissionMode?.(next)
    if (!result?.success) {
      permissionMode.value = previous
      permissionError.value = result?.error || '切换权限模式失败'
      return
    }
    if (result.data) {
      permissionMode.value = normalizeAiPermissionMode(result.data.permissionMode)
    }
  } catch (error) {
    permissionMode.value = previous
    permissionError.value = error instanceof Error ? error.message : '切换权限模式失败'
  } finally {
    permissionSaving.value = false
  }
}

async function changeModel(next: string): Promise<void> {
  const previous = model.value
  if (!next || next === previous) return

  model.value = next
  modelSaving.value = true
  modelError.value = ''
  try {
    const result = await window.electronAPI?.setAiModel?.(next)
    if (!result?.success) {
      model.value = previous
      modelError.value = result?.error || '切换模型失败'
      return
    }
    if (result.data) {
      model.value = result.data.model
      models.value = result.data.models ?? models.value
    }
  } catch (error) {
    model.value = previous
    modelError.value = error instanceof Error ? error.message : '切换模型失败'
  } finally {
    modelSaving.value = false
  }
}
</script>

<template>
  <section
    class="ai-panel"
    aria-label="AI 助手"
  >
    <AiConversationSidebar />
    <div class="workbench">
      <header class="panel-header">
        <div>
          <strong>AI 助手</strong>
          <span :class="{ ready: props.ready }">{{ props.ready ? '配置可用' : '需要配置' }}</span>
        </div>
        <div>
          <button
            type="button"
            data-testid="ai-settings"
            @click="emit('openSettings')"
          >
            设置
          </button>
        </div>
      </header>
      <AiMessageList
        :messages="store.messages"
        :tool-calls="store.toolCalls"
        :approvals="store.approvalHistory"
        :running="store.running"
        @recall="handleRecall"
      />
      <p
        v-if="store.error"
        class="error"
        role="alert"
      >
        {{ store.error }}
      </p>
      <div class="composer-wrap">
        <!-- 权限模式与模型都是输入框的一部分（住在输入框底栏），不是另起一条控件栏 -->
        <AiComposer
          ref="composerRef"
          :running="store.running"
          :ready="props.ready"
          :permission-mode="permissionMode"
          :permission-saving="permissionSaving"
          :model="model"
          :models="models"
          :model-saving="modelSaving"
          @send="store.sendMessage"
          @stop="store.cancelRun"
          @permission-change="changePermissionMode"
          @model-change="changeModel"
        />
        <p
          v-if="permissionError || modelError"
          class="composer-error"
          role="alert"
        >
          {{ permissionError || modelError }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ai-panel { display: flex; flex: 1; min-width: 0; min-height: 0; background: var(--color-bg-primary); color: var(--color-text); }.workbench { display: flex; width: 100%; flex: 1; min-width: 0; min-height: 0; flex-direction: column; }.panel-header { display: flex; align-items: center; justify-content: space-between; min-height: 46px; padding: 0 16px; border-bottom: 1px solid var(--color-border); }.panel-header div { display: flex; align-items: center; gap: 9px; }.panel-header strong { font-size: var(--ui-font-size); }.panel-header span { color: var(--color-text-tertiary); font-size: calc(var(--ui-font-size) - 3px); }.panel-header span.ready { color: var(--color-primary); }.panel-header button { padding: 5px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }.panel-header button:hover:not(:disabled) { background: var(--color-bg-secondary); }.panel-header button:disabled { cursor: not-allowed; opacity: .45; }.composer-wrap { padding: 8px clamp(18px, 5vw, 64px) 18px; }.error { max-width: 780px; margin: 0 auto 5px; padding: 0 clamp(18px, 5vw, 64px); color: var(--color-error, #ef4444); font-size: calc(var(--ui-font-size) - 1px); }

/* 权限 / 模型切换失败的提示留在输入框外：控件本身太小，塞不进错误信息 */
.composer-error { max-width: 780px; margin: 6px auto 0; padding: 0 4px; color: var(--color-error, #ef4444); font-size: calc(var(--ui-font-size) - 2px); }
@media (max-width: 760px) { .composer-wrap { padding: 8px 12px 12px; } }
</style>
