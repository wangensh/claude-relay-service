// 空值表示不附加字段；仅接受 JSON 对象，避免数组或标量被展开到请求体。
function normalizeCustomRequestBody(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return {}
  }

  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('customRequestBody must be a valid JSON object')
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('customRequestBody must be a valid JSON object')
  }

  return parsed
}

module.exports = { normalizeCustomRequestBody }
