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

export interface FolderColor {
  hue: number
  /** 节点填充色 */
  fill: string
  /** 节点描边色 */
  stroke: string
  /** 该簇的标签文字色 */
  label: string
  /** 图例色块 / chips 用色（不透明，小面积下仍然可辨） */
  swatch: string
}

export type GraphTheme = 'light' | 'dark'

/**
 * 按主题取一整套颜色。
 *
 * 深色底上要提亮、浅色底上要压暗，饱和度也要跟着调——
 * 直接复用同一个 HSL 会在其中一种主题下糊成一团。
 *
 * 编码方式与常见网络图相反：节点不是「彩色实心球」，而是
 * **一圈墨线 + 一层几乎没有颜色的底**。实心高饱和的圆点铺满一屏后，
 * 每个点都在抢注意力，颜色只剩「分了几簇」这一个信息，
 * 却把边、标签、形状全压住了。改成墨线描边之后：
 * 色相仍然分簇（描边承担），面积让位给留白，小圆点看起来也更锐利。
 *
 * - 浅色：描边取低明度（40% 上下）的同一色相，底几乎接近纸色（96%）
 * - 深色：描边反过来提亮到 66%，底压到深墨（26%）
 * 标签色都走同一色相的深/浅两端，保证文字与自己的点是一支笔写的。
 */
export function folderColor(folder: string, theme: GraphTheme): FolderColor {
  const hue = folderHue(folder)
  const dark = theme === 'dark'

  if (dark) {
    return {
      hue,
      fill: `hsla(${hue}, 40%, 26%, 0.72)`,
      stroke: `hsl(${hue}, 60%, 66%)`,
      label: `hsl(${hue}, 30%, 86%)`,
      swatch: `hsl(${hue}, 52%, 62%)`
    }
  }

  return {
    hue,
    fill: `hsla(${hue}, 56%, 96%, 0.94)`,
    stroke: `hsl(${hue}, 44%, 41%)`,
    label: `hsl(${hue}, 32%, 29%)`,
    swatch: `hsl(${hue}, 44%, 45%)`
  }
}

/** 断链幽灵节点的配色：与所有文件夹色带都拉开，避免被误认为某个簇 */
export function unresolvedColor(theme: GraphTheme): FolderColor {
  const dark = theme === 'dark'
  return {
    hue: 0,
    fill: dark ? 'hsla(0, 0%, 0%, 0)' : 'hsla(0, 0%, 100%, 0)',
    stroke: dark ? 'hsl(2, 66%, 64%)' : 'hsl(2, 60%, 52%)',
    label: dark ? 'hsl(2, 58%, 76%)' : 'hsl(2, 56%, 42%)',
    swatch: dark ? 'hsl(2, 66%, 64%)' : 'hsl(2, 60%, 52%)'
  }
}
