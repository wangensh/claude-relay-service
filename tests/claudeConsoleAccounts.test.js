const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({
  testAccountConnection: jest.fn(async (accountId, res) =>
    res.status(200).json({ success: true, accountId })
  )
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  createAccount: jest.fn(async (data) => ({ id: 'account-1', ...data })),
  getAccount: jest.fn(async () => ({ id: 'account-1', accountType: 'shared' })),
  updateAccount: jest.fn(async () => {})
}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/webhookNotifier', () => ({}))
jest.mock('../src/routes/admin/utils', () => ({
  formatAccountExpiry: jest.fn((account) => account),
  mapExpiryField: jest.fn((updates) => updates)
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountsRouter = require('../src/routes/admin/claudeConsoleAccounts')

describe('POST /admin/claude-console-accounts/:accountId/test', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', claudeConsoleAccountsRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 400 when model is missing', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/test')
      .send({})

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'model is required' })
    expect(claudeConsoleRelayService.testAccountConnection).not.toHaveBeenCalled()
  })

  it('passes model through to relay service when provided', async () => {
    const app = buildApp()

    const response = await request(app)
      .post('/admin/claude-console-accounts/account-1/test')
      .send({ model: 'claude-sonnet-4-6' })

    expect(response.status).toBe(200)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledTimes(1)
    expect(claudeConsoleRelayService.testAccountConnection).toHaveBeenCalledWith(
      'account-1',
      expect.any(Object),
      'claude-sonnet-4-6'
    )
  })
})

describe('Claude Console custom request JSON settings', () => {
  const accountService = require('../src/services/account/claudeConsoleAccountService')
  const app = express()
  app.use(express.json())
  app.use('/admin', claudeConsoleAccountsRouter)
  const provider = { order: ['anthropic'], allow_fallbacks: false }

  beforeEach(() => jest.clearAllMocks())

  it('creates an account with OpenRouter provider settings', async () => {
    const response = await request(app).post('/admin/claude-console-accounts').send({
      name: 'OpenRouter',
      apiUrl: 'https://openrouter.ai/api',
      apiKey: 'test-key',
      customRequestBody: { provider }
    })
    expect(response.status).toBe(200)
    expect(response.body.data.customRequestBody).toEqual({ provider })
    expect(accountService.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ customRequestBody: { provider } })
    )
  })

  it.each([{ provider }, JSON.stringify({ provider }), '', null, {}])(
    'updates or clears custom JSON: %j',
    async (value) => {
      const response = await request(app)
        .put('/admin/claude-console-accounts/account-1')
        .send({ customRequestBody: value })
      expect(response.status).toBe(200)
      expect(accountService.updateAccount).toHaveBeenCalledWith('account-1', {
        customRequestBody:
          value === '' || value === null
            ? {}
            : typeof value === 'string'
              ? JSON.parse(value)
              : value
      })
    }
  )

  it('leaves custom JSON untouched when omitted from an update', async () => {
    await request(app).put('/admin/claude-console-accounts/account-1').send({ name: 'Renamed' })
    expect(accountService.updateAccount).toHaveBeenCalledWith('account-1', { name: 'Renamed' })
  })

  it.each(['{invalid', '[]', 'null', '"text"', '42', [], true, 42])(
    'rejects invalid custom JSON before saving: %j',
    async (value) => {
      const create = await request(app).post('/admin/claude-console-accounts').send({
        name: 'OpenRouter',
        apiUrl: 'https://openrouter.ai/api',
        apiKey: 'test-key',
        customRequestBody: value
      })
      const update = await request(app)
        .put('/admin/claude-console-accounts/account-1')
        .send({ customRequestBody: value })
      expect(create.status).toBe(400)
      expect(update.status).toBe(400)
      expect(accountService.createAccount).not.toHaveBeenCalled()
      expect(accountService.updateAccount).not.toHaveBeenCalled()
    }
  )
})
