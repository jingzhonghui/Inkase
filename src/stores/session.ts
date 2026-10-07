import type { EditorMode } from './file'

const SESSION_STORAGE_KEY = 'inkase-session'

export interface SessionState {
  openedFolderPath: string | null
  openFilePaths: string[]
  activeFilePath: string | null
  sidebarCollapsed: boolean
  sidebarWidth?: number
  editorMode: EditorMode
  aiPanelOpen: boolean
  aiPanelActive?: boolean
  aiActiveConversationId: string | null
  maxOpenTabs?: number
}

export function loadSessionState(): SessionState | null {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY)
    if (saved) {
      return JSON.parse(saved) as SessionState
    }
  } catch {
    // 忽略解析错误
  }
  return null
}

export function saveSessionState(state: SessionState): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 忽略存储错误
  }
}

export function clearSessionState(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // 忽略
  }
}
