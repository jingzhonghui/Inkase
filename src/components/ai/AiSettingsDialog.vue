<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { IconX } from '@tabler/icons-vue'
import type { AiConfigInput, AiConnectionTestResult } from '../../../shared/ai/types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; readiness: [ready: boolean] }>()
const form = reactive({ baseUrl: '', model: '', apiKey: '', temperature: 0.3, maxOutputTokens: undefined as number | undefined, contextWindow: undefined as number | undefined, maxSteps: undefined as number | undefined })
const hasApiKey = ref(false)
const loading = ref(false)
const message = ref('')
const capabilities = ref<AiConnectionTestResult | null>(null)
const capabilityFingerprint = ref<string | null>(null)
const persistedFingerprint = ref<string | null>(null)
const capabilityReady = ref(false)

function input(includeEmptyKey = false): AiConfigInput {
  const value: AiConfigInput = { baseUrl: form.baseUrl.trim(), model: form.model.trim(), temperature: Number(form.temperature), maxOutputTokens: form.maxOutputTokens, contextWindow: form.contextWindow, maxSteps: form.maxSteps }
  if (form.apiKey || includeEmptyKey) value.apiKey = form.apiKey
  return value
}

function configFingerprint(value: AiConfigInput): string {
  return JSON.stringify(value)
}

async function load(): Promise<void> {
  loading.value = true; message.value = ''; capabilities.value = null
  try {
    const result = await window.electronAPI.getAiConfig()
    if (result.success && result.data) {
      Object.assign(form, result.data, { apiKey: '' }); hasApiKey.value = result.data.hasApiKey
      persistedFingerprint.value = configFingerprint(input())
      capabilities.value = result.data.capabilities ?? null
      capabilityFingerprint.value = capabilities.value ? configFingerprint(input()) : null
      capabilityReady.value = result.data.ready === true
      emit('readiness', result.data.ready === true)
    } else message.value = result.error || '加载配置失败'
  } catch (error) { message.value = error instanceof Error ? error.message : '加载配置失败' }
  finally { loading.value = false }
}

async function save(): Promise<void> {
  loading.value = true; message.value = ''
  const savedInput = input()
  try {
    const result = await window.electronAPI.setAiConfig(savedInput)
    if (result.success && result.data) {
      hasApiKey.value = result.data.hasApiKey
      form.apiKey = ''
      persistedFingerprint.value = configFingerprint(input())
      capabilities.value = result.data.capabilities ?? null
      capabilityFingerprint.value = capabilities.value ? configFingerprint(input()) : null
      capabilityReady.value = result.data.ready === true
      message.value = '设置已保存'
      emit('readiness', result.data.ready === true)
    }
    else message.value = result.error || '保存失败'
  } catch (error) { message.value = error instanceof Error ? error.message : '保存失败' }
  finally { loading.value = false }
}

async function test(): Promise<void> {
  loading.value = true; message.value = ''; capabilities.value = null
  const testedInput = input()
  const testedFingerprint = configFingerprint(testedInput)
  try {
    const result = await window.electronAPI.testAiConfig(testedInput)
    if (configFingerprint(input()) !== testedFingerprint) return
    if (result.success && result.data) {
      capabilities.value = result.data
      capabilityFingerprint.value = testedFingerprint
      capabilityReady.value = (
        testedFingerprint === persistedFingerprint.value &&
        result.data.textGeneration &&
        result.data.toolCalling
      )
      emit('readiness', capabilityReady.value)
    }
    else { message.value = result.error || '连接测试失败'; emit('readiness', false) }
  } catch (error) { message.value = error instanceof Error ? error.message : '连接测试失败'; emit('readiness', false) }
  finally { loading.value = false }
}

watch(() => props.open, (open) => { if (open) void load() }, { immediate: true })
watch(
  () => [form.baseUrl, form.model, form.apiKey, form.temperature, form.maxOutputTokens, form.contextWindow, form.maxSteps],
  () => {
    if (capabilityFingerprint.value === configFingerprint(input())) return
    capabilities.value = null
    capabilityFingerprint.value = null
    capabilityReady.value = false
    emit('readiness', false)
  }
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="backdrop"
    >
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
      >
        <header>
          <div>
            <small>Provider</small><h2 id="ai-settings-title">
              AI 设置
            </h2>
          </div><button
            type="button"
            aria-label="关闭设置"
            @click="emit('close')"
          >
            <IconX :size="18" />
          </button>
        </header>
        <form
          data-testid="ai-settings-form"
          @submit.prevent="save"
        >
          <label>API 地址<input
            v-model="form.baseUrl"
            type="url"
            required
          ></label>
          <label>模型<input
            v-model="form.model"
            data-testid="ai-model"
            required
          ></label>
          <label>API Key <span
            v-if="hasApiKey"
            class="saved"
          >已保存 Key</span><input
            v-model="form.apiKey"
            data-testid="ai-api-key"
            type="password"
            autocomplete="new-password"
            :placeholder="hasApiKey ? '留空以保留现有 Key' : '输入 API Key'"
          ></label>
          <div class="grid">
            <label>温度<input
              v-model.number="form.temperature"
              type="number"
              min="0"
              max="2"
              step="0.1"
            ></label><label>最大输出<input
              v-model.number="form.maxOutputTokens"
              type="number"
              min="1"
            ></label>
          </div>
          <div class="grid">
            <label>最大工具步骤<input
              v-model.number="form.maxSteps"
              type="number"
              min="1"
              max="100"
              placeholder="默认 20"
            ></label><label>上下文窗口<input
              v-model.number="form.contextWindow"
              data-testid="ai-context-window"
              type="number"
              min="1"
            ></label>
          </div>
          <p class="privacy">
            隐私说明：每条用户消息都会发送给你配置的第三方 Provider，无需源读取审批。网页或本地文件的源正文需要逐次一次性批准，并由主进程授权读取；读取出的正文会作为工具结果发送给该 Provider。
          </p>
          <div
            v-if="capabilities"
            class="capabilities"
          >
            <span data-testid="text-capability">文本生成：{{ capabilities.textGeneration ? '通过' : '不支持' }}</span>
            <span data-testid="tools-capability">工具调用：{{ capabilities.toolCalling ? '通过' : '不支持' }}</span>
            <strong data-testid="config-readiness">{{ capabilityReady ? '配置已就绪' : '尚未就绪' }}</strong>
          </div>
          <p
            v-if="message"
            class="message"
          >
            {{ message }}
          </p>
          <footer>
            <button
              type="button"
              data-testid="ai-test-config"
              :disabled="loading"
              @click="test"
            >
              测试能力
            </button><button
              type="submit"
              class="primary"
              :disabled="loading"
            >
              保存
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop { position: fixed; z-index: 1000; inset: 0; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 42%); }
.dialog { width: min(560px, 100%); max-height: calc(100vh - 40px); overflow: auto; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-primary); color: var(--color-text); box-shadow: 0 20px 60px rgb(0 0 0 / 28%); }
header { display: flex; justify-content: space-between; padding: 14px 20px 10px; border-bottom: 1px solid var(--color-border); } h2 { margin: 2px 0 0; font-size: calc(var(--ui-font-size) + 5px); } header small { color: var(--color-primary); font-size: calc(var(--ui-font-size) - 3px); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; } header button { border: 0; background: transparent; color: var(--color-text-secondary); font-size: calc(var(--ui-font-size) + 11px); cursor: pointer; }
form { display: grid; gap: 9px; padding: 14px 20px 16px; } label { display: grid; gap: 4px; font-size: calc(var(--ui-font-size) - 1px); font-weight: 600; } input, textarea { padding: 7px 9px; border: 1px solid var(--color-border); border-radius: 5px; outline: none; background: var(--color-bg-secondary); color: var(--color-text); font: inherit; } input:focus,textarea:focus { border-color: var(--color-primary); box-shadow: 0 0 0 2px var(--color-primary-light); }.saved { float: right; color: var(--color-primary); font-weight: 500; }.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.privacy,.message { margin: 0; color: var(--color-text); font-size: calc(var(--ui-font-size) - 1px); line-height: 1.6; }.privacy { opacity: .85; }.capabilities { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px; border: 1px solid var(--color-border); border-radius: 6px; font-size: calc(var(--ui-font-size) - 1px); color: var(--color-text); }.capabilities strong { grid-column: 1 / -1; color: var(--color-primary); font-size: var(--ui-font-size); } footer { display: flex; justify-content: flex-end; gap: 8px; } footer button { padding: 8px 14px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-bg-secondary); color: var(--color-text); cursor: pointer; }.primary { border-color: var(--color-primary); background: var(--color-primary); color: white; }
</style>
