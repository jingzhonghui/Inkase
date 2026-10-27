import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    languageOptions: {
      parserOptions: {
        parser: '@typescript-eslint/parser'
      },
      globals: {
        process: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'vue/multi-word-component-names': 'off'
    }
  },
  {
    ignores: [
      'build/**',
      'dist/**',
      'dist-electron/**',
      'docs/**',
      'out/**',
      'node_modules/**',
      'public/vditor/dist/**',
      // 第三方随包资源：自托管的 draw.io webapp（`pnpm run fetch:drawio` 生成，45MB 压缩产物）
      'resources/drawio/**'
    ]
  }
]
