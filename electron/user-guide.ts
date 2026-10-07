import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const USER_GUIDE_FILE_NAME = 'Inkase 使用教程.pdf'

export interface UserGuideDependencies {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  existsSync: (filePath: string) => boolean
}

function defaultDependencies(): UserGuideDependencies {
  return {
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    existsSync: fs.existsSync
  }
}

export function resolveUserGuidePath(dependencies: UserGuideDependencies = defaultDependencies()): string {
  if (dependencies.isPackaged) {
    return path.join(dependencies.resourcesPath, 'user-guide', USER_GUIDE_FILE_NAME)
  }

  return path.join(dependencies.appPath, 'resources', USER_GUIDE_FILE_NAME)
}

/** 解析内置使用教程路径；文件不存在时返回 null */
export function resolveExistingUserGuidePath(dependencies: UserGuideDependencies = defaultDependencies()): string | null {
  const guidePath = resolveUserGuidePath(dependencies)
  return dependencies.existsSync(guidePath) ? guidePath : null
}
