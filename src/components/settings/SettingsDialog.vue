<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  IconAdjustmentsHorizontal,
  IconKeyboard,
  IconPalette,
  IconPhoto,
  IconRobot,
  IconTypography,
  type Icon
} from '@tabler/icons-vue'
import type { ThemeType } from '../../stores/theme'
import { useAppearanceStore } from '../../stores/appearance'
import { useFileStore } from '../../stores/file'
import { useThemeStore } from '../../stores/theme'
import { applyOverrides, getOverrides } from '../../shortcuts/overrides'
import AppearanceSection from './sections/AppearanceSection.vue'
import AiSection from './sections/AiSection.vue'
import EditorSection from './sections/EditorSection.vue'
import FilesSection from './sections/FilesSection.vue'
import GeneralSection from './sections/GeneralSection.vue'
import ShortcutsSection from './sections/ShortcutsSection.vue'
import type { SettingsSectionId } from './types'
import './settings-controls.css'

/**
 * 设置中心。
 *
 * 版式照大多数桌面应用：左边是分组目录，右边是当前分组的内容，页脚固定贴底。
 * 目录只画「分组」不画子项——设置项本身已经是完整的一句话，再缩进一层反而难扫。
 *
 * 三条与状态有关的规则（重构前是混着的，现在是明确的一条）：
 * 1. **暂存**：除主题外，所有改动只写进本地草稿，点「保存」才落到 store；
 *    取消 / Esc / 点遮罩 = 丢掉草稿，不弹二次确认（设置项代价低）。
 * 2. **主题即时预览**：切换立刻生效，取消时回滚到打开设置时的那一档。
 *    否则用户会以为「主题没保存成功」——这是旧实现里最容易误解的地方。
 * 3. **Esc 归这里管**：外壳自己监听 Esc，AppHeader 的全局 Esc 不再代为关闭
 *    （将来快捷键节要「第一次 Esc 退出录制、第二次才关面板」）。
 *
 * 落点由 `initialSection` 决定：菜单/快捷键打开落在「外观」，AI 面板的「设置」
 * 按钮落在「AI 助手」——用户点的是哪一块，就把他放到哪一节，不要让他再找一次。
 */

const props = withDefaults(
  defineProps<{
    /** 打开时落在哪一节。默认「外观」，也是菜单入口的落点。 */
    initialSection?: SettingsSectionId
  }>(),
  { initialSection: 'appearance' }
)

const emit = defineEmits<{ close: [] }>()

const fileStore = useFileStore()
const themeStore = useThemeStore()
const appearanceStore = useAppearanceStore()

interface SectionDef {
  id: SettingsSectionId
  label: string
  icon: Icon
  desc: string
}

/** 分组顺序按使用频率排，不按「文件里出现的先后」 */
const SECTIONS: readonly SectionDef[] = [
  { id: 'appearance', label: '外观', icon: IconPalette, desc: '主题与主界面字号。' },
  { id: 'editor', label: '编辑器', icon: IconTypography, desc: '编辑区的字号、字体与行高。' },
  { id: 'files', label: '文件与图片', icon: IconPhoto, desc: '插入图片时的压缩策略。' },
  {
    id: 'ai',
    label: 'AI 助手',
    icon: IconRobot,
    desc: 'Provider 连接参数。API Key 只保存在本机。'
  },
  { id: 'shortcuts', label: '快捷键', icon: IconKeyboard, desc: '点键位后按下新组合，Backspace 清除。' },
  {
    id: 'general',
    label: '通用',
    icon: IconAdjustmentsHorizontal,
    desc: '标签页与窗口层面的行为。'
  }
]

const activeSection = ref<SettingsSectionId>(props.initialSection)
const currentSection = computed(
  () => SECTIONS.find((section) => section.id === activeSection.value) ?? SECTIONS[0]
)

/** 打开时记下主题，取消时用它回滚即时预览 */
const initialTheme = themeStore.theme

const draft = ref({
  compressEnabled: fileStore.imageCompressSettings.enabled,
  compressQuality: fileStore.imageCompressSettings.quality,
  maxTabs: fileStore.maxOpenTabs,
  uiFontSize: appearanceStore.uiFontSize,
  editorFontSize: appearanceStore.editorFontSize,
  editorFontFamily: appearanceStore.editorFontFamily,
  editorMonoFontFamily: appearanceStore.editorMonoFontFamily,
  editorLineHeight: appearanceStore.editorLineHeight,
  theme: themeStore.theme as ThemeType,
  /** 快捷键也走草稿：录制期间只改这里，点「保存」才落盘生效 */
  overrides: { ...getOverrides() }
})

/** 主题走即时预览，不进草稿的提交阶段 */
const draftTheme = computed({
  get: () => draft.value.theme,
  set: (next: ThemeType) => {
    draft.value.theme = next
    themeStore.setTheme(next)
  }
})

/**
 * 提交。
 *
 * 本地设置是同步落 store，AI 配置要过主进程异步 IPC。两者失败语义不同：
 * 本地设置写不坏，AI 却可能因为地址非法、Key 失效而拒绝。所以 AI 保存失败时
 * **不关面板**，并自动切回「AI 助手」节——否则错误信息留在看不见的那一节里，
 * 用户只知道「点了保存没反应」。
 */
async function save(): Promise<void> {
  fileStore.setImageCompressSettings({
    enabled: draft.value.compressEnabled,
    quality: draft.value.compressQuality
  })
  fileStore.setMaxOpenTabs(draft.value.maxTabs)
  appearanceStore.setUiFontSize(draft.value.uiFontSize)
  appearanceStore.setEditorFontSize(draft.value.editorFontSize)
  appearanceStore.setEditorFontFamily(draft.value.editorFontFamily)
  appearanceStore.setEditorMonoFontFamily(draft.value.editorMonoFontFamily)
  appearanceStore.setEditorLineHeight(draft.value.editorLineHeight)
  applyOverrides(draft.value.overrides)

  const aiSaved = await (aiSectionRef.value?.save() ?? Promise.resolve(true))
  if (!aiSaved) {
    activeSection.value = 'ai'
    return
  }
  emit('close')
}

/**
 * AI 节常驻，其他节按需挂载。
 *
 * 它的表单状态活在组件里（草稿机制），跟着 `v-if` 走会在切节时被销毁——
 * 用户改了 API 地址去看了眼「外观」，回来就没了。首次进入才创建，
 * 之后用 `v-show` 保活，与工作台 `graph` / `ai` 两段同一种做法。
 */
const aiSectionRef = ref<InstanceType<typeof AiSection> | null>(null)
const aiMounted = ref(props.initialSection === 'ai')
watch(activeSection, (section) => {
  if (section === 'ai') aiMounted.value = true
})

/**
 * AI 配置的就绪状态要往外传。
 *
 * 「配置可用」的绿字挂在 AI 面板的标题栏，面板与设置中心不在同一棵子树里；
 * 保存/探测都会改变它，而 AI 面板没有理由知道设置中心存在。走一条窗口事件，
 * 与 `editor:image` 那几个同一种做法。
 */
function onAiReadiness(ready: boolean): void {
  window.dispatchEvent(new CustomEvent('ai:readiness', { detail: ready }))
}

/** 取消：主题回滚是唯一的副作用，其余草稿直接丢弃 */
function cancel(): void {
  if (themeStore.theme !== initialTheme) themeStore.setTheme(initialTheme)
  emit('close')
}

// ===== 左栏键盘导航 =====
const railRef = ref<HTMLElement | null>(null)

function focusActiveTab(): void {
  const tabs = railRef.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  const index = SECTIONS.findIndex((section) => section.id === activeSection.value)
  tabs?.[index]?.focus()
}

function onRailKeydown(event: KeyboardEvent): void {
  const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!handled.includes(event.key)) return
  event.preventDefault()

  const index = SECTIONS.findIndex((section) => section.id === activeSection.value)
  let next = index
  if (event.key === 'ArrowDown') next = (index + 1) % SECTIONS.length
  else if (event.key === 'ArrowUp') next = (index - 1 + SECTIONS.length) % SECTIONS.length
  else if (event.key === 'Home') next = 0
  else next = SECTIONS.length - 1

  activeSection.value = SECTIONS[next].id
  void nextTick(focusActiveTab)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  cancel()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  void nextTick(focusActiveTab)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    class="settings-overlay"
    @mousedown.self="cancel"
  >
    <section
      class="settings-shell"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <nav
        ref="railRef"
        class="settings-rail"
        role="tablist"
        aria-orientation="vertical"
        @keydown="onRailKeydown"
      >
        <button
          v-for="section in SECTIONS"
          :key="section.id"
          type="button"
          role="tab"
          class="settings-rail__item"
          :class="{ active: section.id === activeSection }"
          :aria-selected="section.id === activeSection"
          :aria-controls="`settings-panel-${section.id}`"
          :tabindex="section.id === activeSection ? 0 : -1"
          @click="activeSection = section.id"
        >
          <component
            :is="section.icon"
            :size="14"
            stroke="1.8"
          />
          <span>{{ section.label }}</span>
        </button>
      </nav>

      <div class="settings-main">
        <header class="settings-main__head">
          <h2>{{ currentSection.label }}</h2>
          <p class="settings-main__desc">
            {{ currentSection.desc }}
          </p>
        </header>

        <div
          :id="`settings-panel-${currentSection.id}`"
          class="settings-main__body"
          role="tabpanel"
        >
          <AppearanceSection
            v-if="activeSection === 'appearance'"
            v-model:theme="draftTheme"
            v-model:ui-font-size="draft.uiFontSize"
          />
          <EditorSection
            v-else-if="activeSection === 'editor'"
            v-model:font-size="draft.editorFontSize"
            v-model:family="draft.editorFontFamily"
            v-model:mono-family="draft.editorMonoFontFamily"
            v-model:line-height="draft.editorLineHeight"
          />
          <ShortcutsSection
            v-else-if="activeSection === 'shortcuts'"
            v-model:overrides="draft.overrides"
          />
          <FilesSection
            v-else-if="activeSection === 'files'"
            v-model:compress-enabled="draft.compressEnabled"
            v-model:compress-quality="draft.compressQuality"
          />
          <GeneralSection
            v-else-if="activeSection === 'general'"
            v-model:max-tabs="draft.maxTabs"
          />
          <!-- AI 节首次进入才创建，之后保活：切节不丢已填的表单 -->
          <AiSection
            v-if="aiMounted"
            v-show="activeSection === 'ai'"
            ref="aiSectionRef"
            @readiness="onAiReadiness"
            @submit="save"
          />
        </div>

        <footer class="settings-foot">
          <!-- 快捷键节的页脚多一个「恢复全部默认」：这份草稿就是整张覆盖表，清空即还原 -->
          <button
            v-if="activeSection === 'shortcuts'"
            type="button"
            class="secondary settings-foot__reset"
            :disabled="Object.keys(draft.overrides).length === 0"
            @click="draft.overrides = {}"
          >
            恢复全部默认
          </button>
          <button
            type="button"
            class="secondary"
            @click="cancel"
          >
            取消
          </button>
          <button
            type="button"
            class="primary"
            @click="save"
          >
            保存
          </button>
        </footer>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10010;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.settings-shell {
  display: grid;
  grid-template-columns: 196px minmax(0, 1fr);
  /**
   * 隐式行高是 `auto`，会被内容撑到高于 560px 的容器：右栏随之变高，
   * `.settings-main__body` 的 `flex: 1` 拿到足够空间，`overflow-y: auto`
   * 就永远没有触发条件——超出部分被 shell 的 `overflow: hidden` 直接裁掉，
   * 表现出来就是「快捷键面板滚不动、底下几行看不见」。
   * 钉死成 `minmax(0, 1fr)`，行高才真正等于容器高度。
   */
  grid-template-rows: minmax(0, 1fr);
  width: 860px;
  height: 560px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow: hidden;
  color: var(--color-text);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.24);
}

/* ===== 左栏：分组目录 ===== */
.settings-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 10px;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-secondary) 60%, transparent);
}

.settings-rail__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--ui-font-size);
  text-align: left;
  cursor: pointer;
}

.settings-rail__item:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.settings-rail__item.active {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-weight: 600;
}

/* 选中项左侧的强调条：颜色之外再给一个不依赖色觉的位置信号 */
.settings-rail__item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 2px;
  height: 16px;
  margin-top: -8px;
  border-radius: 1px;
  background: var(--color-primary);
}

.settings-rail__item:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

/* ===== 右栏 ===== */
.settings-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 同理：flex/grid 子项默认 min-height: auto，会被内容撑破行高 */
  min-height: 0;
  overflow: hidden;
}

.settings-main__head {
  flex-shrink: 0;
  padding: 18px 24px 10px;
}

.settings-main__head h2 {
  margin: 0;
  font-size: calc(var(--ui-font-size) + 4px);
}

.settings-main__desc {
  margin: 4px 0 0;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
}

.settings-main__body {
  flex: 1;
  min-height: 0;
  /* 底部留白：滚到最后一行时不贴着页脚，否则看着像被切掉 */
  padding: 0 24px 18px;
  overflow-y: auto;
}

/* 内容区按行阅读，宽屏上不要拉成一条长线 */
.settings-main__body > :deep(*) {
  max-width: 720px;
}

.settings-foot {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 24px;
  border-top: 1px solid var(--color-border);
}

/* 「恢复全部默认」贴左边：它不是确认动作，和保存/取消分开放 */
.settings-foot__reset {
  margin-right: auto;
}

.settings-foot__reset:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.settings-foot button {
  padding: 7px 14px;
  color: var(--color-text);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.settings-foot button:hover {
  filter: brightness(1.05);
}

.settings-foot button.primary {
  color: white;
  background: var(--color-primary);
  border-color: var(--color-primary);
}
</style>
