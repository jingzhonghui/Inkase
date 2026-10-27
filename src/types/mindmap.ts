/**
 * 思维导图文档模型
 *
 * 这是 Inkase 自己的思维导图数据结构，落盘为纯文本 JSON（`.inkmind`）。
 *
 * 为什么不直接存渲染库（mind-elixir）的原生格式：
 * - 渲染库的字段名与语义会随大版本变化（v5 → v6 已有 breaking change），
 *   一旦写进用户文件，升级渲染库就等于迁移用户数据；
 * - 渲染库的数据里带 `parent` 反向引用（运行时构造），序列化后是冗余环；
 * - 自有 schema 带 `version`，便于后续加入节点样式、备注、多画布等能力，
 *   并且将来若要支持 XMind 导入导出，只需新增一个转换器，不动存储格式。
 */

import { MINDMAP_FILE_SCHEMA, MINDMAP_VERSION } from '../../shared/mindmap/document'

/**
 * 磁盘格式标识 / 版本 / 扩展名
 *
 * 主进程新建 `.inkmind` 时也要用同一套常量，所以定义在 `shared/` 里，
 * 这里只做转出，保证两边不会各写一份字符串而漂移。
 */
export {
  MINDMAP_EXTENSION,
  MINDMAP_FILE_SCHEMA,
  MINDMAP_VERSION
} from '../../shared/mindmap/document'

/** 节点在画布上的朝向：左 / 右。缺省由布局自动决定 */
export type MindMapNodeDirection = 'left' | 'right'

/**
 * 控制条可切换的结构方向。
 * `down`（向下生长的组织结构图）只在文件里出现，暂不提供切换入口。
 */
export type MindMapLayoutDirection = 'side' | 'left' | 'right'

/**
 * 节点图标。
 *
 * 用固定的名字而不是 emoji/图片，是为了让文件里存一个短标识，
 * 具体画成什么样由渲染层的白名单决定——换图标集不需要迁移用户文件。
 */
export type MindMapIcon = 'star' | 'flag' | 'question' | 'exclamation' | 'check'

/** 节点标签（优先级、分类、状态这类短标记） */
export interface MindMapTag {
  text: string
  /** 徽章底色（`#rrggbb`），缺省用主题强调色 */
  color?: string
}

/** 节点图片 */
export interface MindMapImage {
  /**
   * 包内路径（`assets/images/…`）。`.inkmind` 是 ZIP 容器，图片跟着文件走，
   * 不再有「图片和导图分离」的状态。`data:` URL 仅作为读取容错。
   */
  src: string
  /** 显示宽度（像素）；缺省按原始比例 */
  width?: number
  /** 显示高度（像素）；缺省按原始比例 */
  height?: number
}

/**
 * 节点附件（非图片）。
 *
 * 与图片分开建模：图片要占画布面积、按比例渲染，
 * 附件只显示成一张小卡片，两者的展示与交互完全不同。
 */
export interface MindMapAttachment {
  id: string
  /** 原始文件名，卡片显示与「另存为」的默认名 */
  name: string
  /** 包内路径（`assets/files/…`） */
  src: string
  /** MIME，决定卡片上的图标 */
  mime: string
  /** 字节数，卡片上显示大小 */
  size: number
}

/** 节点之间的连线（对齐 XMind 的 relationship） */
export interface MindMapArrow {
  id: string
  /** 起点节点 id */
  from: string
  /** 终点节点 id */
  to: string
  /** 连线上的文字 */
  label?: string
  /** 是否双向箭头 */
  bidirectional?: boolean
  /** 连线颜色（`#rrggbb`） */
  color?: string
}

/** 概要：把某个节点的一段子主题括起来加标题（对齐 XMind 的 summary） */
export interface MindMapSummary {
  id: string
  /** 概要挂在哪个节点下 */
  parent: string
  /** 起始子主题下标（含） */
  start: number
  /** 结束子主题下标（含） */
  end: number
  /** 概要文字 */
  label?: string
  /** 括线颜色（`#rrggbb`） */
  color?: string
}

/** 单个节点 */
export interface MindMapNode {
  /** 稳定唯一 id，用于渲染层与文件之间的一一对应 */
  id: string
  /** 节点文本（单行；换行由渲染层决定如何处理） */
  text: string
  /** 节点备注（不在画布上显示，仅存储） */
  note?: string
  /** 是否折叠子节点 */
  collapsed?: boolean
  /** 指定左右朝向，缺省自动布局 */
  direction?: MindMapNodeDirection
  /**
   * 分支颜色覆盖（`#rrggbb`）。
   * 缺省由主题调色板按「第几个主分支」自动分配，即彩虹分支；
   * 该节点的所有子孙分支都会继承这个颜色。
   */
  color?: string
  /** 节点图片 */
  image?: MindMapImage
  /** 节点附件（非图片，画布上显示为卡片） */
  attachments?: MindMapAttachment[]
  /** 节点图标（白名单内的名字） */
  icons?: MindMapIcon[]
  /** 节点标签 */
  tags?: MindMapTag[]
  /** 超链接（只允许 http/https） */
  href?: string
  /** 子节点 */
  children: MindMapNode[]
}

/** 整篇思维导图 */
export interface MindMapDocument {
  schema: typeof MINDMAP_FILE_SCHEMA
  version: number
  /** 根节点 */
  root: MindMapNode
  /** 画布默认朝向；缺省为双向（左右分叉） */
  direction?: 'side' | 'left' | 'right' | 'down'
  /**
   * 彩虹分支：按调色板给每个主分支分配不同颜色（对齐 XMind 的「彩虹分支」）。
   * 缺省（未写入时）视为开启；关闭后所有分支使用同一种强调色。
   */
  rainbowBranches?: boolean
  /** 节点之间的连线 */
  arrows?: MindMapArrow[]
  /** 概要 */
  summaries?: MindMapSummary[]
}

/** 节点 id 前缀，便于排查与人工阅读 */
const NODE_ID_PREFIX = 'n_'

let nodeIdCounter = 0

/**
 * 生成节点 id。
 * 采用「时间戳 + 递增序号」而不是随机串：同一会话内生成顺序可读，
 * 且避免 Math.random 在同一毫秒内碰撞导致渲染层 id 冲突。
 */
export function createNodeId(): string {
  nodeIdCounter += 1
  return `${NODE_ID_PREFIX}${Date.now().toString(36)}${nodeIdCounter.toString(36)}`
}

/** 创建单个节点 */
export function createMindMapNode(text = '', children: MindMapNode[] = []): MindMapNode {
  return { id: createNodeId(), text, children }
}

/** 新建空白思维导图（中心主题占位，方便用户直接开始输入） */
export function createEmptyMindMap(rootText = '中心主题'): MindMapDocument {
  return {
    schema: MINDMAP_FILE_SCHEMA,
    version: MINDMAP_VERSION,
    root: createMindMapNode(rootText)
  }
}
