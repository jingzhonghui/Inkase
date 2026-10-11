<script setup lang="ts">
import type { EditorContextMenuItem } from '../../types/editor-context-menu'
import { IconChevronRight } from '@tabler/icons-vue'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: EditorContextMenuItem[]
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()
</script>

<template>
  <teleport to="body">
    <div
      v-if="props.visible"
      class="editor-context-menu"
      :style="{ left: `${props.x}px`, top: `${props.y}px` }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <template
        v-for="(item, index) in props.items"
        :key="index"
      >
        <div
          v-if="item.divider"
          class="context-menu-divider"
        />
        <div
          v-else-if="item.children"
          class="context-menu-item submenu-trigger"
        >
          <span>{{ item.label }}</span>
          <IconChevronRight
            class="submenu-arrow"
            :size="14"
          />
          <div class="submenu">
            <template
              v-for="(child, childIndex) in item.children"
              :key="childIndex"
            >
              <div
                v-if="child.divider"
                class="context-menu-divider"
              />
              <div
                v-else
                class="submenu-item"
                @click.stop="child.action?.(); emit('close')"
              >
                {{ child.label }}
              </div>
            </template>
          </div>
        </div>
        <div
          v-else
          class="context-menu-item"
          @click="item.action?.(); emit('close')"
        >
          {{ item.label }}
        </div>
      </template>
    </div>
  </teleport>
</template>

<style scoped>
.editor-context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 140px;
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.context-menu-item,
.submenu-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  color: var(--color-text);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--ui-font-size);
  white-space: nowrap;
}

.context-menu-item:hover,
.submenu-item:hover {
  background: var(--color-bg-secondary);
}

.submenu-trigger {
  position: relative;
}

.submenu {
  position: absolute;
  top: -4px;
  left: 100%;
  display: none;
  min-width: 130px;
  /* 无 margin：与触发项右缘贴合，避免鼠标斜移穿过空隙时 :hover 丢失 */
  padding: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.submenu-trigger:hover .submenu {
  display: block;
}

.submenu-arrow {
  margin-left: 12px;
  opacity: 0.6;
  font-size: calc(var(--ui-font-size) + 5px);
  line-height: 12px;
}

.context-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--color-border);
}
</style>
