<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { IconEye, IconEyeOff } from '@tabler/icons-vue'
import Tooltip from '../../common/Tooltip.vue'
import SettingsRow from '../SettingsRow.vue'
import type { AiConfigInput, AiConnectionTestResult } from '../../../../shared/ai/types'

/**
 * AI 助手：Provider 连接参数。
 *
 * 这一节原先是一个独立对话框（`AiSettingsDialog`），从 AI 面板的「设置」按钮
 * 弹出。挪进设置中心是为了只有一处「设置」入口——用户不该在两个地方找同一组配置。
 *
 * 三条从旧对话框原样带过来的规则，改之前先想清楚：
 * 1. **API Key 不回显**：主进程只回 `hasApiKey`，输入框恒为空，提交时留空就
 *    不带 `apiKey` 字段，后端据此保留已存的那把 Key。
 * 2. **能力探测要防竞态**：探测是异步的，回来时如果表单已经被改过，结果作废
 *    （用指纹比对），否则会出现「测的是 A、显示在 B 上」。
 * 3. **只有「探测通过 + 表单与已存配置一致」才算就绪**：测成功不等于能直接用，
 *    没点保存的话主进程里还是旧配置。
 *
 * 与设置中心其他节的差别：本节的落盘走主进程异步 IPC，可能失败，所以
 * `save()` 返回 `boolean`，失败时由 `SettingsDialog` 把焦点留在本节并显示原因。
 */
const emit = defineEmits<{ readiness: [ready: boolean]; submit: [] }>()

const form = reactive({
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.3,
  maxOutputTokens: undefined as number | undefined,
  contextWindow: undefined as number | undefined,
  maxSteps: undefined as number | undefined
})
const hasApiKey = ref(false)
/** API Key 是否明文显示（小眼睛切换） */
const showApiKey = ref(false)
const loading = ref(false)
const message = ref('')
const messageTone = ref<'ok' | 'error'>('ok')
const capabilities = ref<AiConnectionTestResult | null>(null)
const capabilityFingerprint = ref<string | null>(null)
const persistedFingerprint = ref<string | null>(null)
const capabilityReady = ref(false)

function input(includeEmptyKey = false): AiConfigInput {
  const value: AiConfigInput = {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    temperature: Number(form.temperature),
    maxOutputTokens: form.maxOutputTokens,
    contextWindow: form.contextWindow,
    maxSteps: form.maxSteps
  }
  if (form.apiKey || includeEmptyKey) value.apiKey = form.apiKey
  return value
}

function configFingerprint(value: AiConfigInput): string {
  return JSON.stringify(value)
}

function setMessage(text: string, tone: 'ok' | 'error'): void {
  message.value = text
  messageTone.value = tone
}

async function load(): Promise<void> {
  loading.value = true
  message.value = ''
  capabilities.value = null
  try {
    const result = await window.electronAPI.getAiConfig()
    if (result.success && result.data) {
      Object.assign(form, result.data, { apiKey: '' })
      hasApiKey.value = result.data.hasApiKey
      persistedFingerprint.value = configFingerprint(input())
      capabilities.value = result.data.capabilities ?? null
      capabilityFingerprint.value = capabilities.value ? configFingerprint(input()) : null
      capabilityReady.value = result.data.ready === true
      emit('readiness', result.data.ready === true)
    } else setMessage(result.error || '加载配置失败', 'error')
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '加载配置失败', 'error')
  } finally {
    loading.value = false
  }
}

/**
 * 落盘。由设置中心的「保存」调用，也可由本节表单的回车触发。
 *
 * @returns 是否成功。失败时本节自己已把原因写进 `message`。
 */
async function save(): Promise<boolean> {
  loading.value = true
  message.value = ''
  try {
    const result = await window.electronAPI.setAiConfig(input())
    if (result.success && result.data) {
      hasApiKey.value = result.data.hasApiKey
      form.apiKey = ''
      persistedFingerprint.value = configFingerprint(input())
      capabilities.value = result.data.capabilities ?? null
      capabilityFingerprint.value = capabilities.value ? configFingerprint(input()) : null
      capabilityReady.value = result.data.ready === true
      setMessage('设置已保存', 'ok')
      emit('readiness', result.data.ready === true)
      return true
    }
    setMessage(result.error || '保存失败', 'error')
    return false
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '保存失败', 'error')
    return false
  } finally {
    loading.value = false
  }
}

async function test(): Promise<void> {
  loading.value = true
  message.value = ''
  capabilities.value = null
  const testedInput = input()
  const testedFingerprint = configFingerprint(testedInput)
  try {
    const result = await window.electronAPI.testAiConfig(testedInput)
    // 探测期间表单又变了：这次结果对应的不是眼前这份配置，丢掉
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
    } else {
      setMessage(result.error || '连接测试失败', 'error')
      emit('readiness', false)
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '连接测试失败', 'error')
    emit('readiness', false)
  } finally {
    loading.value = false
  }
}

/**
 * 回车不该只存这一节。
 *
 * 用户在设置中心里按回车，期望的是「保存整个面板」——只把 AI 配置写掉、
 * 面板还开着且不提示，是最容易让人以为没保存成功的那种。所以这里只发信号，
 * 由 `SettingsDialog` 决定怎么处理（它会把本地草稿一起落盘并关闭）。
 */
function onSubmit(): void {
  emit('submit')
}

watch(
  () => [
    form.baseUrl,
    form.model,
    form.apiKey,
    form.temperature,
    form.maxOutputTokens,
    form.contextWindow,
    form.maxSteps
  ],
  () => {
    if (capabilityFingerprint.value === configFingerprint(input())) return
    capabilities.value = null
    capabilityFingerprint.value = null
    capabilityReady.value = false
    emit('readiness', false)
  }
)

onMounted(() => {
  void load()
})

/** 只有落盘需要外壳代劳：探测是本节自己的按钮 */
defineExpose({ save })
</script>

<template>
  <form
    data-testid="ai-settings-form"
    @submit.prevent="onSubmit"
  >
    <SettingsRow
      title="API 地址"
      desc="兼容 OpenAI 接口的服务地址，通常以 /v1 结尾"
    >
      <input
        v-model="form.baseUrl"
        class="ai-input"
        type="url"
        required
        placeholder="https://api.example.com/v1"
      >
    </SettingsRow>

    <SettingsRow
      title="模型"
      desc="由 Provider 提供的模型标识"
    >
      <input
        v-model="form.model"
        class="ai-input"
        data-testid="ai-model"
        type="text"
        required
        placeholder="模型名称"
      >
    </SettingsRow>

    <SettingsRow
      title="API Key"
      :desc="hasApiKey ? '已保存 Key，留空则保持不变' : '仅保存在本机，不会上传'"
    >
      <span class="key-field">
        <input
          v-model="form.apiKey"
          class="ai-input"
          data-testid="ai-api-key"
          :type="showApiKey ? 'text' : 'password'"
          autocomplete="new-password"
          :placeholder="hasApiKey ? '留空以保留现有 Key' : '输入 API Key'"
        >
        <span class="key-field-toggle">
          <Tooltip :content="showApiKey ? '隐藏密钥' : '显示密钥'">
            <button
              type="button"
              class="key-field-btn"
              data-testid="ai-api-key-toggle"
              :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'"
              :aria-pressed="showApiKey"
              @click="showApiKey = !showApiKey"
            >
              <IconEyeOff
                v-if="showApiKey"
                :size="14"
              />
              <IconEye
                v-else
                :size="14"
              />
            </button>
          </Tooltip>
        </span>
      </span>
    </SettingsRow>

    <SettingsRow
      title="温度"
      desc="0 更稳定、2 更发散"
      layout="inline"
    >
      <input
        v-model.number="form.temperature"
        class="settings-number"
        type="number"
        min="0"
        max="2"
        step="0.1"
      >
    </SettingsRow>

    <SettingsRow
      title="最大输出"
      desc="单次回复的 token 上限，留空由 Provider 决定"
      layout="inline"
    >
      <input
        v-model.number="form.maxOutputTokens"
        class="settings-number"
        type="number"
        min="1"
      >
    </SettingsRow>

    <SettingsRow
      title="上下文窗口"
      desc="模型可接受的上下文长度，用于裁剪历史消息"
      layout="inline"
    >
      <input
        v-model.number="form.contextWindow"
        class="settings-number"
        data-testid="ai-context-window"
        type="number"
        min="1"
      >
    </SettingsRow>

    <SettingsRow
      title="最大工具步骤"
      desc="一次提问里最多连续调用工具的次数"
      layout="inline"
    >
      <input
        v-model.number="form.maxSteps"
        class="settings-number"
        type="number"
        min="1"
        max="100"
        placeholder="默认 20"
      >
    </SettingsRow>

    <p class="ai-privacy">
      隐私说明：每条用户消息都会发送给你配置的第三方 Provider，无需源读取审批。
      网页或本地文件的源正文需要逐次一次性批准，并由主进程授权读取；
      读取出的正文会作为工具结果发送给该 Provider。
    </p>

    <div class="ai-actions">
      <button
        type="button"
        class="secondary"
        data-testid="ai-test-config"
        :disabled="loading"
        @click="test"
      >
        测试连接
      </button>
      <span class="ai-actions__hint">探测文本生成与工具调用能力，不会保存</span>
    </div>

    <div
      v-if="capabilities"
      class="ai-capabilities"
    >
      <span data-testid="text-capability">文本生成：{{ capabilities.textGeneration ? '通过' : '不支持' }}</span>
      <span data-testid="tools-capability">工具调用：{{ capabilities.toolCalling ? '通过' : '不支持' }}</span>
      <strong data-testid="config-readiness">{{ capabilityReady ? '配置已就绪' : '尚未就绪' }}</strong>
    </div>

    <p
      v-if="message"
      class="ai-message"
      :class="messageTone"
      role="status"
    >
      {{ message }}
    </p>
  </form>
</template>

<style scoped>
.ai-input {
  width: 100%;
  padding: 6px 9px;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--ui-font-size);
  font-family: inherit;
  outline: none;
}

.ai-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-light);
}

/* Key 输入框右侧留出小眼睛的位置 */
.key-field {
  position: relative;
  display: block;
  width: 100%;
}

.key-field .ai-input {
  padding-right: 32px;
}

.key-field-toggle {
  position: absolute;
  top: 50%;
  right: 5px;
  display: flex;
  transform: translateY(-50%);
}

.key-field-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.key-field-btn:hover {
  color: var(--color-text);
}

.ai-privacy {
  margin: 14px 0 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.6;
}

.ai-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.ai-actions button {
  padding: 6px 13px;
  color: var(--color-text);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.ai-actions button:hover:not(:disabled) {
  filter: brightness(1.05);
}

.ai-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ai-actions__hint {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.ai-capabilities {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
  margin-top: 12px;
  padding: 10px 12px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: calc(var(--ui-font-size) - 1px);
}

.ai-capabilities strong {
  grid-column: 1 / -1;
  color: var(--color-primary);
  font-size: var(--ui-font-size);
}

.ai-message {
  margin: 10px 0 0;
  font-size: calc(var(--ui-font-size) - 1px);
}

.ai-message.error {
  color: var(--color-error, #ef4444);
}

.ai-message.ok {
  color: var(--color-primary);
}
</style>
