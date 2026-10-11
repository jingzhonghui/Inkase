const RESERVED_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

/**
 * 校验 Windows 文件夹名称。
 * 返回 null 表示合法，否则返回可直接展示给用户的错误信息。
 */
export function validateWindowsFolderName(value: string): string | null {
  const name = value
  if (!name.trim()) return '请输入文件夹名称'
  if (name.length > 255) return '文件夹名称不能超过 255 个字符'
  if (/[<>:"/\\|?*]/.test(name)) return '文件夹名称不能包含 < > : " / \\ | ? * 等字符'
  if ([...name].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f)) return '文件夹名称不能包含控制字符'
  if (/[ .]$/.test(name)) return '文件夹名称不能以空格或句点结尾'
  if (RESERVED_DEVICE_NAME.test(name)) return '该名称是 Windows 保留名称，请换一个名称'
  return null
}

/**
 * 校验 Windows 文件名（含扩展名）。
 * 返回 null 表示合法，否则返回可直接展示给用户的错误信息。
 */
export function validateWindowsFileName(value: string): string | null {
  const name = value
  if (!name.trim()) return '请输入文件名'
  if (name.length > 255) return '文件名不能超过 255 个字符'
  if (/[<>:"/\\|?*]/.test(name)) return '文件名不能包含 < > : " / \\ | ? * 等字符'
  if ([...name].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f)) return '文件名不能包含控制字符'
  if (/[ .]$/.test(name)) return '文件名不能以空格或句点结尾'
  if (RESERVED_DEVICE_NAME.test(name)) return '该名称是 Windows 保留名称，请换一个名称'
  return null
}
