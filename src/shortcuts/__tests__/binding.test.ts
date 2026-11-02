// @vitest-environment node

import { describe, it, expect } from 'vitest'
import {
  bindingFromEvent,
  formatBinding,
  isReservedBinding,
  matchesBinding,
  normalizeKey,
  parseBinding,
  type KeyEventLike
} from '../binding'
import {
  COMMANDS,
  commandById,
  effectiveBinding,
  findConflicts,
  formatShortcut,
  normalizeOverrides
} from '../registry'
import { matchCommand } from '../match'

/** 造一个只带「四个修饰键 + key」的假事件 */
function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyEventLike, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}
): KeyEventLike {
  return {
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    metaKey: modifiers.metaKey ?? false
  }
}

describe('快捷键绑定：解析', () => {
  it('解析修饰键与键名', () => {
    expect(parseBinding('Mod+Shift+K')).toMatchObject({ mod: true, shift: true, key: 'k' })
    expect(parseBinding('Mod+Comma')).toMatchObject({ mod: true, key: 'Comma' })
    expect(parseBinding('Shift+Alt+F')).toMatchObject({ shift: true, alt: true, key: 'f' })
  })

  it('无法识别的写法一律返回 null', () => {
    expect(parseBinding('')).toBeNull()
    expect(parseBinding('   ')).toBeNull()
    expect(parseBinding('BadMod+X')).toBeNull()
    expect(parseBinding('Mod+不是键')).toBeNull()
  })

  it('纯修饰键不算键名', () => {
    expect(normalizeKey('Control')).toBeNull()
    expect(normalizeKey('Shift')).toBeNull()
  })

  it('把 event.key 的各种形态归一', () => {
    expect(normalizeKey('N')).toBe('n')
    expect(normalizeKey('ArrowLeft')).toBe('Left')
    expect(normalizeKey(',')).toBe('Comma')
    expect(normalizeKey(' ')).toBe('Space')
    expect(normalizeKey('F5')).toBe('F5')
  })
})

describe('快捷键绑定：显示', () => {
  it('Windows 用 Ctrl，macOS 用符号', () => {
    expect(formatBinding('Mod+S', 'win32')).toBe('Ctrl+S')
    expect(formatBinding('Mod+Shift+S', 'win32')).toBe('Ctrl+Shift+S')
    expect(formatBinding('Mod+S', 'darwin')).toBe('⌘S')
    expect(formatBinding('Mod+Shift+N', 'darwin')).toBe('⇧⌘N')
    expect(formatBinding('Shift+Alt+F', 'darwin')).toBe('⌥⇧F')
  })

  it('方向键与标点显示成符号', () => {
    expect(formatBinding('Mod+Left', 'win32')).toBe('Ctrl+←')
    expect(formatBinding('Mod+Comma', 'win32')).toBe('Ctrl+,')
    expect(formatBinding('Mod+Slash', 'win32')).toBe('Ctrl+/')
  })
})

describe('快捷键绑定：匹配', () => {
  it('修饰键必须完全一致', () => {
    expect(matchesBinding('Mod+S', keyEvent('s', { ctrlKey: true }), 'win32')).toBe(true)
    // 多按一个 Shift 就不该命中 Ctrl+S，否则另存为会顺带保存一次
    expect(matchesBinding('Mod+S', keyEvent('S', { ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      false
    )
    expect(matchesBinding('Mod+W', keyEvent('w', { ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      false
    )
    expect(matchesBinding('Mod+Left', keyEvent('ArrowLeft', { ctrlKey: true, metaKey: true }), 'win32')).toBe(
      false
    )
  })

  it('Mod 在 macOS 上落到 ⌘', () => {
    expect(matchesBinding('Mod+S', keyEvent('s', { metaKey: true }), 'darwin')).toBe(true)
    expect(matchesBinding('Mod+S', keyEvent('s', { ctrlKey: true }), 'darwin')).toBe(false)
  })

  it('单独按修饰键不触发', () => {
    expect(matchesBinding('Mod+S', keyEvent('Control', { ctrlKey: true }), 'win32')).toBe(false)
  })
})

describe('命令注册表', () => {
  it('命令 id 唯一', () => {
    const ids = COMMANDS.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('默认绑定不重复（同一平台同一层）', () => {
    const seen = new Map<string, string>()
    for (const command of COMMANDS) {
      if (!command.binding) continue
      const binding = parseBinding(command.binding)
      expect(binding, `${command.id} 的绑定无法解析`).not.toBeNull()
      const signature = [
        command.priority ?? 'bubble',
        binding!.mod,
        binding!.ctrl,
        binding!.alt,
        binding!.shift,
        binding!.meta,
        binding!.key
      ].join('|')
      const previous = seen.get(signature)
      expect(previous, `${command.id} 与 ${previous} 绑定了同一个键`).toBeUndefined()
      seen.set(signature, command.id)
    }
  })

  it('只有 app 层的命令能在界面里改', () => {
    // 编辑器/系统命令的键位写在 ProseMirror 的 keymap 或 Chromium 里，
    // 列出来让人改是假的（改完显示新键、按下去还是旧键）
    const fixed = COMMANDS.filter((command) => command.owner !== 'app')
    expect(fixed.map((command) => command.id)).toContain('editor.bold')
    expect(fixed.map((command) => command.id)).toContain('edit.copy')
  })

  it('取显示文本走注册表', () => {
    expect(formatShortcut('file.new', 'win32')).toBe('Ctrl+N')
    expect(commandById('file.new').label).toBe('新建文件')
  })

  it('关键命令的菜单文案稳定', () => {
    // 菜单右侧那一列全靠这个函数，改坏了是全应用范围的可见回归。
    // 速查表删掉之后，这里是唯一钉住文案的地方。
    const expected: Array<[Parameters<typeof formatShortcut>[0], string]> = [
      ['file.new', 'Ctrl+N'],
      ['file.save', 'Ctrl+S'],
      ['file.save-as', 'Ctrl+Shift+S'],
      ['file.close-tab', 'Ctrl+W'],
      ['file.quick-open', 'Ctrl+P'],
      ['app.settings', 'Ctrl+,'],
      ['tab.prev', 'Ctrl+←'],
      ['edit.copy', 'Ctrl+C'],
      ['editor.bold', 'Ctrl+B']
    ]
    for (const [id, text] of expected) {
      expect(formatShortcut(id, 'win32'), id).toBe(text)
    }
  })

  it('mac 上同一份绑定显示成 ⌘', () => {
    expect(formatShortcut('file.new', 'darwin')).toBe('⌘N')
    expect(formatShortcut('file.save-as', 'darwin')).toBe('⇧⌘S')
  })
})

describe('命令匹配：优先级与前置条件', () => {
  it('只有 app 层的命令会被派发器接走', () => {
    // 加粗由编辑器自己处理，应用派发器不能抢
    const matched = matchCommand(keyEvent('b', { ctrlKey: true }), 'win32', {
      priority: 'bubble',
      hasDialogOpen: false,
      isTextInput: false
    })
    expect(matched).toBeNull()
  })

  it('标签切换只在捕获层匹配', () => {
    const event = keyEvent('ArrowRight', { ctrlKey: true })
    expect(
      matchCommand(event, 'win32', {
        priority: 'bubble',
        hasDialogOpen: false,
        isTextInput: false
      })
    ).toBeNull()
    expect(
      matchCommand(event, 'win32', {
        priority: 'capture',
        hasDialogOpen: false,
        isTextInput: false
      })?.id
    ).toBe('tab.next')
  })

  it('对话框开着时不关标签页', () => {
    const event = keyEvent('w', { ctrlKey: true })
    expect(
      matchCommand(event, 'win32', {
        priority: 'bubble',
        hasDialogOpen: true,
        isTextInput: false
      })
    ).toBeNull()
    expect(
      matchCommand(event, 'win32', {
        priority: 'bubble',
        hasDialogOpen: false,
        isTextInput: false
      })?.id
    ).toBe('file.close-tab')
  })
})

describe('allowInInput：输入框里的取舍', () => {
  const inInput = { priority: 'bubble' as const, hasDialogOpen: false, isTextInput: true }

  it('新建/打开在输入框里让路：不把眼前的输入换掉', () => {
    expect(matchCommand(keyEvent('n', { ctrlKey: true }), 'win32', inInput)).toBeNull()
    expect(matchCommand(keyEvent('N', { ctrlKey: true, shiftKey: true }), 'win32', inInput)).toBeNull()
    expect(
      matchCommand(keyEvent('D', { ctrlKey: true, shiftKey: true }), 'win32', inInput)
    ).toBeNull()
    expect(matchCommand(keyEvent('o', { ctrlKey: true }), 'win32', inInput)).toBeNull()
  })

  it('保存在输入框里仍然生效：在哪儿按都该能存', () => {
    expect(matchCommand(keyEvent('s', { ctrlKey: true }), 'win32', inInput)?.id).toBe('file.save')
    expect(
      matchCommand(keyEvent('S', { ctrlKey: true, shiftKey: true }), 'win32', inInput)?.id
    ).toBe('file.save-as')
  })

  it('只开面板的命令不被拦：按到也没损失', () => {
    expect(matchCommand(keyEvent('p', { ctrlKey: true }), 'win32', inInput)?.id).toBe(
      'file.quick-open'
    )
    expect(matchCommand(keyEvent(',', { ctrlKey: true }), 'win32', inInput)?.id).toBe('app.settings')
  })

  it('在输入框外，那四个照常生效', () => {
    const outInput = { ...inInput, isTextInput: false }
    expect(matchCommand(keyEvent('n', { ctrlKey: true }), 'win32', outInput)?.id).toBe('file.new')
    expect(matchCommand(keyEvent('o', { ctrlKey: true }), 'win32', outInput)?.id).toBe('file.open')
  })

  it('让路名单就是这四条，别的一条不多', () => {
    // 名单一长就会把本该交给输入框的按键吞掉，所以钉住它
    const blocked = COMMANDS.filter((command) => command.allowInInput === false).map(
      (command) => command.id
    )
    expect(blocked.sort()).toEqual(
      ['file.new', 'file.new-diagram', 'file.new-mindmap', 'file.open'].sort()
    )
  })
})

describe('快捷键覆盖值', () => {
  it('没改过时取默认值', () => {
    expect(effectiveBinding('file.save', {})).toBe('Mod+S')
  })

  it('改过时取覆盖值，其余命令不受影响', () => {
    const overrides = { 'file.save': 'Mod+Alt+S' }
    expect(effectiveBinding('file.save', overrides)).toBe('Mod+Alt+S')
    expect(effectiveBinding('file.save-as', overrides)).toBe('Mod+Shift+S')
  })

  it('null 表示显式解绑', () => {
    expect(effectiveBinding('file.save', { 'file.save': null })).toBeNull()
    expect(formatShortcut('file.save', 'win32')).not.toBe('')
  })

  it('解析不了的覆盖值回落到默认，而不是让命令失效', () => {
    expect(effectiveBinding('file.save', { 'file.save': '???+X' })).toBe('Mod+S')
  })

  it('与默认值相同的改动会被丢掉，不写进配置', () => {
    expect(normalizeOverrides({ 'file.save': 'Mod+S' })).toEqual({})
    expect(normalizeOverrides({ 'file.save': 'Mod+Alt+S' })).toEqual({ 'file.save': 'Mod+Alt+S' })
    expect(normalizeOverrides({ 'file.save': null })).toEqual({ 'file.save': null })
    // 未知命令 id 直接丢弃，避免旧版本残留污染配置
    expect(normalizeOverrides({ 'file.不存在': 'Mod+M' })).toEqual({})
  })
})

describe('快捷键冲突检测', () => {
  it('默认配置没有冲突', () => {
    expect(findConflicts({}, 'win32').size).toBe(0)
  })

  it('同层撞键时两边都能说出对手', () => {
    const conflicts = findConflicts({ 'file.save': 'Mod+N' }, 'win32')
    expect(conflicts.get('file.save')).toEqual(['file.new'])
    expect(conflicts.get('file.new')).toEqual(['file.save'])
  })

  it('跨优先级层不算冲突：捕获层更早拿到事件', () => {
    expect(findConflicts({ 'file.save': 'Mod+Left' }, 'win32').size).toBe(0)
  })
})

describe('快捷键录制', () => {
  it('录成 Mod 形态，便于跨平台迁移', () => {
    expect(bindingFromEvent(keyEvent('s', { ctrlKey: true, altKey: true }), 'win32')).toBe(
      'Mod+Alt+S'
    )
    expect(bindingFromEvent(keyEvent('k', { metaKey: true }), 'darwin')).toBe('Mod+K')
  })

  it('mac 上非主修饰键保留成 Ctrl', () => {
    expect(bindingFromEvent(keyEvent('k', { ctrlKey: true }), 'darwin')).toBe('Ctrl+K')
  })

  it('只按修饰键、或没有任何修饰键，都不产生绑定', () => {
    expect(bindingFromEvent(keyEvent('Control', { ctrlKey: true }), 'win32')).toBeNull()
    expect(bindingFromEvent(keyEvent('a'), 'win32')).toBeNull()
  })

  it('系统保留键被拒', () => {
    expect(isReservedBinding('Alt+F4', 'win32')).toBe(true)
    expect(isReservedBinding('F12', 'win32')).toBe(true)
    expect(isReservedBinding('Mod+Q', 'darwin')).toBe(true)
    expect(isReservedBinding('Mod+S', 'darwin')).toBe(false)
  })
})
