// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import SideBar from '../SideBar.vue'
import { useDailyStore } from '../../../stores/daily'

function mountSideBar(collapsed = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(SideBar, {
    props: { collapsed },
    global: {
      plugins: [pinia],
      stubs: {
        FileExplorer: true,
        SearchPanel: true,
        TagPanel: true,
        OutlinePanel: true,
        Tooltip: { template: '<span><slot /></span>' }
      }
    }
  })
}

describe('sidebar daily note entry', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('opens today’s daily note from the expanded sidebar', async () => {
    const wrapper = mountSideBar()
    const daily = useDailyStore()
    const openToday = vi.spyOn(daily, 'openToday').mockResolvedValue(true)

    await wrapper.get('[data-testid="sidebar-daily"]').trigger('click')

    expect(openToday).toHaveBeenCalled()
  })

  it('keeps the entry in the collapsed icon bar', async () => {
    const wrapper = mountSideBar(true)
    const daily = useDailyStore()
    const openToday = vi.spyOn(daily, 'openToday').mockResolvedValue(true)

    await wrapper.get('[data-testid="sidebar-daily-collapsed"]').trigger('click')

    expect(openToday).toHaveBeenCalled()
  })
})
