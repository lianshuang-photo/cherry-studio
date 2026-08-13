import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import {
  isDshCompatibleModel,
  isOfficialDeepSeekProvider,
  toDshBaseUrl,
  toDshModelId
} from '@shared/ai/dshModelCompatibility'
import type { UniqueModelId } from '@shared/data/types/model'
import { parseUniqueModelId } from '@shared/data/types/model'

import { resolveEffectiveEndpoint } from '../../provider/endpoint'

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
  apiKey: string
  modelId: string
  baseUrl?: string
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
  if (!isDshCompatibleModel(provider, model)) {
    throw new DshUnsupportedProviderError(providerId)
  }
  const resolvedApiKey = providerService.resolveApiKey(provider.id)
  if (!resolvedApiKey.value.trim()) {
    throw new DshMissingApiKeyError(provider.id)
  }
  const endpoint = resolveEffectiveEndpoint(provider, model)
  const official = isOfficialDeepSeekProvider(provider)
  return {
    apiKey: resolvedApiKey.value,
    modelId: toDshModelId(model, provider),
    baseUrl: official ? undefined : toDshBaseUrl(endpoint.baseUrl)
  }
}
