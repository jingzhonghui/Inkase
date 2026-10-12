import { ref, type Ref } from 'vue'
import { useAiStore } from '../ai'
import { compareFolderEntries } from '../../utils/folder-sort'
import { requestFileConflictAction } from '../../utils/file-conflict'
import type { FileTreeNode, FolderItem, TabInfo } from './types'

export interface FolderDeps {
  tabs: Ref<TabInfo[]>
  activeTabId: Ref<string | null>
  stateVersion: Ref<number>
  editorResetVersion: Ref<number>
  error: Ref<string | null>
  isLoading: Ref<boolean>
  openFile: (filePath?: string, options?: { addToRecent?: boolean; excludeFromRecent?: boolean }) => Promise<boolean>
  loadRecentFiles: () => Promise<void>
  persistSession: () => void
  closeTab: (tabId: string) => Promise<boolean>
}

/**
 * 文件夹浏览 + 文件/文件夹 CRUD（上下文菜单）
 */
export function useFolder(deps: FolderDeps) {
  const { tabs, activeTabId, stateVersion } = deps

  const openedFolderPath = ref<string | null>(null)
  const folderItems = ref<FolderItem[]>([])
  const folderHistory = ref<string[]>([])
  const fileTree = ref<FileTreeNode[]>([])
  const selectedPaths = ref<string[]>([])
  const selectionAnchor = ref<string | null>(null)

  /** 按当前展开状态深度优先展平可见节点路径 */
  function collectVisiblePaths(nodes: FileTreeNode[]): string[] {
    const result: string[] = []
    const visit = (list: FileTreeNode[]): void => {
      for (const node of list) {
        result.push(node.path)
        if (node.isDirectory && node.isExpanded) visit(node.children)
      }
    }
    visit(nodes)
    return result
  }

  function isSelected(path: string): boolean {
    return selectedPaths.value.includes(path)
  }

  function selectOnly(path: string): void {
    selectedPaths.value = [path]
    selectionAnchor.value = path
  }

  function toggleSelected(path: string): void {
    selectedPaths.value = isSelected(path)
      ? selectedPaths.value.filter((item) => item !== path)
      : [...selectedPaths.value, path]
    selectionAnchor.value = path
  }

  function selectRange(path: string): void {
    const visible = collectVisiblePaths(fileTree.value)
    const anchor = selectionAnchor.value
    const anchorIndex = anchor ? visible.indexOf(anchor) : -1
    const targetIndex = visible.indexOf(path)
    if (anchorIndex === -1 || targetIndex === -1) {
      selectOnly(path)
      return
    }
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
    selectedPaths.value = visible.slice(start, end + 1)
  }

  function selectAllVisible(): void {
    const root = fileTree.value[0]
    const candidates = root ? collectVisiblePaths(root.children) : collectVisiblePaths(fileTree.value)
    selectedPaths.value = candidates
    selectionAnchor.value = candidates[0] ?? null
  }

  function clearSelection(): void {
    selectedPaths.value = []
    selectionAnchor.value = null
  }

  /** 判断路径是否位于当前已打开的文件夹内（不含文件夹根本身） */
  function isInsideOpenedFolder(filePath: string): boolean {
    const folderPath = openedFolderPath.value
    if (!folderPath) return false
    const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    return normalize(filePath).startsWith(`${normalize(folderPath)}/`)
  }

  function pruneSelection(): void {
    const visible = new Set(collectVisiblePaths(fileTree.value))
    selectedPaths.value = selectedPaths.value.filter((item) => visible.has(item))
    if (selectionAnchor.value && !visible.has(selectionAnchor.value)) {
      selectionAnchor.value = null
    }
  }

  function relocateSelection(sourcePath: string, newPath: string): void {
    const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    const normalizedSource = normalize(sourcePath)
    selectedPaths.value = selectedPaths.value.map((item) => {
      const normalizedItem = normalize(item)
      if (normalizedItem === normalizedSource) return newPath
      if (normalizedItem.startsWith(`${normalizedSource}/`)) return newPath + item.slice(sourcePath.length)
      return item
    })
    if (selectionAnchor.value) {
      const normalizedAnchor = normalize(selectionAnchor.value)
      if (normalizedAnchor === normalizedSource) selectionAnchor.value = newPath
      else if (normalizedAnchor.startsWith(`${normalizedSource}/`)) {
        selectionAnchor.value = newPath + selectionAnchor.value.slice(sourcePath.length)
      }
    }
  }

  /** 按 path 收集树中已存在的节点（用于刷新时保留展开状态与已加载的子节点）。 */
  function collectOldNodes(nodes: FileTreeNode[]): Map<string, FileTreeNode> {
    const map = new Map<string, FileTreeNode>()
    const visit = (list: FileTreeNode[]): void => {
      for (const node of list) {
        map.set(node.path, node)
        if (node.isDirectory) visit(node.children)
      }
    }
    visit(nodes)
    return map
  }

  /**
   * 递归重读已展开的目录节点，使磁盘上直接新增/删除的文件能同步到树中。
   * 重读子层时保留各节点的展开状态；逐层异步进行，不阻塞 readFolder 本身。
   */
  async function refreshExpandedChildren(nodes: FileTreeNode[]): Promise<void> {
    for (const node of nodes) {
      if (!node.isDirectory || !node.isExpanded) continue
      const oldChildren = collectOldNodes(node.children)
      const result = await window.electronAPI?.readFolder(node.path)
      if (result?.success && result.data) {
        node.children = result.data.map((item: FolderItem) => {
          const old = oldChildren.get(item.path)
          return {
            name: item.name,
            path: item.path,
            isDirectory: item.isDirectory,
            isExpanded: old ? old.isExpanded : false,
            isLoading: false,
            children: old ? old.children : []
          }
        })
        await refreshExpandedChildren(node.children)
      }
    }
  }

  async function readFolder(dirPath: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false

      const result = await window.electronAPI.readFolder(dirPath)
      if (result.success && result.data) {
        openedFolderPath.value = dirPath
        folderItems.value = result.data
        if (typeof window.electronAPI.authorizeWorkspaceRoot === 'function') {
          await window.electronAPI.authorizeWorkspaceRoot(dirPath)
        }

        // 同步更新 fileTree 根节点的子节点，使侧边栏文件树即时刷新；
        // 保留原有节点的展开状态与已加载的子节点，避免刷新后文件树收起
        if (fileTree.value.length > 0 && fileTree.value[0].path === dirPath) {
          const oldNodes = collectOldNodes(fileTree.value[0].children)
          fileTree.value[0].children = result.data.map((item: FolderItem) => {
            const old = oldNodes.get(item.path)
            return {
              name: item.name,
              path: item.path,
              isDirectory: item.isDirectory,
              isExpanded: old ? old.isExpanded : false,
              isLoading: false,
              children: old ? old.children : []
            }
          })
          // 已展开的子目录重新读取，让磁盘上直接新增/删除的文件也能显示
          // （watcher 与手动"刷新"都只走根目录 readFolder，不会触发 loadChildren）
          void refreshExpandedChildren(fileTree.value[0].children)
        }

        pruneSelection()
        return true
      }
      return false
    } catch (err) {
      deps.error.value = err instanceof Error ? err.message : '读取文件夹失败'
      return false
    }
  }

  async function openFolder(): Promise<boolean> {
    deps.isLoading.value = true
    deps.error.value = null

    try {
      if (!window.electronAPI) {
        deps.error.value = 'Electron API 不可用'
        return false
      }

      const dialogResult = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择文件夹'
      })

      if (!dialogResult.success || !dialogResult.data || dialogResult.data.length === 0) {
        return false
      }

      return await openFolderPath(dialogResult.data[0])
    } catch (err) {
      deps.error.value = err instanceof Error ? err.message : '打开文件夹失败'
      return false
    } finally {
      deps.isLoading.value = false
    }
  }

  async function openFolderPath(dirPath: string): Promise<boolean> {
    const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    const isSameFolder =
      openedFolderPath.value !== null && normalize(openedFolderPath.value) === normalize(dirPath)

    // 切换到不同文件夹时先关闭当前全部标签（复用关闭流程处理未保存内容）；
    // 任一标签取消关闭或保存失败则中止切换，保持原工作区不变
    if (!isSameFolder) {
      const tabIds = tabs.value.map((tab) => tab.id)
      for (const tabId of tabIds) {
        if (!(await deps.closeTab(tabId))) return false
      }
      clearSelection()
    }

    const success = await readFolder(dirPath)

    // 初始化文件树
    if (success) {
      // 记录到最近打开列表（文件夹类型），并立即刷新渲染进程的列表
      window.electronAPI?.addRecentFile?.(dirPath, 'folder')
      await deps.loadRecentFiles()

      const folderName = dirPath.split(/[/\\]/).pop() || dirPath
      fileTree.value = [
        {
          name: folderName,
          path: dirPath,
          isDirectory: true,
          isExpanded: true,
          isLoading: false,
          children: folderItems.value.map((item) => ({
            name: item.name,
            path: item.path,
            isDirectory: item.isDirectory,
            isExpanded: false,
            isLoading: false,
            children: []
          }))
        }
      ]
      deps.persistSession()
      await useAiStore().loadConversations(dirPath)
    }

    return success
  }

  async function loadChildren(node: FileTreeNode): Promise<void> {
    if (!node.isDirectory || node.isLoading) return

    node.isLoading = true
    try {
      const result = await window.electronAPI?.readFolder(node.path)
      if (result?.success && result.data) {
        node.children = result.data.map((item: FolderItem) => ({
          name: item.name,
          path: item.path,
          isDirectory: item.isDirectory,
          isExpanded: false,
          isLoading: false,
          children: []
        }))
      }
    } catch {
      // 忽略错误
    } finally {
      node.isLoading = false
    }
  }

  async function expandNode(node: FileTreeNode): Promise<void> {
    node.isExpanded = true
    if (node.isDirectory && node.children.length === 0) {
      await loadChildren(node)
    }
  }

  function collapseNode(node: FileTreeNode): void {
    node.isExpanded = false
  }

  async function toggleNode(node: FileTreeNode): Promise<void> {
    if (node.isExpanded) {
      collapseNode(node)
    } else {
      await expandNode(node)
    }
  }

  async function closeFolder(): Promise<boolean> {
    const folderPath = openedFolderPath.value
    if (folderPath) {
      const normalizedFolder = folderPath.replace(/[\\/]+/g, '/').replace(/\/$/, '')
      const folderTabs = tabs.value.filter((tab) => {
        const path = tab.fileInfo?.path
        return !!path && path.replace(/[\\/]+/g, '/').startsWith(`${normalizedFolder}/`)
      })
      for (const tab of folderTabs) {
        const closed = await deps.closeTab(tab.id)
        if (!closed) return false
      }
    }

    openedFolderPath.value = null
    folderItems.value = []
    folderHistory.value = []
    fileTree.value = []
    clearSelection()
    if (typeof window.electronAPI?.authorizeWorkspaceRoot === 'function') {
      void window.electronAPI.authorizeWorkspaceRoot(null).catch(() => {})
    }
    deps.persistSession()
    void useAiStore().loadConversations(null)
    return true
  }

  async function navigateToFolder(dirPath: string): Promise<boolean> {
    return await readFolder(dirPath)
  }

  async function navigateUp(): Promise<boolean> {
    if (!openedFolderPath.value) return false
    const parts = openedFolderPath.value.split(/[/\\]/)
    parts.pop()
    const parentPath = parts.join('/')
    if (!parentPath || parentPath === openedFolderPath.value) return false
    return await readFolder(parentPath)
  }

  /** 展开文件所在的所有父目录，支持按需加载尚未展开的目录。 */
  async function revealFileInTree(filePath: string): Promise<void> {
    const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    const target = normalize(filePath)

    async function visit(nodes: FileTreeNode[]): Promise<boolean> {
      for (const node of nodes) {
        const nodePath = normalize(node.path)
        if (!node.isDirectory) {
          if (nodePath === target) return true
          continue
        }

        if (target !== nodePath && !target.startsWith(`${nodePath}/`)) continue
        if (!node.isExpanded || node.children.length === 0) await expandNode(node)
        if (await visit(node.children)) return true
      }
      return false
    }

    await visit(fileTree.value)
  }

  /** 将新建的文件/文件夹节点增量插入树中；父目录尚未加载时回退到全量刷新根节点。 */
  function insertCreatedNode(parentPath: string, node: FileTreeNode): void {
    const parent = findNodeInTree(fileTree.value, parentPath)
    if (!parent) {
      void readFolder(openedFolderPath.value!)
      return
    }
    insertNodeSorted(parent.children, node)
    if (parent.path === openedFolderPath.value) syncRootItems()
  }

  async function createFile(dirPath: string, name: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false
      const result = await window.electronAPI.createFile(dirPath, name)
      if (result.success && result.data?.path) {
        insertCreatedNode(dirPath, {
          name,
          path: result.data.path,
          isDirectory: false,
          isExpanded: false,
          isLoading: false,
          children: []
        })
        return await deps.openFile(result.data.path, { addToRecent: false, excludeFromRecent: true })
      }
      return false
    } catch {
      return false
    }
  }

  async function createFolder(parentPath: string, name: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false
      const result = await window.electronAPI.createFolder(parentPath, name)
      if (result.success && result.data?.path) {
        insertCreatedNode(parentPath, {
          name,
          path: result.data.path,
          isDirectory: true,
          isExpanded: false,
          isLoading: false,
          children: []
        })
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async function renameItem(oldPath: string, newName: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false
      const result = await window.electronAPI.renameFile(oldPath, newName)
      if (result.success) {
        // 更新所有匹配的 tab 中的 fileInfo
        for (const tab of tabs.value) {
          if (tab.fileInfo?.path === oldPath) {
            tab.fileInfo.path = result.data!.path
            tab.fileInfo.name = newName
          }
        }
        // 增量更新树节点（目录需同步其子节点路径前缀），保持展开状态
        const isRoot = fileTree.value[0]?.path === oldPath
        const node = findNodeInTree(fileTree.value, oldPath)
        if (node) {
          relocateNodePaths(node, oldPath, result.data!.path)
          node.name = newName
          if (isRoot) openedFolderPath.value = result.data!.path
          sortTreeChildren(fileTree.value)
          relocateSelection(oldPath, result.data!.path)
          syncRootItems()
        } else {
          await readFolder(openedFolderPath.value!)
        }
        return true
      }
      deps.error.value = result.error || '重命名失败'
      return false
    } catch {
      return false
    }
  }

  // ========== 拖拽移动辅助：增量更新文件树（保持各节点展开状态） ==========
  function findNodeInTree(nodes: FileTreeNode[], targetPath: string): FileTreeNode | null {
    for (const node of nodes) {
      if (node.path === targetPath) return node
      if (node.isDirectory) {
        const found = findNodeInTree(node.children, targetPath)
        if (found) return found
      }
    }
    return null
  }

  function removeNodeFromTree(nodes: FileTreeNode[], targetPath: string): FileTreeNode | null {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.path === targetPath) {
        return nodes.splice(i, 1)[0]
      }
      if (node.isDirectory) {
        const found = removeNodeFromTree(node.children, targetPath)
        if (found) return found
      }
    }
    return null
  }

  function insertNodeSorted(nodes: FileTreeNode[], node: FileTreeNode): void {
    const index = nodes.findIndex((current) => compareFolderEntries(node, current) < 0)
    nodes.splice(index === -1 ? nodes.length : index, 0, node)
  }

  function sortTreeChildren(nodes: FileTreeNode[]): void {
    nodes.sort(compareFolderEntries)
    for (const node of nodes) {
      if (node.isDirectory && node.children.length > 1) sortTreeChildren(node.children)
    }
  }

  function relocateNodePaths(node: FileTreeNode, sourcePath: string, newPath: string): void {
    const normalizedSource = sourcePath.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    const normalizedNode = node.path.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    if (normalizedNode === normalizedSource) {
      node.path = newPath
    } else if (normalizedNode.startsWith(`${normalizedSource}/`)) {
      node.path = newPath + node.path.slice(sourcePath.length)
    }
    for (const child of node.children) relocateNodePaths(child, sourcePath, newPath)
  }

  function syncRootItems(): void {
    const root = fileTree.value[0]
    if (root && root.path === openedFolderPath.value) {
      folderItems.value = root.children.map((child) => ({
        name: child.name,
        path: child.path,
        isDirectory: child.isDirectory
      }))
    }
  }

  async function applyMoveToTree(sourcePath: string, newPath: string, targetDir: string): Promise<void> {
    const movedNode = removeNodeFromTree(fileTree.value, sourcePath)
    if (!movedNode) {
      // 源节点不在已加载的树中，回退到全量刷新
      await readFolder(openedFolderPath.value!)
      return
    }
    relocateNodePaths(movedNode, sourcePath, newPath)
    const targetNode = findNodeInTree(fileTree.value, targetDir)
    if (!targetNode) {
      // 目标节点尚未加载，回退到全量刷新
      await readFolder(openedFolderPath.value!)
      return
    }
    if (targetNode.children.length === 0) {
      // 目标目录尚未展开加载，重新读取磁盘以包含移动后的文件
      await loadChildren(targetNode)
    } else {
      insertNodeSorted(targetNode.children, movedNode)
    }
    syncRootItems()
  }

  async function moveItem(sourcePath: string, targetDir: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false
      const result = await window.electronAPI.moveFile(sourcePath, targetDir)
      if (!result.success) {
        deps.error.value = result.error || '移动失败'
        return false
      }

      // 更新所有受影响 tab 的 fileInfo.path（精确匹配 + 前缀匹配）
      const normalize = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
      const normalizedSource = normalize(sourcePath)
      const newPath = result.data!.path
      for (const tab of tabs.value) {
        const info = tab.fileInfo
        if (!info) continue
        const tabPath = info.path
        const normalizedTab = normalize(tabPath)
        if (normalizedTab === normalizedSource) {
          info.path = newPath
        } else if (normalizedTab.startsWith(`${normalizedSource}/`)) {
          info.path = newPath + tabPath.slice(sourcePath.length)
        }
      }
      stateVersion.value++
      deps.persistSession()

      // 增量更新文件树，保持各节点原有的展开状态
      relocateSelection(sourcePath, newPath)
      await applyMoveToTree(sourcePath, newPath, targetDir)
      return true
    } catch {
      return false
    }
  }

  async function moveItems(sourcePaths: string[], targetDir: string): Promise<boolean> {
    let success = true
    for (const sourcePath of sourcePaths) {
      if (!(await moveItem(sourcePath, targetDir))) success = false
    }
    return success
  }

  async function deleteItem(targetPath: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false
      const result = await window.electronAPI.deleteFile(targetPath)
      if (result.success) {
        // 一次性移除匹配的 tab，避免编辑器收到删除过程中的中间状态
        const activeIndex = tabs.value.findIndex((tab) => tab.id === activeTabId.value)
        const matchingTabs = tabs.value.filter((tab) => tab.fileInfo?.path === targetPath)
        const matchingIds = new Set(matchingTabs.map((tab) => tab.id))
        const activeTabDeleted = matchingIds.has(activeTabId.value || '')

        if (matchingIds.size > 0) {
          tabs.value = tabs.value.filter((tab) => !matchingIds.has(tab.id))

          if (activeTabDeleted) {
            const nextIndex = activeIndex >= 0 ? Math.min(activeIndex, tabs.value.length - 1) : 0
            activeTabId.value = tabs.value[nextIndex]?.id ?? null
            deps.editorResetVersion.value++
          }
          stateVersion.value++
          deps.persistSession()
        }

        // 增量移除树节点，保持其余节点展开状态；节点未加载时回退到全量刷新
        const removed = removeNodeFromTree(fileTree.value, targetPath)
        if (removed) {
          syncRootItems()
        } else {
          await readFolder(openedFolderPath.value!)
        }
        pruneSelection()
        return true
      }
      return false
    } catch {
      return false
    }
  }

  async function runImportToFolder(kind: 'files' | 'directory', targetDir: string): Promise<boolean> {
    try {
      if (!window.electronAPI) return false
      let result =
        kind === 'files'
          ? await window.electronAPI.importFilesIntoFolder(targetDir)
          : await window.electronAPI.importDirectoryIntoFolder(targetDir)
      if (!result.success) {
        deps.error.value = result.error || '导入失败'
        return false
      }
      let data = result.data
      if (!data || data.canceled) return true
      if (data.needsResolution && data.sources && data.conflicts) {
        const conflictAction = await requestFileConflictAction(data.conflicts)
        if (!conflictAction) return false
        result = kind === 'files'
          ? await window.electronAPI.importFilesIntoFolder(targetDir, data.sources, conflictAction)
          : await window.electronAPI.importDirectoryIntoFolder(targetDir, data.sources[0], conflictAction)
        if (!result.success) {
          deps.error.value = result.error || '导入失败'
          return false
        }
        data = result.data
        if (!data) return true
      }
      const importedCount = data.imported.length
      const failedCount = data.failed.length
      if (failedCount > 0) {
        deps.error.value =
          importedCount === 0 ? data.failed[0].error : `导入完成：成功 ${importedCount} 个，失败 ${failedCount} 个`
      } else if (importedCount > 0) {
        deps.error.value = null
        console.log(`导入完成：${importedCount} 个`)
      }
      return true
    } catch {
      return false
    }
  }

  /** 选择外部文件（可多选）并复制到指定目录，源文件保留 */
  async function importFilesInto(targetDir: string): Promise<boolean> {
    return runImportToFolder('files', targetDir)
  }

  /** 选择外部文件夹并整体复制为指定目录下的子目录，源文件夹保留 */
  async function importDirectoryInto(targetDir: string): Promise<boolean> {
    return runImportToFolder('directory', targetDir)
  }

  function copyPath(filePath: string): void {
    try {
      navigator.clipboard.writeText(filePath)
    } catch {
      // 忽略
    }
  }

  return {
    openedFolderPath,
    folderItems,
    fileTree,
    selectedPaths,
    isSelected,
    selectOnly,
    toggleSelected,
    selectRange,
    selectAllVisible,
    clearSelection,
    isInsideOpenedFolder,
    pruneSelection,
    openFolder,
    openFolderPath,
    readFolder,
    loadChildren,
    expandNode,
    collapseNode,
    toggleNode,
    closeFolder,
    navigateToFolder,
    navigateUp,
    revealFileInTree,
    createFile,
    createFolder,
    renameItem,
    moveItem,
    moveItems,
    deleteItem,
    importFilesInto,
    importDirectoryInto,
    copyPath
  }
}
