const logger = require('./logger')
const upstreamErrorHelper = require('./upstreamErrorHelper')

const KEY_PREFIX = 'circuit:claude-console:'

const STATE_CLOSED = 'closed'
const STATE_OPEN = 'open'
const STATE_HALF_OPEN = 'half-open'

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504, 529])
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_SOCKET_HANG_UP'
])

const PRESETS = Object.freeze({
  direct: {
    retryOnTransient: 0,
    window: 60,
    minSamples: 5,
    errorRateThreshold: 0.4,
    consecutiveFailureThreshold: 3,
    openCooldown: 300,
    openCooldownMax: 1800
  },
  adaptive: {
    retryOnTransient: 1,
    window: 60,
    minSamples: 10,
    errorRateThreshold: 0.5,
    consecutiveFailureThreshold: 5,
    openCooldown: 30,
    openCooldownMax: 600
  },
  aggregator: {
    retryOnTransient: 2,
    window: 60,
    minSamples: 15,
    errorRateThreshold: 0.7,
    consecutiveFailureThreshold: 8,
    openCooldown: 20,
    openCooldownMax: 300
  }
})

const UPSTREAM_TYPES = Object.freeze(['direct', 'adaptive', 'aggregator'])
const DEFAULT_UPSTREAM_TYPE = 'adaptive'

let _redis = null
const getRedis = () => {
  if (!_redis) {
    _redis = require('../models/redis')
  }
  return _redis
}

let _accountService = null
const getAccountService = () => {
  if (!_accountService) {
    _accountService = require('../services/account/claudeConsoleAccountService')
  }
  return _accountService
}

let _configCache = null
const getConfig = () => {
  if (!_configCache) {
    try {
      _configCache = require('../../config/config')
    } catch {
      _configCache = {}
    }
  }
  return _configCache
}

const isEnabled = () => {
  const cfg = getConfig()
  if (!cfg || !cfg.circuitBreaker) {
    return true
  }
  return cfg.circuitBreaker.enabled !== false
}

const keys = (accountId) => ({
  samples: `${KEY_PREFIX}${accountId}:samples`,
  errors: `${KEY_PREFIX}${accountId}:errors`,
  state: `${KEY_PREFIX}${accountId}:state`,
  openedAt: `${KEY_PREFIX}${accountId}:openedAt`,
  failRun: `${KEY_PREFIX}${accountId}:failRun`,
  probe: `${KEY_PREFIX}${accountId}:probe`,
  cooldown: `${KEY_PREFIX}${accountId}:cooldown`
})

const resolvePresetFromConfig = (upstreamType) => {
  const cfg = getConfig()
  const fromConfig = cfg?.circuitBreaker?.presets?.[upstreamType]
  const fallback = PRESETS[upstreamType] || PRESETS[DEFAULT_UPSTREAM_TYPE]
  return { ...fallback, ...(fromConfig || {}) }
}

const normalizeUpstreamType = (raw) => {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return UPSTREAM_TYPES.includes(value) ? value : DEFAULT_UPSTREAM_TYPE
}

const resolvePolicyFromAccount = (account) => {
  const upstreamType = normalizeUpstreamType(account?.upstreamType)
  const preset = resolvePresetFromConfig(upstreamType)
  const override =
    account?.errorPolicy && typeof account.errorPolicy === 'object' ? account.errorPolicy : null
  return { ...preset, ...(override || {}) }
}

const loadPolicy = async (accountId) => {
  try {
    const account = await getAccountService().getAccount(accountId)
    if (!account) {
      return resolvePresetFromConfig(DEFAULT_UPSTREAM_TYPE)
    }
    return resolvePolicyFromAccount(account)
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] Failed to load policy for ${accountId}: ${err.message}`)
    return resolvePresetFromConfig(DEFAULT_UPSTREAM_TYPE)
  }
}

const isTransient = (errorOrStatus) => {
  if (errorOrStatus === null || errorOrStatus === undefined) {
    return false
  }
  if (typeof errorOrStatus === 'number') {
    return TRANSIENT_STATUSES.has(errorOrStatus) || errorOrStatus === 529
  }
  if (typeof errorOrStatus === 'object') {
    if (typeof errorOrStatus.status === 'number') {
      return TRANSIENT_STATUSES.has(errorOrStatus.status) || errorOrStatus.status === 529
    }
    if (typeof errorOrStatus.code === 'string' && TRANSIENT_ERROR_CODES.has(errorOrStatus.code)) {
      return true
    }
    if (typeof errorOrStatus.name === 'string' && errorOrStatus.name === 'AxiosError') {
      const { response } = errorOrStatus
      if (response && typeof response.status === 'number') {
        return TRANSIENT_STATUSES.has(response.status) || response.status === 529
      }
    }
  }
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const computeRetryBackoff = (attempt) => (attempt === 1 ? 50 : 200)

// withRetry: attempts = number of RETRIES (total calls = attempts + 1).
// fn should return the raw axios response. If status in transient set, retry.
// If fn throws and error is transient, retry.
async function withRetry(fn, { attempts = 0, onRetry } = {}) {
  let lastError
  let lastResponse
  for (let i = 0; i <= attempts; i++) {
    try {
      const result = await fn(i)
      if (!result || typeof result.status !== 'number') {
        return result
      }
      if (i < attempts && isTransient(result.status)) {
        lastResponse = result
        if (typeof onRetry === 'function') {
          try {
            onRetry({ attempt: i + 1, statusCode: result.status })
          } catch {
            // ignore onRetry errors
          }
        }
        await sleep(computeRetryBackoff(i + 1))
        continue
      }
      return result
    } catch (err) {
      lastError = err
      if (i >= attempts || !isTransient(err)) {
        throw err
      }
      if (typeof onRetry === 'function') {
        try {
          onRetry({ attempt: i + 1, error: err })
        } catch {
          // ignore onRetry errors
        }
      }
      await sleep(computeRetryBackoff(i + 1))
    }
  }
  if (lastResponse) {
    return lastResponse
  }
  throw lastError || new Error('withRetry: exhausted without response')
}

const getTtlForKeys = (policy) => Math.max(60, Math.floor((policy.window || 60) * 2))

async function trimAndAdd(client, accountId, windowSeconds, isFailure, statusCode) {
  const now = Date.now()
  const threshold = now - windowSeconds * 1000
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`
  const k = keys(accountId)
  const ttl = Math.max(60, windowSeconds * 2)

  const pipeline = client.pipeline()
  pipeline.zadd(k.samples, now, member)
  pipeline.zremrangebyscore(k.samples, 0, threshold)
  pipeline.expire(k.samples, ttl)
  if (isFailure) {
    pipeline.zadd(k.errors, now, `${member}:${statusCode}`)
    pipeline.zremrangebyscore(k.errors, 0, threshold)
    pipeline.expire(k.errors, ttl)
    pipeline.incr(k.failRun)
    pipeline.expire(k.failRun, ttl)
  } else {
    pipeline.set(k.failRun, '0', 'EX', ttl)
  }
  pipeline.zcard(k.samples)
  pipeline.zcard(k.errors)
  pipeline.get(k.failRun)
  pipeline.get(k.state)
  pipeline.get(k.cooldown)
  const results = await pipeline.exec()

  // Read trailing counters (last 5 results). ioredis returns [err, value] tuples.
  const tail = results.slice(-5).map((r) => (Array.isArray(r) ? r[1] : r))
  const [samples, errors, failRunRaw, stateRaw, cooldownRaw] = tail
  return {
    samples: Number(samples) || 0,
    errors: Number(errors) || 0,
    failRun: Number(failRunRaw) || 0,
    state: stateRaw || STATE_CLOSED,
    currentCooldown: Number(cooldownRaw) || 0
  }
}

async function trip(
  accountId,
  policy,
  reason,
  { doubleCooldown = false, previousCooldown = 0 } = {}
) {
  const client = getRedis().getClientSafe()
  const k = keys(accountId)
  const ttl = getTtlForKeys(policy)
  let cooldownSeconds = policy.openCooldown
  if (doubleCooldown) {
    const basis = previousCooldown > 0 ? previousCooldown : policy.openCooldown
    cooldownSeconds = Math.min(basis * 2, policy.openCooldownMax)
  }
  cooldownSeconds = Math.max(5, Math.floor(cooldownSeconds))

  const openedAt = new Date().toISOString()
  const pipeline = client.pipeline()
  pipeline.set(k.state, STATE_OPEN, 'EX', ttl)
  pipeline.set(k.openedAt, openedAt, 'EX', ttl)
  pipeline.set(k.cooldown, String(cooldownSeconds), 'EX', ttl)
  pipeline.del(k.probe)
  await pipeline.exec()

  await upstreamErrorHelper
    .markTempUnavailable(accountId, 'claude-console', 529, cooldownSeconds, {
      source: 'circuit_breaker',
      reason
    })
    .catch(() => {})

  try {
    const webhookNotifier = require('./webhookNotifier')
    const accountService = getAccountService()
    const account = await accountService.getAccount(accountId).catch(() => null)
    await webhookNotifier.sendAccountAnomalyNotification({
      accountId,
      accountName: account?.name || 'Claude Console Account',
      platform: 'claude-console',
      status: 'error',
      errorCode: 'CLAUDE_CONSOLE_OVERLOADED',
      reason: `Circuit breaker tripped (${reason}). cooldown=${cooldownSeconds}s`,
      timestamp: openedAt
    })
  } catch (webhookError) {
    logger.warn(
      `⚠️ [CircuitBreaker] Failed to send webhook for account ${accountId}: ${webhookError.message}`
    )
  }

  logger.performance('console_circuit_trip', {
    accountId,
    reason,
    cooldownSeconds,
    policy
  })
  logger.warn(
    `🚨 [CircuitBreaker] Account ${accountId} tripped (${reason}), cooldown ${cooldownSeconds}s`
  )
}

async function recordSuccess(accountId, options = {}) {
  if (!isEnabled()) {
    return
  }
  const { probe = false } = options
  try {
    const policy = await loadPolicy(accountId)
    const client = getRedis().getClientSafe()
    const counters = await trimAndAdd(client, accountId, policy.window, false, null)

    if (probe && (counters.state === STATE_HALF_OPEN || counters.state === STATE_OPEN)) {
      const k = keys(accountId)
      const pipeline = client.pipeline()
      pipeline.set(k.state, STATE_CLOSED, 'EX', getTtlForKeys(policy))
      pipeline.del(k.openedAt)
      pipeline.del(k.cooldown)
      pipeline.del(k.probe)
      pipeline.set(k.failRun, '0', 'EX', getTtlForKeys(policy))
      await pipeline.exec()
      await upstreamErrorHelper.clearTempUnavailable(accountId, 'claude-console').catch(() => {})
      logger.info(`✅ [CircuitBreaker] Account ${accountId} recovered via probe success`)
    }
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] recordSuccess failed for ${accountId}: ${err.message}`)
  }
}

async function recordFailure(accountId, statusCode, options = {}) {
  if (!isEnabled()) {
    return
  }
  const { probe = false, reason } = options
  try {
    const policy = await loadPolicy(accountId)
    const client = getRedis().getClientSafe()
    const counters = await trimAndAdd(client, accountId, policy.window, true, statusCode)

    if (probe) {
      await trip(accountId, policy, reason || `probe_failed_${statusCode}`, {
        doubleCooldown: true,
        previousCooldown: counters.currentCooldown
      })
      return
    }

    if (counters.state === STATE_OPEN) {
      return
    }

    const errorRate = counters.samples > 0 ? counters.errors / counters.samples : 0
    const hitConsecutive = counters.failRun >= policy.consecutiveFailureThreshold
    const hitRate = counters.samples >= policy.minSamples && errorRate >= policy.errorRateThreshold

    if (hitConsecutive || hitRate) {
      const tripReason = hitConsecutive
        ? `consecutive_failures=${counters.failRun}`
        : `error_rate=${errorRate.toFixed(2)} samples=${counters.samples}`
      await trip(accountId, policy, tripReason)
    }
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] recordFailure failed for ${accountId}: ${err.message}`)
  }
}

// 尝试获取 half-open 探测权。
// **语义**：本函数必须在调度器已判定 `temp_unavailable === true` 时调用。
// - state=closed / 缺失：意味着 temp_unavailable 不是熔断器写的（401/429 等机制），
//   本函数不插手，返回 false 让调度器按不可用处理
// - state=open：若冷却仍在 TTL 内返回 false；冷却到期则 CAS 到 half-open 并尝试抢探测锁
// - state=half-open：SET NX 抢探��锁，只有第一个请求获得
async function tryAcquireProbe(accountId, probeTtlSeconds = 30) {
  if (!isEnabled()) {
    return false
  }
  try {
    const client = getRedis().getClientSafe()
    const k = keys(accountId)
    const stateRaw = await client.get(k.state)

    if (!stateRaw || stateRaw === STATE_CLOSED) {
      return false
    }

    if (stateRaw === STATE_OPEN) {
      const stillCooling = await upstreamErrorHelper
        .isTempUnavailable(accountId, 'claude-console')
        .catch(() => false)
      if (stillCooling) {
        return false
      }
      const ttl = Math.max(10, Math.floor(probeTtlSeconds))
      const transitioned = await client.set(k.state, STATE_HALF_OPEN, 'EX', ttl * 2, 'XX')
      if (transitioned !== 'OK') {
        return false
      }
    }

    const probeId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const acquired = await client.set(k.probe, probeId, 'NX', 'EX', probeTtlSeconds)
    return acquired === 'OK'
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] tryAcquireProbe failed for ${accountId}: ${err.message}`)
    return false
  }
}

async function getState(accountId) {
  try {
    const client = getRedis().getClientSafe()
    const k = keys(accountId)
    const pipeline = client.pipeline()
    pipeline.zcard(k.samples)
    pipeline.zcard(k.errors)
    pipeline.get(k.state)
    pipeline.get(k.openedAt)
    pipeline.get(k.failRun)
    pipeline.get(k.cooldown)
    pipeline.ttl(k.state)
    const rows = await pipeline.exec()
    const [samples, errors, stateRaw, openedAt, failRunRaw, cooldownRaw, ttlRaw] = rows.map((r) =>
      Array.isArray(r) ? r[1] : r
    )

    const samplesNum = Number(samples) || 0
    const errorsNum = Number(errors) || 0
    const state = stateRaw || STATE_CLOSED
    const cooldownSeconds = Number(cooldownRaw) || 0
    const ttlSec = Number(ttlRaw) || 0

    let cooldownRemaining = 0
    if (state === STATE_OPEN) {
      const tempStatus = await upstreamErrorHelper.isTempUnavailable(accountId, 'claude-console')
      if (tempStatus) {
        const redisClient = getRedis().getClientSafe()
        const tempTtl = await redisClient.ttl(`temp_unavailable:claude-console:${accountId}`)
        cooldownRemaining = tempTtl > 0 ? tempTtl : 0
      }
    }

    return {
      state,
      samples: samplesNum,
      errors: errorsNum,
      errorRate: samplesNum > 0 ? errorsNum / samplesNum : 0,
      failRun: Number(failRunRaw) || 0,
      cooldownSeconds,
      cooldownRemaining,
      openedAt: openedAt || null,
      stateTtl: ttlSec
    }
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] getState failed for ${accountId}: ${err.message}`)
    return {
      state: STATE_CLOSED,
      samples: 0,
      errors: 0,
      errorRate: 0,
      failRun: 0,
      cooldownSeconds: 0,
      cooldownRemaining: 0,
      openedAt: null,
      stateTtl: 0
    }
  }
}

// 消费探测令牌：若当前账户有未使用的 probe 凭证，返回 true 并删除之
// （相当于"标记本次请求为 half-open 探测请求"）。并发安全：多个请求竞争时只有一个能消费。
async function consumeProbeFlag(accountId) {
  if (!isEnabled()) {
    return false
  }
  try {
    const client = getRedis().getClientSafe()
    const k = keys(accountId)
    // 优先使用 GETDEL（Redis ≥ 6.2），否则 GET + DEL（允许极小概率多个请求都读到，再由 DEL 收敛）
    let value = null
    if (typeof client.getdel === 'function') {
      value = await client.getdel(k.probe)
    } else {
      value = await client.get(k.probe)
      if (value) {
        await client.del(k.probe)
      }
    }
    return Boolean(value)
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] consumeProbeFlag failed for ${accountId}: ${err.message}`)
    return false
  }
}

async function clear(accountId) {
  try {
    const client = getRedis().getClientSafe()
    const k = keys(accountId)
    await client.del(k.samples, k.errors, k.state, k.openedAt, k.failRun, k.probe, k.cooldown)
    logger.info(`🧹 [CircuitBreaker] Cleared state for ${accountId}`)
  } catch (err) {
    logger.warn(`⚠️ [CircuitBreaker] clear failed for ${accountId}: ${err.message}`)
  }
}

module.exports = {
  recordSuccess,
  recordFailure,
  getState,
  tryAcquireProbe,
  consumeProbeFlag,
  clear,
  isTransient,
  withRetry,
  resolvePolicyFromAccount,
  normalizeUpstreamType,
  PRESETS,
  UPSTREAM_TYPES,
  DEFAULT_UPSTREAM_TYPE,
  STATE_CLOSED,
  STATE_OPEN,
  STATE_HALF_OPEN,
  KEY_PREFIX
}
