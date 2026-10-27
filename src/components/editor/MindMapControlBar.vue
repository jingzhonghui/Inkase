<script setup lang="ts">
/**
 * 思维导图控制条
 *
 * 只是「按钮 + 事件」，不持有渲染库实例，便于单独测试。
 * 按钮一律 `@mousedown.prevent`：不让按钮抢走画布焦点，
 * 否则点完缩放再按 Tab/Enter 就没有反应了。
 *
 * 两种形态（`variant`）：
 * - `floating`：浮在画布右下角（默认，画布大、控件少的场合）；
 * - `panel`：嵌进右侧属性栏的「画布」标签页，改为带分组标题的竖排按钮，
 *   不再定位、不再投影——面板里没有「浮在某块内容上」的概念。
 * 形态只是样式差异，事件与按钮语义完全一致。
 */
import { computed } from 'vue'
import { formatZoomPercent } from '../../utils/mindmap/viewport'
import type { MindMapLayoutDirection } from '../../types/mindmap'

const props = withDefaults(
  defineProps<{
    zoom: number
    rainbow: boolean
    direction: MindMapLayoutDirection
    /** 展示形态：浮在画布上 / 嵌进属性栏 */
    variant?: 'floating' | 'panel'
  }>(),
  { variant: 'floating' }
)

const emit = defineEmits<{
  (event: 'zoom-in'): void
  (event: 'zoom-out'): void
  (event: 'zoom-reset'): void
  (event: 'fit'): void
  (event: 'center'): void
  (event: 'collapse-all'): void
  (event: 'expand-all'): void
  (event: 'toggle-rainbow'): void
  (event: 'change-direction', direction: MindMapLayoutDirection): void
  /** 导出当前画布为图片 */
  (event: 'export-image', format: 'png' | 'svg'): void
}>()

const zoomText = computed(() => formatZoomPercent(props.zoom))
const isPanel = computed(() => props.variant === 'panel')

const directions: { value: MindMapLayoutDirection; label: string; title: string }[] = [
  { value: 'left', label: '左', title: '向左展开' },
  { value: 'side', label: '双', title: '左右双向展开' },
  { value: 'right', label: '右', title: '向右展开' }
]
</script>

<template>
  <div
    class="mind-map-controls"
    :class="{ 'is-panel': isPanel }"
    role="toolbar"
    aria-label="思维导图控制"
    @mousedown.prevent
    @contextmenu.prevent
  >
    <div class="mind-map-controls-group">
      <!-- 分组标题只在属性栏里显示；浮在画布上时按钮本身就够清楚 -->
      <span class="mind-map-controls-label">缩放</span>
      <button
        type="button"
        class="mind-map-control"
        title="缩小（Ctrl+滚轮也可缩放）"
        @click="emit('zoom-out')"
      >
        −
      </button>
      <button
        type="button"
        class="mind-map-control is-readout"
        title="恢复到 100%"
        @click="emit('zoom-reset')"
      >
        {{ zoomText }}
      </button>
      <button
        type="button"
        class="mind-map-control"
        title="放大"
        @click="emit('zoom-in')"
      >
        ＋
      </button>
    </div>

    <div class="mind-map-controls-group">
      <span class="mind-map-controls-label">视图</span>
      <button
        type="button"
        class="mind-map-control"
        title="适应画布：缩放到能看见整张导图"
        @click="emit('fit')"
      >
        适应
      </button>
      <button
        type="button"
        class="mind-map-control"
        title="回到中心主题"
        @click="emit('center')"
      >
        居中
      </button>
    </div>

    <div class="mind-map-controls-group">
      <span class="mind-map-controls-label">折叠</span>
      <button
        type="button"
        class="mind-map-control"
        title="折叠全部子主题"
        @click="emit('collapse-all')"
      >
        折叠
      </button>
      <button
        type="button"
        class="mind-map-control"
        title="展开全部子主题"
        @click="emit('expand-all')"
      >
        展开
      </button>
    </div>

    <div class="mind-map-controls-group">
      <span class="mind-map-controls-label">配色</span>
      <button
        type="button"
        class="mind-map-control"
        :class="{ 'is-active': rainbow }"
        :title="rainbow ? '彩虹分支：已开启，点击改为单色' : '彩虹分支：已关闭，点击开启'"
        @click="emit('toggle-rainbow')"
      >
        彩虹分支
      </button>
    </div>

    <div
      class="mind-map-controls-group"
      role="group"
      aria-label="导出为图片"
    >
      <span class="mind-map-controls-label">导出</span>
      <button
        type="button"
        class="mind-map-control"
        title="导出为 PNG 图片（2 倍分辨率）"
        @click="emit('export-image', 'png')"
      >
        PNG
      </button>
      <button
        type="button"
        class="mind-map-control"
        title="导出为 SVG 矢量图（可放大不失真）"
        @click="emit('export-image', 'svg')"
      >
        SVG
      </button>
    </div>

    <div
      class="mind-map-controls-group"
      role="group"
      aria-label="结构方向"
    >
      <span class="mind-map-controls-label">结构</span>
      <button
        v-for="item in directions"
        :key="item.value"
        type="button"
        class="mind-map-control"
        :class="{ 'is-active': direction === item.value }"
        :title="item.title"
        @click="emit('change-direction', item.value)"
      >
        {{ item.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.mind-map-controls {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 19;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font-size: calc(var(--ui-font-size) - 1px);
  user-select: none;
}

.mind-map-controls-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.mind-map-controls-group + .mind-map-controls-group {
  padding-left: 6px;
  border-left: 1px solid var(--color-border);
}

/* 分组标题默认不显示：浮在画布上时按钮文案已经说明用途，多一行字反而挤 */
.mind-map-controls-label {
  display: none;
}

.mind-map-control {
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background-color: transparent;
  color: var(--color-text-secondary);
  font-size: inherit;
  line-height: 1;
  cursor: pointer;
}

.mind-map-control:hover {
  background-color: var(--color-bg-secondary);
  color: var(--color-text);
}

.mind-map-control.is-active {
  background-color: var(--color-primary-light);
  color: var(--color-primary);
}

.mind-map-control.is-readout {
  min-width: 46px;
  font-variant-numeric: tabular-nums;
}

/* ---------- 属性栏里的形态：竖排分组，不再浮在内容上 ---------- */

.mind-map-controls.is-panel {
  position: static;
  z-index: auto;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background-color: transparent;
  box-shadow: none;
  font-size: var(--ui-font-size);
}

.mind-map-controls.is-panel .mind-map-controls-group {
  flex-wrap: wrap;
  gap: 4px;
}

.mind-map-controls.is-panel .mind-map-controls-group + .mind-map-controls-group {
  padding-left: 0;
  border-left: 0;
}

.mind-map-controls.is-panel .mind-map-controls-label {
  display: block;
  width: 100%;
  margin-bottom: 2px;
  color: var(--color-text-secondary);
  font-size: calc(var(--ui-font-size) - 1px);
}

/* 面板里按钮要有边界，否则一排文字看不出哪里能点 */
.mind-map-controls.is-panel .mind-map-control {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-primary);
}

.mind-map-controls.is-panel .mind-map-control.is-active {
  border-color: var(--color-primary);
  background-color: var(--color-primary-light);
  color: var(--color-primary);
}
</style>
