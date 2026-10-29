import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // `webdav` 是 ESM-only（`"type": "module"`，exports 无 `require` 条件）。
    // 若外置，main.cjs 会 `require("webdav")`，在 Electron 内置 Node 20 上直接 ERR_REQUIRE_ESM。
    // 因此排除它，让 rollup 把 ESM 打成 CJS 内联进产物。
    plugins: [externalizeDepsPlugin({ exclude: ['webdav'] })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve(__dirname, 'electron/main.ts'),
        external: ['electron-clipboard-ex'],
        output: {
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload.ts'),
        output: {
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: '.',
    // 端口由 scripts/dev.mjs 实探后经 INKASE_DEV_PORT 传入：Windows 上 5173 常被
    // Hyper-V / WinNAT 保留（netsh int ipv4 show excludedportrange protocol=tcp），
    // 此时 listen 报 EACCES，Vite 不会顺延端口。strictPort 必须开 ——
    // electron-vite 拼 ELECTRON_RENDERER_URL 用的是 config 里的 port 而非实际端口。
    server: {
      host: '127.0.0.1',
      port: Number(process.env.INKASE_DEV_PORT) || 5173,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@renderer': resolve(__dirname, 'src')
      }
    },
    plugins: [vue()]
  }
})
