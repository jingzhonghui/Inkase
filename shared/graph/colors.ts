/**
 * 顶部文件夹 → 稳定配色。
 *
 * 图谱里唯一可靠的「分组」信号是顶层文件夹，所以颜色只按它算，
 * 且必须稳定：同一份数据每次打开、每次重新构建，同一个文件夹都得是同一个颜色，
 * 否则用户刚建立的「蓝的那一簇」记忆会失效。
 */

/** 根目录文档的专用色相（也是所有子目录必须避让的色带中心） */
export const ROOT_FOLDER_HUE = 215

/** 根目录色相两侧避让的度数：子目录不会落在 195–235 之间 */
const ROOT_HUE_GUARD = 20

/** 根目录在图例与信息卡里的显示名 */
export const ROOT_FOLDER_LABEL = '根目录'

function hashString(value: string): number {
  // djb2 变体：足够分散，且不依赖平台（不要用 Math.random 或取对象地址）
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/**
 * 文件夹的稳定色相（0–359）。
 *
 * 空字符串代表根目录，固定取 `ROOT_FOLDER_HUE`；其余文件夹把哈希值
 * 映射到「避开根目录色带」的那一段圆弧上。
 */
export function folderHue(folder: string): number {
  if (!folder) return ROOT_FOLDER_HUE
  const span = 360 - 2 * ROOT_HUE_GUARD
  const offset = hashString(folder) % span
  return (ROOT_FOLDER_HUE + ROOT_HUE_GUARD + offset) % 360
}

/**
 * 一个文件夹在画布与侧栏里的颜色。
 *
 * 只有一格：**实心填充**。侧栏色标与画布上的点取同一个值，
 * 用户在两处看到的是同一支笔画的同一件事。
 */
export interface FolderColor {
  hue: number
  /** 节点实心填充色 / 侧栏色标 */
  fill: string
}

export type GraphTheme = 'light' | 'dark'

/**
 * 文件夹 → 实心色。
 *
 * 早先的版本画的是「一圈墨线 + 一层几乎没有颜色的底」：担心满屏实心高饱和圆点
 * 每个都在抢注意力。实际用下来是反的——空心小环在浅色纸上太轻，
 * 缩到 8px 时几乎只剩一个圈，图的「密度」读不出来，而颜色又同时跑到了标签上，
 * 于是整屏是「彩色小字 + 灰线」，比一屏色点更吵。
 *
 * 现在按画布上最有效的分工来：**颜色只出现在点上，文字一律走中性墨色**
 * （见 `graphPalette`）。于是：
 * - 浅色底上压暗到 47% 明度，白底上 3:1 以上，8px 的点也立得住；
 * - 深色底上提亮到 64%，避免深蓝深紫糊进 `#1f2937`。
 * - 饱和度取在 66–72%：够分簇，又不至于三十个目录排开像调色盘。
 */
export function folderColor(folder: string, theme: GraphTheme): FolderColor {
  const hue = folderHue(folder)
  return {
    hue,
    fill:
      theme === 'dark'
        ? `hsl(${hue}, 72%, 64%)`
        : `hsl(${hue}, 66%, 47%)`
  }
}

/**
 * 画布的中性配色。
 *
 * 这一组值与官网（`website/assets/graph.css` + `style.css`）用的是同一套语义：
 * 底色＝面板 surface、边＝`--edge-hi`、常规标签＝三级文字、焦点标签＝正文墨色、
 * 选中＝强调色光环、断链＝红色虚线。
 *
 * 放在这里而不是散在 `render.ts` 里，是因为画布拿不到 CSS 变量：
 * 所有颜色必须以纯函数形式随主题一起给出，才能在单元测试里断言。
 */
export interface GraphPalette {
  /** 画布底色：与面板 surface 同一档，画布不再是独立的一张「纸」 */
  canvas: string
  /** 普通边 */
  edge: string
  /** 与焦点（hover 优先于选中）相连的边 */
  edgeFocus: string
  /** 常规标签文字 */
  label: string
  /** 焦点 / 选中节点标签文字 */
  labelFocus: string
  /** 选中光环 */
  accent: string
  /** 断链边与幽灵节点描边 */
  broken: string
}

export function graphPalette(theme: GraphTheme): GraphPalette {
  if (theme === 'dark') {
    return {
      canvas: '#1f2937',
      edge: '#3a4553',
      edgeFocus: '#94a3b8',
      label: '#8b95a4',
      labelFocus: '#e5e7eb',
      accent: '#60a5fa',
      broken: 'hsl(2, 78%, 68%)'
    }
  }

  return {
    canvas: '#ffffff',
    edge: '#d8dde4',
    edgeFocus: '#8b95a4',
    label: '#5b6472',
    labelFocus: '#1f2937',
    accent: '#2563eb',
    broken: 'hsl(2, 68%, 46%)'
  }
}

/** 断链幽灵节点的描边色（与文件夹色带彻底拉开，避免被误认为某一簇） */
export function unresolvedColor(theme: GraphTheme): string {
  return graphPalette(theme).broken
}
