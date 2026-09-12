jest.mock('axios', () => jest.fn())
jest.mock('../src/services/userMessageQueueService', () => ({
  isUserMessageRequest: jest.fn(() => false)
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  _createProxyAgent: jest.fn(),
  getMappedModel: jest.fn((mapping, model) => mapping[model] || model),
  isAccountRateLimited: jest.fn(async () => false),
  isAccountOverloaded: jest.fn(async () => false)
}))

jest.mock('../config/config', () => ({}), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  sendStreamTestRequest: jest.fn()
}))

const claudeConsoleRelayService = require('../src/services/relay/claudeConsoleRelayService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const { createClaudeTestPayload, sendStreamTestRequest } = require('../src/utils/testPayloadHelper')

describe('claudeConsoleRelayService.testAccountConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes selected model stream payload and bearer auth for non sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        authorization: 'Bearer test-key'
      })
    )
  })

  it('passes selected model stream payload and x-api-key for sk-ant key', async () => {
    claudeConsoleAccountService.getAccount.mockResolvedValue({
      name: 'Console A1',
      apiUrl: 'https://console.example.com',
      apiKey: 'sk-ant-test-key',
      proxy: null,
      userAgent: null
    })
    claudeConsoleAccountService._createProxyAgent.mockReturnValue(undefined)

    const payload = {
      model: 'claude-sonnet-4-6',
      stream: true
    }
    createClaudeTestPayload.mockReturnValue(payload)
    sendStreamTestRequest.mockResolvedValue(undefined)

    const res = {}
    await claudeConsoleRelayService.testAccountConnection('a1', res, 'claude-sonnet-4-6')

    expect(createClaudeTestPayload).toHaveBeenCalledWith('claude-sonnet-4-6', { stream: true })
    const requestOptions = sendStreamTestRequest.mock.calls[0][0]
    expect(requestOptions).toEqual(
      expect.objectContaining({
        payload,
        extraHeaders: expect.objectContaining({
          'x-api-key': 'sk-ant-test-key'
        })
      })
    )
    expect(requestOptions).not.toHaveProperty('authorization')
  })
})

describe('Claude Console OpenRouter custom request body', () => {
  const axios = require('axios')
  const { EventEmitter } = require('events')
  const provider = { order: ['anthropic'], allow_fallbacks: false }
  let account

  beforeEach(() => {
    jest.clearAllMocks()
    account = {
      name: 'OpenRouter',
      apiUrl: 'https://openrouter.ai/api',
      apiKey: 'test-key',
      supportedModels: { 'claude-test': 'anthropic/claude-test' },
      customRequestBody: { provider }
    }
    claudeConsoleAccountService.getAccount.mockResolvedValue(account)
  })

  it('merges provider into non-streaming requests without changing the client body', async () => {
    const body = {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 32,
      stream: false,
      provider: { sort: 'price' }
    }
    axios.mockResolvedValue({ status: 200, headers: {}, data: { content: [] } })
    const result = await claudeConsoleRelayService.relayRequest(
      body,
      { id: 'key' },
      null,
      null,
      {},
      'a1'
    )
    expect(result.statusCode).toBe(200)
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://openrouter.ai/api/v1/messages',
        data: { ...body, model: 'anthropic/claude-test', thinking: { type: 'disabled' }, provider }
      })
    )
    expect(body.provider).toEqual({ sort: 'price' })
    expect(body.model).toBe('claude-test')
    expect(body).not.toHaveProperty('thinking')
  })

  it('merges provider into streaming requests after model mapping', async () => {
    const body = { model: 'claude-test', messages: [], max_tokens: 32, stream: true }
    // Stop at the transport boundary after capturing the outgoing request.
    const transportError = new Error('test transport stopped')
    axios.mockRejectedValue(transportError)
    const responseStream = Object.assign(new EventEmitter(), {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    })
    await expect(
      claudeConsoleRelayService.relayStreamRequestWithUsageCapture(
        body,
        { id: 'key' },
        responseStream,
        {},
        jest.fn(),
        'a1'
      )
    ).rejects.toThrow(transportError)
    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        responseType: 'stream',
        data: { ...body, model: 'anthropic/claude-test', provider }
      })
    )
    expect(body).not.toHaveProperty('provider')
  })

  it('includes provider in the account connectivity test', async () => {
    const payload = { model: 'anthropic/claude-test', messages: [], stream: true }
    createClaudeTestPayload.mockReturnValue(payload)
    await claudeConsoleRelayService.testAccountConnection('a1', {}, 'claude-test')
    expect(sendStreamTestRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { ...payload, provider },
        authorization: 'Bearer test-key'
      })
    )
    expect(payload).not.toHaveProperty('provider')
  })

  it.each([undefined, {}])(
    'preserves requests for old or cleared accounts: %j',
    async (customRequestBody) => {
      account.customRequestBody = customRequestBody
      const body = { model: 'other-model', messages: [], provider: { sort: 'price' } }
      axios.mockResolvedValue({ status: 200, headers: {}, data: {} })
      await claudeConsoleRelayService.relayRequest(body, { id: 'key' }, null, null, {}, 'a1')
      expect(axios.mock.calls[0][0].data).toEqual(body)
    }
  )
})
