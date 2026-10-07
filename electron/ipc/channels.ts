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
  APP: {
    PING: 'ping',
    GET_VERSION: 'app:getVersion',
    GET_PLATFORM: 'app:getPlatform',
    GET_USER_GUIDE_PATH: 'app:getUserGuidePath',
    CONFIRM_CLOSE: 'app:confirm-close',
    CLOSE_CONFIRMED: 'app:close-confirmed',
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
