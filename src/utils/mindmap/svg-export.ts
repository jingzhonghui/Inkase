/**
 * 思维导图 → SVG
 *
 * 为什么不用渲染库自带的 `exportSvg()`：
 * 1. 它已被标记为 deprecated。默认实现走 `<foreignObject>` 包 HTML 文本，而浏览器把
 *    SVG 当作 `<img>` 栅格化时**不会渲染 foreignObject**——导出的 PNG 会是一张没有
 *    任何文字的图。它的 `noForeignObject` 分支虽然改用 `<text>`，但会把每行文本直接
 *    塞进 `innerHTML`，主题里出现 `<`、`&` 就能破坏整段 SVG。
 * 2. 它只读主题的 `backgroundColor`。彩虹分支的底纹是叠在底色之上的
 *    `background-image: linear-gradient(...)`（见 `branch-color.ts`），于是导出结果里
 *    所有主题都会退回同一个灰底，和画布上「一支一色」的观感不符。
 * 3. 它写死 100px 边距、并且把内容整体偏移一个 `me-nodes` 的内边距量，
 *    小图/大图的留白都不好看。
 *
 * 因此这里从**实时 DOM** 抄一份矢量图：
 * - 几何一律用 `offsetLeft / offsetTop / offsetWidth / offsetHeight`：这些值不受
 *   当前缩放（`transform: scale()`）影响，导出的图与画布缩放无关；
 * - 颜色一律用 `getComputedStyle`：导出的是用户眼前那一版配色（明暗主题、彩虹分支、
 *   单分支手选色都会如实反映），而不是重新算一遍；
 * - 文字用 `<text>` + 显式基线：没有 foreignObject，任何浏览器、Inkscape、
 *   Illustrator 都能正常打开。
 */

/** 画布内容四周的留白（px），与主题阴影/折叠标记的溢出量匹配 */
export const MINDMAP_EXPORT_MARGIN = 48

/** 主题节点元素（与 `context-menu.ts` 判定的一致） */
const TOPIC_SELECTOR = 'me-tpc'
/** 渲染库的坐标原点：所有主题都相对它排版 */
const NODES_SELECTOR = 'me-nodes'

export interface MindMapSvgOptions {
  /** 四周留白，默认 `MINDMAP_EXPORT_MARGIN` */
  margin?: number
  /** 背景色；`null` 表示透明背景。默认取画布自己的计算背景色 */
  background?: string | null
}

export interface MindMapSvgResult {
  /** 完整的 `<svg>` 文本，可直接存成 `.svg` */
  svg: string
  width: number
  height: number
}

/* ------------------------------ 文本度量 ------------------------------ */

/**
 * 文本度量。
 *
 * 单独抽出来是为了能在 jsdom（没有 canvas）里测：那里 `getContext('2d')` 返回 null，
 * 会走「按字符估宽」的退化路径，构图逻辑本身仍然可测。
 */
export interface MindMapTextMetrics {
  width(text: string, font: string): number
  ascent(font: string): number
  descent(font: string): number
}

/** 全角字符：CJK、假名、全角标点……它们的宽度基本等于字号 */
function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

/** 退化估宽：没有 canvas 时按「全角 1em、半角 0.55em」估，够用于纯结构校验 */
function estimateWidth(text: string, fontSize: number): number {
  let units = 0
  for (const char of text) units += isWideChar(char) ? 1 : 0.55
  return units * fontSize
}

/** 从 font 简写里取出字号，用于退路计算 */
function fontSizeOf(font: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match ? Number.parseFloat(match[1]) : 16
}

/**
 * 默认度量实现：优先用 canvas，缺失时退化为估算法。
 * canvas 与浏览器排版共用同一套字体度量，所以它量出来的换行位置和画布最接近。
 */
export function createTextMetrics(): MindMapTextMetrics {
  let cached: CanvasRenderingContext2D | null | undefined

  function context(): CanvasRenderingContext2D | null {
    if (cached !== undefined) return cached
    try {
      // jsdom 等环境没有 canvas 实现，这里会拿到 null（或直接抛错），都退化成估宽
      cached = document.createElement('canvas').getContext('2d') ?? null
    } catch {
      cached = null
    }
    return cached
  }

  return {
    width(text, font) {
      const ctx = context()
      if (!ctx) return estimateWidth(text, fontSizeOf(font))
      ctx.font = font
      return ctx.measureText(text).width
    },
    ascent(font) {
      const ctx = context()
      if (!ctx) return fontSizeOf(font) * 0.8
      ctx.font = font
      const metrics = ctx.measureText('Hg')
      // fontBoundingBox* 才是行高计算实际用的那组度量（Chrome/Safari 支持）
      return metrics.fontBoundingBoxAscent || fontSizeOf(font) * 0.8
    },
    descent(font) {
      const ctx = context()
      if (!ctx) return fontSizeOf(font) * 0.2
      ctx.font = font
      const metrics = ctx.measureText('Hg')
      return metrics.fontBoundingBoxDescent || fontSizeOf(font) * 0.2
    }
  }
}

/* ------------------------------ 纯函数工具 ------------------------------ */

/** XML 转义。主题里出现 `A & B <c>` 时不会破坏整段 SVG */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 数值写进 SVG 前的兜底：NaN / Infinity 会直接毁掉整份文件 */
function num(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** 解析 `rgb() / rgba() / #rrggbb / #rgb`，解析不了返回 null */
export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase()
  if (!text || text === 'transparent' || text === 'none') return null

  const hex = /^#([0-9a-f]{3,8})$/.exec(text)
  if (hex) {
    const raw = hex[1]
    if (raw.length === 3 || raw.length === 4) {
      return {
        r: Number.parseInt(raw[0] + raw[0], 16),
        g: Number.parseInt(raw[1] + raw[1], 16),
        b: Number.parseInt(raw[2] + raw[2], 16),
        a: raw.length === 4 ? Number.parseInt(raw[3] + raw[3], 16) / 255 : 1
      }
    }
    if (raw.length === 6 || raw.length === 8) {
      return {
        r: Number.parseInt(raw.slice(0, 2), 16),
        g: Number.parseInt(raw.slice(2, 4), 16),
        b: Number.parseInt(raw.slice(4, 6), 16),
        a: raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1
      }
    }
    return null
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(text)
  if (!fn) return null
  const parts = fn[1]
    .split(/[\s,/]+/)
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part))
  if (parts.length < 3) return null
  return {
    r: parts[0],
    g: parts[1],
    b: parts[2],
    a: parts.length >= 4 ? parts[3] : 1
  }
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/**
 * 把一层半透明色调叠到底色上，返回不透明的 `rgb(...)`。
 *
 * 画布上的主题底色是「不透明底色 + 半透明渐变底纹」两层（见 `branch-color.ts`），
 * SVG 里没必要真的画两层——两层算完的结果是纯色，直接合成一个实色更干净，
 * 也能保证主题始终不透明、连线不会透到文字上。
 */
export function blendOver(base: string, tint: Rgba | null): string | null {
  const bottom = parseColor(base)
  if (!bottom) {
    if (!tint) return null
    return `rgb(${clampChannel(tint.r)}, ${clampChannel(tint.g)}, ${clampChannel(tint.b)})`
  }
  if (!tint || tint.a <= 0) {
    return `rgb(${clampChannel(bottom.r)}, ${clampChannel(bottom.g)}, ${clampChannel(bottom.b)})`
  }
  const alpha = Math.min(1, tint.a)
  return `rgb(${clampChannel(bottom.r * (1 - alpha) + tint.r * alpha)}, ${clampChannel(
    bottom.g * (1 - alpha) + tint.g * alpha
  )}, ${clampChannel(bottom.b * (1 - alpha) + tint.b * alpha)})`
}

/**
 * 从 `linear-gradient(rgba(...), rgba(...))` 里取第一层颜色。
 *
 * 分支底纹是 `linear-gradient(同一个色, 同一个色)`（见 `branch-color.ts`），
 * 取第一个色标就等价于整层。取不到（`none`、图片背景、多色渐变）时返回 null，
 * 主题按纯底色绘制，宁可与画布略有差异也不乱猜。
 */
export function readGradientTint(backgroundImage: string): Rgba | null {
  if (!backgroundImage || backgroundImage === 'none') return null
  const match = /rgba?\([^)]*\)/.exec(backgroundImage)
  return match ? parseColor(match[0]) : null
}

/* ------------------------------ 换行 ------------------------------ */

/** 可以在任意位置断行的字符（CJK、全角标点） */
function isBreakable(char: string): boolean {
  return isWideChar(char)
}

/**
 * 切成「不可再分的排版单元」：CJK 一字一个单元，西文按词（空格留在词尾）。
 * 这样换行只会在空格或汉字之间发生，不会把 `Inkase` 劈成 `Ink / ase`。
 */
export function tokenizeForWrap(text: string): string[] {
  const tokens: string[] = []
  let word = ''
  const flush = (): void => {
    if (word) {
      tokens.push(word)
      word = ''
    }
  }
  for (const char of text) {
    if (isBreakable(char)) {
      flush()
      tokens.push(char)
    } else if (char === ' ' || char === '\t') {
      word += char
      flush()
    } else {
      word += char
    }
  }
  flush()
  return tokens
}

/** 单个单元比整行还宽时（长 URL、无空格长串）按字符硬断 */
function breakByChar(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const pieces: string[] = []
  let buffer = ''
  for (const char of text) {
    const candidate = buffer + char
    if (buffer && measure(candidate) > maxWidth) {
      pieces.push(buffer)
      buffer = char
    } else {
      buffer = candidate
    }
  }
  if (buffer) pieces.push(buffer)
  return pieces.length > 0 ? pieces : ['']
}

/**
 * 贪心换行。
 *
 * 画布上的主题是 `white-space: pre-wrap` + `max-width: 35em` 的普通 div，
 * 浏览器会自动折行；SVG 的 `<text>` 不会。所以必须自己按同样的可用宽度断一遍，
 * 否则长主题在导出的图里会横着戳出方框。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number
): string[] {
  if (!(maxWidth > 0) || text.length === 0) return [text]

  const lines: string[] = []
  let current = ''
  const commit = (): void => {
    // 行尾空格不参与视觉，去掉避免 `xml:space="preserve"` 把它们画出来
    lines.push(current.replace(/[ \t]+$/, ''))
    current = ''
  }

  for (const token of tokenizeForWrap(text)) {
    // 放不下了：本行先结束
    if (current && measure(current + token) > maxWidth) commit()
    // 单个单元就比整行还宽（长 URL、无空格长串）：只能按字符硬断
    if (!current && measure(token) > maxWidth) {
      const pieces = breakByChar(token, maxWidth, measure)
      for (const piece of pieces.slice(0, -1)) lines.push(piece)
      current = pieces[pieces.length - 1] ?? ''
      continue
    }
    current += token
  }

  if (current) commit()
  return lines.length > 0 ? lines : ['']
}

/* ------------------------------ 几何 ------------------------------ */

/**
 * 数出浏览器把这段文字排成了几行。
 *
 * `white-space: pre-wrap` 的主题会自动折行，但 DOM 只给出一个整块矩形，
 * 拿不到「排了几行、每行多高」。对文本节点取 Range 的 client rects 就能拿到
 * 逐行的行盒——这是浏览器排版的结果，比自己按字体度量推算准得多。
 * 在没有布局的环境（jsdom）里返回 0，调用方走估算退路。
 */
export function countLineBoxes(element: HTMLElement): number {
  try {
    const range = document.createRange()
    range.selectNodeContents(element)
    const boxes = Array.from(range.getClientRects()).filter((box) => box.height > 0)
    range.detach?.()
    return boxes.length
  } catch {
    return 0
  }
}

/** 元素的布局尺寸 / 位置（不受画布 `transform: scale()` 影响） */
function layoutBox(
  element: HTMLElement,
  scale: number
): { left: number; top: number; width: number; height: number } | null {
  const box = element.getBoundingClientRect()
  if (!(box.width > 0) || !(box.height > 0)) return null
  return {
    left: box.left / scale,
    top: box.top / scale,
    width: box.width / scale,
    height: box.height / scale
  }
}
/**
 * 画布当前的缩放系数。
 *
 * `.map-canvas` 上的 `transform: scale(z)` 会同步放大 `getBoundingClientRect`，
 * 而导出必须是布局单位（与缩放无关），所以量出来的矩形要除回去。
 * 直接读 transform 矩阵而不是用 `rect.width / offsetWidth`：后者被
 * `offsetWidth` 的取整污染，1x 下也会算出 0.9975 这种误差。
 */
export function readCanvasScale(element: HTMLElement): number {
  const canvas = element.closest('.map-canvas') ?? element.parentElement
  if (!canvas) return 1
  const transform = getComputedStyle(canvas).transform
  const matrix = /^matrix\(([^,]+),/.exec(transform ?? '')
  const scale = matrix ? Number.parseFloat(matrix[1]) : Number.NaN
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** 元素左上角相对 `root` 的偏移（padding 边，不含 `root` 自身的 padding） */
export function offsetWithin(
  root: HTMLElement,
  element: HTMLElement
): { left: number; top: number } {
  let left = 0
  let top = 0
  let current: HTMLElement | null = element
  // 逐级累加 offsetLeft/offsetTop：`me-parent`、`me-wrapper` 都是定位元素，
  // 只读主题自身的 offsetLeft 会得到「相对父主题」的值，位置全错。
  while (current && current !== root) {
    left += current.offsetLeft
    top += current.offsetTop
    current = current.offsetParent as HTMLElement | null
  }
  return { left, top }
}

/* ------------------------------ 主流程 ------------------------------ */

interface TextLine {
  text: string
  x: number
  y: number
}

interface TopicLayout {
  left: number
  top: number
  width: number
  height: number
  radius: number
  fill: string | null
  stroke: string | null
  strokeWidth: number
  font: {
    family: string
    size: number
    weight: string
    style: string
    color: string
  } | null
  lines: TextLine[]
  /** 折叠主题的展开标记（有隐藏子主题时才有） */
  badge: { cx: number; cy: number; radius: number; fill: string } | null
}

function findNodes(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  return (
    (root.matches(NODES_SELECTOR) ? root : null) ??
    root.querySelector<HTMLElement>(NODES_SELECTOR) ??
    // 容错：调用方直接传了 `.map-container` 内部元素时，往上找一次
    (root.closest(NODES_SELECTOR) as HTMLElement | null)
  )
}

function readTopicLayout(
  nodes: HTMLElement,
  topic: HTMLElement,
  metrics: MindMapTextMetrics,
  scale: number
): TopicLayout {
  const box = offsetWithin(nodes, topic)
  const style = getComputedStyle(topic)
  const borderWidth = Number.parseFloat(style.borderTopWidth) || 0
  const strokeColor = style.borderTopColor?.trim() ?? ''
  const tint = readGradientTint(style.backgroundImage)
  // 尺寸优先用小数：`offsetWidth` 会取整，主题底色与边框之间会差出半像素
  const measured = layoutBox(topic, scale)

  const layout: TopicLayout = {
    left: box.left,
    top: box.top,
    width: measured?.width ?? topic.offsetWidth,
    height: measured?.height ?? topic.offsetHeight,
    radius: Number.parseFloat(style.borderTopLeftRadius) || 0,
    fill: blendOver(style.backgroundColor ?? '', tint),
    stroke: borderWidth > 0 ? strokeColor || null : null,
    strokeWidth: borderWidth,
    font: null,
    lines: [],
    badge: null
  }

  const text = topic.querySelector<HTMLElement>(':scope > .text')
  const content = (text?.textContent ?? topic.textContent ?? '').replace(/\r\n?/g, '\n')
  if (content.trim()) {
    const textStyle = getComputedStyle(text ?? topic)
    const size = Number.parseFloat(textStyle.fontSize) || 16
    const font = `${textStyle.fontStyle} ${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`
    const ascent = metrics.ascent(font)
    const descent = metrics.descent(font)

    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
    const paddingRight = Number.parseFloat(style.paddingRight) || 0
    const borderX =
      (Number.parseFloat(style.borderLeftWidth) || 0) +
      (Number.parseFloat(style.borderRightWidth) || 0)

    /*
     * 折行宽度取**小数**的内容盒宽度。
     * `clientWidth` 是取整值：一行文字刚好填满时（实测 176.1 对 176），
     * 用它当上限会让这段文字被错误地多折一行，导出的图里就会多出一条
     * 戳出方框的字。再补 0.25px 亚像素容差，抵消布局与 canvas 度量的抖动。
     */
    const measuredWidth = measured?.width ?? 0
    const contentWidth = measuredWidth > 0 ? measuredWidth : topic.clientWidth
    const available = contentWidth - paddingLeft - paddingRight - borderX + 0.25

    /*
     * 行高优先用浏览器自己排出的行盒高度。
     * 主题样式没写 line-height（计算值就是字符串 "normal"），`parseFloat` 会拿到
     * NaN；退回「1.2 倍字号」就会比真实的 1.34 倍小，多行主题会逐行往上漂，
     * 最后一行明显贴不到底部。span 总高 ÷ 浏览器排出的行数才是真值。
     */
    const spanBox = text ? layoutBox(text, scale) : null
    const domLines = text ? countLineBoxes(text) : 0
    const declaredLineHeight = Number.parseFloat(textStyle.lineHeight)
    const lineHeight =
      spanBox && domLines > 0
        ? spanBox.height / domLines
        : Number.isFinite(declaredLineHeight) && declaredLineHeight > 0
          ? declaredLineHeight
          : size * 1.35

    // 行盒上下各有半行距，基线 = 行顶 + 半行距 + 字号上沿
    const baselineInLine = (lineHeight - (ascent + descent)) / 2 + ascent
    const textBox = offsetWithin(nodes, text ?? topic)

    const rawLines = content.split('\n')
    const wrapped = rawLines.flatMap((line) =>
      wrapText(line, available, (value) => metrics.width(value, font))
    )

    layout.font = {
      family: textStyle.fontFamily,
      size,
      weight: textStyle.fontWeight,
      style: textStyle.fontStyle,
      color: textStyle.color
    }
    layout.lines = wrapped.map((line, index) => ({
      text: line,
      x: textBox.left,
      y: textBox.top + index * lineHeight + baselineInLine
    }))
  }

  // 折叠标记：渲染库给展开状态的 me-epd 加 `minus`（透明度 0），
  // 去掉这个类就是「已折叠、还有子主题没画出来」。导出时补一个标记，
  // 否则读者看不出这张图里其实还藏着内容。
  const expander = topic.closest('me-parent')?.querySelector<HTMLElement>(':scope > me-epd')
  if (expander && !expander.classList.contains('minus') && layout.lines.length > 0) {
    const at = offsetWithin(nodes, expander)
    const marker = Math.max(
      8,
      Math.min(expander.offsetWidth || 16, expander.offsetHeight || 16) / 2
    )
    layout.badge = {
      cx: at.left + (expander.offsetWidth || 16) / 2,
      cy: at.top + (expander.offsetHeight || 16) / 2,
      radius: marker * 0.6,
      fill: layout.stroke ?? layout.font?.color ?? '#94a3b8'
    }
  }

  return layout
}

/** 把连线那一层 `<svg>` 的子节点抽出来，稍后整体平移到位 */
function readConnectorContent(svg: Element | null | undefined): string {
  if (!svg) return ''
  return Array.from(svg.children)
    .map((child) => child.outerHTML)
    .join('')
}

/**
 * 从实时 DOM 生成 SVG。
 *
 * @param root 包含渲染库 DOM 的容器（`.mind-map-scroll` 或 `.map-container` 都行）
 * @returns 没有可导出的内容时返回 null
 */
export function buildMindMapSvg(
  root: HTMLElement | null,
  options: MindMapSvgOptions = {}
): MindMapSvgResult | null {
  const nodes = findNodes(root)
  if (!nodes) return null

  const topics = Array.from(nodes.querySelectorAll<HTMLElement>(TOPIC_SELECTOR))
  if (topics.length === 0) return null

  const margin = Number.isFinite(options.margin)
    ? Math.max(0, options.margin as number)
    : MINDMAP_EXPORT_MARGIN
  const metrics = createTextMetrics()
  const scale = readCanvasScale(nodes)
  const layouts = topics.map((topic) => readTopicLayout(nodes, topic, metrics, scale))

  // 内容包围盒只按主题算：连线永远在主题之间，折叠标记略超出主题，由 margin 兜住
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const layout of layouts) {
    if (!(layout.width > 0) || !(layout.height > 0)) continue
    minX = Math.min(minX, layout.left)
    minY = Math.min(minY, layout.top)
    maxX = Math.max(maxX, layout.left + layout.width)
    maxY = Math.max(maxY, layout.top + layout.height)
  }
  // 没有量到尺寸（jsdom、隐藏容器）时退化成一张最小可用的画布，绝不写 NaN 进 SVG
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    minX = 0
    minY = 0
    maxX = 0
    maxY = 0
  }

  /*
   * 画布尺寸取整到整数像素。
   * 内容包围盒是小数（布局本来就有亚像素），若原样写进 `width/height`，
   * 栅格化时目标画布只能取整，就会把整张图非等比拉伸半个像素。
   * 宁可右/下留白多出不到 1px。
   */
  const width = Math.max(1, Math.ceil(num(maxX - minX) + margin * 2))
  const height = Math.max(1, Math.ceil(num(maxY - minY) + margin * 2))
  const translateX = margin - minX
  const translateY = margin - minY

  const mapContainer = nodes.closest('.map-container') ?? nodes
  const canvasBackground =
    options.background === undefined
      ? getComputedStyle(mapContainer).backgroundColor
      : options.background

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  )
  const background = canvasBackground ? parseColor(canvasBackground) : null
  if (background && background.a > 0) {
    parts.push(
      `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(canvasBackground as string)}"/>`
    )
  }
  parts.push(`<g transform="translate(${num(translateX)} ${num(translateY)})">`)

  // 连线画在主题下面：主题底色不透明，重叠处只会露出该露出的那一段
  for (const wrapper of Array.from(nodes.querySelectorAll('me-wrapper'))) {
    const content = readConnectorContent(wrapper.querySelector(':scope > .subLines'))
    if (!content) continue
    const at = offsetWithin(nodes, wrapper as HTMLElement)
    parts.push(`<g transform="translate(${num(at.left)} ${num(at.top)})">${content}</g>`)
  }
  const mainLines = readConnectorContent(nodes.querySelector(':scope > .lines'))
  if (mainLines) parts.push(`<g>${mainLines}</g>`)
  // 概要（summary）与主题连线都是渲染库画好的纯 SVG，原样搬过来
  const extras = readConnectorContent(nodes.querySelector(':scope > .summary'))
  if (extras) parts.push(`<g>${extras}</g>`)

  for (const layout of layouts) {
    const radius = num(layout.radius)
    const rectAttrs = [
      `x="${num(layout.left)}"`,
      `y="${num(layout.top)}"`,
      `width="${num(layout.width)}"`,
      `height="${num(layout.height)}"`,
      `rx="${radius}"`,
      `ry="${radius}"`,
      `fill="${escapeXml(layout.fill ?? 'transparent')}"`
    ]
    if (layout.stroke) {
      rectAttrs.push(`stroke="${escapeXml(layout.stroke)}"`)
      rectAttrs.push(`stroke-width="${num(layout.strokeWidth)}"`)
    }
    parts.push(`<rect ${rectAttrs.join(' ')}/>`)

    if (layout.font && layout.lines.length > 0) {
      const font = layout.font
      const attrs = [
        `font-family="${escapeXml(font.family)}"`,
        `font-size="${num(font.size)}"`,
        `font-weight="${escapeXml(font.weight)}"`,
        `font-style="${escapeXml(font.style)}"`,
        `fill="${escapeXml(font.color)}"`,
        'xml:space="preserve"'
      ].join(' ')
      for (const line of layout.lines) {
        if (!line.text) continue
        parts.push(
          `<text x="${num(line.x)}" y="${num(line.y)}" ${attrs}>${escapeXml(line.text)}</text>`
        )
      }
    }

    if (layout.badge) {
      const { cx, cy, radius: r, fill } = layout.badge
      parts.push(
        `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${escapeXml(fill)}"/>`,
        `<path d="M ${num(cx - r * 0.5)} ${num(cy)} H ${num(cx + r * 0.5)} M ${num(cx)} ${num(
          cy - r * 0.5
        )} V ${num(cy + r * 0.5)}" stroke="#ffffff" stroke-width="${num(
          Math.max(1.5, r / 4)
        )}" stroke-linecap="round" fill="none"/>`
      )
    }
  }

  parts.push('</g>')
  parts.push('</svg>')
  return { svg: parts.join(''), width, height }
}
