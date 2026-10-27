/**
 * 思维导图右键菜单（自有实现）
 *
 * 为什么不用渲染库自带的菜单：
 * - 它是 `position: fixed` + 覆盖整个视口的遮罩（`.context-menu`，z-index 99），
 *   在编辑器面板内会吃掉所有点击，也与「面板内滚动/缩放」的直觉冲突；
 * - 文案是英文默认值，样式也不受 Inkase 主题变量控制；
 * - 自带菜单包含「专注模式 / 关联线」，这两个能力在 v1 不落盘，属于误导性入口。
 *
 * 交互对齐 XMind：右键先选中主题，菜单只作用于该主题，并按节点能力禁用不适用项
 * （根主题没有同级主题/父主题、不能上移下移、不能删除）。
 */

import {
  MINDMAP_GLYPH_TO_ICON,
  MINDMAP_ICON_GLYPHS,
  MINDMAP_ICON_LABELS,
  MINDMAP_ICONS
} from './rich-content'
import type { MindMapIcon } from '../../types/mindmap'

/** 渲染库注入在自定义元素 `me-tpc` 上的最小结构（只声明我们读取的字段） */export interface MindMapTopicElement extends HTMLElement {
  nodeObj?: {
    id?: string
    topic?: string
    expanded?: boolean
    children?: unknown[]
    /** 分支颜色（`#rrggbb`）；改动后需要 refresh 才会重画连线 */
    branchColor?: string
    /** 备注文本（落盘为节点 `note`），改动后同样需要 refresh */
    note?: string
    /** 图标名列表（落盘为节点 `icons`） */
    icons?: string[]
    /** 标签（落盘为节点 `tags`） */
    tags?: unknown[]
    /** 超链接（落盘为节点 `href`） */
    hyperLink?: string
    /** 节点图片（落盘为节点 `image`，这里只用来判断有无） */
    image?: unknown
    /** 渲染库的自定义元数据（存图片原始相对路径） */
    metadata?: Record<string, unknown>
  }
}

export type MindMapMenuAction =
  | 'edit'
  | 'edit-note'
  | 'add-tag'
  | 'add-link'
  | 'pick-icons'
  | 'clear-rich'
  | 'add-arrow'
  | 'add-summary'
  | 'add-image'
  | 'remove-image'
  | 'add-attachment'
  | 'manage-attachments'
  | 'add-child'
  | 'add-sibling'
  | 'add-parent'
  | 'move-up'
  | 'move-down'
  | 'toggle-collapse'
  | 'export-png'
  | 'export-svg'
  | 'remove'

export interface MindMapMenuItem {
  /** 稳定标识，同时用于菜单项的 click 分发 */
  action: MindMapMenuAction
  label: string
  /** 快捷键提示（仅展示；真实按键由渲染库与我们自己的监听处理） */
  hint?: string
  /** 与上一项之间画分隔线 */
  dividerBefore?: boolean
  disabled?: boolean
  /** 开关型菜单项（如「星标」）的勾选态 */
  checked?: boolean
  /** 二级菜单：有这一项时，父项只作为入口，点击后展开而不触发 action */
  children?: MindMapMenuChoice[]
}

/**
 * 二级菜单里的一项。
 *
 * 目前只有图标用到它：图标是「多选开关」，直接在菜单里点一下就能插入，
 * 不必像标签/链接那样先弹一个输入面板——图标没有需要校验的中间状态。
 */
export interface MindMapMenuChoice {
  /** 该项的值（图标名） */
  value: MindMapIcon
  label: string
  /** 左侧预览用的字形 */
  glyph: string
  checked: boolean
}

/** 判断主题的所有子主题是否都已折叠（无子主题时为 false） */
export function areAllChildrenCollapsed(topic: MindMapTopicElement | null): boolean {
  const children = topic?.nodeObj?.children
  if (!Array.isArray(children) || children.length === 0) return false
  return children.every((child) => (child as { expanded?: boolean } | null)?.expanded === false)
}

/**
 * 根据被右键的主题生成菜单项。
 *
 * `selectionCount` 是当前选中的主题数量：关系线需要恰好两个端点，
 * 菜单在其它情况下把该项置灰，而不是点了没反应。
 */
export function buildMindMapMenu(
  topic: MindMapTopicElement | null,
  isRoot: boolean,
  selectionCount = 1
): MindMapMenuItem[] {
  const hasChildren = (topic?.nodeObj?.children?.length ?? 0) > 0
  const collapsed = topic?.nodeObj?.expanded === false
  const hasNote = typeof topic?.nodeObj?.note === 'string' && topic.nodeObj.note.length > 0
  const hasTags = Array.isArray(topic?.nodeObj?.tags) && (topic?.nodeObj?.tags?.length ?? 0) > 0
  const hasLink =
    typeof topic?.nodeObj?.hyperLink === 'string' && topic.nodeObj.hyperLink.length > 0
  const iconNames: MindMapIcon[] = Array.isArray(topic?.nodeObj?.icons)
    ? (topic.nodeObj.icons.map((raw) => MINDMAP_GLYPH_TO_ICON[raw] ?? raw) as MindMapIcon[])
    : []
  const activeIcons = new Set(iconNames)
  const iconCount = activeIcons.size
  const hasImage = Boolean(topic?.nodeObj?.image)
  const attachmentCount = Array.isArray(
    (topic?.nodeObj?.metadata as Record<string, unknown> | undefined)?.['inkaseAttachments']
  )
    ? ((topic?.nodeObj?.metadata as Record<string, unknown>)['inkaseAttachments'] as unknown[]).length
    : 0

  const items: MindMapMenuItem[] = [
    { action: 'edit', label: '编辑主题', hint: 'F2' },
    // 备注挂在节点上、落盘进 `note`：根主题同样可以有备注，所以不参与 isRoot 判断
    { action: 'edit-note', label: hasNote ? '编辑备注' : '添加备注' },
    /*
     * 富内容（标签/链接/星标）同样属于节点自身，根主题也可以用：
     * 「这张导图的关键结论」本身就是一个合理的星标对象。
     */
    { action: 'add-tag', label: hasTags ? '编辑标签' : '添加标签' },
    { action: 'add-link', label: hasLink ? '编辑链接' : '添加链接' },
    {
      action: 'pick-icons',
      label: iconCount > 0 ? `图标（${iconCount}）` : '图标',
      children: MINDMAP_ICONS.map((name) => ({
        value: name,
        label: MINDMAP_ICON_LABELS[name],
        glyph: MINDMAP_ICON_GLYPHS[name],
        checked: activeIcons.has(name)
      }))
    },
    // 图片同样属于节点自身，根主题也可以有（当作封面）
    { action: 'add-image', label: hasImage ? '更换图片' : '插入图片' },
    ...(hasImage ? [{ action: 'remove-image' as const, label: '移除图片' }] : []),
    // 附件：非图片文件，画布上显示为节点下方的卡片
    { action: 'add-attachment', label: attachmentCount > 0 ? '添加更多附件' : '添加附件' },
    ...(attachmentCount > 0
      ? [
          {
            action: 'manage-attachments' as const,
            label: `管理附件（${attachmentCount}）`
          }
        ]
      : []),
    { action: 'add-child', label: '新建子主题', hint: 'Tab' }
  ]

  if (hasTags || hasLink || iconCount > 0) {
    items.push({ action: 'clear-rich', label: '清除标签、链接与图标', dividerBefore: true })
  }

  if (!isRoot) {
    items.push(
      { action: 'add-sibling', label: '新建同级主题', hint: 'Enter' },
      { action: 'add-parent', label: '新建父主题', hint: 'Ctrl+Enter' },
      { action: 'move-up', label: '上移', dividerBefore: true },
      { action: 'move-down', label: '下移' }
    )
  }

  /*
   * 关系线连接两个主题，所以要求恰好选中两个；
   * 概要盖住一个主题下的全部子主题（XMind 里是对同级主题的区间，这里取最常见的「总结这一支」）。
   */
  items.push(
    {
      action: 'add-arrow',
      label: '添加关系线',
      hint: selectionCount === 2 ? undefined : '需选中 2 个主题',
      dividerBefore: true,
      disabled: selectionCount !== 2
    },
    {
      action: 'add-summary',
      label: '添加概要',
      hint: undefined,
      disabled: !hasChildren
    }
  )

  /*
   * 根主题在渲染库的 DOM 里是 `me-root > me-tpc`，没有 `me-parent` 也没有 `me-epd`，
   * 而库的 `expandNode` 要写 `parentNode.children[1].expanded`——对它调用必崩。
   * 语义上根主题也没有「折叠自己」这回事，它的折叠等于**折叠整张导图**，
   * 所以文案按整张导图来写，动作走批量折叠。
   */
  items.push({
    action: 'toggle-collapse',
    label: isRoot
      ? areAllChildrenCollapsed(topic)
        ? '展开全部'
        : '折叠全部'
      : collapsed
        ? '展开子主题'
        : '折叠子主题',
    dividerBefore: true,
    disabled: !hasChildren
  })

  /*
   * 导出整张导图为图片。
   * 它是**画布级**操作、与具体主题无关，但右键菜单是用户在想「把这张图拿走」
   * 时最自然的落点，所以每个主题的菜单里都给一份（不按 isRoot 裁剪）。
   * 放在删除之前：破坏性操作始终留在菜单最底部。
   */
  items.push(
    { action: 'export-png', label: '导出为 PNG 图片', dividerBefore: true },
    { action: 'export-svg', label: '导出为 SVG 矢量图' }
  )

  items.push({
    action: 'remove',
    label: '删除主题',
    hint: 'Delete',
    dividerBefore: true,
    disabled: isRoot
  })

  return items
}

/** 从事件目标向上找主题元素（渲染库的主题标签是自定义元素 me-tpc） */
export function resolveTopicFromEvent(target: EventTarget | null): MindMapTopicElement | null {
  if (!(target instanceof Element)) return null
  return (target.closest('me-tpc') as MindMapTopicElement | null) ?? null
}

/** 主题是否为根主题（根主题的父元素是 me-root） */
export function isRootTopic(topic: MindMapTopicElement | null): boolean {
  if (!topic) return false
  return topic.parentElement?.tagName === 'ME-ROOT'
}
