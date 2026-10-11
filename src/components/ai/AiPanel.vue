<script setup lang="ts">
import { ref } from 'vue'
import { useAiStore } from '../../stores/ai'
import AiComposer from './AiComposer.vue'
import AiMessageList from './AiMessageList.vue'
import AiConversationSidebar from './AiConversationSidebar.vue'

const store = useAiStore()
const props = defineProps<{ ready: boolean }>()
const emit = defineEmits<{ openSettings: [] }>()

const composerRef = ref<InstanceType<typeof AiComposer> | null>(null)

function handleRecall(messageId: string): void {
  const content = store.recallMessage(messageId)
  if (content !== null) composerRef.value?.setText(content)
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
        <div><strong>AI 助手</strong><span :class="{ ready: props.ready }">{{ props.ready ? '配置可用' : '需要配置' }}</span></div>
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
        <AiComposer
          ref="composerRef"
          :running="store.running"
          :ready="props.ready"
          @send="store.sendMessage"
          @stop="store.cancelRun"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.ai-panel { display: flex; flex: 1; min-width: 0; min-height: 0; background: var(--color-bg-primary); color: var(--color-text); }.workbench { display: flex; width: 100%; flex: 1; min-width: 0; min-height: 0; flex-direction: column; }.panel-header { display: flex; align-items: center; justify-content: space-between; min-height: 46px; padding: 0 16px; border-bottom: 1px solid var(--color-border); }.panel-header div { display: flex; align-items: center; gap: 9px; }.panel-header strong { font-size: var(--ui-font-size); }.panel-header span { color: var(--color-text-tertiary); font-size: calc(var(--ui-font-size) - 3px); }.panel-header span.ready { color: var(--color-primary); }.panel-header button { padding: 5px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }.panel-header button:hover:not(:disabled) { background: var(--color-bg-secondary); }.panel-header button:disabled { cursor: not-allowed; opacity: .45; }.composer-wrap { padding: 8px clamp(18px, 5vw, 64px) 18px; }.error { margin: 0 18px 5px; color: var(--color-error, #ef4444); font-size: calc(var(--ui-font-size) - 1px); }
@media (max-width: 760px) { .composer-wrap { padding: 8px 12px 12px; } }
</style>
