<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { IconPencil, IconTrash } from '@tabler/icons-vue'
import { useAiStore } from '../../stores/ai'
import { requestDialog } from '../../utils/dialog'
import Tooltip from '../common/Tooltip.vue'

const store = useAiStore()

const sidebarWidth = ref(210)
const MIN_WIDTH = 160
const MAX_WIDTH = 420
let dragStartX = 0
let dragStartWidth = 0

function onResizeMove(event: MouseEvent): void {
  const delta = event.clientX - dragStartX
  sidebarWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidth + delta))
}

function endResize(): void {
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', endResize)
  document.body.style.userSelect = ''
}

function startResize(event: MouseEvent): void {
  dragStartX = event.clientX
  dragStartWidth = sidebarWidth.value
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', endResize)
}

onUnmounted(() => {
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', endResize)
  document.body.style.userSelect = ''
})

interface MenuItem {
  label: string
  action: () => void
}

const contextMenu = ref({ visible: false, x: 0, y: 0, items: [] as MenuItem[] })
const renamingId = ref<string | null>(null)
const renameValue = ref('')

const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'inkase:close-context-menus'

function showContextMenu(event: MouseEvent, items: MenuItem[]): void {
  window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
  contextMenu.value = { visible: true, x: event.clientX, y: event.clientY, items }
}

function onContextMenu(event: MouseEvent, id: string): void {
  showContextMenu(event, [
    { label: '重命名', action: () => startRename(id) },
    { label: '删除', action: () => void confirmDelete(id) }
  ])
}

function startRename(id: string): void {
  renamingId.value = id
  const conv = store.conversations.find((c) => c.id === id)
  renameValue.value = conv?.title ?? ''
}

function commitRename(): void {
  if (renamingId.value) void store.renameConversation(renamingId.value, renameValue.value)
  renamingId.value = null
}

async function confirmDelete(id: string): Promise<void> {
  const choice = await requestDialog({
    title: '删除会话',
    message: '确定要删除该会话吗？',
    detail: '删除后不可恢复。',
    buttons: [
      { label: '取消', value: 1 },
      { label: '删除', value: 0, primary: true }
    ]
  })
  if (choice === 0) await store.deleteConversation(id)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <aside
    class="conversation-sidebar"
    aria-label="会话列表"
    :style="{ width: `${sidebarWidth}px` }"
  >
    <div class="sidebar-header">
      <span>会话</span>
      <button
        type="button"
        data-testid="ai-new-conversation"
        @click="store.newConversation"
      >
        新建
      </button>
    </div>
    <ul class="conversation-list">
      <li
        v-for="conv in store.conversations"
        :key="conv.id"
        class="conversation-item"
        :class="{ active: conv.id === store.activeConversationId }"
        data-testid="ai-conversation-item"
        @click="conv.id !== store.activeConversationId && store.openConversation(conv.id)"
        @contextmenu.prevent.stop="onContextMenu($event, conv.id)"
      >
        <template v-if="renamingId === conv.id">
          <input
            v-model="renameValue"
            class="rename-input"
            data-testid="ai-conversation-rename-input"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="renamingId = null"
          >
        </template>
        <template v-else>
          <div class="conv-title">
            {{ conv.title }}
          </div>
          <div class="conv-time">
            {{ formatTime(conv.updatedAt) }}
          </div>
          <div class="item-actions">
            <Tooltip content="重命名">
              <button
                type="button"
                class="item-action"
                data-testid="ai-conversation-rename"
                @click.stop="startRename(conv.id)"
              >
                <IconPencil :size="12" />
              </button>
            </Tooltip>
            <Tooltip content="删除">
              <button
                type="button"
                class="item-action"
                data-testid="ai-conversation-delete"
                @click.stop="confirmDelete(conv.id)"
              >
                <IconTrash :size="12" />
              </button>
            </Tooltip>
          </div>
        </template>
      </li>
    </ul>
    <div class="sidebar-footer">
      {{ store.storageRoot ? store.storageRoot : '未打开工作区' }}
    </div>

    <div
      class="resize-handle"
      aria-hidden="true"
      @mousedown.prevent="startResize"
    />

    <div
      v-if="contextMenu.visible"
      class="context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
    >
      <button
        v-for="item in contextMenu.items"
        :key="item.label"
        type="button"
        class="context-menu-item"
        @click="item.action(); contextMenu.visible = false"
      >
        {{ item.label }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.conversation-sidebar { position: relative; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--color-border); background: var(--color-bg); }
.sidebar-header { display: flex; align-items: center; justify-content: space-between; min-height: 46px; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
.sidebar-header span { font-size: calc(var(--ui-font-size) - 1px); color: var(--color-text-secondary); }
.sidebar-header button { padding: 3px 8px; border: 0; border-radius: 4px; background: var(--color-primary); color: white; cursor: pointer; font-size: calc(var(--ui-font-size) - 1px); }
.conversation-list { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 4px; }
.conversation-item { position: relative; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.conversation-item:hover { background: var(--color-bg-secondary); }
.conversation-item.active { background: var(--color-primary-light); }
.conversation-item.active .conv-title { color: var(--color-primary); font-weight: 600; }
.conv-title { padding-right: 40px; font-size: calc(var(--ui-font-size) - 1px); color: var(--color-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-time { font-size: calc(var(--ui-font-size) - 3px); color: var(--color-text-tertiary); }
.item-actions { position: absolute; top: 50%; right: 6px; display: flex; gap: 2px; transform: translateY(-50%); opacity: 0; transition: opacity .12s; }
.item-actions :deep(.tooltip-trigger) { flex: none; }
.conversation-item:hover .item-actions { opacity: 1; }
.item-action { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
.item-action:hover { background: var(--color-bg-tertiary); color: var(--color-text); }
.rename-input { width: 100%; font-size: calc(var(--ui-font-size) - 1px); border: 1px solid var(--color-border); background: var(--color-bg-primary); color: var(--color-text); }
.sidebar-footer { padding: 8px 12px; border-top: 1px solid var(--color-border); font-size: calc(var(--ui-font-size) - 3px); color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resize-handle { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: col-resize; }
.resize-handle:hover { background: var(--color-primary-light); }
.context-menu { position: fixed; z-index: 1000; min-width: 120px; padding: 4px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-primary); box-shadow: 0 8px 24px rgb(0 0 0 / 12%); }
.context-menu-item { display: block; width: 100%; padding: 6px 10px; border: 0; border-radius: 4px; background: transparent; color: var(--color-text); text-align: left; cursor: pointer; font-size: calc(var(--ui-font-size) - 1px); }
.context-menu-item:hover { background: var(--color-bg-secondary); }
</style>
