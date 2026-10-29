/**
 * 把一条「相关笔记」链接插进正文。
 *
 * 纯粹的正则与字符串操作，没有任何 fs / DOM 依赖——主进程写盘与渲染层
 * 「只改缓冲区」两条路径必须产出**完全一样**的结果，所以逻辑只能有一份。
 */

export const RELATED_SECTION_TITLE = '相关笔记'

const RELATED_HEADING_RE = /^##[ \t]+相关笔记[ \t]*$/
const ANY_HEADING_RE = /^#{1,6}[ \t]+\S/
const SECTION_BREAK_RE = /^#{1,2}[ \t]+\S/

export interface InsertPlan {
  content: string
  /** 新链接所在行号（1 起） */
  line: number
}

/** 转义链接文字里会破坏语法的字符 */
export function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1')
}

/** 组装一条列表项：`- [标题](路径)` */
export function buildRelatedBullet(title: string, encodedPath: string): string {
  return `- [${escapeLinkText(title)}](${encodedPath})`
}

/**
 * 计算插入位置。
 *
 * 目标位置固定在最后一个 `## 相关笔记` 小节末尾（下一个同级或更高级标题之前）；
 * 小节不存在时在文末新建，并前置一个空行。
 */
export function planRelatedLinkInsertion(content: string, bullet: string): InsertPlan {
  const normalized = content.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')

  let headingIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (RELATED_HEADING_RE.test(lines[i])) headingIndex = i
  }

  if (headingIndex === -1) {
    const trimmed = normalized.replace(/\n+$/, '')
    // 新建小节时的正文前缀；行号由前缀里的换行数推导，别硬编码
    const prefix = trimmed.trim()
      ? `${trimmed}\n\n## ${RELATED_SECTION_TITLE}\n\n`
      : `## ${RELATED_SECTION_TITLE}\n\n`
    return { content: `${prefix}${bullet}\n`, line: prefix.split('\n').length }
  }

  // 小节范围：到下一个一级或二级标题为止
  let sectionEnd = lines.length
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (SECTION_BREAK_RE.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  let insertAt = headingIndex + 1
  for (let i = headingIndex + 1; i < sectionEnd; i++) {
    if (lines[i].trim() !== '') insertAt = i + 1
  }

  const inserted: string[] = []
  // 紧接着是新标题时补一个空行，否则列表项会粘在标题上
  const nextLine = lines[insertAt]
  if (nextLine !== undefined && ANY_HEADING_RE.test(nextLine)) {
    inserted.push(bullet, '')
  } else {
    inserted.push(bullet)
  }

  const merged = [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)].join('\n')

  return { content: merged, line: insertAt + 1 }
}
