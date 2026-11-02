<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  bindingFromEvent,
  detectPlatform,
  formatBinding,
  isReservedBinding
} from '../../../shortcuts/binding'
import {
  commandById,
  commandGroups,
  effectiveBinding,
  findConflicts,
  isOverridden,
  normalizeOverrides,
  type CommandId
} from '../../../shortcuts/registry'
import type { ShortcutOverrides } from '../../../shortcuts/overrides'

/**
 * 快捷键设置：查与改是同一份列表。
 *
 * 与「只读速查表」的区别只有两点——键位是个可点的按钮，点下去进入录制态；
 * 每行末尾多一个「恢复」，且被改过的行标出来。其余（分组、顺序、文案）
 * 全部来自命令注册表，所以这里永远不会跟菜单栏说不一样的话。
 *
 * 录制态的三条约定：
 * 1. **吞掉一切按键**：capture 阶段 `preventDefault` + `stopPropagation`，
 *    否则录 `Ctrl+W` 会当场把标签关了、录 `Ctrl+S` 会顺手存一次盘；
 * 2. **Esc 只退出录制**，不关面板——面板的 Esc 是外壳在冒泡阶段收的，
 *    这里已经把它拦在前面了；
 * 3. **Backspace 清除绑定**（`null` = 显式解绑），只按修饰键不产生绑定。
 */
const overrides = defineModel<ShortcutOverrides>('overrides', { required: true })

const platform = detectPlatform()

const query = ref('')
const recording = ref<CommandId | null>(null)
/** 录制时被拒绝的原因（保留键、单键），只在录制态显示 */
const recordHint = ref('')

const conflicts = computed(() => findConflicts(overrides.value, platform))

/**
 * 撞键里是否牵涉到不可改的命令（编辑器 / 系统）。
 *
 * 两种撞法后果不一样，提示不能混为一谈：
 * - 应用层内部撞：派发器按注册表顺序走，只有排在前面的那条会执行；
 * - 撞到编辑器/系统：那两边的 keymap 不受这里控制，可能两边都响应
 *   （比如把保存改成 Ctrl+B，按一下既存盘又加粗），也可能都没反应。
 */
const hasFixedConflict = computed(() =>
  [...conflicts.value.entries()].some(
    ([id, others]) =>
      !isEditable(commandById(id)) || others.some((other) => !isEditable(commandById(other)))
  )
)

/**
 * 这份列表只收「应用层能改」和「编辑器层能查」的命令。
 *
 * `owner: 'native'`（剪切 / 复制 / 粘贴）是 Chromium 的原生行为，键位由操作
 * 系统定死，既改不了也不该在这里改——列出来纯属噪音（用户看到 Ctrl+C 会以为
 * 那是本应用的设置）。注册表里**仍然保留**这三条：编辑菜单右侧的 Ctrl+C 文案
 * 还要从它们读，删了菜单就不显示键位了。
 */
const groups = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return commandGroups()
    .map((section) => ({
      ...section,
      commands: section.commands.filter((command) => {
        if (command.owner === 'native') return false
        if (!keyword) return true
        const binding = effectiveBinding(command.id, overrides.value)
        const label = command.label.toLowerCase()
        const keys = binding ? formatBinding(binding, platform).toLowerCase() : '未绑定'
        return label.includes(keyword) || keys.includes(keyword)
      })
    }))
    .filter((section) => section.commands.length > 0)
})

function displayBinding(id: CommandId): string {
  const binding = effectiveBinding(id, overrides.value)
  return binding ? formatBinding(binding, platform) : '未绑定'
}

/**
 * 这条命令的键位能不能在这里改。
 *
 * 只有 `owner: 'app'`（由 AppHeader 派发器执行）的才归这里管。编辑器命令的
 * 键位写死在 ProseMirror/CodeMirror 的 keymap 里，剪切/复制/粘贴更是 Chromium
 * 原生行为——列出来让人改是假的：改完列表显示新键，按下去还是旧键。
 * 所以这些行只读，并标明是谁在处理。
 */
function isEditable(command: { owner: string }): boolean {
  return command.owner === 'app'
}

/** 只读行的第三列文案：谁在处理这个键 */
function ownerLabel(command: { owner: string }): string {
  return command.owner === 'native' ? '系统' : '编辑器'
}

/** 只读行的悬停说明 */
function ownerHint(command: { owner: string }): string {
  return command.owner === 'native'
    ? '由系统原生处理，暂不支持在这里修改'
    : '由编辑器处理，暂不支持在这里修改'
}

function conflictText(id: CommandId): string {
  const others = conflicts.value.get(id)
  if (!others || others.length === 0) return ''
  const names = others.map((other) => {
    const target = commandById(other)
    // 系统原生（剪切/复制/粘贴）不在列表里，直接报名字会让人找不到那一行
    return target.owner === 'native' ? '系统快捷键' : `「${target.label}」`
  })
  return `与${names.join('、')}冲突`
}

/**
 * 逐条列举时只列**这个面板里看得见**的命令。
 *
 * 冲突本身仍按全量算（撞到 Ctrl+C 是要提醒的），但键是系统原生命令的那一侧
 * 不列举——列表里根本没有它，列出来只会变成一个点不掉的幽灵条目。
 */
const visibleConflicts = computed(() =>
  [...conflicts.value.entries()].filter(([id]) => commandById(id).owner !== 'native')
)

function isModified(id: CommandId): boolean {
  return isOverridden(id, overrides.value)
}

function startRecording(id: CommandId): void {
  if (!isEditable(commandById(id))) return
  if (recording.value === id) {
    stopRecording()
    return
  }
  recording.value = id
  recordHint.value = ''
}

function stopRecording(): void {
  recording.value = null
  recordHint.value = ''
}

/** 写入一条改动：先落草稿再规范化（与默认值相同就自动删掉这条覆盖） */
function assign(id: CommandId, binding: string | null): void {
  overrides.value = normalizeOverrides({ ...overrides.value, [id]: binding })
  stopRecording()
}

function resetOne(id: CommandId): void {
  const next = { ...overrides.value }
  delete next[id]
  overrides.value = next
}

function onRecordKeydown(event: KeyboardEvent): void {
  const id = recording.value
  if (!id) return

  // 录制期间所有按键都归这里，既不能让编辑器看见，也不能让外壳的 Esc 关面板
  event.preventDefault()
  event.stopPropagation()

  if (event.key === 'Escape') {
    stopRecording()
    return
  }

  // 不带修饰键的 Backspace / Delete = 清除绑定（显式解绑）
  if (
    (event.key === 'Backspace' || event.key === 'Delete') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    assign(id, null)
    return
  }

  const binding = bindingFromEvent(event, platform)
  if (!binding) {
    // 只按了修饰键：继续等待，不提示——这是录制过程中最常见的中间态
    return
  }

  if (isReservedBinding(binding, platform)) {
    recordHint.value = `${formatBinding(binding, platform)} 是系统保留键，请换一个`
    return
  }

  assign(id, binding)
}

onMounted(() => {
  window.addEventListener('keydown', onRecordKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onRecordKeydown, true)
})
</script>

<template>
  <div class="shortcuts-toolbar">
    <input
      v-model="query"
      type="search"
      class="shortcuts-search"
      placeholder="搜索命令或键位"
    >
    <span class="shortcuts-tip">
      点键位后按下新组合；Backspace 清除；Esc 取消。标「编辑器/系统」的由它们各自处理，不可修改。
    </span>
  </div>

  <section
    v-for="section in groups"
    :key="section.group"
    class="shortcuts-group"
  >
    <h3>{{ section.label }}</h3>

    <div
      v-for="command in section.commands"
      :key="command.id"
      class="shortcut-line"
      :class="{ 'is-recording': recording === command.id }"
    >
      <span class="shortcut-line__label">{{ command.label }}</span>

      <!-- 可改的命令：键位就是按钮；只读的：纯展示 + 标明由谁处理 -->
      <button
        v-if="isEditable(command)"
        type="button"
        class="shortcut-line__keys"
        :class="{ 'is-recording': recording === command.id, 'is-empty': !effectiveBinding(command.id, overrides) }"
        :aria-label="`${command.label} 的快捷键，点击后按下新组合`"
        @click="startRecording(command.id)"
      >
        {{
          recording === command.id ? '按下组合键…' : displayBinding(command.id)
        }}
      </button>
      <span
        v-else
        class="shortcut-line__keys is-fixed"
        :title="ownerHint(command)"
      >{{ displayBinding(command.id) }}</span>

      <button
        v-if="isEditable(command) && isModified(command.id)"
        type="button"
        class="shortcut-line__reset"
        title="恢复默认"
        @click="resetOne(command.id)"
      >
        恢复
      </button>
      <span
        v-else-if="isEditable(command)"
        class="shortcut-line__reset-placeholder"
      />
      <span
        v-else
        class="shortcut-line__owner"
        :title="ownerHint(command)"
      >{{ ownerLabel(command) }}</span>
    </div>
  </section>

  <p
    v-if="groups.length === 0"
    class="shortcuts-empty"
  >
    没有匹配「{{ query }}」的命令
  </p>

  <p
    v-if="recordHint"
    class="shortcuts-hint"
  >
    {{ recordHint }}
  </p>

  <p
    v-if="conflicts.size > 0 && hasFixedConflict"
    class="shortcuts-conflict"
  >
    有键位和编辑器或系统命令撞了：在这里改不掉它们，按下去可能两边一起响应，建议换个组合键。
  </p>
  <p
    v-else-if="visibleConflicts.length > 0"
    class="shortcuts-conflict"
  >
    有 {{ visibleConflicts.length }} 条命令的键位撞在一起，保存后同层只有排在前面的那条会生效。
  </p>
  <p
    v-for="[id] in visibleConflicts"
    :key="id"
    class="shortcuts-conflict-detail"
  >
    {{ commandById(id).label }}：{{ conflictText(id) }}
  </p>
</template>

<style scoped>
.shortcuts-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0 14px;
  border-bottom: 1px solid var(--color-border);
}

.shortcuts-search {
  width: 220px;
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-primary);
  color: var(--color-text);
  font-size: var(--ui-font-size);
}

.shortcuts-tip {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
}

.shortcuts-group h3 {
  margin: 18px 0 6px;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
  font-weight: 600;
}

.shortcut-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 52px;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--color-border);
}

.shortcut-line:last-child {
  border-bottom: none;
}

.shortcut-line__label {
  min-width: 0;
  overflow: hidden;
  font-size: var(--ui-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 键位本身就是按钮：整行唯一的可点区域，避免误触 */
.shortcut-line__keys {
  padding: 3px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-family: var(--editor-mono-font-family, monospace);
  font-size: calc(var(--ui-font-size) - 1px);
  cursor: pointer;
}

.shortcut-line__keys:hover {
  border-color: var(--color-border-hover);
}

/* 未绑定：虚线框，和「有键位但按不出来」区分开 */
.shortcut-line__keys.is-empty {
  color: var(--color-text-tertiary);
  border-style: dashed;
}

/* 只读：由编辑器或系统处理。外观压低但保留键位样式，说明「这是键，只是不归我改」 */
.shortcut-line__keys.is-fixed {
  color: var(--color-text-tertiary);
  background: transparent;
  cursor: default;
}

.shortcut-line__owner {
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 3px);
  text-align: right;
  white-space: nowrap;
}

.shortcut-line__keys.is-recording {
  color: var(--color-primary);
  border-color: var(--color-primary);
  border-style: solid;
  background: var(--color-primary-light);
}

.shortcut-line__reset {
  padding: 3px 0;
  border: none;
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 2px);
  cursor: pointer;
}

.shortcut-line__reset:hover {
  color: var(--color-primary);
}

/* 占位保持三列对齐：没有「恢复」的行也不让键位按钮左右跳 */
.shortcut-line__reset-placeholder {
  display: block;
}

.shortcuts-empty {
  padding: 24px 0;
  color: var(--color-text-tertiary);
  font-size: var(--ui-font-size);
}

.shortcuts-hint,
.shortcuts-conflict,
.shortcuts-conflict-detail {
  margin: 10px 0 0;
  font-size: calc(var(--ui-font-size) - 2px);
}

.shortcuts-hint,
.shortcuts-conflict {
  color: var(--color-warning, #d97706);
}

.shortcuts-conflict-detail {
  margin: 4px 0 0;
  color: var(--color-text-tertiary);
}
</style>
