import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useConfigStore } from '../config'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
    get length() {
      return Object.keys(store).length
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  }
})()

vi.stubGlobal('localStorage', localStorageMock)

describe('sidebar expanded state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
  })

  it('defaults to expanded when no persisted value is present', () => {
    const store = useConfigStore()

    expect(store.sidebarExpanded).toBe(true)
  })

  it('preserves a persisted collapsed state', () => {
    localStorage.setItem('sidebarExpanded', 'false')

    const store = useConfigStore()

    expect(store.sidebarExpanded).toBe(false)
  })
})

describe('proxies display mode migration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
  })

  it('migrates the removed chips mode to card mode', async () => {
    localStorage.setItem('proxiesDisplayMode', 'chipsMode')

    const store = useConfigStore()

    expect(store.proxiesDisplayMode).toBe('cardMode')
    await nextTick()
    expect(localStorage.getItem('proxiesDisplayMode')).toBe('cardMode')
  })
})

describe('connections display mode migration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
  })

  it('defaults to auto when no legacy or new key is present', () => {
    const store = useConfigStore()
    expect(store.connectionsDisplayMode).toBe('auto')
  })

  it('migrates legacy useMobileConnectionsTable=true to table', () => {
    localStorage.setItem('useMobileConnectionsTable', 'true')

    const store = useConfigStore()

    expect(store.connectionsDisplayMode).toBe('table')
    expect(localStorage.getItem('useMobileConnectionsTable')).toBeNull()
  })

  it('migrates legacy useMobileConnectionsTable=false to auto', () => {
    localStorage.setItem('useMobileConnectionsTable', 'false')

    const store = useConfigStore()

    expect(store.connectionsDisplayMode).toBe('auto')
    expect(localStorage.getItem('useMobileConnectionsTable')).toBeNull()
  })

  it('preserves an already-set new key over a legacy key (new wins)', () => {
    // VueUse's default string serializer is identity (no JSON encoding),
    // so the stored value is the raw string, not JSON-quoted.
    localStorage.setItem('connectionsDisplayMode', 'card')
    localStorage.setItem('useMobileConnectionsTable', 'true')

    const store = useConfigStore()

    expect(store.connectionsDisplayMode).toBe('card')
  })
})

describe('resolveLatencyTestUrl', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorageMock.clear()
  })

  it("uses the group's testUrl in core mode and falls back to the dashboard url", () => {
    const store = useConfigStore()

    expect(store.resolveLatencyTestUrl('https://group.test/204')).toBe(
      'https://group.test/204',
    )
    expect(store.resolveLatencyTestUrl(null)).toBe(store.urlForLatencyTest)
    expect(store.resolveLatencyTestUrl('')).toBe(store.urlForLatencyTest)
  })

  it('uses the dashboard URL for a default test in dashboard mode', () => {
    const store = useConfigStore()
    store.latencyTestUrlSource = 'dashboard'

    expect(store.resolveLatencyTestUrl('https://group.test/204')).toBe(
      store.urlForLatencyTest,
    )
  })

  it.each(['docker-registry', 'claude-test'] as const)(
    'does not override a %s group URL in dashboard mode',
    (testType) => {
      const store = useConfigStore()
      store.latencyTestUrlSource = 'dashboard'

      expect(
        store.resolveLatencyTestUrl('https://group.test/special', testType),
      ).toBe('https://group.test/special')
    },
  )

  it('resets the URL source to core mode', () => {
    const store = useConfigStore()
    store.latencyTestUrlSource = 'dashboard'

    store.resetProxiesSettings()

    expect(store.latencyTestUrlSource).toBe('core')
  })
})
