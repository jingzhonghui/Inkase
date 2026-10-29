import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useAiStore } from './ai'
import { useFileStore } from './file'
import { useGraphStore } from './graph'
import { toWorkspaceRelative } from '../utils/graph/dirty-overlay'

/**
 * 工作台（Workbench）。
 *
 * 标签栏只表达两类东西：**文档** 与 **工作台**。AI 助手与知识图谱原本各自
 * 占一个「合成标签」，既能被拖到文件中间（`aiTabIndex`），又被锁死在末尾
 * （图谱），同一根标签栏里混着两种语义。现在它们降级为工作台内部的段，
 * 标签栏回到「文件 + 一个固定的家」。
 *
 * 两个段互斥是因为它们都需要整块面积，靠 `v-show` 保活而不是 `v-if`：
 * 图谱的仿真坐标活在组件实例里，销毁重建会让整张图重新播种跳位。
 *
 * 图谱是默认段：工作台存在的意义是「看你的库」，AI 是按需打开的第二段。
 */

export type WorkspaceSegment = 'graph' | 'ai'

export interface WorkspaceSegmentDef {
  id: WorkspaceSegment
  label: string
  /** 悬停提示：说明这一段是干什么的 */
  hint: string
}

export const WORKSPACE_SEGMENTS: readonly WorkspaceSegmentDef[] = [
  { id: 'graph', label: '图谱', hint: '文档之间的链接拓扑、断链与孤儿' },
  { id: 'ai', label: 'AI 助手', hint: '对话、工具调用与审批' }
]

export interface OpenWorkspaceOptions {
  /** 直接以某个文件为局部图中心（文件树右键「显示图谱」） */
  centerFilePath?: string
}

export const useWorkspaceStore = defineStore('workspace', () => {
  /** 工作台是否在前台（false 时显示文档视图） */
  const active = ref(false)
  const segment = ref<WorkspaceSegment>('graph')
  /** 图谱段：收起侧栏，让画布占满 */
  const expanded = ref(false)

  const isAi = computed(() => active.value && segment.value === 'ai')
  const isGraph = computed(() => active.value && segment.value === 'graph')

  /**
   * 打开工作台并切到某一段。
   *
   * 这里负责把「段」翻译成对应 store 的生命周期调用，让调用方（菜单、
   * 快捷键、文件树右键、概览卡片）只需要说清「我要去哪一段」。
   */
  function open(next: WorkspaceSegment = 'graph', options: OpenWorkspaceOptions = {}): void {
    active.value = true
    segment.value = next
    expanded.value = false

    if (next === 'ai') {
      const aiStore = useAiStore()
      if (!aiStore.panelOpen) aiStore.openPanel()
      else aiStore.activatePanel()
    }

    if (next === 'graph') {
      const graphStore = useGraphStore()
      if (!graphStore.panelOpen) {
        // 首次打开才建索引；已经建过就只激活，别让用户从文档跳过来又等一次全库扫描
        void graphStore.openPanel(options.centerFilePath)
        return
      }
      graphStore.activatePanel()
      const center = options.centerFilePath
      if (center) {
        const fileStore = useFileStore()
        const relative = toWorkspaceRelative(fileStore.openedFolderPath ?? '', center)
        if (relative) graphStore.setCenter(relative)
      }
    }
  }

  function setSegment(next: WorkspaceSegment): void {
    if (next === segment.value && active.value) {
      if (next === 'graph') expanded.value = false
      return
    }
    open(next)
  }

  /**
   * 只是把工作台提到前台，保持当前分段（点标签栏上的「工作台」时用）。
   *
   * 两段都有「面板没开就没有内容」的前置条件（图谱靠 `panelOpen` 挂载 GraphView，
   * AI 靠 `panelOpen` 挂载 AiPanel），所以这里补一次挂载——否则从文档视图点回
   * 「工作台」会落在一块空白上。
   */
  function activate(): void {
    active.value = true
    if (segment.value === 'graph') {
      const graphStore = useGraphStore()
      if (!graphStore.panelOpen) void graphStore.openPanel()
      return
    }
    const aiStore = useAiStore()
    if (!aiStore.panelOpen) aiStore.openPanel()
  }

  /** 回到文档；没有文档时调用方应保持工作台可见 */
  function close(): void {
    active.value = false
    expanded.value = false
    useAiStore().deactivatePanel()
    useGraphStore().deactivatePanel()
  }

  function toggleExpanded(): void {
    expanded.value = !expanded.value
  }

  function setExpanded(value: boolean): void {
    expanded.value = value
  }

  return {
    active,
    segment,
    expanded,
    isAi,
    isGraph,
    open,
    setSegment,
    activate,
    close,
    toggleExpanded,
    setExpanded
  }
})
