jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../config/config', () => ({}), { virtual: true })

const {
  sanitizeUpstreamError,
  sanitizeErrorMessage,
  stripVendorPrefix,
  isAnthropicErrorSchema,
  isOpenAIErrorSchema
} = require('../src/utils/errorSanitizer')

describe('errorSanitizer 分层策略', () => {
  describe('4xx 客户端错误 - 透传原始结构', () => {
    it('400 invalid_request_error 透传 Anthropic 标准格式', () => {
      const payload = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages.0.content: array too short - minimum length 1'
        }
      }
      const result = sanitizeUpstreamError(payload, 400)
      expect(result).toEqual({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages.0.content: array too short - minimum length 1'
        }
      })
    })

    it('400 prompt 超长透传原始描述', () => {
      const payload = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 345678 tokens > 200000 maximum'
        }
      }
      const result = sanitizeUpstreamError(payload, 400)
      expect(result.error.message).toBe('prompt is too long: 345678 tokens > 200000 maximum')
      expect(result.error.type).toBe('invalid_request_error')
    })

    it('400 消息带供应商路由前缀被脱敏', () => {
      const payload = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'tools.0.input_schema: field required [codex/openrouter]'
        }
      }
      const result = sanitizeUpstreamError(payload, 400)
      expect(result.error.message).toBe('tools.0.input_schema: field required')
    })

    it('422 保留原始结构', () => {
      const payload = {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'unprocessable input' }
      }
      const result = sanitizeUpstreamError(payload, 422)
      expect(result.type).toBe('error')
      expect(result.error.type).toBe('invalid_request_error')
    })

    it('401 保留 type 并脱敏 message', () => {
      const payload = {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid api key for [codex/xyz]' }
      }
      const result = sanitizeUpstreamError(payload, 401)
      expect(result.error.type).toBe('authentication_error')
      expect(result.error.message).toBe('invalid api key for')
    })

    it('429 保留原始消息（含额度信息）', () => {
      const payload = {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'quota exhausted until 2026-04-20T00:00:00Z' }
      }
      const result = sanitizeUpstreamError(payload, 429)
      expect(result.error.message).toBe('quota exhausted until 2026-04-20T00:00:00Z')
    })

    it('OpenAI 风格 schema 也能透传', () => {
      const payload = {
        error: {
          message: 'Invalid model specified',
          type: 'invalid_request_error',
          code: 'model_not_found'
        }
      }
      const result = sanitizeUpstreamError(payload, 400)
      expect(result.error.message).toBe('Invalid model specified')
      expect(result.error.type).toBe('invalid_request_error')
      expect(result.error.code).toBe('model_not_found')
    })
  })

  describe('5xx / 529 - 走白名单但用 Anthropic 标准 schema', () => {
    it('500 输出 Anthropic 格式 + 白名单消息', () => {
      const payload = {
        type: 'error',
        error: { type: 'api_error', message: 'internal upstream error [codex/openrouter]' }
      }
      const result = sanitizeUpstreamError(payload, 500)
      expect(result.type).toBe('error')
      expect(result.error.type).toBe('api_error')
      // 消息被替换为白名单消息（不含任何上游原始内容）
      expect(result.error.message).not.toContain('codex')
      expect(result.error.message).not.toContain('openrouter')
      expect(result.error.code).toMatch(/^E\d{3}$/)
    })

    it('503 走白名单 + error.type=overloaded_error', () => {
      const payload = {
        type: 'error',
        error: { type: 'api_error', message: 'backend service unavailable' }
      }
      const result = sanitizeUpstreamError(payload, 503)
      expect(result.type).toBe('error')
      expect(result.error.type).toBe('overloaded_error')
      expect(result.error.code).toBe('E001')
      expect(result.error.message).toBe('Service temporarily unavailable')
    })

    it('529 映射到 overloaded_error / E012', () => {
      const payload = {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' }
      }
      const result = sanitizeUpstreamError(payload, 529)
      expect(result.type).toBe('error')
      expect(result.error.type).toBe('overloaded_error')
      expect(result.error.code).toBe('E012')
    })

    it('504 超时 → api_error', () => {
      const payload = {
        type: 'error',
        error: { type: 'api_error', message: 'gateway timeout' }
      }
      const result = sanitizeUpstreamError(payload, 504)
      expect(result.error.type).toBe('api_error')
      expect(result.error.code).toBe('E008')
    })

    it('不传 statusCode 时仍输出 Anthropic schema（走白名单 fallback）', () => {
      const payload = {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages.0.content: too short' }
      }
      const result = sanitizeUpstreamError(payload)
      expect(result.type).toBe('error')
      expect(result.error).toHaveProperty('type')
      expect(result.error).toHaveProperty('message')
    })
  })

  describe('未知 schema 回落到白名单（但仍是 Anthropic 格式）', () => {
    it('HTML 响应（伪 400）也走白名单', () => {
      const payload = '<html>Bad Gateway</html>'
      const result = sanitizeUpstreamError(payload, 400)
      // 字符串不符合 schema，fallback 到 mapToErrorCode
      expect(result.type).toBe('error')
      expect(result.error).toHaveProperty('type')
      expect(result.error).toHaveProperty('message')
    })

    it('随意对象走白名单', () => {
      const payload = { foo: 'bar', baz: 42 }
      const result = sanitizeUpstreamError(payload, 400)
      expect(result.type).toBe('error')
      expect(result.error).toHaveProperty('code')
    })
  })

  describe('sanitizeErrorMessage 字符串版本', () => {
    it('4xx 只脱敏供应商前缀，保留消息主体', () => {
      const result = sanitizeErrorMessage('prompt is too long [codex/backend]', 400)
      expect(result).toBe('prompt is too long')
    })

    it('5xx 走白名单', () => {
      const result = sanitizeErrorMessage('internal error', 500)
      // 白名单消息
      expect(result).not.toContain('internal error')
    })

    it('空消息返回安全默认', () => {
      expect(sanitizeErrorMessage('', 400)).toBe('Service temporarily unavailable')
    })
  })

  describe('辅助函数', () => {
    it('stripVendorPrefix 移除 [vendor/route]', () => {
      expect(stripVendorPrefix('error occurred [codex/openrouter]')).toBe('error occurred')
      expect(stripVendorPrefix('no prefix here')).toBe('no prefix here')
      expect(stripVendorPrefix('[not matched]')).toBe('[not matched]') // 不带空格不算前缀
    })

    it('isAnthropicErrorSchema 识别标准 Anthropic 错误', () => {
      expect(
        isAnthropicErrorSchema({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'x' }
        })
      ).toBe(true)
      expect(isAnthropicErrorSchema({ error: { message: 'x' } })).toBe(false)
      expect(isAnthropicErrorSchema({ type: 'error' })).toBe(false)
      expect(isAnthropicErrorSchema(null)).toBe(false)
    })

    it('isOpenAIErrorSchema 识别 OpenAI 风格错误', () => {
      expect(isOpenAIErrorSchema({ error: { message: 'x', type: 'invalid' } })).toBe(true)
      expect(isOpenAIErrorSchema({ error: {} })).toBe(false)
      expect(isOpenAIErrorSchema(null)).toBe(false)
    })
  })
})
