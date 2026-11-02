<script setup lang="ts">
/**
 * 设置行：标题 + 说明 + 控件。
 *
 * 两种排布：
 * - `stacked`：说明在上、控件在下（下拉、滑杆、字体这类宽控件）；
 * - `inline`：控件贴右边与文字同行（开关、字号这类窄控件）。
 *
 * `clickable` 把根节点换成 `<label>`：整行点击都能切换控件，
 * 复选框不再需要用户精确点到那 13px 的小方块上。
 */
withDefaults(
  defineProps<{
    title: string
    desc?: string
    layout?: 'stacked' | 'inline'
    clickable?: boolean
  }>(),
  { desc: '', layout: 'stacked', clickable: false }
)
</script>

<template>
  <component
    :is="clickable ? 'label' : 'div'"
    class="settings-row"
    :class="[`settings-row--${layout}`, { 'settings-row--clickable': clickable }]"
  >
    <span class="settings-row__text">
      <strong>{{ title }}</strong>
      <small v-if="desc">{{ desc }}</small>
    </span>
    <span class="settings-row__control">
      <slot />
    </span>
  </component>
</template>

<style scoped>
.settings-row {
  display: flex;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px solid var(--color-border);
}

/* 最后一行不画线：列表末尾多一道横线会像内容被截断 */
.settings-row:last-child {
  border-bottom: none;
}

.settings-row--stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 9px;
}

.settings-row--inline {
  align-items: center;
  justify-content: space-between;
}

.settings-row--clickable {
  cursor: pointer;
}

.settings-row__text {
  min-width: 0;
}

.settings-row strong {
  display: block;
  font-size: var(--ui-font-size);
  font-weight: 600;
}

.settings-row small {
  display: block;
  margin-top: 3px;
  color: var(--color-text-tertiary);
  font-size: calc(var(--ui-font-size) - 1px);
  line-height: 1.5;
}

.settings-row__control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
</style>
