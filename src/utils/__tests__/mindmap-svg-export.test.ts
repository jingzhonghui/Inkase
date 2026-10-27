// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import MindElixir from 'mind-elixir'
import { MINDMAP_FILE_SCHEMA, type MindMapDocument } from '../../types/mindmap'
import { toElixirData } from '../mindmap/adapter'
import {
  blendOver,
  buildMindMapSvg,
  countLineBoxes,
  createTextMetrics,
  escapeXml,
  offsetWithin,
  parseColor,
  readCanvasScale,
  readGradientTint,
  tokenizeForWrap,
  wrapText
} from '../mindmap/svg-export'

/**
 * SVG 导出的单元测试。
 *
 * jsdom 没有布局引擎（`offsetLeft` 全是 0），所以这里对几何做**显式注入**：
 * 用 `defineProperty` 给元素写上 offset/client 尺寸，再构造一套和渲染库同构的 DOM。
 * 这样能断言的是真正的构图逻辑（位置、混色、描边、换行、折叠标记、转义），
 * 而不是「跑起来没报错」。
 */

/* ------------------------------ 纯函数 ------------------------------ */

// jsdom 没装 canvas 包：显式让 getContext 返回 null，走「按字符估宽」的退化路径，
// 顺带消掉每次调用都会打印的 "Not implemented: getContext" 噪声
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('svg-export 纯函数', () => {
  it('parseColor 认识 hex / rgb / rgba，不认识就返回 null', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('#11223380')).toEqual({ r: 17, g: 34, b: 51, a: 128 / 255 })
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor('transparent')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor('var(--x)')).toBeNull()
  })

  it('blendOver 把半透明底纹合成到不透明底色上', () => {
    // 齐次项：alpha = 0 时就是底色
    expect(blendOver('rgb(245, 247, 250)', null)).toBe('rgb(245, 247, 250)')
    expect(blendOver('rgb(245, 247, 250)', { r: 74, g: 125, b: 255, a: 0 })).toBe(
      'rgb(245, 247, 250)'
    )
    // 16% 分支色叠在灰底上：和画布上「不透明底色 + 半透明底纹」的观感一致
    expect(blendOver('rgb(245, 247, 250)', { r: 74, g: 125, b: 255, a: 0.16 })).toBe(
      'rgb(218, 227, 251)'
    )
    // 底色解析不出来时退回底纹本身，而不是画成透明
    expect(blendOver('var(--x)', { r: 10, g: 20, b: 30, a: 1 })).toBe('rgb(10, 20, 30)')
  })

  it('readGradientTint 只认 linear-gradient 里的第一个颜色', () => {
    expect(readGradientTint('none')).toBeNull()
    expect(readGradientTint('')).toBeNull()
    expect(
      readGradientTint('linear-gradient(rgba(74, 125, 255, 0.16), rgba(74, 125, 255, 0.16))')
    ).toEqual({ r: 74, g: 125, b: 255, a: 0.16 })
    expect(readGradientTint('url("a.png")')).toBeNull()
  })

  it('escapeXml 转义会破坏 XML 的字符', () => {
    expect(escapeXml('A & B <c> "d" \'e\'')).toBe('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;')
  })

  it('tokenizeForWrap 在西文单词处不断行，在汉字处断行', () => {
    expect(tokenizeForWrap('Hello world')).toEqual(['Hello ', 'world'])
    expect(tokenizeForWrap('中文')).toEqual(['中', '文'])
    expect(tokenizeForWrap('A中B')).toEqual(['A', '中', 'B'])
  })

  it('wrapText 按可用宽度贪心断行', () => {
    // 每个字符固定 10px，70px 宽 → 每行 7 个字符
    const measure = (value: string) => value.length * 10
    // 整串西文没有空格 → 按字符硬断
    expect(wrapText('0123456789ABCDEFGHIJ', 70, measure)).toEqual(['0123456', '789ABCD', 'EFGHIJ'])
    // 有空格时只在空格处断，行尾不留空格
    expect(wrapText('abc def ghi', 70, measure)).toEqual(['abc', 'def ghi'])
    expect(wrapText('abc def', 70, measure)).toEqual(['abc def'])
    // 超长单词按字符硬断
    expect(wrapText('ABCDEFGHIJKLMN', 50, measure)).toEqual(['ABCDE', 'FGHIJ', 'KLMN'])
    // 空文本 / 无宽度约束时不折腾
    expect(wrapText('', 70, measure)).toEqual([''])
    expect(wrapText('abc', 0, measure)).toEqual(['abc'])
    // 汉字之间可以断行
    expect(wrapText('中文内容测试', 40, measure)).toEqual(['中文内容', '测试'])
  })
})

/* ------------------------------ 构图的 DOM 夹具 ------------------------------ */

/** 每个元素的计算样式（jsdom 的 CSS 引擎不保证解析渐变，直接注入最可靠） */
const styles = new WeakMap<Element, Record<string, string>>()

const DEFAULT_STYLE: Record<string, string> = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  borderTopWidth: '0px',
  borderTopColor: 'rgba(0, 0, 0, 0)',
  borderTopLeftRadius: '0px',
  paddingLeft: '0px',
  paddingRight: '0px',
  fontFamily: 'Test Sans',
  fontStyle: 'normal',
  fontWeight: '400',
  fontSize: '16px',
  lineHeight: '24px',
  color: 'rgb(51, 51, 51)'
}

function computedStyleOf(element: Element): CSSStyleDeclaration {
  const own = styles.get(element) ?? {}
  const merged = { ...DEFAULT_STYLE, ...own }
  // 只要实现被读取的那几个属性即可，其余按 undefined 交给调用方
  return merged as unknown as CSSStyleDeclaration
}

interface Box {
  left?: number
  top?: number
  width?: number
  height?: number
}

/** jsdom 不做布局：把几何量直接钉在元素上 */
function setBox(element: HTMLElement, box: Box, parent: HTMLElement | null): void {
  const define = (name: string, value: number): void => {
    Object.defineProperty(element, name, { value, configurable: true })
  }
  define('offsetLeft', box.left ?? 0)
  define('offsetTop', box.top ?? 0)
  define('offsetWidth', box.width ?? 0)
  define('offsetHeight', box.height ?? 0)
  define('clientWidth', box.width ?? 0)
  define('clientHeight', box.height ?? 0)
  Object.defineProperty(element, 'offsetParent', { value: parent, configurable: true })
}

interface MapFixture {
  root: HTMLElement
  nodes: HTMLElement
  branchTopic: HTMLElement
  branchText: HTMLElement
  rootTopic: HTMLElement
  expander: HTMLElement
}

/**
 * 构造一份与渲染库同构的 DOM：
 * `me-nodes` 里左右各一个 `me-main`，`me-wrapper > me-parent > me-tpc > span.text`，
 * 外加连线层 `.lines` / `.subLines`。
 */
function mountMap(): MapFixture {
  const root = document.createElement('div')
  root.className = 'map-container'
  root.innerHTML = `
    <div class="map-canvas">
      <me-nodes>
        <me-main class="rhs">
          <me-wrapper>
            <me-parent>
              <me-tpc><span class="text"></span></me-tpc>
              <me-epd class="minus"></me-epd>
            </me-parent>
            <svg class="subLines" overflow="visible">
              <path d="M 30 0 C 0 0 0 0 -30 0 H 30" stroke="#4a7dff" fill="none" stroke-width="2"></path>
            </svg>
          </me-wrapper>
        </me-main>
        <me-root><me-tpc><span class="text"></span></me-tpc></me-root>
        <svg class="lines" overflow="visible">
          <path d="M0 0 L 10 10" stroke="#4a7dff" fill="none" stroke-width="3"></path>
        </svg>
      </me-nodes>
    </div>`
  document.body.appendChild(root)

  const nodes = root.querySelector<HTMLElement>('me-nodes') as HTMLElement
  const wrapper = root.querySelector<HTMLElement>('me-wrapper') as HTMLElement
  const parent = root.querySelector<HTMLElement>('me-parent') as HTMLElement
  const branchTopic = root.querySelector<HTMLElement>('me-main me-tpc') as HTMLElement
  const branchText = branchTopic.querySelector<HTMLElement>('.text') as HTMLElement
  const expander = root.querySelector<HTMLElement>('me-epd') as HTMLElement
  const rootEl = root.querySelector<HTMLElement>('me-root') as HTMLElement
  const rootTopic = rootEl.querySelector<HTMLElement>('me-tpc') as HTMLElement
  const rootSpan = rootTopic.querySelector<HTMLElement>('.text') as HTMLElement

  // 分支：wrapper(400,100) → parent(0,0) → tpc(0,0,120x40)，文字在 padding 内
  setBox(wrapper, { left: 400, top: 100, width: 120, height: 40 }, nodes)
  setBox(parent, { left: 0, top: 0, width: 120, height: 40 }, wrapper)
  setBox(branchTopic, { left: 0, top: 0, width: 120, height: 40 }, parent)
  setBox(branchText, { left: 25, top: 8, width: 70, height: 24 }, branchTopic)
  setBox(expander, { left: 110, top: 31, width: 18, height: 18 }, parent)
  // 根主题：(100,200) 160x50
  setBox(rootEl, { left: 100, top: 200, width: 160, height: 50 }, nodes)
  setBox(rootTopic, { left: 0, top: 0, width: 160, height: 50 }, rootEl)
  setBox(rootSpan, { left: 30, top: 10, width: 100, height: 30 }, rootTopic)

  styles.set(branchTopic, {
    backgroundColor: 'rgb(245, 247, 250)',
    backgroundImage: 'linear-gradient(rgba(74, 125, 255, 0.16), rgba(74, 125, 255, 0.16))',
    borderTopWidth: '2px',
    borderTopColor: 'rgb(74, 125, 255)',
    borderTopLeftRadius: '8px',
    paddingLeft: '25px',
    paddingRight: '25px'
  })
  styles.set(rootTopic, {
    backgroundColor: 'rgb(74, 125, 255)',
    borderTopWidth: '0px',
    borderTopLeftRadius: '10px',
    paddingLeft: '30px',
    paddingRight: '30px'
  })
  styles.set(rootSpan, { color: 'rgb(255, 255, 255)', fontSize: '25px', lineHeight: '30px' })

  return { root, nodes, branchTopic, branchText, rootTopic, expander }
}

describe('buildMindMapSvg', () => {
  beforeEach(() => {
    vi.stubGlobal('getComputedStyle', (element: Element) => computedStyleOf(element))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('没有画布 / 没有主题时返回 null', () => {
    expect(buildMindMapSvg(null)).toBeNull()

    const empty = document.createElement('div')
    empty.className = 'map-container'
    document.body.appendChild(empty)
    expect(buildMindMapSvg(empty)).toBeNull()
  })

  it('按主题包围盒 + 留白决定画布尺寸', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'
    fixture.rootTopic.querySelector('.text')!.textContent = '中心主题'

    const result = buildMindMapSvg(fixture.root, { margin: 48 })
    expect(result).not.toBeNull()
    // x: 100 → 520（分支右缘），y: 100 → 250（根主题下缘）
    expect(result!.width).toBe(420 + 48 * 2)
    expect(result!.height).toBe(150 + 48 * 2)
    expect(result!.svg).not.toMatch(/NaN|undefined/)
    expect(result!.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(result!.svg.endsWith('</svg>')).toBe(true)
  })

  it('内容整体平移到留白之内', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'

    const { svg } = buildMindMapSvg(fixture.root, { margin: 48 })!
    // 内容最小 x/y 都是 100，留白 48 → 平移 -52
    expect(svg).toContain('<g transform="translate(-52 -52)">')
    expect(svg).toContain('x="400"')
  })

  it('主题底色是「底色 + 分支底纹」合成后的不透明色，并带描边与圆角', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'

    const { svg } = buildMindMapSvg(fixture.root, { margin: 48 })!
    expect(svg).toContain('fill="rgb(218, 227, 251)"')
    expect(svg).toContain('stroke="rgb(74, 125, 255)"')
    expect(svg).toContain('stroke-width="2"')
    expect(svg).toContain('rx="8"')
    // 根主题没有描边、圆角不同
    expect(svg).toContain('fill="rgb(74, 125, 255)"')
    expect(svg).toContain('rx="10"')
  })

  it('文字用 <text> 绘制并保留字号与颜色', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'

    const { svg } = buildMindMapSvg(fixture.root, { margin: 48 })!
    expect(svg).toContain('>分支 A</text>')
    expect(svg).toContain('font-size="16"')
    expect(svg).toContain('fill="rgb(51, 51, 51)"')
    expect(svg).toContain('xml:space="preserve"')
  })

  it('主题文字里的 XML 特殊字符会被转义', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = 'A & B <c>'

    const { svg } = buildMindMapSvg(fixture.root, { margin: 48 })!
    // 无论折成几行，`&` 与 `<` `>` 都必须转义，否则整份 SVG 会解析失败
    expect(svg).toContain('A &amp; B')
    expect(svg).toContain('&lt;c&gt;')
    expect(svg).not.toContain('<c>')
  })

  it('连线层原样搬进导出结果', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'

    const { svg } = buildMindMapSvg(fixture.root, { margin: 48 })!
    expect(svg).toContain('M0 0 L 10 10')
    expect(svg).toContain('M 30 0 C 0 0 0 0 -30 0 H 30')
  })

  it('折叠的主题补一个标记，展开的不补', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'
    expect(buildMindMapSvg(fixture.root, { margin: 48 })!.svg).not.toContain('<circle')

    // 渲染库给折叠状态的 me-epd 去掉 `minus` 类
    fixture.expander.classList.remove('minus')
    expect(buildMindMapSvg(fixture.root, { margin: 48 })!.svg).toContain('<circle')
  })

  it('长主题按主题内容宽度折行', () => {
    const fixture = mountMap()
    // 内容宽度 120 - 25 - 25 = 70px，16px 汉字每字 16px → 每行 4 字
    fixture.branchText.textContent = '一二三四五六七八'

    const { svg } = buildMindMapSvg(fixture.root, { margin: 48 })!
    const lines = svg.match(/<text [^>]*>[^<]+<\/text>/g) ?? []
    const branchLines = lines.filter((line) => /[一二三四五六七八]/.test(line))
    expect(branchLines.length).toBe(2)
    expect(branchLines[0]).toContain('一二三四')
    expect(branchLines[1]).toContain('五六七八')
  })

  it('画布背景不透明时铺一层底色，透明时不铺', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '分支 A'

    expect(buildMindMapSvg(fixture.root, { margin: 48 })!.svg).not.toContain('<rect x="0" y="0"')

    styles.set(fixture.root, { backgroundColor: 'rgb(255, 255, 255)' })
    expect(buildMindMapSvg(fixture.root, { margin: 48 })!.svg).toContain(
      '<rect x="0" y="0" width="516" height="246" fill="rgb(255, 255, 255)"/>'
    )
  })

  it('offsetWithin 逐级累加定位祖先的偏移', () => {
    const fixture = mountMap()
    // 分支文字的累计偏移 = 25(tpc 内) + 0 + 0 + 400(wrapper)
    expect(offsetWithin(fixture.nodes, fixture.branchText)).toEqual({ left: 425, top: 108 })
  })

  it('readCanvasScale 从 .map-canvas 的 transform 矩阵读缩放，读不到就当 1', () => {
    const fixture = mountMap()
    const canvas = fixture.root.querySelector('.map-canvas') as HTMLElement
    // 没有 transform（jsdom / 1x）→ 1
    expect(readCanvasScale(fixture.nodes)).toBe(1)

    styles.set(canvas, { transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' })
    expect(readCanvasScale(fixture.nodes)).toBe(0.5)

    styles.set(canvas, { transform: 'matrix(1.75, 0, 0, 1.75, 0, 0)' })
    expect(readCanvasScale(fixture.nodes)).toBe(1.75)

    // 不在 .map-canvas 里时退化成 1，不会除出 Infinity
    const orphan = document.createElement('me-nodes')
    expect(readCanvasScale(orphan)).toBe(1)
  })

  it('countLineBoxes 在无布局环境里返回 0 而不是抛错', () => {
    const fixture = mountMap()
    fixture.branchText.textContent = '中文'
    expect(countLineBoxes(fixture.branchText)).toBe(0)
  })

  it('createTextMetrics 在没有 canvas 时也能给出正数度量', () => {
    const metrics = createTextMetrics()
    expect(metrics.width('中文测试', '16px Test Sans')).toBeGreaterThan(0)
    expect(metrics.ascent('16px Test Sans')).toBeGreaterThan(0)
    expect(metrics.descent('16px Test Sans')).toBeGreaterThan(0)
  })
})

/* ------------------------------ 与真实渲染库联调 ------------------------------ */

describe('buildMindMapSvg 与真实 mind-elixir', () => {
  const doc: MindMapDocument = {
    schema: MINDMAP_FILE_SCHEMA,
    version: 1,
    direction: 'side',
    root: {
      id: 'n_root',
      text: '中心主题',
      children: [
        {
          id: 'n_a',
          text: '分支 A & 细节',
          children: [{ id: 'n_a1', text: '叶子', children: [] }]
        },
        { id: 'n_b', text: '分支 B', collapsed: true, children: [] }
      ]
    }
  }

  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    )
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('能导出真实 DOM 且包含全部主题文本，不出现 NaN', () => {
    const el = document.createElement('div')
    el.style.width = '800px'
    el.style.height = '600px'
    document.body.appendChild(el)
    const mind = new MindElixir({
      el,
      direction: MindElixir.SIDE,
      editable: true,
      toolBar: false,
      keypress: false,
      allowUndo: false,
      contextMenu: false
    })
    mind.init(toElixirData(doc))

    const result = buildMindMapSvg(el)
    expect(result).not.toBeNull()
    expect(result!.svg).toContain('中心主题')
    expect(result!.svg).toContain('分支 A &amp; 细节')
    expect(result!.svg).toContain('叶子')
    // 只校验我们自己写的几何属性：渲染库在无布局环境（jsdom）下算出的连线
    // `d="M NaN 0 ..."` 是它自己的除零结果，真实浏览器里不会出现
    expect(result!.svg).not.toMatch(/ (x|y|width|height|rx|ry|font-size)="NaN"/)
    expect(result!.width).toBeGreaterThan(0)
    expect(result!.height).toBeGreaterThan(0)

    mind.destroy()
  })
})
