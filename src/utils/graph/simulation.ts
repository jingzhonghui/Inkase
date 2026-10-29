/**
 * 力导向布局。
 *
 * 设计文档原本选 `d3-force`，实现改成自带的等价版本，原因与取舍写在
 * `docs/2026-10-28-knowledge-graph-design.md` §5.8：它只做数值计算、不碰 DOM，
 * 而这个项目没有网络安装窗口，少一个依赖就少一个「装完才能跑」的门槛。
 * 对外接口（`reheat` / `pin` / `release` / `stop` / `positions`）与 d3 的用法保持一致，
 * 将来要换回去只需改这个文件。
 *
 * 关键取指策略：
 * - 斥力用**网格近似**（远格按质心、近格逐个算），2000 节点也不会退化成 O(n²)；
 * - 初位置由节点 id 哈希决定，同一份数据每次打开都是同一个形状；
 * - 收敛（alpha < alphaMin）后不再 tick，静止时零开销。
 */

export interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** 被钉住时的固定坐标 */
  fx: number | null
  fy: number | null
  radius: number
}

export interface SimLink {
  source: string
  target: string
  count: number
}

export interface SimNodeSeed {
  id: string
  radius: number
}

export const SIM_ALPHA_MIN = 0.001
export const SIM_ALPHA_DECAY = 0.0228
const VELOCITY_DECAY = 0.4
const LINK_DISTANCE = 60
const LINK_STRENGTH = 0.1
const CHARGE_STRENGTH = -120
const CHARGE_DISTANCE_MAX = 600
const CHARGE_MIN_DISTANCE2 = 1
const CENTER_STRENGTH = 0.04
/** 超过这个节点数就不注册碰撞力（碰撞是 O(邻域) 且洗牌感最强） */
const COLLIDE_MAX_NODES = 1500

function hashString(value: string): number {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/** 由 id 决定初始角度与半径：确定性布局，不会「每次打开都换个形状」 */
function seedPosition(id: string): { x: number; y: number } {
  const hash = hashString(id)
  const angle = ((hash % 3600) / 3600) * Math.PI * 2
  const radius = 40 + (hash % 360)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

interface GridCell {
  cx: number
  cy: number
  nodes: SimNode[]
  mass: number
  mx: number
  my: number
}

export interface GraphSimulation {
  /** id → 位置与速度（渲染层直接用） */
  positions: Map<string, SimNode>
  /** 推进一帧；返回 false 表示已收敛 */
  tick(): boolean
  /** 重新加热（数据变化或用户拖动后调用） */
  reheat(alpha?: number): void
  /** 钉住节点（拖动时） */
  pin(id: string, x: number, y: number): void
  /** 释放节点（双击时） */
  release(id: string): void
  stop(): void
  /** 当前是否还在跑 */
  isRunning(): boolean
}

export interface CreateSimulationOptions {
  nodes: readonly SimNodeSeed[]
  links: readonly SimLink[]
  /** 沿用上一次布局的坐标（重建后不重排，只有新节点被播种） */
  previousPositions?: ReadonlyMap<string, { x: number; y: number }>
}

export function createSimulation(options: CreateSimulationOptions): GraphSimulation {
  const positions = new Map<string, SimNode>()

  for (const seed of options.nodes) {
    const previous = options.previousPositions?.get(seed.id)
    const seeded = previous ?? seedPosition(seed.id)
    positions.set(seed.id, {
      id: seed.id,
      x: seeded.x,
      y: seeded.y,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      radius: seed.radius
    })
  }

  const links = options.links.filter(
    (link) => positions.has(link.source) && positions.has(link.target)
  )
  const enableCollide = positions.size <= COLLIDE_MAX_NODES

  let alpha = 1
  let running = true
  // 小库用小网格（力更精确），大库用大网格（计算量可控）
  const cellSize = suggestCellSize(options.nodes.length)
  const cellRange = Math.ceil(CHARGE_DISTANCE_MAX / cellSize)

  const nodeList = (): SimNode[] => [...positions.values()]

  function buildGrid(nodes: SimNode[]): Map<string, GridCell> {
    const grid = new Map<string, GridCell>()
    for (const node of nodes) {
      const cx = Math.floor(node.x / cellSize)
      const cy = Math.floor(node.y / cellSize)
      const key = `${cx},${cy}`
      let cell = grid.get(key)
      if (!cell) {
        cell = { cx, cy, nodes: [], mass: 0, mx: 0, my: 0 }
        grid.set(key, cell)
      }
      cell.nodes.push(node)
      cell.mass += 1
      cell.mx += node.x
      cell.my += node.y
    }
    for (const cell of grid.values()) {
      cell.mx /= cell.mass
      cell.my /= cell.mass
    }
    return grid
  }

  function applyLinkForce(nodesById: Map<string, SimNode>): void {
    for (const link of links) {
      const source = nodesById.get(link.source)
      const target = nodesById.get(link.target)
      if (!source || !target) continue

      let dx = target.x + target.vx - (source.x + source.vx)
      let dy = target.y + target.vy - (source.y + source.vy)
      let distance = Math.hypot(dx, dy)
      if (distance < 1e-6) {
        // 完全重合时给一个确定性的微小偏移，否则永远分不开
        dx = (hashString(source.id) % 7) - 3 || 1
        dy = (hashString(target.id) % 7) - 3 || 1
        distance = Math.hypot(dx, dy)
      }

      // 重复链接（count > 1）的边更强，但不超过 0.5，避免少数边把图拽成一团
      const strength = Math.min(0.5, LINK_STRENGTH * Math.max(1, link.count))
      const bias = (distance - LINK_DISTANCE) / distance * strength * alpha
      const fx = dx * bias
      const fy = dy * bias

      target.vx -= fx
      target.vy -= fy
      source.vx += fx
      source.vy += fy
    }
  }

  function applyChargeForce(nodes: SimNode[]): void {
    const grid = buildGrid(nodes)

    for (const node of nodes) {
      const cx = Math.floor(node.x / cellSize)
      const cy = Math.floor(node.y / cellSize)

      for (let gx = cx - cellRange; gx <= cx + cellRange; gx++) {
        for (let gy = cy - cellRange; gy <= cy + cellRange; gy++) {
          const cell = grid.get(`${gx},${gy}`)
          if (!cell) continue

          const isNear = gx >= cx - 1 && gx <= cx + 1 && gy >= cy - 1 && gy <= cy + 1
          if (isNear) {
            // 近处逐个算，否则相邻节点会被质心近似抹平，挤成一点
            for (const other of cell.nodes) {
              if (other === node) continue
              pushApart(node, other.x, other.y, 1)
            }
            continue
          }

          // 远处整格当一个大质量单体
          pushApart(node, cell.mx, cell.my, cell.mass)
        }
      }
    }
  }

  function pushApart(node: SimNode, ox: number, oy: number, mass: number): void {
    let dx = ox - node.x
    let dy = oy - node.y
    let distance2 = dx * dx + dy * dy
    if (distance2 > CHARGE_DISTANCE_MAX * CHARGE_DISTANCE_MAX) return
    if (distance2 < CHARGE_MIN_DISTANCE2) distance2 = CHARGE_MIN_DISTANCE2

    const distance = Math.sqrt(distance2)
    // jiggle：离得极近时给一点随机化，帮助重合节点散开
    if (distance < 1) {
      dx = (hashString(node.id) % 5) - 2 || 1
      dy = 2
    }

    const force = (CHARGE_STRENGTH * mass * alpha) / distance2
    const factor = (dx / distance) * force
    const factorY = (dy / distance) * force
    node.vx += factor
    node.vy += factorY
  }

  function applyCenterForce(nodes: SimNode[]): void {
    for (const node of nodes) {
      node.vx -= node.x * CENTER_STRENGTH * alpha
      node.vy -= node.y * CENTER_STRENGTH * alpha
    }
  }

  function applyCollideForce(nodes: SimNode[]): void {
    const grid = buildGrid(nodes)
    for (const node of nodes) {
      const cx = Math.floor(node.x / cellSize)
      const cy = Math.floor(node.y / cellSize)
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = grid.get(`${gx},${gy}`)
          if (!cell) continue
          for (const other of cell.nodes) {
            if (other === node) continue
            const dx = other.x - node.x
            const dy = other.y - node.y
            const distance = Math.hypot(dx, dy) || 1e-6
            const minDistance = node.radius + other.radius + 2
            if (distance >= minDistance) continue
            const overlap = (minDistance - distance) * 0.5
            const ux = (dx / distance) * overlap
            const uy = (dy / distance) * overlap
            node.vx -= ux
            node.vy -= uy
            other.vx += ux
            other.vy += uy
          }
        }
      }
    }
  }

  function integrate(nodes: SimNode[]): void {
    const damping = 1 - VELOCITY_DECAY
    for (const node of nodes) {
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx
        node.y = node.fy
        node.vx = 0
        node.vy = 0
        continue
      }
      node.vx *= damping
      node.vy *= damping
      node.x += node.vx
      node.y += node.vy
    }
  }

  return {
    positions,

    tick(): boolean {
      if (!running) return false

      const nodes = nodeList()
      if (nodes.length === 0) {
        running = false
        return false
      }

      const nodesById = new Map(nodes.map((node) => [node.id, node]))

      applyLinkForce(nodesById)
      applyChargeForce(nodes)
      applyCenterForce(nodes)
      if (enableCollide) applyCollideForce(nodes)
      integrate(nodes)

      alpha += (0 - alpha) * SIM_ALPHA_DECAY
      if (alpha < SIM_ALPHA_MIN) {
        alpha = SIM_ALPHA_MIN
        running = false
        return false
      }
      return true
    },

    reheat(next = 0.6): void {
      alpha = Math.max(alpha, Math.min(1, next))
      running = true
    },

    pin(id, x, y): void {
      const node = positions.get(id)
      if (!node) return
      node.fx = x
      node.fy = y
      node.x = x
      node.y = y
      node.vx = 0
      node.vy = 0
      running = true
    },

    release(id): void {
      const node = positions.get(id)
      if (!node) return
      node.fx = null
      node.fy = null
      running = true
    },

    stop(): void {
      running = false
    },

    isRunning(): boolean {
      return running
    }
  }
}

/** 供渲染层参考的初始缩放：网格随节点数增大，避免小库挤成一坨 */
export function suggestCellSize(nodeCount: number): number {
  if (nodeCount <= 200) return 60
  if (nodeCount <= 800) return 100
  return 140
}

export const SIM_DEFAULTS = {
  linkDistance: LINK_DISTANCE,
  alphaMin: SIM_ALPHA_MIN,
  chargeDistanceMax: CHARGE_DISTANCE_MAX,
  collideEnabled: (nodeCount: number): boolean => nodeCount <= COLLIDE_MAX_NODES,
  centerStrength: CENTER_STRENGTH
} as const
