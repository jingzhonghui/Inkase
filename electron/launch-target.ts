import * as fs from 'node:fs'
import * as path from 'node:path'

export type LaunchTargetKind = 'file' | 'directory'

export interface LaunchTarget {
  path: string
  kind: LaunchTargetKind
}

type InspectTarget = (target: string) => LaunchTargetKind | null

/** 可作为文档直接打开的扩展名（文件夹不受限制） */
const DOCUMENT_EXTENSIONS = ['.md', '.mdx', '.inkmind', '.drawio']

function inspectTarget(target: string): LaunchTargetKind | null {
  try {
    const stat = fs.statSync(target)
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
  } catch {
    // Ignore stale shell entries and malformed arguments.
  }
  return null
}

export function parseLaunchTargets(
  argv: string[],
  inspect: InspectTarget = inspectTarget
): string[] {
  const targets: string[] = []
  const seen = new Set<string>()

  for (const raw of argv) {
    if (!raw || raw.startsWith('-')) continue
    const kind = inspect(raw)
    if (!kind) continue
    if (kind === 'file' && !DOCUMENT_EXTENSIONS.includes(path.extname(raw).toLowerCase())) continue

    const key = process.platform === 'win32' ? raw.toLowerCase() : raw
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(raw)
  }
  return targets
}

export function inspectLaunchTarget(target: string): LaunchTarget | null {
  const kind = inspectTarget(target)
  return kind ? { path: target, kind } : null
}
