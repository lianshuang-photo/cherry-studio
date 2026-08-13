import { CHERRYAI_DEFAULT_MODEL_ID, CHERRYAI_PROVIDER_ID } from '@shared/data/presets/cherryai'
import type { Model } from '@shared/data/types/model'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { describe, expect, it } from 'vitest'

import { isDshCompatibleModel, toDshBaseUrl, toDshModelId } from '../dshModelCompatibility'

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'deepseek',
    name: 'deepseek',
    defaultChatEndpoint: 'openai-chat-completions',
    endpointConfigs: { 'openai-chat-completions': { adapterFamily: 'openai' } },
    ...overrides
  } as Provider
}

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'deepseek::deepseek-v4-flash',
    providerId: 'deepseek',
    name: 'V4 Flash',
    capabilities: [],
    contextWindow: 128_000,
    supportsStreaming: true,
    isEnabled: true,
    isHidden: false,
    endpointTypes: [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS],
    ...overrides
  } as Model
}

describe('isDshCompatibleModel', () => {
  it('rejects orphan models', () => {
    expect(isDshCompatibleModel(undefined, makeModel())).toBe(false)
  })

  it('accepts the official DeepSeek provider', () => {
    expect(isDshCompatibleModel(makeProvider(), makeModel())).toBe(true)
  })

  it('accepts a custom OpenAI-compatible host with no adapter family', () => {
    expect(
      isDshCompatibleModel(
        makeProvider({
          id: 'saas',
          presetProviderId: undefined,
          defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
          endpointConfigs: {
            [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://e-api.cherryai.com.cn/' }
          }
        }),
        makeModel({ endpointTypes: undefined, apiModelId: 'agent/deepseek-v4-flash' })
      )
    ).toBe(true)
  })

  it('strips Cherry agent/ catalog prefixes for the official DeepSeek wire id', () => {
    expect(toDshModelId(makeModel({ apiModelId: 'agent/deepseek-v4-flash' }))).toBe('deepseek-v4-flash')
    expect(toDshModelId(makeModel({ apiModelId: 'deepseek-v4-flash' }), makeProvider())).toBe('deepseek-v4-flash')
  })

  it('keeps the gateway catalog id for OpenAI-compatible hosts', () => {
    const gateway = makeProvider({ id: 'saas', presetProviderId: undefined })
    expect(toDshModelId(makeModel({ apiModelId: 'agent/deepseek-v4-flash' }), gateway)).toBe('agent/deepseek-v4-flash')
  })

  it('adds /v1 to OpenAI-compatible hosts the same way in-app chat does', () => {
    expect(toDshBaseUrl('https://e-api.cherryai.com.cn/')).toBe('https://e-api.cherryai.com.cn/v1')
    expect(toDshBaseUrl('https://gateway.example/v1')).toBe('https://gateway.example/v1')
    expect(toDshBaseUrl('')).toBeUndefined()
  })

  it('rejects the managed CherryAI default model', () => {
    expect(
      isDshCompatibleModel(
        makeProvider({ id: CHERRYAI_PROVIDER_ID }),
        makeModel({ providerId: CHERRYAI_PROVIDER_ID, apiModelId: CHERRYAI_DEFAULT_MODEL_ID })
      )
    ).toBe(false)
  })
})
