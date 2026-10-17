// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SyncConflictDialog from '../SyncConflictDialog.vue'

const files = [
  { path: 'C:/ws/docs/a.md', label: 'docs/a.md' },
  { path: 'C:/ws/docs/b.md', label: 'docs/b.md' }
]

function mountDialog(overrides: Record<string, unknown> = {}) {
  return mount(SyncConflictDialog, {
    props: { files, ...overrides },
    global: { stubs: { teleport: true } }
  })
}

describe('SyncConflictDialog', () => {
  it('lists every conflicted file by its relative label', () => {
    const wrapper = mountDialog()

    const list = wrapper.get('[data-test="conflict-dialog-files"]')
    expect(list.text()).toContain('docs/a.md')
    expect(list.text()).toContain('docs/b.md')
    expect(wrapper.get('[data-test="conflict-dialog-count"]').text()).toContain('2')
  })

  it('emits the batch choice matching the clicked button', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[data-test="conflict-resolve-all-local"]').trigger('click')
    expect(wrapper.emitted('resolveAll')?.at(-1)).toEqual(['local'])

    await wrapper.get('[data-test="conflict-resolve-all-remote"]').trigger('click')
    expect(wrapper.emitted('resolveAll')?.at(-1)).toEqual(['remote'])
  })

  it('emits open and per-file choices carrying the absolute path', async () => {
    const wrapper = mountDialog()

    await wrapper.findAll('[data-test="conflict-open-file"]')[1].trigger('click')
    expect(wrapper.emitted('open')?.at(-1)).toEqual(['C:/ws/docs/b.md'])

    await wrapper.findAll('[data-test="conflict-keep-local"]')[0].trigger('click')
    expect(wrapper.emitted('resolve')?.at(-1)).toEqual([{ path: 'C:/ws/docs/a.md', choice: 'local' }])

    await wrapper.findAll('[data-test="conflict-take-remote"]')[1].trigger('click')
    expect(wrapper.emitted('resolve')?.at(-1)).toEqual([{ path: 'C:/ws/docs/b.md', choice: 'remote' }])
  })

  it('emits close from the close button and the overlay', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[data-test="conflict-dialog-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.get('[data-test="conflict-dialog"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('disables every decision button while busy', () => {
    const wrapper = mountDialog({ busy: true })

    const selectors = [
      '[data-test="conflict-resolve-all-local"]',
      '[data-test="conflict-resolve-all-remote"]',
      '[data-test="conflict-keep-local"]',
      '[data-test="conflict-take-remote"]'
    ]
    for (const selector of selectors) {
      expect(wrapper.get(selector).attributes('disabled')).toBeDefined()
    }
  })
})
