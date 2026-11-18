<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { IconEye, IconEyeOff } from '@tabler/icons-vue'
import Tooltip from '../../common/Tooltip.vue'
import SettingsRow from '../SettingsRow.vue'
import { requestDialog } from '../../../utils/dialog'
import type {
  AiConfigInput,
  AiConfigView,
  AiConnectionTestResult
} from '../../../../shared/ai/types'

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
  maxSteps: undefined as number | undefined,
  /**
   * 表单用「人类单位」，配置里存字节 / 毫秒：
   * 读取上限按 KB 填、空闲超时按分钟填，避免让用户写 262144 这种数字。
   */
  maxReadKb: undefined as number | undefined,
  idleTimeoutMinutes: undefined as number | undefined,
  /** 完全控制：开启后不再逐次请求批准 */
  autoApprove: false
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
/** 能力探测是否通过（探针结果与当前表单一致时才算） */
const capabilityReady = ref(false)
/**
 * 保存的配置是否可用（地址 + 模型 + API Key 齐备）。
 *
 * 与 capabilityReady 分开：发送按钮只看「配置是否可用」，能力探测只是额外的验证信息，
 * 没点过「测试连接」不影响使用。
 */
const configReady = ref(false)

function input(includeEmptyKey = false): AiConfigInput {
  const value: AiConfigInput = {
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    temperature: Number(form.temperature),
    maxOutputTokens: form.maxOutputTokens,
    contextWindow: form.contextWindow,
    maxSteps: form.maxSteps,
    maxReadBytes: toBytes(form.maxReadKb, 1024),
    idleTimeoutMs: toBytes(form.idleTimeoutMinutes, 60_000),
    approvalMode: form.autoApprove ? 'auto' : 'ask'
  }
  if (form.apiKey || includeEmptyKey) value.apiKey = form.apiKey
  return value
}

function toBytes(value: number | undefined, unit: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value * unit)
}

function fromBytes(value: number | undefined, unit: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value / unit)
}

/** 把服务端视图搬进表单，顺便把字节/毫秒换算成 KB/分钟，并广播审批模式。 */
function fillForm(data: AiConfigView): void {
  form.baseUrl = data.baseUrl
  form.model = data.model
  form.temperature = data.temperature
  form.maxOutputTokens = data.maxOutputTokens
  form.contextWindow = data.contextWindow
  form.maxSteps = data.maxSteps
  form.maxReadKb = fromBytes(data.maxReadBytes, 1024)
  form.idleTimeoutMinutes = fromBytes(data.idleTimeoutMs, 60_000)
  form.autoApprove = data.approvalMode === 'auto'
  form.apiKey = ''
  broadcastApprovalMode()
}

/** 顶条徽标要看这个状态，但设置面板不归 App 管，所以走窗口事件广播。 */
function broadcastApprovalMode(): void {
  window.dispatchEvent(
    new CustomEvent('ai:approval-mode', { detail: form.autoApprove ? 'auto' : 'ask' })
  )
}

/**
 * 切换「完全控制」。
 *
 * 这是把「每次都要我点允许」换成「不再问」，代价是不可逆操作也会被自动放行，
 * 所以只在开启方向要一次明确确认；关闭随时可以。
 */
async function toggleAutoApprove(next: boolean): Promise<void> {
  if (!next) {
    form.autoApprove = false
    broadcastApprovalMode()
    return
  }
  const choice = await requestDialog({
    title: '开启完全控制',
    message: '开启后 AI 将自动执行所有操作，不再逐次请求批准。',
    detail: '包括写入文档、移动/删除文件等不可恢复的操作。会话里仍会留下「自动执行」记录，但不会再给你拦截的机会。',
    buttons: [
      { label: '取消', value: 1 },
      { label: '开启', value: 0, primary: true }
    ]
  })
  form.autoApprove = choice === 0
  broadcastApprovalMode()
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
      fillForm(result.data)
      hasApiKey.value = result.data.hasApiKey
      persistedFingerprint.value = configFingerprint(input())
      capabilities.value = result.data.capabilities ?? null
      capabilityFingerprint.value = capabilities.value ? configFingerprint(input()) : null
      applyReadiness(result.data)
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
      applyReadiness(result.data)
      setMessage('设置已保存', 'ok')
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

/**
 * 就绪状态：配置齐备即可用，能力探测只是附加信息。
 *
 * 先把「保存的配置是否完整」记为 configReady，再单独记录探测是否通过；
 * 发给外部的 readiness 用前者，避免没点过「测试连接」就发不出消息。
 */
function applyReadiness(data: AiConfigView): void {
  configReady.value = data.ready === true
  capabilityReady.value = !!(data.capabilities?.textGeneration && data.capabilities.toolCalling)
  emit('readiness', configReady.value)
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
      // 探测通过可以证明配置可用；探测失败或表单未保存则回落到已保存配置的判定
      emit('readiness', capabilityReady.value || configReady.value)
    } else {
      setMessage(result.error || '连接测试失败', 'error')
      emit('readiness', configReady.value)
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '连接测试失败', 'error')
    emit('readiness', configReady.value)
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
    form.maxSteps,
    form.maxReadKb,
    form.idleTimeoutMinutes,
    form.autoApprove
  ],
  () => {
    if (capabilityFingerprint.value === configFingerprint(input())) return
    capabilities.value = null
    capabilityFingerprint.value = null
    capabilityReady.value = false
    // 保存的配置没变，发送按钮不该因为表单里改了字而失效
    emit('readiness', configReady.value)
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
    >
      <input
        v-model.number="form.maxOutputTokens"
        class="settings-number"
        type="number"
        min="1"
      >
      <span class="settings-unit">tokens</span>
    </SettingsRow>

    <SettingsRow
      title="上下文窗口"
      desc="模型可接受的上下文长度，用于裁剪历史消息"
    >
      <input
        v-model.number="form.contextWindow"
        class="settings-number"
        data-testid="ai-context-window"
        type="number"
        min="1"
      >
      <span class="settings-unit">tokens</span>
    </SettingsRow>

    <SettingsRow
      title="最大工具步骤"
      desc="一次提问里最多连续调用工具的次数，整理目录这类任务建议调高"
    >
      <input
        v-model.number="form.maxSteps"
        class="settings-number"
        type="number"
        min="1"
        max="200"
        placeholder="默认 50"
      >
      <span class="settings-unit">次</span>
    </SettingsRow>

    <SettingsRow
      title="单次读取上限"
      desc="一次 read_workspace_file 最多返回的正文大小，超出部分模型会用 offset 续读"
    >
      <input
        v-model.number="form.maxReadKb"
        class="settings-number"
        data-testid="ai-max-read-kb"
        type="number"
        min="4"
        max="4096"
        step="1"
        placeholder="默认 256"
      >
      <span class="settings-unit">KB</span>
    </SettingsRow>

    <SettingsRow
      title="空闲超时"
      desc="模型既没输出、也没有工具在跑的时间上限；工具执行与审批等待不计入"
    >
      <input
        v-model.number="form.idleTimeoutMinutes"
        class="settings-number"
        data-testid="ai-idle-timeout"
        type="number"
        min="1"
        max="60"
        step="1"
        placeholder="默认 10"
      >
      <span class="settings-unit">分钟</span>
    </SettingsRow>

    <SettingsRow
      title="完全控制"
      desc="开启后 AI 自动执行写入、移动、删除等操作，不再逐次请求批准；会话里仍会留档"
    >
      <label class="ai-toggle">
        <input
          data-testid="ai-auto-approve"
          type="checkbox"
          :checked="form.autoApprove"
          @change="toggleAutoApprove(($event.target as HTMLInputElement).checked)"
        >
        <span>{{ form.autoApprove ? '已开启' : '关闭' }}</span>
      </label>
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
      <strong data-testid="config-readiness">{{ capabilityReady ? '配置可用 · 能力验证通过' : configReady ? '配置可用 · 能力未验证' : '尚未就绪' }}</strong>
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

.ai-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--color-text);
  font-size: var(--ui-font-size);
  cursor: pointer;
}
</style>
