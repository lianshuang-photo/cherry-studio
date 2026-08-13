/**
 * Cross-process model filter for the dsh runtime.
 * Official harness talks DeepSeek's OpenAI-compatible host (or a proxy via
 * DEEPSEEK_BASE_URL). Fail closed when the provider is missing — we need its
 * endpoint to decide whether the official adapter can drive it.
 */

import { isManagedCherryAiDefaultModel } from '@shared/data/presets/cherryai'
import type { Model } from '@shared/data/types/model'
import { ENDPOINT_TYPE, parseUniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { formatApiHost } from '@shared/utils/api'
import { getRawModelId } from '@shared/utils/model'

export function isOfficialDeepSeekProvider(provider: Provider | undefined): boolean {
  if (!provider) return false
  return provider.id === 'deepseek' || provider.presetProviderId === 'deepseek'
}

/**
 * Official DeepSeek wants `deepseek-v4-flash`. OpenAI-compatible gateways keep
 * Cherry's catalog id (`agent/deepseek-v4-flash`) because that is what they list.
 */
export function toDshModelId(model: Model, provider?: Provider): string {
  const raw = getRawModelId(model)
  if (provider && !isOfficialDeepSeekProvider(provider)) return raw
  return raw.replace(/^agent\//, '')
}

/**
 * Official adapter POSTs `{base}/chat/completions`. Cherry stores OpenAI-compatible
 * hosts without `/v1`; format the same way in-app chat does or the gateway 404s.
 */
export function toDshBaseUrl(raw: string | undefined): string | undefined {
  const formatted = formatApiHost(raw)
  return formatted || undefined
}

export function isDshCompatibleModel(provider: Provider | undefined, model: Model): boolean {
  if (!provider) return false
  if (isManagedCherryAiDefaultModel(model.providerId, model.apiModelId ?? parseUniqueModelId(model.id).modelId)) {
    return false
  }

  const providerId = provider.id.toLowerCase()
  const preset = String(provider.presetProviderId ?? '').toLowerCase()
  if (providerId === 'deepseek' || preset === 'deepseek') return true

  const endpointTypes = model.endpointTypes ?? []
  if (endpointTypes.includes(ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS)) return true
  if (provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS) return true
  if (provider.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.baseUrl) return true

  const families = Object.values(provider.endpointConfigs ?? {}).map((config) =>
    String(config?.adapterFamily ?? '').toLowerCase()
  )
  return families.some(
    (family) => family.includes('openai') || family.includes('deepseek') || family === 'openai-compatible'
  )
}
