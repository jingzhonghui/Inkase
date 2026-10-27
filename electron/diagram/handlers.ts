/**
 * 图表相关的 IPC。
 *
 * 只有一条：把「webapp 在不在、在哪」告诉渲染层。
 * 渲染层据此决定是挂 iframe 还是显示「缺少组件，请运行 pnpm run fetch:drawio」。
 *
 * 为什么要问主进程而不是渲染层自己拼路径：
 * 打包后 webapp 在 `process.resourcesPath` 下，渲染层拿不到这个值；
 * 同时这也让「找不到组件」变成一个可解释的状态，而不是 iframe 白屏。
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'
import { describeDiagramWebapp } from './protocol'

export interface DiagramSupportInfo {
  available: boolean
  root: string
  scheme: string
  host: string
}

export function registerDiagramHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.DIAGRAM.INFO,
    (): { success: boolean; data?: DiagramSupportInfo; error?: string } => {
      try {
        return { success: true, data: describeDiagramWebapp() }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : '未知错误'
        }
      }
    }
  )
}
