import type { AiUsageCredentialReceipt } from '@data/services/AiUsageRecordService'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { createAiUsagePricingSnapshot } from '@main/ai/utils/usageCapture'
import { isDshCompatibleModel, toDshBaseUrl, toDshModelId } from '@shared/ai/dshModelCompatibility'
import { ENDPOINT_TYPE, MODALITY, type Model, parseUniqueModelId, type UniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { getRawModelId } from '@shared/utils/model'

import { resolveEffectiveEndpoint } from '../../provider/endpoint'
import type { AgentSessionUsageCapture } from '../types'

export const DSH_PI_PROVIDER_ROUTE = 'cherry-dsh'
export const DSH_PI_CREDENTIAL_REF = 'CHERRY_DSH_API_KEY'

export class DshUnsupportedProviderError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" is not supported by DeepSeek Harness`)
    this.name = 'DshUnsupportedProviderError'
  }
}

export class DshMissingApiKeyError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" has no API key configured for DeepSeek Harness`)
    this.name = 'DshMissingApiKeyError'
  }
}

export interface DshProviderInjection {
  /** Private provider route in the per-session Harness context. */
  providerRoute: typeof DSH_PI_PROVIDER_ROUTE
  /** Reference resolved by Cherry's in-memory Harness credential provider. */
  credentialRef: typeof DSH_PI_CREDENTIAL_REF
  apiKey: string
  api: 'openai-completions'
  baseURL: string
  modelId: string
  contextWindow?: number
  maxTokens?: number
  input: Array<'text' | 'image'>
  headers?: Record<string, string>
  usageCapture: Extract<AgentSessionUsageCapture, { owner: 'agent-sdk' }>
}

/** Side-effect free: do not rotate API keys. */
export async function assertDshProviderUsable(uniqueModelId: UniqueModelId): Promise<void> {
  const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
  const [provider, model] = await Promise.all([
    providerService.getByProviderId(providerId),
    modelService.getByKey(providerId, modelId)
  ])
  if (!isDshCompatibleModel(provider, model)) {
    throw new DshUnsupportedProviderError(providerId)
  }
  const endpoint = resolveEffectiveEndpoint(provider, model)
  if (endpoint.endpointType !== ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS || !toDshBaseUrl(endpoint.baseUrl)) {
    throw new DshUnsupportedProviderError(providerId)
  }
  const apiKeys = providerService.getApiKeys(providerId, { enabled: true })
  if (!apiKeys.some((entry) => entry.key.trim())) {
    throw new DshMissingApiKeyError(providerId)
  }
}

export async function resolveDshProviderInjection(uniqueModelId: UniqueModelId): Promise<DshProviderInjection> {
  const { providerId, modelId } = parseUniqueModelId(uniqueModelId)
  const [provider, model] = await Promise.all([
    providerService.getByProviderId(providerId),
    modelService.getByKey(providerId, modelId)
  ])
  const resolvedApiKey = providerService.resolveApiKey(provider.id)
  return buildDshProviderInjection(provider, model, resolvedApiKey.value, resolvedApiKey.apiKeySelection)
}

/**
 * Build a self-contained DSH route from Cherry-owned provider facts. The raw
 * key is intentionally separate from the profile consumed by pi-ai.
 */
export function buildDshProviderInjection(
  provider: Provider,
  model: Model,
  apiKey: string,
  credentialReceipt?: AiUsageCredentialReceipt
): DshProviderInjection {
  if (!isDshCompatibleModel(provider, model)) {
    throw new DshUnsupportedProviderError(provider.id)
  }
  if (!apiKey.trim()) {
    throw new DshMissingApiKeyError(provider.id)
  }
  const endpoint = resolveEffectiveEndpoint(provider, model)
  if (endpoint.endpointType !== ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS) {
    throw new DshUnsupportedProviderError(provider.id)
  }
  const baseURL = toDshBaseUrl(endpoint.baseUrl)
  if (!baseURL) {
    throw new DshUnsupportedProviderError(provider.id)
  }
  const modelId = toDshModelId(model, provider)
  return {
    providerRoute: DSH_PI_PROVIDER_ROUTE,
    credentialRef: DSH_PI_CREDENTIAL_REF,
    apiKey,
    api: 'openai-completions',
    baseURL,
    modelId,
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutputTokens,
    input: model.inputModalities?.includes(MODALITY.IMAGE) ? ['text', 'image'] : ['text'],
    ...(provider.settings?.extraHeaders ? { headers: provider.settings.extraHeaders } : {}),
    usageCapture: {
      owner: 'agent-sdk',
      credentialReceipt: credentialReceipt ?? { attribution: 'unknown' },
      providerId: provider.id,
      providerName: provider.name ?? null,
      source: null,
      frozenModels: [
        {
          modelId: model.id,
          modelName: model.name ?? model.id,
          aliases: [...new Set([model.id, getRawModelId(model), modelId])],
          pricingSnapshot: createAiUsagePricingSnapshot(model.pricing)
        }
      ]
    }
  }
}
