import { describe, expect, it } from 'vitest'
import {
  FILE_ICON_COMPONENTS,
  getFileIconComponent,
  getFileIconKey,
  type FileIconKey
} from '../file-icons'

describe('getFileIconKey', () => {
  it.each([
    ['notes.mdx', false, 'markdown'],
    ['README.MD', false, 'markdown'],
    ['draft.markdown', false, 'markdown'],
    ['document.pdf', false, 'pdf'],
    ['photo.webp', false, 'image'],
    ['icon.svg', false, 'svg'],
    ['archive.7z', false, 'archive'],
    ['config.yaml', false, 'yaml'],
    ['data.json', false, 'json'],
    ['setup.toml', false, 'toml'],
    ['keys.xml', false, 'xml'],
    ['rows.csv', false, 'csv'],
    ['component.vue', false, 'vue'],
    ['main.ts', false, 'typescript'],
    ['main.tsx', false, 'react'],
    ['index.js', false, 'javascript'],
    ['index.jsx', false, 'react'],
    ['page.html', false, 'html'],
    ['styles.scss', false, 'sass'],
    ['app.py', false, 'python'],
    ['main.rs', false, 'rust'],
    ['main.go', false, 'go'],
    ['Program.cs', false, 'csharp'],
    ['native.cpp', false, 'cpp'],
    ['run.sh', false, 'shell'],
    ['deploy.ps1', false, 'powershell'],
    ['query.sql', false, 'sql'],
    ['report.docx', false, 'word'],
    ['sheet.xlsx', false, 'excel'],
    ['slide.pptx', false, 'powerpoint'],
    ['notes.txt', false, 'text'],
    ['debug.log', false, 'log'],
    ['package.json', false, 'npm'],
    ['tsconfig.json', false, 'config'],
    ['.gitignore', false, 'git'],
    ['Dockerfile', false, 'docker'],
    ['.env', false, 'env'],
    ['LICENSE', false, 'license'],
    ['Makefile', false, 'shell'],
    ['app.lock', false, 'lock'],
    ['unknown.bin', false, 'file'],
    ['noextension', false, 'file'],
    ['assets', true, 'folder']
  ] as [string, boolean, FileIconKey][])('classifies %s as %s', (name, isDirectory, expected) => {
    expect(getFileIconKey(name, isDirectory)).toBe(expected)
  })

  it('matches special filenames before the extension', () => {
    expect(getFileIconKey('package.json', false)).toBe('npm')
    expect(getFileIconKey('Dockerfile.dev', false)).toBe('docker')
    expect(getFileIconKey('.env.production', false)).toBe('env')
    expect(getFileIconKey('vite.config.ts', false)).toBe('config')
    expect(getFileIconKey('.gitkeep', false)).toBe('git')
  })

  it('treats unknown dotfiles as plain files', () => {
    expect(getFileIconKey('.unknownfile', false)).toBe('file')
  })
})

describe('getFileIconComponent', () => {
  it('maps a folder to the Tabler folder icon', () => {
    expect(getFileIconComponent('assets', true)).toBe(FILE_ICON_COMPONENTS.folder)
  })

  it('maps a pdf to the dedicated PDF icon', () => {
    expect(getFileIconComponent('document.pdf', false)).toBe(FILE_ICON_COMPONENTS.pdf)
  })

  it('has a component for every icon key', () => {
    for (const key of Object.keys(FILE_ICON_COMPONENTS) as FileIconKey[]) {
      expect(FILE_ICON_COMPONENTS[key]).toBeTruthy()
    }
  })
})
