jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../config/config', () => ({}), { virtual: true })
jest.mock('../src/models/redis', () => ({ getClientSafe: () => ({}) }))

const { isFakeRateLimit } = require('../src/utils/upstreamErrorHelper')

describe('isFakeRateLimit', () => {
  describe('真限流（应返回 false）', () => {
    it('error.type === rate_limit_error', () => {
      const body = {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'quota exceeded' }
      }
      expect(isFakeRateLimit(body, {})).toBe(false)
    })

    it('带 Retry-After 且消息包含 rate/quota', () => {
      const body = { error: { type: 'api_error', message: 'rate limit reached, retry later' } }
      expect(isFakeRateLimit(body, { 'retry-after': '60' })).toBe(false)
    })

    it('Anthropic 限流头也视为真', () => {
      const body = { error: { message: 'quota exceeded' } }
      expect(
        isFakeRateLimit(body, { 'anthropic-ratelimit-unified-reset': '2026-04-17T00:00:00Z' })
      ).toBe(false)
    })
  })

  describe('假限流（应返回 true）', () => {
    it('中文"负载饱和"（线上 ccodeai 的实际场景）', () => {
      const body = {
        type: 'error',
        error: {
          type: '<nil>',
          message:
            '当前分组上游负载已饱和，请稍后再试 (request id: 20260417184526466319226osoXKVRn)'
        }
      }
      expect(isFakeRateLimit(body, {})).toBe(true)
    })

    it('英文 overloaded', () => {
      const body = { error: { type: 'api_error', message: 'Upstream service overloaded' } }
      expect(isFakeRateLimit(body, {})).toBe(true)
    })

    it('capacity saturated', () => {
      const body = { error: { type: '', message: 'backend capacity saturated, try again later' } }
      expect(isFakeRateLimit(body, {})).toBe(true)
    })

    it('AWS Bedrock SDK 透传 ThrottlingException（线上 ccodeai 实际场景，2026-04-20）', () => {
      const body = {
        type: 'error',
        error: {
          type: '<nil>',
          message:
            'InvokeModelWithResponseStream: operation error Bedrock Runtime: InvokeModelWithResponseStream, exceeded maximum number of attempts, 3, https response error StatusCode: 429, RequestID: 985f1efc-9ca0-43d8-9de9-0db9622da11b, ThrottlingException: Too many tokens per day, please wait before trying again.'
        }
      }
      expect(isFakeRateLimit(body, {})).toBe(true)
    })

    it('单独 InvokeModel 错误（AWS SDK 特征）', () => {
      const body = {
        error: {
          type: '<nil>',
          message: 'InvokeModelWithResponseStream: operation error Bedrock Runtime: ...'
        }
      }
      expect(isFakeRateLimit(body, {})).toBe(true)
    })

    it('error.type 为 <nil>，消息里无 overload 关键词：保守按真限流（false）', () => {
      const body = { error: { type: '<nil>', message: 'something went wrong' } }
      expect(isFakeRateLimit(body, {})).toBe(false)
    })

    it('error.type 为 api_error，消息里无 overload 关键词：保守按真限流（false）', () => {
      const body = { error: { type: 'api_error', message: 'temporary issue' } }
      expect(isFakeRateLimit(body, {})).toBe(false)
    })
  })

  describe('边界', () => {
    it('字符串 body 可解析 JSON', () => {
      const body = JSON.stringify({
        error: { type: '<nil>', message: '负载饱和' }
      })
      expect(isFakeRateLimit(body, {})).toBe(true)
    })

    it('纯字符串（非 JSON）body，按消息文本处理', () => {
      expect(isFakeRateLimit('upstream overloaded now', {})).toBe(true)
      expect(isFakeRateLimit('some random text', {})).toBe(false)
    })

    it('null / undefined 返回 false', () => {
      expect(isFakeRateLimit(null, {})).toBe(false)
      expect(isFakeRateLimit(undefined, {})).toBe(false)
    })
  })
})
