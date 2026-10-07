<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import {
  IconBold,
  IconBlockquote,
  IconCode,
  IconHeading,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconPhoto,
  IconStrikethrough,
  IconTable,
  IconUnderline,
  IconUpload
} from '@tabler/icons-vue'
import Tooltip from '../common/Tooltip.vue'

// 标题下拉菜单状态
const headingMenuOpen = ref(false)
const headingLevels = [
  { label: '正文', level: 0 },
  { label: '标题 1', level: 1 },
  { label: '标题 2', level: 2 },
  { label: '标题 3', level: 3 },
  { label: '标题 4', level: 4 },
  { label: '标题 5', level: 5 },
  { label: '标题 6', level: 6 }
]

// 链接对话框状态
const linkDialogOpen = ref(false)
const linkHref = ref('')
const linkTitle = ref('')

// 图片对话框状态
const imageDialogOpen = ref(false)
const imageSrc = ref('')
const imageAlt = ref('')

// 代码块对话框状态（已移除，改为直接插入）

/**
 * 应用格式
 */
function applyFormat(format: string): void {
  window.dispatchEvent(new CustomEvent('editor:format', { detail: format }))
}

/**
 * 切换标题级别
 */
function handleHeadingSelect(level: number): void {
  headingMenuOpen.value = false
  window.dispatchEvent(new CustomEvent('editor:heading', { detail: level }))
}

/**
 * 显示插入链接对话框
 */
function insertLink(): void {
  linkDialogOpen.value = true
  linkHref.value = ''
  linkTitle.value = ''
}

/**
 * 确认插入链接
 */
function confirmInsertLink(): void {
  if (linkHref.value.trim()) {
    window.dispatchEvent(new CustomEvent('editor:link', {
      detail: { href: linkHref.value.trim(), title: linkTitle.value.trim() }
    }))
  }
  linkDialogOpen.value = false
}

/**
 * 显示插入图片对话框
 */
function insertImage(): void {
  imageDialogOpen.value = true
  imageSrc.value = ''
  imageAlt.value = ''
}

/**
 * 确认插入图片
 */
function confirmInsertImage(): void {
  if (imageSrc.value.trim()) {
    window.dispatchEvent(new CustomEvent('editor:image', {
      detail: { src: imageSrc.value.trim(), alt: imageAlt.value.trim() }
    }))
  }
  imageDialogOpen.value = false
}

/**
 * 直接插入代码块（不弹窗）
 */
function insertCodeBlock(): void {
  window.dispatchEvent(new CustomEvent('editor:codeBlock', {
    detail: { language: '' }
  }))
}

/**
 * 插入表格
 */
function insertTable(): void {
  window.dispatchEvent(new CustomEvent('editor:format', { detail: 'table' }))
}

/** 点击外部关闭标题菜单 */
function onDocumentClick(): void {
  headingMenuOpen.value = false
}

// 从右键菜单打开对话框的事件监听
function onShowImageDialog() {
  insertImage()
}

function onShowLinkDialog() {
  insertLink()
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  window.addEventListener('editor:showImageDialog', onShowImageDialog)
  window.addEventListener('editor:showLinkDialog', onShowLinkDialog)
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('editor:showImageDialog', onShowImageDialog)
  window.removeEventListener('editor:showLinkDialog', onShowLinkDialog)
})

/**
 * 选择本地图片文件
 */
async function selectImageFile(): Promise<void> {
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        // 读取文件为 data URL
        const reader = new FileReader()
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string
          window.dispatchEvent(new CustomEvent('editor:image', {
            detail: { src: dataUrl, alt: file.name }
          }))
          imageDialogOpen.value = false
        }
        reader.readAsDataURL(file)
      }
    }
    input.click()
  } catch (error) {
    console.error('选择图片失败:', error)
  }
}
</script>

<template>
  <div class="toolbar">
    <!-- 格式化按钮组 -->
    <div class="format-group">
      <Tooltip content="粗体 Ctrl+B">
        <button
          class="format-btn"
          @click="applyFormat('bold')"
        >
          <IconBold stroke="2.5" />
        </button>
      </Tooltip>
      <Tooltip content="斜体 Ctrl+I">
        <button
          class="format-btn"
          @click="applyFormat('italic')"
        >
          <IconItalic />
        </button>
      </Tooltip>
      <Tooltip content="删除线">
        <button
          class="format-btn"
          @click="applyFormat('strikethrough')"
        >
          <IconStrikethrough />
        </button>
      </Tooltip>
      <Tooltip content="下划线 Ctrl+U">
        <button
          class="format-btn"
          @click="applyFormat('underline')"
        >
          <IconUnderline />
        </button>
      </Tooltip>
    </div>

    <div class="toolbar-divider" />

    <!-- 块级元素 -->
    <div class="format-group">
      <!-- 标题下拉菜单 -->
      <div class="dropdown-container">
        <Tooltip content="标题">
          <button
            class="format-btn"
            @click.stop="headingMenuOpen = !headingMenuOpen"
          >
            <IconHeading stroke="2.5" />
            <!-- 标题下拉菜单 -->
            <div
              v-if="headingMenuOpen"
              class="dropdown-menu"
            >
              <button
                v-for="item in headingLevels"
                :key="item.level"
                class="dropdown-item"
                @click.stop="handleHeadingSelect(item.level)"
              >
                <span v-if="item.level === 0">正文</span>
                <span
                  v-else
                  :class="'h' + item.level"
                >{{ item.label }}</span>
              </button>
            </div>
          </button>
        </Tooltip>
      </div>
      <Tooltip content="无序列表">
        <button
          class="format-btn"
          @click="applyFormat('unorderedList')"
        >
          <IconList />
        </button>
      </Tooltip>
      <Tooltip content="有序列表">
        <button
          class="format-btn"
          @click="applyFormat('orderedList')"
        >
          <IconListNumbers />
        </button>
      </Tooltip>
      <Tooltip content="引用">
        <button
          class="format-btn"
          @click="applyFormat('blockquote')"
        >
          <IconBlockquote />
        </button>
      </Tooltip>
      <Tooltip content="代码块">
        <button
          class="format-btn"
          @click="insertCodeBlock"
        >
          <IconCode />
        </button>
      </Tooltip>
    </div>
    <div class="toolbar-divider" />

    <!-- 插入元素 -->
    <div class="format-group">
      <Tooltip content="链接 Ctrl+K">
        <button
          class="format-btn"
          @click="insertLink"
        >
          <IconLink />
        </button>
      </Tooltip>
      <Tooltip content="图片">
        <button
          class="format-btn"
          @click="insertImage"
        >
          <IconPhoto />
        </button>
      </Tooltip>
      <Tooltip content="表格">
        <button
          class="format-btn"
          @click="insertTable"
        >
          <IconTable />
        </button>
      </Tooltip>
    </div>

    <!-- 链接对话框 -->
    <div
      v-if="linkDialogOpen"
      class="dialog-overlay"
    >
      <div
        class="dialog"
        @click.stop
      >
        <h3 class="dialog-title">
          插入链接
        </h3>
        <input
          v-model="linkHref"
          type="text"
          placeholder="链接地址 (https://...)"
          class="dialog-input"
          @keydown.enter="confirmInsertLink"
        >
        <input
          v-model="linkTitle"
          type="text"
          placeholder="标题 (可选)"
          class="dialog-input"
          @keydown.enter="confirmInsertLink"
        >
        <div class="dialog-actions">
          <button
            class="dialog-btn dialog-btn-cancel"
            @click="linkDialogOpen = false"
          >
            取消
          </button>
          <button
            class="dialog-btn dialog-btn-confirm"
            @click="confirmInsertLink"
          >
            确定
          </button>
        </div>
      </div>
    </div>

    <!-- 图片对话框 -->
    <div
      v-if="imageDialogOpen"
      class="dialog-overlay"
    >
      <div
        class="dialog"
        @click.stop
      >
        <h3 class="dialog-title">
          插入图片
        </h3>
        <input
          v-model="imageSrc"
          type="text"
          placeholder="图片地址 (URL 或相对路径)"
          class="dialog-input"
          @keydown.enter="confirmInsertImage"
        >
        <input
          v-model="imageAlt"
          type="text"
          placeholder="替代文本 (可选)"
          class="dialog-input"
          @keydown.enter="confirmInsertImage"
        >
        <div class="dialog-divider">
          或
        </div>
        <button
          class="dialog-file-btn"
          @click="selectImageFile"
        >
          <IconUpload :size="16" />
          选择本地图片
        </button>
        <div class="dialog-actions">
          <button
            class="dialog-btn dialog-btn-cancel"
            @click="imageDialogOpen = false"
          >
            取消
          </button>
          <button
            class="dialog-btn dialog-btn-confirm"
            @click="confirmInsertImage"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  height: var(--toolbar-height);
  padding: 0 var(--spacing-md);
  background-color: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.toolbar-divider {
  width: 1px;
  height: 20px;
  background-color: var(--color-border);
}

.format-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.format-group > :deep(.tooltip-trigger) {
  flex: 0 0 auto;
}

.format-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.format-btn:hover {
  background-color: var(--color-bg-tertiary);
  color: var(--color-text);
}

.format-btn svg {
  width: 16px;
  height: 16px;
}

/* 下拉菜单 */
.dropdown-container {
  position: relative;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 4px;
  min-width: 120px;
  z-index: 100;
}

.dropdown-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
}

.dropdown-item:hover {
  background: var(--color-bg-secondary);
}

.dropdown-item .h1 { font-size: 1.5em; font-weight: 700; }
.dropdown-item .h2 { font-size: 1.3em; font-weight: 600; }
.dropdown-item .h3 { font-size: 1.15em; font-weight: 600; }
.dropdown-item .h4 { font-size: 1em; font-weight: 600; }

/* 对话框 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-bg-primary);
  border-radius: 8px;
  padding: 20px;
  min-width: 360px;
  max-width: 90vw;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.dialog-title {
  margin: 0 0 16px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
}

.dialog-input {
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}

.dialog-input:focus {
  border-color: var(--color-primary);
}

.dialog-input::placeholder {
  color: var(--color-text-tertiary);
}

.dialog-divider {
  text-align: center;
  margin: 12px 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  position: relative;
}

.dialog-divider::before,
.dialog-divider::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 40%;
  height: 1px;
  background: var(--color-border);
}

.dialog-divider::before { left: 0; }
.dialog-divider::after { right: 0; }

.dialog-file-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  cursor: pointer;
  transition: all 0.15s;
}

.dialog-file-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.dialog-btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}

.dialog-btn-cancel {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
}

.dialog-btn-cancel:hover {
  background: var(--color-bg-secondary);
}

.dialog-btn-confirm {
  border: none;
  background: var(--color-primary);
  color: white;
}

.dialog-btn-confirm:hover {
  filter: brightness(1.1);
}
</style>
