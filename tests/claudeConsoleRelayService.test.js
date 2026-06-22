jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  _createProxyAgent: jest.fn()
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

describe('claudeConsoleRelayService._maybeInjectOpenRouterProviderOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('injects provider.order for OpenRouter account + deepseek upstream model', () => {
    const body = { model: 'deepseek-chat' }
    const account = { apiUrl: 'https://openrouter.ai/api/v1' }

    claudeConsoleRelayService._maybeInjectOpenRouterProviderOrder(body, account)

    expect(body.provider).toEqual({ order: ['deepseek'] })
  })

  it('does not inject for non-deepseek model', () => {
    const body = { model: 'claude-sonnet-4-6' }
    const account = { apiUrl: 'https://openrouter.ai/api/v1' }

    claudeConsoleRelayService._maybeInjectOpenRouterProviderOrder(body, account)

    expect(body.provider).toBeUndefined()
  })

  it('does not inject for non-OpenRouter account', () => {
    const body = { model: 'deepseek-chat' }
    const account = { apiUrl: 'https://console.example.com' }

    claudeConsoleRelayService._maybeInjectOpenRouterProviderOrder(body, account)

    expect(body.provider).toBeUndefined()
  })

  it('matches case-insensitively and on prefixed model names', () => {
    const body = { model: 'DeepSeek/deepseek-chat' }
    const account = { apiUrl: 'https://OpenRouter.ai/api/v1' }

    claudeConsoleRelayService._maybeInjectOpenRouterProviderOrder(body, account)

    expect(body.provider).toEqual({ order: ['deepseek'] })
  })

  it('does not override an existing provider field', () => {
    const body = { model: 'deepseek-chat', provider: { order: ['custom'] } }
    const account = { apiUrl: 'https://openrouter.ai/api/v1' }

    claudeConsoleRelayService._maybeInjectOpenRouterProviderOrder(body, account)

    expect(body.provider).toEqual({ order: ['custom'] })
  })
})
