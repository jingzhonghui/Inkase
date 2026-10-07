/**
 * MDX 文件操作 Composable
 *
 * 提供前端使用的 .mdx 文件操作方法
 */

import { ref, computed } from 'vue'
import type { MdxDocument } from '../types/mdx'

export interface FileStatus {
  filePath: string | null
  fileName: string
  isModified: boolean
  isNew: boolean
}

/**
 * MDX 文件操作
 */
export function useMdx() {
  // 状态
  const document = ref<MdxDocument | null>(null)
  const filePath = ref<string | null>(null)
  const isModified = ref(false)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  // 计算属性
  const fileStatus = computed<FileStatus>(() => ({
    filePath: filePath.value,
    fileName: filePath.value
      ? filePath.value.split(/[/\\]/).pop()?.replace('.mdx', '') || '未命名文档'
      : document.value?.metadata.title || '未命名文档',
    isModified: isModified.value,
    isNew: !filePath.value
  }))

  const hasDocument = computed(() => document.value !== null)

  /**
   * 创建新文件
   */
  async function newFile(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      const result = await window.electronAPI.newFile()

      if (result.success && result.data) {
        document.value = result.data.document as MdxDocument
        filePath.value = null
        isModified.value = false
        return true
      } else {
        error.value = result.error || '创建文件失败'
        return false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 打开文件
   */
  async function openFile(filePathToOpen?: string): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      let targetPath = filePathToOpen

      // 如果没有指定路径，显示文件对话框
      if (!targetPath) {
        const dialogResult = await window.electronAPI.showOpenDialog({
          properties: ['openFile'],
          filters: [
            { name: 'Inkase 文档', extensions: ['mdx'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        })

        if (!dialogResult.success || !dialogResult.data || dialogResult.data.length === 0) {
          isLoading.value = false
          return false
        }

        targetPath = dialogResult.data[0]
      }

      const result = await window.electronAPI.openFile(targetPath)

      if (result.success && result.data) {
        document.value = result.data.document as MdxDocument
        filePath.value = result.data.filePath as string
        isModified.value = false
        return true
      } else {
        error.value = result.error || '打开文件失败'
        return false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 保存文件
   */
  async function saveFile(content: string, title?: string): Promise<boolean> {
    if (!document.value) return false

    isLoading.value = true
    error.value = null

    try {
      // 更新文档内容
      document.value.content = content
      if (title) {
        document.value.metadata.title = title
      }

      const result = await window.electronAPI.saveFile(content, title)

      if (result.success) {
        isModified.value = false
        return true
      } else if (result.error === 'NEW_FILE') {
        // 新文件需要另存为
        return await saveAsFile(content, title)
      } else {
        error.value = result.error || '保存文件失败'
        return false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 另存为
   */
  async function saveAsFile(content: string, title?: string): Promise<boolean> {
    if (!document.value) return false

    isLoading.value = true
    error.value = null

    try {
      // 显示保存对话框
      const defaultPath = filePath.value || `${document.value.metadata.title || '未命名文档'}.mdx`
      const dialogResult = await window.electronAPI.showSaveDialog({
        defaultPath,
        filters: [
          { name: 'Inkase 文档', extensions: ['mdx'] }
        ]
      })

      if (!dialogResult.success || !dialogResult.data) {
        isLoading.value = false
        return false
      }

      // 确保扩展名正确
      let targetPath = dialogResult.data
      if (!targetPath.toLowerCase().endsWith('.mdx')) {
        targetPath += '.mdx'
      }

      const result = await window.electronAPI.saveAsFile(content, title)

      if (result.success) {
        filePath.value = targetPath
        isModified.value = false
        return true
      } else {
        error.value = result.error || '保存文件失败'
        return false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 关闭文件
   */
  async function closeFile(): Promise<boolean> {
    try {
      await window.electronAPI.closeFile()
      document.value = null
      filePath.value = null
      isModified.value = false
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    }
  }

  /**
   * 导入 Markdown 文件
   */
  async function importMarkdown(): Promise<boolean> {
    isLoading.value = true
    error.value = null

    try {
      // 选择要导入的 Markdown 文件
      const dialogResult = await window.electronAPI.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Markdown 文件', extensions: ['md'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })

      if (!dialogResult.success || !dialogResult.data || dialogResult.data.length === 0) {
        isLoading.value = false
        return false
      }

      const mdFilePath = dialogResult.data[0]

      // 选择保存位置
      const defaultName = mdFilePath.split(/[/\\]/).pop()?.replace('.md', '.mdx') || '未命名文档.mdx'
      const saveDialogResult = await window.electronAPI.showSaveDialog({
        defaultPath: defaultName,
        filters: [
          { name: 'Inkase 文档', extensions: ['mdx'] }
        ]
      })

      if (!saveDialogResult.success || !saveDialogResult.data) {
        isLoading.value = false
        return false
      }

      let targetPath = saveDialogResult.data
      if (!targetPath.toLowerCase().endsWith('.mdx')) {
        targetPath += '.mdx'
      }

      // 导入并保存
      const result = await window.electronAPI.importMd(mdFilePath, targetPath)

      if (result.success && result.data) {
        document.value = result.data.document as MdxDocument
        filePath.value = targetPath
        isModified.value = false
        return true
      } else {
        error.value = result.error || '导入失败'
        return false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 导出为 Markdown
   */
  async function exportMarkdown(): Promise<boolean> {
    if (!filePath.value) {
      error.value = '请先保存文件'
      return false
    }

    isLoading.value = true
    error.value = null

    try {
      // 选择输出目录
      const dialogResult = await window.electronAPI.showOpenDialog({
        properties: ['openDirectory']
      })

      if (!dialogResult.success || !dialogResult.data || dialogResult.data.length === 0) {
        isLoading.value = false
        return false
      }

      const outputDir = dialogResult.data[0]
      const result = await window.electronAPI.exportMd(filePath.value, outputDir)

      if (result.success) {
        return true
      } else {
        error.value = result.error || '导出失败'
        return false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : '未知错误'
      return false
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 设置修改状态
   */
  function setModified(modified: boolean) {
    isModified.value = modified
  }

  /**
   * 更新文档内容（不保存）
   */
  function updateContent(content: string) {
    if (document.value) {
      document.value.content = content
      isModified.value = true
    }
  }

  /**
   * 清除错误
   */
  function clearError() {
    error.value = null
  }

  return {
    // 状态
    document,
    filePath,
    isModified,
    isLoading,
    error,
    // 计算属性
    fileStatus,
    hasDocument,
    // 方法
    newFile,
    openFile,
    saveFile,
    saveAsFile,
    closeFile,
    importMarkdown,
    exportMarkdown,
    setModified,
    updateContent,
    clearError
  }
}
