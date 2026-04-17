/**
 * 错误消息清理工具 - 分层策略
 *
 * 策略：
 * - 客户端错误（4xx：400/404/422/429/401/403）: 保留上游原始结构与消息，
 *   仅做字符串级供应商标识脱敏（剔除 `[vendor/route]` 这类路由前缀）。
 *   原因：这类错误描述的是用户请求本身的问题，SDK 需要 Anthropic 标准
 *   `{type:"error", error:{type, message}}` 格式才能正确解析和提示用户。
 * - 服务端错误（5xx/529）和网络错误 / 未知格式: 走白名单错误码映射，
 *   用预定义的标准消息替换原始内容，避免泄漏上游供应商细节与抖动状态。
 */

const logger = require('./logger')

// 供应商路由前缀的正则，与 upstreamErrorHelper.sanitizeErrorForClient 一致
// 匹配形如 " [foo/bar]" 的片段
const VENDOR_ROUTE_PATTERN = / \[[^\]/]+\/[^\]]+\]/g

// 可以原样透传的客户端错误 HTTP 状态码集合
const PASSTHROUGH_STATUS_CODES = new Set([400, 401, 403, 404, 409, 413, 422, 429])

// 标准错误码定义
const ERROR_CODES = {
  E001: { message: 'Service temporarily unavailable', status: 503 },
  E002: { message: 'Network connection failed', status: 502 },
  E003: { message: 'Authentication failed', status: 401 },
  E004: { message: 'Rate limit exceeded', status: 429 },
  E005: { message: 'Invalid request', status: 400 },
  E006: { message: 'Model not available', status: 503 },
  E007: { message: 'Upstream service error', status: 502 },
  E008: { message: 'Request timeout', status: 504 },
  E009: { message: 'Permission denied', status: 403 },
  E010: { message: 'Resource not found', status: 404 },
  E011: { message: 'Account temporarily unavailable', status: 503 },
  E012: { message: 'Server overloaded', status: 529 },
  E013: { message: 'Invalid API key', status: 401 },
  E014: { message: 'Quota exceeded', status: 429 },
  E015: { message: 'Internal server error', status: 500 }
}

// 错误特征匹配规则（按优先级排序）
const ERROR_MATCHERS = [
  // 网络层错误
  { pattern: /ENOTFOUND|DNS|getaddrinfo/i, code: 'E002' },
  { pattern: /ECONNREFUSED|ECONNRESET|connection refused/i, code: 'E002' },
  { pattern: /ETIMEDOUT|timeout/i, code: 'E008' },
  { pattern: /ECONNABORTED|aborted/i, code: 'E002' },

  // 认证错误
  { pattern: /unauthorized|invalid.*token|token.*invalid|invalid.*key/i, code: 'E003' },
  { pattern: /invalid.*api.*key|api.*key.*invalid/i, code: 'E013' },
  { pattern: /authentication|auth.*fail/i, code: 'E003' },

  // 权限错误
  { pattern: /forbidden|permission.*denied|access.*denied/i, code: 'E009' },
  { pattern: /does not have.*permission/i, code: 'E009' },

  // 限流错误
  { pattern: /rate.*limit|too many requests|429/i, code: 'E004' },
  { pattern: /quota.*exceeded|usage.*limit/i, code: 'E014' },

  // 过载错误
  { pattern: /overloaded|529|capacity/i, code: 'E012' },

  // 账户错误
  { pattern: /account.*disabled|organization.*disabled/i, code: 'E011' },
  { pattern: /too many active sessions/i, code: 'E011' },

  // 模型错误
  { pattern: /model.*not.*found|model.*unavailable|unsupported.*model/i, code: 'E006' },

  // 请求错误
  { pattern: /bad.*request|invalid.*request|invalid.*argument|malformed/i, code: 'E005' },
  { pattern: /not.*found|404/i, code: 'E010' },

  // 上游错误
  { pattern: /upstream|502|bad.*gateway/i, code: 'E007' },
  { pattern: /503|service.*unavailable/i, code: 'E001' }
]

/**
 * 根据原始错误匹配标准错误码
 * @param {Error|string|object} error - 原始错误
 * @param {object} options - 选项
 * @param {string} options.context - 错误上下文（用于日志）
 * @param {boolean} options.logOriginal - 是否记录原始错误（默认true）
 * @returns {{ code: string, message: string, status: number }}
 */
function mapToErrorCode(error, options = {}) {
  const { context = 'unknown', logOriginal = true } = options

  // 提取原始错误信息
  const originalMessage = extractOriginalMessage(error)
  const errorCode = error?.code || error?.response?.status
  // 优先使用调用方显式传入的 statusCode（比从 error body 里猜更可靠）
  const statusCode =
    (Number.isFinite(options.statusCode) ? options.statusCode : null) ||
    error?.response?.status ||
    error?.status ||
    error?.statusCode

  // 记录原始错误到日志（供调试）
  if (logOriginal && originalMessage) {
    logger.debug(`[ErrorSanitizer] Original error (${context}):`, {
      message: originalMessage,
      code: errorCode,
      status: statusCode
    })
  }

  // 匹配错误码
  let matchedCode = 'E015' // 默认：内部服务器错误

  // 先按 HTTP 状态码快速匹配
  if (statusCode) {
    if (statusCode === 401) {
      matchedCode = 'E003'
    } else if (statusCode === 403) {
      matchedCode = 'E009'
    } else if (statusCode === 404) {
      matchedCode = 'E010'
    } else if (statusCode === 429) {
      matchedCode = 'E004'
    } else if (statusCode === 502) {
      matchedCode = 'E007'
    } else if (statusCode === 503) {
      matchedCode = 'E001'
    } else if (statusCode === 504) {
      matchedCode = 'E008'
    } else if (statusCode === 529) {
      matchedCode = 'E012'
    }
  }

  // 再按消息内容精确匹配（可能覆盖状态码匹配）
  if (originalMessage) {
    for (const matcher of ERROR_MATCHERS) {
      if (matcher.pattern.test(originalMessage)) {
        matchedCode = matcher.code
        break
      }
    }
  }

  // 按错误 code 匹配（网络错误）
  if (errorCode) {
    const codeStr = String(errorCode).toUpperCase()
    if (codeStr === 'ENOTFOUND' || codeStr === 'EAI_AGAIN') {
      matchedCode = 'E002'
    } else if (codeStr === 'ECONNREFUSED' || codeStr === 'ECONNRESET') {
      matchedCode = 'E002'
    } else if (codeStr === 'ETIMEDOUT' || codeStr === 'ESOCKETTIMEDOUT') {
      matchedCode = 'E008'
    } else if (codeStr === 'ECONNABORTED') {
      matchedCode = 'E002'
    }
  }

  const result = ERROR_CODES[matchedCode]
  return {
    code: matchedCode,
    message: result.message,
    status: result.status
  }
}

/**
 * 提取原始错误消息
 */
function extractOriginalMessage(error) {
  if (!error) {
    return ''
  }
  if (typeof error === 'string') {
    return error
  }
  if (error.message) {
    return error.message
  }
  if (error.error?.message) {
    return error.error.message
  }
  if (error.response?.data?.error?.message) {
    return error.response.data.error.message
  }
  if (error.response?.data?.error) {
    return String(error.response.data.error)
  }
  if (error.response?.data?.message) {
    return error.response.data.message
  }
  return ''
}

/**
 * 对字符串做供应商路由前缀脱敏（如 " [codex/openrouter]" -> "")
 */
function stripVendorPrefix(text) {
  if (typeof text !== 'string' || !text) {
    return text
  }
  return text.replace(VENDOR_ROUTE_PATTERN, '')
}

/**
 * 判断是否为 Anthropic 标准错误 schema：`{type:"error", error:{type, message}}`
 */
function isAnthropicErrorSchema(data) {
  return Boolean(
    data &&
      typeof data === 'object' &&
      data.type === 'error' &&
      data.error &&
      typeof data.error === 'object' &&
      typeof data.error.type === 'string' &&
      typeof data.error.message === 'string'
  )
}

/**
 * 判断是否为 OpenAI 风格错误 schema：`{error:{message, type?, code?}}`
 */
function isOpenAIErrorSchema(data) {
  return Boolean(
    data &&
      typeof data === 'object' &&
      data.error &&
      typeof data.error === 'object' &&
      typeof data.error.message === 'string'
  )
}

/**
 * 客户端错误透传：保留结构，对 message 字符串做供应商脱敏
 * 若传入的对象是已知的标准 schema，就按 schema 保留；否则回退到白名单映射
 */
function passthroughClientError(errorData) {
  if (isAnthropicErrorSchema(errorData)) {
    return {
      type: 'error',
      error: {
        type: errorData.error.type,
        message: stripVendorPrefix(errorData.error.message)
      }
    }
  }
  if (isOpenAIErrorSchema(errorData)) {
    const inner = { ...errorData.error }
    if (typeof inner.message === 'string') {
      inner.message = stripVendorPrefix(inner.message)
    }
    return { error: inner }
  }
  return null
}

// 白名单 code 到 Anthropic 标准 error.type 的映射
const ANTHROPIC_ERROR_TYPE_BY_STATUS = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'api_error',
  413: 'request_too_large',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  504: 'api_error',
  529: 'overloaded_error'
}

function anthropicErrorType(statusCode) {
  return ANTHROPIC_ERROR_TYPE_BY_STATUS[statusCode] || 'api_error'
}

/**
 * 创建安全的错误响应对象
 *
 * 输出统一为 Anthropic 标准格式：`{type:"error", error:{type, message}}`
 * - 4xx 客户端错误：透传上游原始 type/message（仅消息做供应商前缀脱敏）
 * - 5xx/未知：用白名单消息替换（保持供应商隐匿），但 schema 仍是 Anthropic 标准
 *
 * @param {Error|string|object} error - 原始错误
 * @param {object} options - 选项
 * @param {number} [options.statusCode] - HTTP 状态码（建议传入，用于 schema 映射和 4xx 透传判断）
 */
function createSafeErrorResponse(error, options = {}) {
  const { statusCode } = options
  // 4xx 客户端错误：透传原始结构（仅消息脱敏）
  if (
    Number.isFinite(statusCode) &&
    PASSTHROUGH_STATUS_CODES.has(statusCode) &&
    error &&
    typeof error === 'object'
  ) {
    const passthrough = passthroughClientError(error)
    if (passthrough) {
      return passthrough
    }
  }
  // 默认：白名单映射（5xx/529/未知 schema/网络错误），用 Anthropic 标准 schema 输出
  const mapped = mapToErrorCode(error, options)
  const effectiveStatus = Number.isFinite(statusCode) ? statusCode : mapped.status
  return {
    type: 'error',
    error: {
      type: anthropicErrorType(effectiveStatus),
      message: mapped.message,
      code: mapped.code
    }
  }
}

/**
 * 创建安全的 SSE 错误事件
 * @param {Error|string|object} error - 原始错误
 * @param {object} options - 选项
 * @returns {string} - SSE 格式的错误事件
 */
function createSafeSSEError(error, options = {}) {
  const mapped = mapToErrorCode(error, options)
  return `event: error\ndata: ${JSON.stringify({
    error: mapped.message,
    code: mapped.code,
    timestamp: new Date().toISOString()
  })}\n\n`
}

/**
 * 获取安全的错误消息（用于替换 error.message）
 * @param {Error|string|object} error - 原始错误
 * @param {object} options - 选项
 * @returns {string}
 */
function getSafeMessage(error, options = {}) {
  return mapToErrorCode(error, options).message
}

/**
 * 兼容旧接口：清洗错误消息字符串
 * @param {string} message - 原始消息
 * @param {number} [statusCode] - HTTP 状态码。4xx 时仅做供应商前缀脱敏；其它情况走白名单
 */
function sanitizeErrorMessage(message, statusCode) {
  if (!message) {
    return 'Service temporarily unavailable'
  }
  if (Number.isFinite(statusCode) && PASSTHROUGH_STATUS_CODES.has(statusCode)) {
    return stripVendorPrefix(typeof message === 'string' ? message : String(message))
  }
  return mapToErrorCode({ message }, { logOriginal: false }).message
}

/**
 * 兼容旧接口：清洗上游错误对象
 * @param {object} errorData - 原始错误对象
 * @param {number} [statusCode] - HTTP 状态码。4xx 时透传原始结构（仅消息脱敏）；其它走白名单
 */
function sanitizeUpstreamError(errorData, statusCode) {
  return createSafeErrorResponse(errorData, { logOriginal: false, statusCode })
}

function extractErrorMessage(body) {
  return extractOriginalMessage(body)
}

function isAccountDisabledError(statusCode, body) {
  if (statusCode !== 400) {
    return false
  }
  const message = extractOriginalMessage(body)
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    lower.includes('organization has been disabled') ||
    lower.includes('account has been disabled') ||
    lower.includes('account is disabled') ||
    lower.includes('no account supporting') ||
    lower.includes('account not found') ||
    lower.includes('invalid account') ||
    lower.includes('too many active sessions')
  )
}

module.exports = {
  ERROR_CODES,
  PASSTHROUGH_STATUS_CODES,
  mapToErrorCode,
  createSafeErrorResponse,
  createSafeSSEError,
  getSafeMessage,
  stripVendorPrefix,
  isAnthropicErrorSchema,
  isOpenAIErrorSchema,
  // 兼容旧接口
  sanitizeErrorMessage,
  sanitizeUpstreamError,
  extractErrorMessage,
  isAccountDisabledError
}
