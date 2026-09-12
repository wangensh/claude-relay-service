jest.useFakeTimers()

jest.mock('../src/models/redis', () => {
  const store = new Map()
  const client = {
    hset: jest.fn(async (key, data) => store.set(key, { ...store.get(key), ...data })),
    hgetall: jest.fn(async (key) => ({ ...store.get(key) })),
    sadd: jest.fn()
  }
  return {
    getClientSafe: () => client,
    getDateStringInTimezone: () => '2026-09-12',
    addToIndex: jest.fn(),
    getConsoleAccountConcurrency: jest.fn(async () => 0),
    getAllIdsByIndex: jest.fn(async () => [...store.values()].map((account) => account.id)),
    batchHgetallChunked: jest.fn(async (keys) => keys.map((key) => ({ ...store.get(key) }))),
    __store: store
  }
})
jest.mock('../config/config', () => ({ security: { encryptionKey: 'test-encryption-key' } }), {
  virtual: true
})
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))

const service = require('../src/services/account/claudeConsoleAccountService')
const redis = require('../src/models/redis')

afterAll(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

describe('Claude Console custom JSON persistence', () => {
  const options = { name: 'OpenRouter', apiUrl: 'https://openrouter.ai/api', apiKey: 'test-key' }
  const customRequestBody = { provider: { order: ['anthropic'], allow_fallbacks: false } }

  beforeEach(() => redis.__store.clear())

  it('round-trips provider settings through creation, detail, list and update', async () => {
    const created = await service.createAccount({ ...options, customRequestBody })
    expect(created.customRequestBody).toEqual(customRequestBody)
    const stored = redis.__store.get(`claude_console_account:${created.id}`)
    expect(stored.customRequestBody).toBe(JSON.stringify(customRequestBody))
    expect((await service.getAccount(created.id)).customRequestBody).toEqual(customRequestBody)
    expect((await service.getAllAccounts())[0].customRequestBody).toEqual(customRequestBody)

    await service.updateAccount(created.id, { name: 'Renamed' })
    expect((await service.getAccount(created.id)).customRequestBody).toEqual(customRequestBody)

    const updatedBody = { provider: { sort: 'price' } }
    await service.updateAccount(created.id, { customRequestBody: JSON.stringify(updatedBody) })
    expect((await service.getAccount(created.id)).customRequestBody).toEqual(updatedBody)

    await service.updateAccount(created.id, { customRequestBody: '' })
    expect((await service.getAccount(created.id)).customRequestBody).toEqual({})
    expect((await service.getAllAccounts())[0].customRequestBody).toEqual({})
  })

  it('supports existing accounts without the field', async () => {
    const created = await service.createAccount(options)
    delete redis.__store.get(`claude_console_account:${created.id}`).customRequestBody
    expect((await service.getAccount(created.id)).customRequestBody).toEqual({})
    expect((await service.getAllAccounts())[0].customRequestBody).toEqual({})
  })

  it('rejects invalid JSON without overwriting a saved configuration', async () => {
    const created = await service.createAccount({ ...options, customRequestBody })
    await expect(service.updateAccount(created.id, { customRequestBody: '[]' })).rejects.toThrow(
      'customRequestBody must be a valid JSON object'
    )
    expect((await service.getAccount(created.id)).customRequestBody).toEqual(customRequestBody)
    await expect(
      service.createAccount({ ...options, customRequestBody: '{invalid' })
    ).rejects.toThrow('customRequestBody must be a valid JSON object')
    expect(redis.__store.size).toBe(1)
  })
})
