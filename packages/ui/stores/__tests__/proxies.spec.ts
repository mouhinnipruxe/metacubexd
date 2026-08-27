import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useProxiesStore } from '../proxies'

const apiMocks = vi.hoisted(() => ({
  fetchProxyProvidersAPI: vi.fn(),
  fetchProxiesAPI: vi.fn(),
  proxyLatencyTestAPI: vi.fn(),
  proxyGroupLatencyTestAPI: vi.fn(),
  unfixProxyInGroupAPI: vi.fn(),
  closeAllConnectionsAPI: vi.fn(),
}))

vi.mock('~/composables/useApi', () => ({
  closeAllConnectionsAPI: apiMocks.closeAllConnectionsAPI,
  closeSingleConnectionAPI: vi.fn(),
  fetchProxiesAPI: apiMocks.fetchProxiesAPI,
  fetchProxyProvidersAPI: apiMocks.fetchProxyProvidersAPI,
  proxyGroupLatencyTestAPI: apiMocks.proxyGroupLatencyTestAPI,
  proxyLatencyTestAPI: apiMocks.proxyLatencyTestAPI,
  proxyProviderHealthCheckAPI: vi.fn(),
  selectProxyInGroupAPI: vi.fn(),
  unfixProxyInGroupAPI: apiMocks.unfixProxyInGroupAPI,
  updateProxyProviderAPI: vi.fn(),
}))

const mockConfigStore = {
  autoCloseConns: false,
  latencyQualityMap: {
    NOT_CONNECTED: 0,
    MEDIUM: 200,
    HIGH: 500,
  },
  latencyTestTimeoutDuration: 5000,
  latencyTestUrlSource: 'dashboard' as 'core' | 'dashboard',
  urlForLatencyTest: 'https://latency.test/default',
  resolveLatencyTestUrl: (
    groupTestUrl?: string | null,
    testType?: 'default' | 'docker-registry' | 'claude-test',
  ) =>
    testType && testType !== 'default'
      ? groupTestUrl || mockConfigStore.urlForLatencyTest
      : mockConfigStore.latencyTestUrlSource === 'dashboard'
        ? mockConfigStore.urlForLatencyTest
        : groupTestUrl || mockConfigStore.urlForLatencyTest,
}

vi.stubGlobal('useConfigStore', () => mockConfigStore)
vi.stubGlobal('useConnectionsStore', () => ({
  latestConnectionMsg: null,
  restructRawMsgToConnection: vi.fn(() => []),
}))

const recordTestResultMock = vi.fn()
const recordBatchResultsMock = vi.fn()
vi.stubGlobal('useNodeRecommendationStore', () => ({
  recordTestResult: recordTestResultMock,
  recordBatchResults: recordBatchResultsMock,
}))

function proxy(overrides: Record<string, unknown> = {}) {
  return {
    name: 'node-a',
    type: 'ss',
    extra: {},
    history: [],
    hidden: false,
    udp: false,
    xudp: false,
    tfo: false,
    now: '',
    ...overrides,
  }
}

describe('stores/proxies latency state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockConfigStore.latencyTestUrlSource = 'core'
    recordTestResultMock.mockReset()
    recordBatchResultsMock.mockReset()
    apiMocks.fetchProxyProvidersAPI.mockResolvedValue({ providers: {} })
  })

  it('dedupes group members so two providers contributing the same node name collapse to one entry', async () => {
    // mihomo lists a member once per provider, so two providers carrying a node
    // of the same name surface it twice in `all`. Every API (select / latency /
    // `now`) is name-keyed, so the duplicate is indistinguishable — keeping it
    // would light up two rows for one selection. Collapse it.
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        AI: proxy({
          name: 'AI',
          type: 'Selector',
          now: 'US_88',
          all: ['US_124', 'US_88', 'US_124', 'US_88'],
        }),
      },
    })

    const store = useProxiesStore()
    await store.fetchProxies()
    await nextTick()

    const group = store.proxies.find((p) => p.name === 'AI')
    expect(group?.all).toEqual(['US_124', 'US_88'])
  })

  it('preserves the previous latency value while an individual test is in flight', async () => {
    let resolveLatency!: (value: { delay: number }) => void
    apiMocks.proxyLatencyTestAPI.mockReturnValue(
      new Promise((resolve) => {
        resolveLatency = resolve
      }),
    )

    const store = useProxiesStore()
    store.__seed({
      nodes: {
        'node-a': {
          name: 'node-a',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {
            [mockConfigStore.urlForLatencyTest]: [
              { time: '2026-05-19T13:17:31.000Z', delay: 88 },
            ],
            'https://latency.test/old': [
              { time: '2026-05-19T13:15:31.000Z', delay: 66 },
            ],
          },
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '',
        },
      },
      latency: {
        'node-a': {
          [mockConfigStore.urlForLatencyTest]: 88,
          'https://latency.test/old': 66,
        },
      },
    })

    const testing = store.proxyLatencyTest('node-a', '', null, null)

    // The Latency pill renders a spinner via proxyLatencyTestingMap; the
    // underlying value should stay at its previous reading so that on failure
    // we don't leak "---" out the other side.
    expect(store.proxyLatencyTestingMap['node-a']).toBe(true)
    expect(store.getLatencyByName('node-a', null)).toBe(88)
    expect(store.getLatencyHistoryByName('node-a', null)).toEqual([
      { time: '2026-05-19T13:17:31.000Z', delay: 88 },
    ])

    resolveLatency({ delay: 42 })
    await testing
  })

  it('appends new latency to history while preserving prior entries', async () => {
    apiMocks.proxyLatencyTestAPI.mockResolvedValue({ delay: 42 })

    const store = useProxiesStore()
    store.__seed({
      nodes: {
        'node-a': {
          name: 'node-a',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {
            [mockConfigStore.urlForLatencyTest]: [
              { time: '2026-05-19T13:17:31.000Z', delay: 88 },
            ],
          },
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '',
        },
      },
      latency: {
        'node-a': {
          [mockConfigStore.urlForLatencyTest]: 88,
        },
      },
    })

    await store.proxyLatencyTest('node-a', '', null, null)

    expect(store.getLatencyByName('node-a', null)).toBe(42)

    const history = store.getLatencyHistoryByName('node-a', null)
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual({
      time: '2026-05-19T13:17:31.000Z',
      delay: 88,
    })
    expect(history[1]?.delay).toBe(42)
    expect(typeof history[1]?.time).toBe('string')
  })

  it('records a failed entry in history without clobbering the latency map when an individual test errors', async () => {
    apiMocks.proxyLatencyTestAPI.mockRejectedValue(new Error('boom'))

    const store = useProxiesStore()
    store.__seed({
      nodes: {
        'node-a': {
          name: 'node-a',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {
            [mockConfigStore.urlForLatencyTest]: [
              { time: '2026-05-19T13:17:31.000Z', delay: 88 },
            ],
          },
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '',
        },
      },
      latency: {
        'node-a': {
          [mockConfigStore.urlForLatencyTest]: 88,
        },
      },
    })

    await store.proxyLatencyTest('node-a', '', null, null)

    // Previous value preserved so the pill stays informative on transport
    // failures; the failure datapoint surfaces via stability bar / sparkline
    // through history + nodeRecommendation.
    expect(store.getLatencyByName('node-a', null)).toBe(88)

    const history = store.getLatencyHistoryByName('node-a', null)
    expect(history).toHaveLength(2)
    expect(history[1]?.delay).toBe(0)

    expect(recordTestResultMock).toHaveBeenCalledWith('node-a', null, false)
  })

  it('preserves prior latency map values when a group latency test fails, only recording failure history', async () => {
    apiMocks.proxyGroupLatencyTestAPI.mockRejectedValue(
      new Error('Request timed out'),
    )
    apiMocks.fetchProxiesAPI.mockResolvedValue({ proxies: {} })

    const store = useProxiesStore()
    store.proxies = [
      {
        name: 'GROUP',
        type: 'Selector',
        all: ['node-a', 'node-b'],
        extra: {},
        history: [],
        hidden: false,
        udp: false,
        xudp: false,
        tfo: false,
        now: 'node-a',
      } as never,
    ]
    store.__seed({
      nodes: {
        'node-a': {
          name: 'node-a',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {
            [mockConfigStore.urlForLatencyTest]: [
              { time: '2026-05-19T13:17:31.000Z', delay: 88 },
            ],
          },
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '',
        },
        'node-b': {
          name: 'node-b',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {},
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '',
        },
      },
      latency: {
        'node-a': { [mockConfigStore.urlForLatencyTest]: 88 },
        'node-b': { [mockConfigStore.urlForLatencyTest]: 120 },
      },
    })

    // Must not reject — store should swallow the network failure.
    await expect(store.proxyGroupLatencyTest('GROUP')).resolves.toBeUndefined()

    expect(store.proxyGroupLatencyTestingMap.GROUP).toBe(false)
    expect(recordBatchResultsMock).toHaveBeenCalledWith({
      'node-a': 0,
      'node-b': 0,
    })

    // Latency map values stay at what they were before the failed test —
    // the user's pills don't suddenly turn into "---".
    expect(store.getLatencyByName('node-a', null)).toBe(88)
    expect(store.getLatencyByName('node-b', null)).toBe(120)

    const aHistory = store.getLatencyHistoryByName('node-a', null)
    expect(aHistory).toHaveLength(2)
    expect(aHistory[1]?.delay).toBe(0)

    const bHistory = store.getLatencyHistoryByName('node-b', null)
    expect(bHistory).toHaveLength(1)
    expect(bHistory[0]?.delay).toBe(0)
  })

  it.each([
    [
      'docker-registry',
      'https://registry-1.docker.io/v2/library/python/manifests/3.12-slim',
    ],
    ['claude-test', 'https://claude.ai/'],
  ] as const)(
    'refreshes %s group state when the backend reports that every node failed',
    async (testType, testUrl) => {
      apiMocks.proxyGroupLatencyTestAPI.mockRejectedValue({
        response: { status: 504 },
      })
      apiMocks.fetchProxiesAPI.mockResolvedValue({
        proxies: {
          GROUP: proxy({
            name: 'GROUP',
            type: 'URLTest',
            all: ['node-a', 'node-b'],
            now: 'node-a',
            testUrl,
            testType,
          }),
          'node-a': proxy({
            name: 'node-a',
            alive: false,
            extra: {
              [testUrl]: {
                alive: false,
                history: [{ time: '2026-08-27T00:00:00.000Z', delay: 0 }],
              },
            },
          }),
          'node-b': proxy({
            name: 'node-b',
            alive: false,
            extra: {
              [testUrl]: {
                alive: false,
                history: [{ time: '2026-08-27T00:00:00.000Z', delay: 0 }],
              },
            },
          }),
        },
      })

      const store = useProxiesStore()
      store.proxies = [
        {
          name: 'GROUP',
          type: 'URLTest',
          all: ['node-a', 'node-b'],
          now: 'node-a',
          testUrl,
          testType,
        } as never,
      ]
      store.__seed({
        latency: {
          'node-a': { [testUrl]: 88 },
          'node-b': { [testUrl]: 120 },
        },
      })

      await store.proxyGroupLatencyTest('GROUP')

      expect(apiMocks.fetchProxiesAPI).toHaveBeenCalledTimes(1)
      expect(store.getLatencyByName('node-a', testUrl, testType)).toBe(0)
      expect(store.getLatencyByName('node-b', testUrl, testType)).toBe(0)
      expect(
        store.getLatencyHistoryByName('node-a', testUrl, testType),
      ).toHaveLength(1)
      expect(
        store.getLatencyHistoryByName('node-b', testUrl, testType),
      ).toHaveLength(1)
    },
  )

  it('keeps successful group latency results when the following proxy refresh fails', async () => {
    const results = { 'node-a': 88, 'node-b': 120 }
    apiMocks.proxyGroupLatencyTestAPI.mockResolvedValue(results)
    apiMocks.fetchProxiesAPI.mockRejectedValueOnce({
      response: { status: 504 },
    })

    const store = useProxiesStore()
    store.proxies = [
      {
        name: 'GROUP',
        type: 'Selector',
        all: ['node-a', 'node-b'],
        extra: {},
        history: [],
        hidden: false,
        udp: false,
        xudp: false,
        tfo: false,
        now: 'node-a',
      } as never,
    ]

    await store.proxyGroupLatencyTest('GROUP')

    expect(apiMocks.fetchProxiesAPI).toHaveBeenCalledOnce()
    expect(recordBatchResultsMock).toHaveBeenCalledOnce()
    expect(recordBatchResultsMock).toHaveBeenCalledWith(results)
  })

  it('batch-tests every provider node via the provider health-check endpoint', async () => {
    apiMocks.proxyLatencyTestAPI
      .mockResolvedValueOnce({ delay: 120 })
      .mockResolvedValueOnce({ delay: 88 })
    apiMocks.fetchProxiesAPI.mockResolvedValue({ proxies: {} })

    const store = useProxiesStore()
    store.proxyProviders = [
      {
        name: '订阅',
        vehicleType: 'HTTP',
        updatedAt: '2026-05-27T00:00:00.000Z',
        testUrl: 'https://latency.test/provider',
        timeout: 3000,
        proxies: [{ name: 'node-a' }, { name: 'node-b' }],
      } as never,
    ]
    store.__seed({
      nodes: {
        'node-a': {
          name: 'node-a',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {},
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '订阅',
        },
        'node-b': {
          name: 'node-b',
          alive: true,
          udp: false,
          tfo: false,
          latencyTestHistory: {},
          latency: '',
          xudp: false,
          type: 'ss',
          provider: '订阅',
        },
      },
    })

    await store.proxyProviderLatencyTest('订阅')

    expect(apiMocks.proxyLatencyTestAPI).toHaveBeenCalledTimes(2)
    expect(apiMocks.proxyLatencyTestAPI).toHaveBeenNthCalledWith(
      1,
      'node-a',
      '订阅',
      'https://latency.test/provider',
      3000,
    )
    expect(apiMocks.proxyLatencyTestAPI).toHaveBeenNthCalledWith(
      2,
      'node-b',
      '订阅',
      'https://latency.test/provider',
      3000,
    )
    expect(recordBatchResultsMock).toHaveBeenCalledWith({
      'node-a': 120,
      'node-b': 88,
    })
    expect(
      store.getLatencyByName('node-a', 'https://latency.test/provider'),
    ).toBe(120)
    expect(
      store.getLatencyByName('node-b', 'https://latency.test/provider'),
    ).toBe(88)
    expect(store.proxyProviderLatencyTestingMap['订阅']).toBe(false)
  })

  it('unfixes an automatic group and refreshes proxies', async () => {
    apiMocks.fetchProxiesAPI.mockResolvedValue({ proxies: {} })

    const store = useProxiesStore()
    await store.unfixProxyInGroup('AUTO')

    expect(apiMocks.unfixProxyInGroupAPI).toHaveBeenCalledWith('AUTO')
    expect(apiMocks.fetchProxiesAPI).toHaveBeenCalled()
  })

  it('notifies node recommendation store after a proxy group latency test', async () => {
    apiMocks.proxyGroupLatencyTestAPI.mockResolvedValue({
      'node-a': 120,
      'node-b': 0,
    })
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        GROUP: {
          name: 'GROUP',
          type: 'Selector',
          all: ['node-a', 'node-b'],
          extra: {},
          history: [],
          hidden: false,
          udp: false,
          xudp: false,
          tfo: false,
          now: 'node-a',
        },
        'node-a': proxy({
          name: 'node-a',
          history: [{ time: '2026-05-19T13:18:00.000Z', delay: 120 }],
        }),
        'node-b': proxy({ name: 'node-b' }),
      },
    })

    const store = useProxiesStore()
    await store.proxyGroupLatencyTest('GROUP')

    expect(recordBatchResultsMock).toHaveBeenCalledWith({
      'node-a': 120,
      'node-b': 0,
    })
    expect(store.getLatencyByName('node-a', null)).toBe(120)
    expect(store.getLatencyByName('node-b', null)).toBe(0)
  })

  it("uses the group's own test url for a manual group latency test", async () => {
    mockConfigStore.latencyTestUrlSource = 'dashboard'
    apiMocks.proxyGroupLatencyTestAPI.mockResolvedValue({ 'node-a': 120 })
    apiMocks.fetchProxiesAPI.mockResolvedValue({ proxies: {} })

    const store = useProxiesStore()
    store.proxies = [
      {
        name: 'REGISTRY',
        type: 'URLTest',
        all: ['node-a'],
        testType: 'docker-registry',
        testUrl: 'https://registry.test/v2/image/manifests/latest',
        timeout: 6000,
      } as never,
    ]

    await store.proxyGroupLatencyTest('REGISTRY')

    expect(apiMocks.proxyGroupLatencyTestAPI).toHaveBeenCalledWith(
      'REGISTRY',
      'https://registry.test/v2/image/manifests/latest',
      6000,
    )
  })

  it('drops stale latency when fresh proxy data has no successful history', async () => {
    const store = useProxiesStore()
    store.__seed({
      latency: {
        'node-a': {
          [mockConfigStore.urlForLatencyTest]: 88,
        },
      },
    })
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        'node-a': proxy({
          history: [],
        }),
      },
    })

    await store.fetchProxies()
    await nextTick()

    expect(store.getLatencyByName('node-a', null)).toBe(0)
    expect(store.getLatencyHistoryByName('node-a', null)).toEqual([])
  })

  it('reuses a node latency measured under a provider test url when the proxy view queries the global url', async () => {
    const store = useProxiesStore()
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        'node-a': proxy({
          name: 'node-a',
          type: 'vless',
          // Backend only has a reading under the provider's health-check url;
          // the global url (used by the proxies view) was never measured.
          extra: {
            'https://latency.test/provider': {
              history: [{ time: '2026-05-19T13:17:31.000Z', delay: 506 }],
            },
          },
          history: [],
        }),
      },
    })

    await store.fetchProxies()
    await nextTick()

    // Provider view (queries the provider url) shows the real value.
    expect(
      store.getLatencyByName('node-a', 'https://latency.test/provider'),
    ).toBe(506)

    // Proxies view falls back to the global url. It must reuse the value that
    // was actually measured rather than reporting "---" (0).
    expect(store.getLatencyByName('node-a', null)).toBe(506)
  })

  it('reuses a node latency history measured under a provider test url when the proxy view queries the global url', async () => {
    const store = useProxiesStore()
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        'node-a': proxy({
          name: 'node-a',
          type: 'vless',
          extra: {
            'https://latency.test/provider': {
              history: [{ time: '2026-05-19T13:17:31.000Z', delay: 506 }],
            },
          },
          history: [],
        }),
      },
    })

    await store.fetchProxies()
    await nextTick()

    // The stability bar / sparkline reads history. It must reuse the measured
    // series instead of the empty placeholder bucket for the global url.
    expect(store.getLatencyHistoryByName('node-a', null)).toEqual([
      { time: '2026-05-19T13:17:31.000Z', delay: 506 },
    ])
  })

  it('keeps an explicit failed reading for the requested url instead of reusing another url', async () => {
    const store = useProxiesStore()
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        'node-a': proxy({
          name: 'node-a',
          type: 'vless',
          extra: {
            'https://latency.test/provider': {
              history: [{ time: '2026-05-19T13:17:31.000Z', delay: 506 }],
            },
          },
          // The requested url was checked and failed. A successful provider
          // check for another url must not make this url look available.
          history: [
            { time: '2026-05-19T13:16:31.000Z', delay: 0 },
            { time: '2026-05-19T13:17:31.000Z', delay: 0 },
          ],
        }),
      },
    })

    await store.fetchProxies()
    await nextTick()

    expect(store.getLatencyByName('node-a', null)).toBe(0)
    expect(store.getLatencyHistoryByName('node-a', null)).toEqual([
      { time: '2026-05-19T13:16:31.000Z', delay: 0 },
      { time: '2026-05-19T13:17:31.000Z', delay: 0 },
    ])
  })

  it('keeps the requested test url history when it has a successful probe', async () => {
    const store = useProxiesStore()
    apiMocks.fetchProxiesAPI.mockResolvedValue({
      proxies: {
        'node-a': proxy({
          name: 'node-a',
          type: 'vless',
          extra: {
            'https://latency.test/provider': {
              history: [{ time: '2026-05-19T13:18:31.000Z', delay: 506 }],
            },
          },
          history: [
            { time: '2026-05-19T13:17:31.000Z', delay: 88 },
            { time: '2026-05-19T13:18:31.000Z', delay: 0 },
          ],
        }),
      },
    })

    await store.fetchProxies()
    await nextTick()

    expect(store.getLatencyHistoryByName('node-a', null)).toEqual([
      { time: '2026-05-19T13:17:31.000Z', delay: 88 },
      { time: '2026-05-19T13:18:31.000Z', delay: 0 },
    ])
  })
})

describe('stores/proxies read model', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    apiMocks.fetchProxyProvidersAPI.mockResolvedValue({ providers: {} })
  })

  it('getNode returns an honest view and never leaks latency-as-now', () => {
    const store = useProxiesStore()
    store.__seed({
      nodes: {
        GROUP: {
          name: 'GROUP',
          alive: undefined,
          udp: false,
          tfo: false,
          xudp: false,
          type: 'selector',
          latency: 'leaf', // the kernel's `now` alias lives in `latency`
          provider: '',
          latencyTestHistory: {},
        },
        leaf: {
          name: 'leaf',
          alive: true,
          udp: true,
          tfo: false,
          xudp: false,
          type: 'ss',
          latency: '',
          provider: 'subA',
          latencyTestHistory: {},
        },
      },
    })

    const group = store.getNode('GROUP')!
    expect(group.selectedNodeName).toBe('leaf')
    expect(group).not.toHaveProperty('latency')

    const leaf = store.getNode('leaf')!
    expect(leaf.selectedNodeName).toBeUndefined()
    expect(leaf.alive).toBe(true)
    expect(leaf.provider).toBe('subA')
    expect(store.getNode('missing')).toBeUndefined()
  })

  it('aliveNodeNames / nodeNames query the hidden map', () => {
    const store = useProxiesStore()
    store.__seed({
      nodes: {
        a: {
          name: 'a',
          alive: true,
          udp: false,
          tfo: false,
          xudp: false,
          type: 'ss',
          latency: '',
          provider: '',
          latencyTestHistory: {},
        },
        b: {
          name: 'b',
          alive: false,
          udp: false,
          tfo: false,
          xudp: false,
          type: 'ss',
          latency: '',
          provider: '',
          latencyTestHistory: {},
        },
      },
    })
    expect(store.aliveNodeNames(['a', 'b', 'missing'])).toEqual(['a'])
    expect(store.nodeNames().sort()).toEqual(['a', 'b'])
  })

  it.each([
    ['claude-test', 'https://claude.ai/'],
    [
      'docker-registry',
      'https://registry-1.docker.io/v2/library/python/manifests/3.12-slim',
    ],
  ] as const)(
    'uses the %s group result instead of the last unrelated health check',
    async (testType, testUrl) => {
      apiMocks.fetchProxiesAPI.mockResolvedValue({
        proxies: {
          GROUP: proxy({
            name: 'GROUP',
            type: 'Selector',
            all: ['node-a', 'node-b'],
            testUrl,
            testType,
          }),
          'node-a': proxy({
            name: 'node-a',
            alive: false,
            extra: {
              [testUrl]: {
                alive: true,
                history: [{ time: '2026-08-27T00:00:00.000Z', delay: 88 }],
              },
            },
          }),
          'node-b': proxy({
            name: 'node-b',
            alive: true,
            extra: {
              [testUrl]: {
                alive: false,
                history: [{ time: '2026-08-27T00:00:00.000Z', delay: 0 }],
              },
            },
          }),
        },
      })

      const store = useProxiesStore()
      await store.fetchProxies()
      await nextTick()

      expect(
        store.aliveNodeNames(['node-a', 'node-b'], testUrl, testType),
      ).toEqual(['node-a'])
    },
  )

  it('isTesting ORs node, provider and group flags', () => {
    const store = useProxiesStore()
    expect(store.isTesting('n')).toBe(false)
    store.proxyLatencyTestingMap.n = true
    expect(store.isTesting('n')).toBe(true)
    store.proxyLatencyTestingMap.n = false
    store.proxyProviderLatencyTestingMap.p = true
    expect(store.isTesting('n', { providerName: 'p' })).toBe(true)
    expect(store.isTesting('n')).toBe(false)
    store.proxyProviderLatencyTestingMap.p = false
    store.proxyGroupLatencyTestingMap.g = true
    expect(store.isTesting('n', { groupName: 'g' })).toBe(true)
    expect(store.isTesting('n', { providerName: 'p' })).toBe(false)
  })
})

describe('stores/proxies closeAllConnections', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockConfigStore.autoCloseConns = false
  })

  it('closes every connection when autoCloseConns is enabled', async () => {
    mockConfigStore.autoCloseConns = true

    const store = useProxiesStore()
    await store.closeAllConnections()

    expect(apiMocks.closeAllConnectionsAPI).toHaveBeenCalledTimes(1)
  })

  it('does nothing when autoCloseConns is disabled', async () => {
    mockConfigStore.autoCloseConns = false

    const store = useProxiesStore()
    await store.closeAllConnections()

    expect(apiMocks.closeAllConnectionsAPI).not.toHaveBeenCalled()
  })

  it('proxiesLoaded flips true after a successful fetch (drives the empty/loading state)', async () => {
    apiMocks.fetchProxiesAPI.mockResolvedValue({ proxies: {} })

    const store = useProxiesStore()
    expect(store.proxiesLoaded).toBe(false)
    await store.fetchProxies()
    expect(store.proxiesLoaded).toBe(true)
  })

  it('proxiesLoaded stays true even when the fetch rejects (no permanent skeleton)', async () => {
    apiMocks.fetchProxiesAPI.mockRejectedValue(new Error('boom'))

    const store = useProxiesStore()
    await expect(store.fetchProxies()).rejects.toThrow('boom')
    expect(store.proxiesLoaded).toBe(true)
  })
})
