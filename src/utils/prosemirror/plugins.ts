/**
 * ProseMirror 插件集合
 */
import { Schema } from 'prosemirror-model'
import { Plugin, PluginKey, EditorState } from 'prosemirror-state'
import { history } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { baseKeymap } from 'prosemirror-commands'
import { tableEditing } from 'prosemirror-tables'
import { buildKeymap } from './keymap'
import { buildInputRules } from './inputrules'

/**
 * 插件 Key（用于状态识别）
 */
export const pluginsKey = {
  history: new PluginKey('history'),
  keymap: new PluginKey('keymap'),
  inputRules: new PluginKey('inputRules'),
  dropCursor: new PluginKey('dropCursor'),
  gapCursor: new PluginKey('gapCursor')
}

/**
 * 创建编辑器插件集合
 * @param schema ProseMirror Schema
 * @returns 插件数组
 */
export function createPlugins(schema: Schema): Plugin[] {
  const plugins: Plugin[] = [
    // 末尾代码块/表格后始终保留可继续输入的空段落
    new Plugin({
      appendTransaction(_transactions, _oldState, newState) {
        const lastChild = newState.doc.lastChild
        if (!lastChild) return null
        if (lastChild.type.name !== 'code_block' && lastChild.type.name !== 'table') return null
        return newState.tr
          .insert(newState.doc.content.size, schema.nodes.paragraph.create())
          .setMeta('addToHistory', false)
      }
    }),

    // 表格编辑核心插件（处理光标定位、单元格导航、选择等）
    tableEditing(),

    // 输入规则（Markdown 语法自动转换）
    buildInputRules(schema),

    // 历史记录（撤销/重做）
    history(),

    // 自定义键盘快捷键
    keymap(buildKeymap(schema)),

    // 基础键盘命令
    keymap(baseKeymap),

    // 拖拽时的光标指示
    dropCursor(),

    // 间隙光标（点击空白处）
    gapCursor()
  ]

  return plugins
}

/**
 * 选区状态插件
 * 用于监听选区变化，触发浮动工具栏等
 */
export const selectionPlugin = new Plugin({
  state: {
    init() {
      return { from: 0, to: 0, empty: true }
    },
    apply(tr, _prev) {
      const { selection } = tr
      return {
        from: selection.from,
        to: selection.to,
        empty: selection.empty
      }
    }
  }
})

/**
 * 文档更新插件
 * 用于监听文档变化，同步到外部状态
 */
export function createDocumentChangePlugin(onChange: (doc: EditorState) => void): Plugin {
  return new Plugin({
    view() {
      return {
        update: (view, prevState) => {
          if (!prevState.doc.eq(view.state.doc)) {
            onChange(view.state)
          }
        }
      }
    }
  })
}

/**
 * 任务列表点击插件
 * 处理任务列表复选框的点击
 */
export const taskListClickPlugin = new Plugin({
  props: {
    handleClickOn(view, _pos, node, nodePos, event) {
      // 检查是否点击了任务列表的复选框
      if (node.type.name === 'task_item') {
        const target = event.target as HTMLElement
        if (target && target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'checkbox') {
          const tr = view.state.tr
          const checked = (target as HTMLInputElement).checked
          tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, checked })
          view.dispatch(tr)
          return true
        }
      }
      return false
    }
  }
})

/**
 * 图片点击插件
 * 处理图片点击，显示图片工具栏
 */
export function createImageClickPlugin(onImageClick: (pos: number, node: any) => void): Plugin {
  return new Plugin({
    props: {
      handleClickOn(_view, _pos, node, nodePos, _event) {
        if (node.type.name === 'image') {
          onImageClick(nodePos, node)
          return true
        }
        return false
      }
    }
  })
}

/**
 * 拖放插件配置
 */
export function createDragDropPlugin(onDrop: (pos: number, files: File[]) => void): Plugin {
  return new Plugin({
    props: {
      handleDrop(view, event, _slice, moved) {
        if (moved) return false

        const files = event.dataTransfer?.files
        if (files && files.length > 0) {
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (pos) {
            onDrop(pos.pos, Array.from(files))
          }
          return true
        }
        return false
      },
      handleDOMEvents: {
        dragover: (_view, event) => {
          event.preventDefault()
          return true
        }
      }
    }
  })
}

/**
 * 粘贴插件配置
 * 处理粘贴图片 - 返回文件信息，由外部处理插入
 */
export function createPastePlugin(
  onPasteImage: (view: import('prosemirror-view').EditorView, file: File) => void
): Plugin {
  return new Plugin({
    props: {
      transformPastedHTML(html: string): string {
        // 链接在 IR 中以字面文本 [文字](url) 存储（schema 中已无 link mark）。
        // 粘贴网页内容时把 <a href> 转成字面文本，避免丢失 URL。
        if (!html || !html.includes('<a')) return html
        const doc = new DOMParser().parseFromString(html, 'text/html')
        doc.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href') || ''
          const text = (a.textContent || '').trim() || href
          a.replaceWith(doc.createTextNode(`[${text}](${href})`))
        })
        return doc.body.innerHTML
      },
      handleDOMEvents: {
        paste: (view, event) => {
          const clipboardData = (event as ClipboardEvent).clipboardData
          if (!clipboardData) return false

          // 优先处理图片文件
          const files = Array.from(clipboardData.files)
          for (const file of files) {
            if (file.type.startsWith('image/')) {
              event.preventDefault()
              onPasteImage(view, file)
              return true
            }
          }

          // 尝试从 clipboardData.items 获取（某些截图工具）
          const items = Array.from(clipboardData.items)
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              const blob = item.getAsFile()
              if (blob) {
                event.preventDefault()
                const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: item.type })
                onPasteImage(view, file)
                return true
              }
            }
          }

          // 尝试从 HTML 内容中提取 base64 图片
          const html = clipboardData.getData('text/html')
          if (html) {
            const parser = new DOMParser()
            const doc = parser.parseFromString(html, 'text/html')
            const images = doc.querySelectorAll('img')

            for (const img of Array.from(images)) {
              const src = img.getAttribute('src')
              if (src && src.startsWith('data:')) {
                event.preventDefault()
                // 将 base64 转换为文件
                fetch(src)
                  .then((response) => response.blob())
                  .then((blob) => {
                    const file = new File([blob], `pasted-image-${Date.now()}.png`, {
                      type: blob.type
                    })
                    onPasteImage(view, file)
                  })
                  .catch((err) => console.error('Failed to process base64 image:', err))
                return true
              }
            }
          }

          return false
        }
      }
    }
  })
}

/**
 * 占位符插件
 * 空编辑器时显示提示文字
 */
export function createPlaceholderPlugin(text: string): Plugin {
  return new Plugin({
    props: {
      decorations: (state) => {
        const doc = state.doc
        if (
          doc.childCount === 1 &&
          doc.firstChild?.type.name === 'paragraph' &&
          doc.firstChild?.content.size === 0
        ) {
          const deco = document.createElement('div')
          deco.className = 'ProseMirror-placeholder'
          deco.textContent = text
          // 使用 ProseMirror 的 Decoration 系统需要在视图中处理
          // 这里简化处理，通过 CSS 的 :empty::before 实现
        }
        return null
      }
    }
  })
}

/**
 * 导出所有插件创建函数
 */
export { history, keymap, dropCursor, gapCursor, baseKeymap }
