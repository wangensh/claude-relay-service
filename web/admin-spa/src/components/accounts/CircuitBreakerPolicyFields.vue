<template>
  <div :class="resolvedContainerClass">
    <label class="mb-3 block text-sm font-semibold text-gray-700 dark:text-gray-300">
      熔断器 / 上游错误处理
    </label>

    <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
      上游类型
    </label>
    <select
      class="form-input mb-3 w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
      :value="upstreamType"
      @change="handleUpstreamTypeChange"
    >
      <option value="direct">direct · 直连单一上游（严格，1~2 次失败即熔断）</option>
      <option value="adaptive">adaptive · 默认·折中策略（推荐大多数场景）</option>
      <option value="aggregator">aggregator · 聚合型上游（宽松，允许较高错误率）</option>
    </select>
    <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
      不同 preset 对 529/5xx 的容忍度不同。adaptive 允许 1 次重试、5 次连续失败才熔断。
    </p>

    <div class="mt-3">
      <button
        class="text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200"
        type="button"
        @click="advancedOpen = !advancedOpen"
      >
        {{ advancedOpen ? '收起高级参数' : '显示高级参数覆盖（可留空回退到 preset）' }}
      </button>
    </div>

    <div v-if="advancedOpen" class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
      <div v-for="field in advancedFields" :key="field.key">
        <label class="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
          {{ field.label }}
        </label>
        <input
          class="form-input w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
          min="0"
          :placeholder="`preset=${presetValues[field.key] ?? ''}`"
          :step="field.step || 1"
          type="number"
          :value="errorPolicy?.[field.key] ?? ''"
          @input="handlePolicyInput(field.key, $event.target.value)"
        />
        <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">{{ field.desc }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const PRESETS = {
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
}

const props = defineProps({
  upstreamType: {
    type: String,
    default: 'adaptive'
  },
  errorPolicy: {
    type: Object,
    default: null
  },
  containerClass: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['update:upstreamType', 'update:errorPolicy'])

const advancedOpen = ref(false)

const resolvedContainerClass = computed(() => {
  const baseClass = 'rounded-lg border border-sky-200/60 p-3 dark:border-sky-700/40'
  return props.containerClass ? `${baseClass} ${props.containerClass}` : baseClass
})

const presetValues = computed(() => PRESETS[props.upstreamType] || PRESETS.adaptive)

const advancedFields = [
  { key: 'retryOnTransient', label: '请求级重试次数', desc: '529/5xx/网络错误的同账户重试次数' },
  { key: 'window', label: '滑动窗口（秒）', desc: '统计错误率的时间窗口' },
  { key: 'minSamples', label: '最小样本数', desc: '样本量未达此值不触发错误率熔断' },
  {
    key: 'errorRateThreshold',
    label: '错误率阈值（0-1）',
    desc: '窗口内错误率超过该值触发熔断',
    step: 0.05
  },
  {
    key: 'consecutiveFailureThreshold',
    label: '连续失败阈值',
    desc: '连续该次数失败即触发熔断'
  },
  { key: 'openCooldown', label: '冷却时长（秒）', desc: '首次触发时的冷却秒数' },
  { key: 'openCooldownMax', label: '冷却时长上限（秒）', desc: '反复失败后的冷却封顶' }
]

const handleUpstreamTypeChange = (event) => {
  emit('update:upstreamType', event.target.value)
}

const normalizeNumericInput = (value, key) => {
  if (value === '' || value === null || value === undefined) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  if (key === 'errorRateThreshold') {
    return Math.min(1, parsed)
  }
  return Math.floor(parsed)
}

const handlePolicyInput = (key, rawValue) => {
  const parsed = normalizeNumericInput(rawValue, key)
  const next = { ...(props.errorPolicy || {}) }
  if (parsed === null) {
    delete next[key]
  } else {
    next[key] = parsed
  }
  emit('update:errorPolicy', Object.keys(next).length === 0 ? null : next)
}
</script>
