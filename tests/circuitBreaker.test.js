jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  performance: jest.fn()
}))

jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn(() => Promise.resolve())
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve({ success: true })),
  clearTempUnavailable: jest.fn(() => Promise.resolve()),
  isTempUnavailable: jest.fn(() => Promise.resolve(false))
}))

jest.mock('../config/config', () => ({}), { virtual: true })

// 🧪 极简的内存 Redis mock，仅实现熔断器用到的命令
const makeMockClient = () => {
  const storage = new Map()
  const zsets = new Map()

  const zsetGet = (key) => {
    if (!zsets.has(key)) zsets.set(key, new Map())
    return zsets.get(key)
  }

  const client = {
    async get(key) {
      return storage.has(key) ? storage.get(key).value : null
    },
    async set(key, value, ...args) {
      // Parse args: 支持 'EX' <seconds>, 'NX', 'XX'
      const options = { ex: null, nx: false, xx: false }
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === 'EX' || a === 'ex') options.ex = Number(args[++i])
        else if (a === 'NX' || a === 'nx') options.nx = true
        else if (a === 'XX' || a === 'xx') options.xx = true
      }
      if (options.nx && storage.has(key)) return null
      if (options.xx && !storage.has(key)) return null
      storage.set(key, {
        value: String(value),
        expireAt: options.ex ? Date.now() + options.ex * 1000 : null
      })
      return 'OK'
    },
    async setex(key, seconds, value) {
      storage.set(key, { value: String(value), expireAt: Date.now() + seconds * 1000 })
      return 'OK'
    },
    async del(...keys) {
      let count = 0
      for (const k of keys) {
        if (storage.delete(k)) count++
        if (zsets.delete(k)) count++
      }
      return count
    },
    async getdel(key) {
      const entry = storage.get(key)
      storage.delete(key)
      return entry ? entry.value : null
    },
    async incr(key) {
      const cur = Number((storage.get(key) || {}).value) || 0
      const next = cur + 1
      storage.set(key, { ...(storage.get(key) || {}), value: String(next) })
      return next
    },
    async expire(key, seconds) {
      if (storage.has(key)) {
        storage.get(key).expireAt = Date.now() + seconds * 1000
        return 1
      }
      if (zsets.has(key)) {
        // 简化：不跟踪 zset ttl，但返回 1
        return 1
      }
      return 0
    },
    async ttl(key) {
      const entry = storage.get(key)
      if (!entry) return -2
      if (!entry.expireAt) return -1
      return Math.max(0, Math.ceil((entry.expireAt - Date.now()) / 1000))
    },
    async zadd(key, score, member) {
      zsetGet(key).set(member, Number(score))
      return 1
    },
    async zcard(key) {
      return zsetGet(key).size
    },
    async zremrangebyscore(key, min, max) {
      const zset = zsetGet(key)
      let count = 0
      for (const [m, s] of zset.entries()) {
        const minOk = min === '-inf' || s >= Number(min)
        const maxOk = max === '+inf' || s <= Number(max)
        if (minOk && maxOk) {
          zset.delete(m)
          count++
        }
      }
      return count
    },
    pipeline() {
      const ops = []
      const pipe = {
        zadd: (...a) => {
          ops.push(['zadd', a])
          return pipe
        },
        zcard: (...a) => {
          ops.push(['zcard', a])
          return pipe
        },
        zremrangebyscore: (...a) => {
          ops.push(['zremrangebyscore', a])
          return pipe
        },
        expire: (...a) => {
          ops.push(['expire', a])
          return pipe
        },
        set: (...a) => {
          ops.push(['set', a])
          return pipe
        },
        del: (...a) => {
          ops.push(['del', a])
          return pipe
        },
        incr: (...a) => {
          ops.push(['incr', a])
          return pipe
        },
        get: (...a) => {
          ops.push(['get', a])
          return pipe
        },
        setex: (...a) => {
          ops.push(['setex', a])
          return pipe
        },
        ttl: (...a) => {
          ops.push(['ttl', a])
          return pipe
        },
        exec: async () => {
          const results = []
          for (const [op, a] of ops) {
            try {
              const result = await client[op](...a)
              results.push([null, result])
            } catch (err) {
              results.push([err])
            }
          }
          return results
        }
      }
      return pipe
    },
    __storage: storage,
    __zsets: zsets
  }
  return client
}

const mockClient = makeMockClient()
jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => mockClient)
}))

const mockGetAccount = jest.fn()
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: (...args) => mockGetAccount(...args)
}))

const circuitBreaker = require('../src/utils/circuitBreaker')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

describe('circuitBreaker', () => {
  const accountId = 'acc-test'
  beforeEach(async () => {
    mockClient.__storage.clear()
    mockClient.__zsets.clear()
    jest.clearAllMocks()
    // 默认是 adaptive preset 的账户
    mockGetAccount.mockResolvedValue({
      id: accountId,
      upstreamType: 'adaptive',
      errorPolicy: null
    })
    upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false)
  })

  it('isTransient 正确分类', () => {
    expect(circuitBreaker.isTransient(529)).toBe(true)
    expect(circuitBreaker.isTransient(502)).toBe(true)
    expect(circuitBreaker.isTransient(503)).toBe(true)
    expect(circuitBreaker.isTransient(504)).toBe(true)
    expect(circuitBreaker.isTransient(500)).toBe(true)
    expect(circuitBreaker.isTransient(401)).toBe(false)
    expect(circuitBreaker.isTransient(429)).toBe(false)
    expect(circuitBreaker.isTransient(200)).toBe(false)
    expect(circuitBreaker.isTransient({ code: 'ECONNRESET' })).toBe(true)
    expect(circuitBreaker.isTransient({ code: 'UNKNOWN' })).toBe(false)
  })

  it('resolvePolicyFromAccount 返回 preset 并合并覆盖', () => {
    const p = circuitBreaker.resolvePolicyFromAccount({ upstreamType: 'adaptive' })
    expect(p.retryOnTransient).toBe(1)
    const p2 = circuitBreaker.resolvePolicyFromAccount({
      upstreamType: 'adaptive',
      errorPolicy: { consecutiveFailureThreshold: 99 }
    })
    expect(p2.consecutiveFailureThreshold).toBe(99)
    expect(p2.retryOnTransient).toBe(1)
  })

  it('recordSuccess 清零 failRun', async () => {
    await circuitBreaker.recordFailure(accountId, 529)
    await circuitBreaker.recordFailure(accountId, 529)
    let state = await circuitBreaker.getState(accountId)
    expect(state.failRun).toBe(2)
    await circuitBreaker.recordSuccess(accountId)
    state = await circuitBreaker.getState(accountId)
    expect(state.failRun).toBe(0)
  })

  it('连续失败达到阈值触发 trip（adaptive=5）', async () => {
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordFailure(accountId, 529)
    }
    const state = await circuitBreaker.getState(accountId)
    expect(state.state).toBe('open')
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalled()
  })

  it('样本不足时高错误率不触发 trip', async () => {
    // adaptive minSamples=10，连续阈值=5，只做 3 次失败（低于连续阈值）
    // 需要更多成功来稀释错误率，同时保证 failRun<5
    for (let i = 0; i < 3; i++) {
      await circuitBreaker.recordFailure(accountId, 503)
      await circuitBreaker.recordSuccess(accountId) // failRun 清零
    }
    const state = await circuitBreaker.getState(accountId)
    expect(state.state).toBe('closed')
  })

  it('recordSuccess({probe: true}) 关闭熔断', async () => {
    // 先手动打开
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordFailure(accountId, 529)
    }
    expect((await circuitBreaker.getState(accountId)).state).toBe('open')
    // 手动把 state 改成 half-open 模拟探测中
    await mockClient.set(`circuit:claude-console:${accountId}:state`, 'half-open')
    await circuitBreaker.recordSuccess(accountId, { probe: true })
    const state = await circuitBreaker.getState(accountId)
    expect(state.state).toBe('closed')
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalled()
  })

  it('recordFailure({probe: true}) 重开并翻倍 cooldown', async () => {
    // trip 一次
    for (let i = 0; i < 5; i++) {
      await circuitBreaker.recordFailure(accountId, 529)
    }
    const before = await circuitBreaker.getState(accountId)
    expect(before.cooldownSeconds).toBe(30) // adaptive openCooldown
    // probe 失败
    await circuitBreaker.recordFailure(accountId, 529, { probe: true })
    const after = await circuitBreaker.getState(accountId)
    expect(after.state).toBe('open')
    expect(after.cooldownSeconds).toBe(60) // 30 * 2
  })

  it('cooldown 封顶 openCooldownMax', async () => {
    // adaptive openCooldownMax=600
    await mockClient.set(`circuit:claude-console:${accountId}:cooldown`, '500')
    await mockClient.set(`circuit:claude-console:${accountId}:state`, 'half-open')
    await circuitBreaker.recordFailure(accountId, 529, { probe: true })
    const state = await circuitBreaker.getState(accountId)
    expect(state.cooldownSeconds).toBe(600) // capped
  })

  it('consumeProbeFlag 消费令牌', async () => {
    await mockClient.set(`circuit:claude-console:${accountId}:probe`, 'marker')
    const first = await circuitBreaker.consumeProbeFlag(accountId)
    const second = await circuitBreaker.consumeProbeFlag(accountId)
    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  describe('tryAcquireProbe', () => {
    it('state 不存在（401/429 等非熔断写入的 temp_unavailable）不授予探测', async () => {
      // 无 circuit state
      upstreamErrorHelper.isTempUnavailable.mockResolvedValue(true)
      const granted = await circuitBreaker.tryAcquireProbe(accountId)
      expect(granted).toBe(false)
    })

    it('state=closed 不授予探测', async () => {
      await mockClient.set(`circuit:claude-console:${accountId}:state`, 'closed')
      upstreamErrorHelper.isTempUnavailable.mockResolvedValue(true)
      const granted = await circuitBreaker.tryAcquireProbe(accountId)
      expect(granted).toBe(false)
    })

    it('state=open 且冷却仍在 TTL 内不授予', async () => {
      await mockClient.set(`circuit:claude-console:${accountId}:state`, 'open')
      upstreamErrorHelper.isTempUnavailable.mockResolvedValue(true) // 冷却还在
      const granted = await circuitBreaker.tryAcquireProbe(accountId)
      expect(granted).toBe(false)
    })

    it('state=open 且冷却过期：CAS 到 half-open 并授予第一个请求', async () => {
      await mockClient.set(`circuit:claude-console:${accountId}:state`, 'open')
      upstreamErrorHelper.isTempUnavailable.mockResolvedValue(false) // 冷却过期

      const first = await circuitBreaker.tryAcquireProbe(accountId)
      expect(first).toBe(true)

      // 状态已转到 half-open
      const stateAfter = await mockClient.get(`circuit:claude-console:${accountId}:state`)
      expect(stateAfter).toBe('half-open')

      // 并发第二次调用：probe 锁已被第一个占，返回 false
      const second = await circuitBreaker.tryAcquireProbe(accountId)
      expect(second).toBe(false)
    })

    it('state=half-open 但 probe 键被释放：新调用可抢到', async () => {
      await mockClient.set(`circuit:claude-console:${accountId}:state`, 'half-open')
      // probe 键不存在 → 可抢
      const granted = await circuitBreaker.tryAcquireProbe(accountId)
      expect(granted).toBe(true)
    })
  })

  it('withRetry 瞬时错误重试然后成功', async () => {
    let call = 0
    const fn = async () => {
      call++
      if (call < 3) return { status: 529 }
      return { status: 200 }
    }
    const result = await circuitBreaker.withRetry(fn, { attempts: 2 })
    expect(result.status).toBe(200)
    expect(call).toBe(3)
  })

  it('withRetry attempts=0 不重试', async () => {
    let call = 0
    const fn = async () => {
      call++
      return { status: 529 }
    }
    const result = await circuitBreaker.withRetry(fn, { attempts: 0 })
    expect(result.status).toBe(529)
    expect(call).toBe(1)
  })

  it('withRetry 非瞬时错误不重试', async () => {
    let call = 0
    const fn = async () => {
      call++
      return { status: 401 }
    }
    const result = await circuitBreaker.withRetry(fn, { attempts: 3 })
    expect(result.status).toBe(401)
    expect(call).toBe(1)
  })

  it('clear 删除所有键', async () => {
    await circuitBreaker.recordFailure(accountId, 529)
    await circuitBreaker.clear(accountId)
    const state = await circuitBreaker.getState(accountId)
    expect(state.state).toBe('closed')
    expect(state.samples).toBe(0)
  })
})
