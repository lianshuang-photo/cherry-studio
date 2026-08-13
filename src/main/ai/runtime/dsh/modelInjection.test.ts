import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Model } from '@shared/data/types/model'
import { DEFAULT_API_FEATURES, type Provider } from '@shared/data/types/provider'
import { afterEach, describe, expect, it } from 'vitest'

import { installDshModelBridge } from './dshModelBridge'
import { buildDshProviderInjection, DSH_PI_CREDENTIAL_REF, DSH_PI_PROVIDER_ROUTE } from './modelInjection'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()))
})

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'gateway',
    name: 'Gateway',
    apiFeatures: DEFAULT_API_FEATURES,
    defaultChatEndpoint: 'openai-chat-completions',
    endpointConfigs: {
      'openai-chat-completions': { adapterFamily: 'openai-compatible', baseUrl: 'https://gateway.example.com' }
    },
    ...overrides
  } as Provider
}

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gateway::agent/deepseek-v4',
    providerId: 'gateway',
    name: 'DeepSeek V4',
    apiModelId: 'agent/deepseek-v4',
    capabilities: [],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsStreaming: true,
    isEnabled: true,
    isHidden: false,
    endpointTypes: ['openai-chat-completions'],
    ...overrides
  } as Model
}

describe('DSH model injection', () => {
  it('keeps the credential separate from the official pi-ai profile and freezes usage attribution', () => {
    const injection = buildDshProviderInjection(makeProvider(), makeModel(), 'sk-cherry-secret-key', {
      attribution: 'matched',
      id: 'key-1',
      masked: 'sk-****'
    })

    expect(injection).toMatchObject({
      providerRoute: DSH_PI_PROVIDER_ROUTE,
      credentialRef: DSH_PI_CREDENTIAL_REF,
      api: 'openai-completions',
      baseURL: 'https://gateway.example.com/v1',
      modelId: 'agent/deepseek-v4',
      usageCapture: {
        owner: 'agent-sdk',
        providerId: 'gateway',
        credentialReceipt: { attribution: 'matched', id: 'key-1', masked: 'sk-****' }
      }
    })
    expect(injection.usageCapture.frozenModels[0]).toMatchObject({
      modelId: 'gateway::agent/deepseek-v4',
      aliases: ['gateway::agent/deepseek-v4', 'agent/deepseek-v4']
    })
    expect(JSON.stringify(injection.usageCapture)).not.toContain(injection.apiKey)
  })

  it('mounts the official adapter on a private route with a memory-only credential', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    const injection = buildDshProviderInjection(makeProvider(), makeModel(), 'sk-cherry-secret-key')

    await installDshModelBridge(context, injection)

    expect(context.llm.listProviders()).toEqual([{ id: DSH_PI_PROVIDER_ROUTE, name: 'Gateway' }])
    await expect(context.llm.listModels(DSH_PI_PROVIDER_ROUTE)).resolves.toEqual([
      expect.objectContaining({ id: 'agent/deepseek-v4', provider: DSH_PI_PROVIDER_ROUTE })
    ])
    await expect(context.credentials.describe(DSH_PI_CREDENTIAL_REF as never)).resolves.toEqual({
      configured: true,
      source: 'cherry',
      writable: false
    })
  })
})
