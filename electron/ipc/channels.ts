/**
 * IPC 通道常量定义
 *
 * 独立的通道定义文件，避免 preload 和主进程之间的循环依赖
 */

export const IPC_CHANNELS = {
  FILE: {
    NEW: 'file:new',
    OPEN: 'file:open',
    SAVE: 'file:save',
    SAVE_AS: 'file:saveAs',
    CLOSE: 'file:close',
    RECENT: 'file:recent',
    RECENT_ADD: 'file:addRecent',
    RECENT_REMOVE: 'file:removeRecent',
    RECENT_CLEAR: 'file:clearRecent',
    CREATE: 'file:create',
    RENAME: 'file:rename',
    MOVE: 'file:move',
    DELETE: 'file:delete',
    REVEAL_IN_EXPLORER: 'file:revealInExplorer',
    /** 导出二进制图片（思维导图 PNG / SVG） */
    EXPORT_IMAGE: 'file:exportImage',
    SEARCH: 'file:search',
    CLIPBOARD_READ_FILES: 'file:clipboardReadFiles',
    CLIPBOARD_WRITE_FILES: 'file:clipboardWriteFiles',
    COPY_INTO: 'file:copyInto'
  },
  MDX: {
    READ: 'mdx:read',
    WRITE: 'mdx:write',
    IMPORT_MD: 'mdx:importMd',
    IMPORT_FOLDER: 'mdx:importFolder',
    IMPORT_DOCX: 'mdx:importDocx',
    EXPORT_MD: 'mdx:exportMd',
    ADD_IMAGE: 'mdx:addImage',
    GET_IMAGE: 'mdx:getImage',
    REMOVE_ASSET: 'mdx:removeAsset',
    LIST_ASSETS: 'mdx:listAssets',
    ADD_ATTACHMENT: 'mdx:addAttachment',
    GET_ATTACHMENT: 'mdx:getAttachment',
    RESTORE_RECOVERY_ASSETS: 'mdx:restoreRecoveryAssets'
  },
  PDF: {
    READ_SOURCE: 'pdf:readSource',
    LIST_FOLDER: 'pdf:listFolder',
    PRINT: 'pdf:print'
  },
  MINDMAP: {
    /** 导入 `.xmind`（新版 content.json）→ 落盘 `.inkmind` 并返回路径 */
    IMPORT_XMIND: 'mindmap:importXmind',
    /** 把当前导图导出为 `.xmind` */
    EXPORT_XMIND: 'mindmap:exportXmind',
    /** 选一张图片拷进 `<导图名>.assets/`，返回相对路径 */
    ADD_ASSET: 'mindmap:addAsset',
    OPEN_ASSET: 'mindmap:openAsset',
    SAVE_ASSET_AS: 'mindmap:saveAssetAs'
  },
  DIAGRAM: {
    /** 自托管 draw.io webapp 是否就位（渲染层据此决定挂 iframe 还是提示缺组件） */
    INFO: 'diagram:info'
  },
  THEME: {
    /**
     * 把应用当前主题告诉主进程，落到 `nativeTheme.themeSource`。
     *
     * 这是「切主题不重建图表 iframe」的关键一环：draw.io 的配色由
     * `prefers-color-scheme` 决定，而 Electron 里这个媒体特性的值由
     * `nativeTheme.themeSource` 控制。改它会让所有渲染进程（含跨域 iframe）
     * 收到 media change，draw.io 自己就翻色了。
     */
    SET_SOURCE: 'theme:setSource'
  },
  APP: {
    PING: 'ping',
    GET_VERSION: 'app:getVersion',
    GET_PLATFORM: 'app:getPlatform',
    GET_USER_GUIDE_PATH: 'app:getUserGuidePath',
    CONFIRM_CLOSE: 'app:confirm-close',
    CLOSE_CONFIRMED: 'app:close-confirmed',
    /**
     * 主进程转发的快捷键。
     *
     * 图表编辑时焦点在 draw.io 的 iframe 里，跨域导致 keydown 不会冒泡到页面，
     * 渲染层自己的监听收不到 Ctrl+S；改由 webContents 的 before-input-event
     * 统一拦截再转过来，保证画布里按保存也有效。载荷是**命令 id**
     * （`file.save`），不是键位——键位只有渲染层的注册表说了算。
     */
    SHORTCUT: 'app:shortcut',
    /**
     * 渲染层把「主进程需要拦截的那几条命令」的当前绑定推给主进程。
     *
     * 用户可以在设置里改键，主进程若还写着 `key === 's'` 就会两头对不上：
     * 新键在画布里没反应、旧键反而还在保存。启动时推一次、每次改键后再推一次。
     */
    SYNC_SHORTCUTS: 'app:sync-shortcuts',
    RECOVERY_STATUS: 'recovery:status',
    RECOVERY_READ: 'recovery:read',
    RECOVERY_WRITE: 'recovery:write',
    RECOVERY_CLEAR: 'recovery:clear',
    OPEN_TARGETS: 'app:open-targets'
  },
  WINDOW: {
    MINIMIZE: 'window:minimize',
    MAXIMIZE: 'window:maximize',
    MAXIMIZED: 'window:maximized',
    UNMAXIMIZED: 'window:unmaximized',
    CLOSE: 'window:close',
    IS_MAXIMIZED: 'window:isMaximized'
  },
  UPDATE: {
    CHECK: 'update:check',
    OPEN_RELEASES: 'update:openReleases',
    AVAILABLE: 'update:available',
    NOT_AVAILABLE: 'update:not-available',
    ERROR: 'update:error'
  },
  DIALOG: {
    SHOW_OPEN: 'dialog:showOpen',
    SHOW_SAVE: 'dialog:showSave',
    SHOW_MESSAGE: 'dialog:showMessage'
  },
  FOLDER: {
    READ: 'folder:read',
    CREATE: 'folder:create',
    IMPORT_FILES: 'folder:importFiles',
    IMPORT_DIRECTORY: 'folder:importDirectory'
  },
  EXTERNAL_WATCH: {
    START: 'watch:start',
    CHANGED: 'watch:changed'
  },
  SYNC: {
    ATTACH_FOLDER: 'sync:attachFolder',
    DETACH_FOLDER: 'sync:detachFolder',
    STATUS: 'sync:status',
    PULL: 'sync:pull',
    PUSH: 'sync:push',
    CONTINUE_REBASE: 'sync:continueRebase',
    ABORT_REBASE: 'sync:abortRebase',
    RESOLVE_CONFLICTS: 'sync:resolveConflicts',
    ENABLE: 'sync:enable',
    DISABLE: 'sync:disable',
    CONFIG: {
      GET: 'sync:config:get',
      SET: 'sync:config:set'
    },
    EVENT: 'sync:event',
    FILE_CHANGED: 'sync:fileChanged'
  },
  LINK: {
    OPEN: 'link:open'
  },
  GRAPH: {
    /** invoke(root) → GraphPayload */
    BUILD: 'graph:build',
    /** webContents.send → { scanned, total } */
    PROGRESS: 'graph:progress',
    /** invoke(root, relPath) → 单文件重算出链 */
    REFRESH_FILE: 'graph:refreshFile',
    /** invoke({ root, from, to, title? }) → { line, skipped } */
    CREATE_LINK: 'graph:createLink'
  },
  AI: {
    CONFIG: {
      GET: 'ai:config:get',
      SET: 'ai:config:set',
      TEST: 'ai:config:test'
    },
    RUN: {
      START: 'ai:run:start',
      CANCEL: 'ai:run:cancel'
    },
    APPROVAL: {
      CLAIM: 'ai:approval:claim',
      RESOLVE: 'ai:approval:resolve'
    },
    CONVERSATION: {
      LIST: 'ai:conversation:list',
      LOAD: 'ai:conversation:load',
      SAVE: 'ai:conversation:save',
      DELETE: 'ai:conversation:delete',
      SUMMARIZE: 'ai:conversation:summarize'
    },
    WORKSPACE: {
      AUTHORIZE: 'ai:workspace:authorize'
    },
    EVENT: 'ai:run:event'
  }
} as const
